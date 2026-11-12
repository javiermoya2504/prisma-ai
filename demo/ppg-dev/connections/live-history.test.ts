import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDatabaseConnection } from "./drivers";
import {
  dropPublication,
  LIVE_HISTORY_PUBLICATION,
  startLiveHistory,
  toWalRecords,
} from "./live-history";
import { listReplicaIdentities, setReplicaIdentity } from "./replica-identity";
import { startLocalStreamsServer } from "./streams-hub";

const timestamp = "2026-11-11T12:00:00.000Z";
const students = {
  keys: [{ name: "id" }],
  schema: "public",
  table: "students",
};

describe("toWalRecords", () => {
  it("maps inserts, updates and deletes to prisma-wal records keyed like @prisma/dev", () => {
    expect(
      toWalRecords(
        { id: 1, name: "Ada" },
        { command: "insert", relation: students },
        timestamp,
      ),
    ).toEqual([
      {
        headers: { operation: "insert", timestamp },
        key: "1",
        old_value: null,
        type: "public.students",
        value: { id: 1, name: "Ada" },
      },
    ]);

    expect(
      toWalRecords(
        { id: 1, name: "Ada L." },
        { command: "update", key: false, old: null, relation: students },
        timestamp,
      )[0],
    ).toMatchObject({
      headers: { operation: "update" },
      key: "1",
      old_value: null,
    });

    // Default replica identity: deletes carry only the key columns.
    expect(
      toWalRecords(
        { id: 1, name: null },
        { command: "delete", key: true, relation: students },
        timestamp,
      )[0],
    ).toMatchObject({
      headers: { operation: "delete" },
      key: "1",
      old_value: { id: 1 },
      value: null,
    });
  });

  it("keys REPLICA IDENTITY FULL tables by their primary key so updates keep the previous row", () => {
    // With FULL, PostgreSQL flags every column as part of the identity.
    const fullStudents = {
      keys: [{ name: "id" }, { name: "name" }],
      schema: "public",
      table: "students",
    };
    const primaryKeys = new Map([["public.students", ["id"]]]);

    expect(
      toWalRecords(
        { id: 1, name: "Ada L." },
        {
          command: "update",
          key: false,
          old: { id: 1, name: "Ada" },
          relation: fullStudents,
        },
        timestamp,
        primaryKeys,
      ),
    ).toEqual([
      {
        headers: { operation: "update", timestamp },
        key: "1",
        old_value: { id: 1, name: "Ada" },
        type: "public.students",
        value: { id: 1, name: "Ada L." },
      },
    ]);

    expect(
      toWalRecords(
        { id: 1, name: "Ada L." },
        { command: "delete", key: false, relation: fullStudents },
        timestamp,
        primaryKeys,
      )[0],
    ).toMatchObject({ key: "1", old_value: { id: 1, name: "Ada L." } });
  });

  it("uses col=value|col=value keys for composite primary keys and splits key changes", () => {
    const enroll = {
      keys: [{ name: "student_id" }, { name: "course" }],
      schema: "public",
      table: "enroll",
    };

    const records = toWalRecords(
      { course: "Algorithms", student_id: 1 },
      {
        command: "update",
        key: true,
        old: { course: "SQL", student_id: 1 },
        relation: enroll,
      },
      timestamp,
    );

    expect(
      records.map((record) => [record.headers.operation, record.key]),
    ).toEqual([
      ["delete", "student_id=1|course=SQL"],
      ["insert", "student_id=1|course=Algorithms"],
    ]);
  });
});

/**
 * Runs against a real Postgres started with `-c wal_level=logical`, e.g.
 * `docker run --rm -e POSTGRES_PASSWORD=pw -p 55432:5432 postgres:17-alpine -c wal_level=logical`
 * and STUDIO_CONNECTIONS_PG_TEST_URL=postgresql://postgres:pw@localhost:55432/postgres
 */
const testUrl = process.env.STUDIO_CONNECTIONS_PG_TEST_URL;

