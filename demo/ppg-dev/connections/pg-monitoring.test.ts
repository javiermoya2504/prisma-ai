import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import type { Executor } from "../../../data/executor";
import { openDatabaseConnection } from "./drivers";
import { cancelPostgresQuery, getPostgresActivity } from "./pg-activity";
import {
  createPgStatStatementsInsights,
  prepareQueryInsights,
} from "./pg-stat-statements";
import { SetupError } from "./setup-error";

function fakeExecutor(respond: (sql: string) => unknown[] | Error): Executor {
  return {
    execute: (query) => {
      const result = respond(query.sql);
      return Promise.resolve(
        (result instanceof Error ? [result] : [null, result]) as never,
      );
    },
  };
}

describe("query insights from pg_stat_statements", () => {
  it("asks for a server restart when the library is not preloaded", async () => {
    const executor = fakeExecutor(() => [{ shared_preload_libraries: "" }]);
    await expect(prepareQueryInsights(executor)).rejects.toMatchObject({
      code: "preload",
    });
    await expect(prepareQueryInsights(executor)).rejects.toBeInstanceOf(
      SetupError,
    );
  });

  it("maps statements to Studio rows, hides catalog traffic, and tracks lastSeen by call growth", async () => {
    let calls = 3;
    const executor = fakeExecutor((sql) =>
      sql.includes("from pg_extension")
        ? [{ schema: "studio_monitoring" }]
        : [
            {
              calls,
              id: "101",
              max_ms: 9,
              mean_ms: 4.5,
              min_ms: 1,
              query: "select * from public.students where id = $1",
              reads: 12,
              rows: 3,
            },
            {
              calls: 50,
              id: "102",
              max_ms: 1,
              mean_ms: 1,
              min_ms: 1,
              query: "select * from pg_catalog.pg_class",
              reads: 1,
              rows: 1,
            },
            {
              calls: 9,
              id: "103",
              max_ms: 1,
              mean_ms: 1,
              min_ms: 1,
              query: "SET application_name = $1",
              reads: 0,
              rows: 0,
            },
            {
              calls: 4,
              id: "104",
              max_ms: 1,
              mean_ms: 1,
              min_ms: 1,
              // Studio's own monitoring query, as pg_stat_statements stores it.
              query:
                "select /* prisma-studio */ pid, extract(epoch from query_start) as started from pg_stat_activity",
              reads: 0,
              rows: 1,
            },
          ],
    );
    let now = 1_000;
    const insights = createPgStatStatementsInsights(() => now);

    const first = await insights.getSnapshot(executor, {});
    expect(first.queries).toEqual([
      {
        count: 3,
        duration: 4.5,
        id: "101",
        lastSeen: 1_000,
        maxDurationMs: 9,
        minDurationMs: 1,
        query: "select * from public.students where id = $1",
        reads: 12,
        rowsReturned: 3,
        tables: ["public.students"],
      },
    ]);

    now = 2_000;
    expect(
      (await insights.getSnapshot(executor, { since: 1_500 })).queries,
    ).toEqual([]);

    now = 3_000;
    calls = 4;
    expect(
      (await insights.getSnapshot(executor, { since: 2_500 })).queries.map(
        (query) => [query.id, query.lastSeen],
      ),
    ).toEqual([["101", 3_000]]);
  });
});

/**
 * Needs a Postgres started with
 * `-c shared_preload_libraries=pg_stat_statements`, e.g.
 * STUDIO_CONNECTIONS_PG_TEST_URL=postgresql://postgres:pw@localhost:55432/postgres
 */
const pgUrl = process.env.STUDIO_CONNECTIONS_PG_TEST_URL;

describe.skipIf(!pgUrl)("PostgreSQL monitoring", () => {
  const app = postgres(pgUrl!, {
    connection: { application_name: "grades-api" },
    max: 1,
    onnotice: () => {},
  });
  const studio = openDatabaseConnection({ kind: "postgres", url: pgUrl! });

  afterAll(async () => {
    await app.end({ timeout: 1 }).catch(() => {});
    await studio.close();
  });

  it("lists other apps' running statements and cancels one", async () => {
    const running = app`select pg_sleep(30)`.catch((error: Error) => error);
    let session;

    for (let attempt = 0; attempt < 50 && !session; attempt += 1) {
      const snapshot = await getPostgresActivity(studio.executor, {
        canCancel: true,
      });
      session = snapshot.sessions.find(
        (item) => item.application === "grades-api" && item.state === "active",
      );
      if (!session) await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(session).toMatchObject({
      isStudio: false,
      query: "select pg_sleep(30)",
      state: "active",
    });
    expect(session?.queryStartedAt).toBeGreaterThan(0);

    if (!session) throw new Error("The pg_sleep session never showed up.");
    expect(await cancelPostgresQuery(studio.executor, session.id)).toBe(true);
    expect(String(await running)).toMatch(/canceling statement/);
    expect(await cancelPostgresQuery(studio.executor, "999999")).toBe(false);
  }, 20_000);

  it("installs the extension outside the user's schemas when it is missing", async () => {
    const admin = postgres(pgUrl!, { max: 1, onnotice: () => {} });
    const name = `pgss_fresh_${Date.now()}`;
    await admin.unsafe(`create database ${name}`);
    const freshUrl = new URL(pgUrl!);
    freshUrl.pathname = `/${name}`;
    const fresh = openDatabaseConnection({
      kind: "postgres",
      url: freshUrl.toString(),
    });

    try {
      await prepareQueryInsights(fresh.executor);
      const [, rows] = await fresh.executor.execute({
        parameters: [],
        sql: `select n.nspname as schema from pg_extension e
                join pg_namespace n on n.oid = e.extnamespace
               where e.extname = 'pg_stat_statements'`,
      } as never);
      expect(rows).toEqual([{ schema: "studio_monitoring" }]);
      const [, publicViews] = await fresh.executor.execute({
        parameters: [],
        sql: "select count(*)::int as n from pg_views where schemaname = 'public'",
      } as never);
      expect(publicViews).toEqual([{ n: 0 }]);
    } finally {
      await fresh.close();
      await admin.unsafe(`drop database if exists ${name}`);
      await admin.end();
    }
  });

  it("reads real pg_stat_statements rows once the extension exists", async () => {
    await prepareQueryInsights(studio.executor);
    await app`select ${1}::int + 1 as two`;

    const snapshot = await createPgStatStatementsInsights().getSnapshot(
      studio.executor,
      {},
    );

    expect(
      snapshot.queries.some((query) => /\$1::int \+ \$2/.test(query.query)),
    ).toBe(true);
  });
});
