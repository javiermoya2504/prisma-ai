import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { asQuery } from "../../../data/query";
import { openDatabaseConnection } from "./drivers";

describe("read-only connections", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-drivers-"));
    file = join(dir, "school.db");
    const database = new DatabaseSync(file);
    database.exec("create table students (id integer primary key, name text)");
    database.close();
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("lets SQLite read but rejects writes at the database level", async () => {
    const connection = openDatabaseConnection({
      kind: "sqlite",
      readOnly: true,
      url: file,
    });

    try {
      const [readError] = await connection.executor.execute(
        asQuery("select count(*) as n from students"),
      );
      expect(readError).toBeNull();

      const [writeError] = await connection.executor.execute(
        asQuery("insert into students (name) values ('Ada')"),
      );
      expect(writeError?.message).toMatch(/readonly/i);
    } finally {
      await connection.close();
    }
  });
});

const pgUrl = process.env.STUDIO_CONNECTIONS_PG_TEST_URL;

describe.skipIf(!pgUrl)("read-only PostgreSQL connections", () => {
  const admin = postgres(pgUrl!, { max: 1, onnotice: () => {} });

  afterAll(async () => {
    await admin.unsafe("drop table if exists ro_students");
    await admin.end();
  });

  it("runs every statement in a read-only transaction", async () => {
    await admin.unsafe(
      "drop table if exists ro_students; create table ro_students (id serial primary key, name text);",
    );
    const connection = openDatabaseConnection({
      kind: "postgres",
      readOnly: true,
      url: pgUrl!,
    });

    try {
      const [readError] = await connection.executor.execute(
        asQuery("select count(*) from ro_students"),
      );
      expect(readError).toBeNull();

      const [writeError] = await connection.executor.execute(
        asQuery("insert into ro_students (name) values ('Ada')"),
      );
      expect(writeError?.message).toMatch(/read-only transaction/);
    } finally {
      await connection.close();
    }
  });
});

const mysqlUrl = process.env.STUDIO_MYSQL_TEST_URL;

describe.skipIf(!mysqlUrl)("read-only MySQL connections", () => {
  it("rejects writes on every pooled connection", async () => {
    const setup = openDatabaseConnection({ kind: "mysql", url: mysqlUrl! });
    await setup.executor.execute(asQuery("drop table if exists ro_students"));
    await setup.executor.execute(
      asQuery("create table ro_students (id int primary key, name text)"),
    );

    const connection = openDatabaseConnection({
      kind: "mysql",
      readOnly: true,
      url: mysqlUrl!,
    });

    try {
      const [readError] = await connection.executor.execute(
        asQuery("select count(*) as n from ro_students"),
      );
      expect(readError).toBeNull();

      const results = await Promise.all(
        [1, 2, 3].map((id) =>
          connection.executor.execute(
            asQuery(`insert into ro_students values (${id}, 'x')`),
          ),
        ),
      );
      for (const [writeError] of results) {
        expect(writeError?.message).toMatch(/READ ONLY/i);
      }
    } finally {
      await connection.close();
      await setup.executor.execute(asQuery("drop table if exists ro_students"));
      await setup.close();
    }
  });
});