describe.skipIf(!testUrl)("live history against Postgres", () => {
  const url = testUrl!;
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  beforeAll(async () => {
    await sql.unsafe(`
      drop table if exists lh_students, lh_logs;
      create table lh_students (id serial primary key, name text);
      create table lh_logs (message text);
      insert into lh_logs values ('before');
    `);
  });

  afterAll(async () => {
    await dropPublication(url);
    await sql.unsafe("drop table if exists lh_students, lh_logs");
    await sql.end();
  });

  it("streams committed changes, never breaks writes to tables without a primary key, and leaves no replication slot behind", async () => {
    const streams = await startLocalStreamsServer(`test-${Date.now()}`);
    const session = await startLiveHistory({
      connectionId: `test-${Date.now()}`,
      streamsServerUrl: streams.url,
      url,
    });

    try {
      const published = await sql<{ tablename: string }[]>`
        select tablename from pg_publication_tables
        where pubname = ${LIVE_HISTORY_PUBLICATION} order by 1
      `;
      expect(published.map((row) => row.tablename)).toContain("lh_students");
      expect(published.map((row) => row.tablename)).not.toContain("lh_logs");

      await sql`insert into lh_students (name) values ('Ada')`;
      await sql`update lh_students set name = 'Ada L.'`;
      // Would fail with "does not have a replica identity" if lh_logs were published.
      await sql`update lh_logs set message = 'after'`;
      await sql`delete from lh_students`;

      let events: Array<{ type: string; headers: { operation: string } }> = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const response = await fetch(
          `${streams.url}/v1/stream/prisma-wal?offset=-1&format=json`,
        );
        events = (await response.json()) as typeof events;
        if (events.length >= 3) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(
        events
          .filter((event) => event.type === "public.lh_students")
          .map((event) => event.headers.operation),
      ).toEqual(["insert", "update", "delete"]);
    } finally {
      await session.stop();
      await streams.close();
    }

    const [slots] = await sql<{ count: number }[]>`
      select count(*)::int as count from pg_replication_slots
    `;
    expect(slots?.count).toBe(0);
  }, 30_000);

  it("records the previous row of an update once the table keeps previous values, and can go back to the default", async () => {
    const studio = openDatabaseConnection({ kind: "postgres", url });
    const streams = await startLocalStreamsServer(`test-full-${Date.now()}`);

    try {
      const tables = await listReplicaIdentities(studio.executor);
      expect(tables).toContainEqual({
        full: false,
        name: "lh_students",
        schema: "public",
      });
      // Tables without a primary key are not offered.
      expect(tables.some((table) => table.name === "lh_logs")).toBe(false);

      await setReplicaIdentity(
        studio.executor,
        { name: "lh_students", schema: "public" },
        true,
      );

      const session = await startLiveHistory({
        connectionId: `test-full-${Date.now()}`,
        streamsServerUrl: streams.url,
        url,
      });

      try {
        await sql`insert into lh_students (id, name) values (100, 'Grace')`;
        await sql`update lh_students set name = 'Grace H.' where id = 100`;

        let update: { old_value: unknown; value: unknown } | undefined;
        for (let attempt = 0; attempt < 40 && !update; attempt += 1) {
          const events = (await (
            await fetch(
              `${streams.url}/v1/stream/prisma-wal?offset=-1&format=json`,
            )
          ).json()) as Array<{
            headers: { operation: string };
            old_value: unknown;
            value: unknown;
          }>;
          update = events.find((event) => event.headers.operation === "update");
          if (!update) await new Promise((resolve) => setTimeout(resolve, 100));
        }

        expect(update).toMatchObject({
          old_value: { id: 100, name: "Grace" },
          value: { id: 100, name: "Grace H." },
        });
      } finally {
        await session.stop();
      }

      await setReplicaIdentity(
        studio.executor,
        { name: "lh_students", schema: "public" },
        false,
      );
      const [identity] = await sql<{ relreplident: string }[]>`
        select relreplident from pg_class where relname = 'lh_students'
      `;
      expect(identity?.relreplident).toBe("d");

      await expect(
        setReplicaIdentity(
          studio.executor,
          { name: "lh_logs", schema: "public" },
          true,
        ),
      ).rejects.toMatchObject({ code: "permission" });
    } finally {
      await streams.close();
      await studio.close();
    }
  }, 30_000);
});
