import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBackupService,
  isBackupId,
  restoredDatabaseName,
  splitPassword,
} from "./backups";
import type { StoredConnection } from "./settings";

describe("backup helpers", () => {
  it("names restored databases next to the original within identifier limits", () => {
    const date = new Date(2026, 10, 11, 22, 30, 5);
    expect(restoredDatabaseName("grades_ai", date)).toBe(
      "grades_ai_restore_20261111_223005",
    );
    expect(restoredDatabaseName("x".repeat(80), date)).toHaveLength(63);
  });

  it("only accepts generated backup ids, so requests cannot escape the folder", () => {
    expect(isBackupId("2026-11-11T22-30-05-123Z.dump")).toBe(true);
    expect(isBackupId("../../etc/passwd")).toBe(false);
    expect(isBackupId("2026-11-11T22-30-05-123Z.dump/../x")).toBe(false);
  });

  it("keeps passwords out of command-line arguments", () => {
    expect(splitPassword("postgresql://me:p%40ss@db:5432/app")).toEqual({
      password: "p@ss",
      url: "postgresql://me@db:5432/app",
    });
  });
});

describe("SQLite backups", () => {
  let dir: string;
  let connection: StoredConnection;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-backups-"));
    const file = join(dir, "school.db");
    const database = new DatabaseSync(file);
    database.exec(
      "create table students (id integer primary key, name text); insert into students (name) values ('Ada');",
    );
    database.close();
    connection = { id: "conn-1", kind: "sqlite", name: "school.db", url: file };
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("backs up, lists, restores into a new file, and deletes without touching the original", async () => {
    const service = createBackupService(join(dir, "backups"));
    const backup = await service.create(connection);

    // Changes after the backup must not appear in the restored copy.
    const original = new DatabaseSync(connection.url);
    original.exec("insert into students (name) values ('Linus')");
    original.close();

    expect(await service.list(connection)).toEqual([backup]);
    expect(backup.sizeBytes).toBeGreaterThan(0);

    const restored = await service.restore(connection, backup.id);
    expect(restored.url).not.toBe(connection.url);
    expect(restored.name).toContain("restored");

    const copy = new DatabaseSync(restored.url, { readOnly: true });
    expect(copy.prepare("select name from students").all()).toEqual([
      { name: "Ada" },
    ]);
    copy.close();

    const untouched = new DatabaseSync(connection.url, { readOnly: true });
    expect(
      untouched.prepare("select count(*) as n from students").get(),
    ).toEqual({ n: 2 });
    untouched.close();

    await service.remove(connection, backup.id);
    expect(await service.list(connection)).toEqual([]);
    await expect(service.restore(connection, "../school.db")).rejects.toThrow(
      "Unknown backup.",
    );
  });
});

/**
 * Needs pg_dump/pg_restore and a Postgres you can create databases on, e.g.
 * STUDIO_CONNECTIONS_PG_TEST_URL=postgresql://postgres:pw@localhost:55432/postgres
 */
const pgUrl = process.env.STUDIO_CONNECTIONS_PG_TEST_URL;

describe.skipIf(!pgUrl)("PostgreSQL backups", () => {
  const sql = postgres(pgUrl!, { max: 1, onnotice: () => {} });
  let dir: string;
  const created: string[] = [];

  afterAll(async () => {
    for (const name of created) {
      await sql.unsafe(`drop database if exists "${name}"`);
    }
    await sql.unsafe("drop table if exists backup_students");
    await sql.end();
    if (dir) await rm(dir, { force: true, recursive: true });
  });

  it("restores a pg_dump into a new database and leaves the original as it is", async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-pg-backups-"));
    await sql.unsafe(`
      drop table if exists backup_students;
      create table backup_students (id serial primary key, name text);
      insert into backup_students (name) values ('Ada');
    `);
    const connection: StoredConnection = {
      id: "pg-1",
      kind: "postgres",
      name: "test",
      url: pgUrl!,
    };
    const service = createBackupService(join(dir, "backups"));
    const backup = await service.create(connection);
    await sql`insert into backup_students (name) values ('Linus')`;

    const restored = await service.restore(connection, backup.id);
    const restoredName = decodeURIComponent(
      new URL(restored.url).pathname.slice(1),
    );
    created.push(restoredName);
    expect(restoredName).toMatch(/_restore_\d{8}_\d{6}$/);

    const copy = postgres(restored.url, { max: 1 });
    expect(await copy`select name from backup_students`).toEqual([
      { name: "Ada" },
    ]);
    await copy.end();

    const [count] = await sql<
      { n: number }[]
    >`select count(*)::int as n from backup_students`;
    expect(count?.n).toBe(2);
  }, 60_000);
});
