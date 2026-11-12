import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectLocalDatabases, findSqliteFiles } from "./detect";

describe("local database detection", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-detect-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("lists every database of a password-less local Postgres server", async () => {
    const listDatabases = vi.fn(async (_kind: string, url: string) => {
      if (url.startsWith("postgresql://postgres@")) return ["app", "shop"];
      throw new Error("role does not exist");
    });

    const results = await detectLocalDatabases({
      env: {},
      findSqliteFiles: async () => [],
      isPortOpen: async (_host, port) => port === 5432,
      listDatabases,
    });

    expect(
      results.map((result) => [result.kind, result.ready, result.url]),
    ).toEqual([
      ["postgres", true, "postgresql://postgres@localhost:5432/app"],
      ["postgres", true, "postgresql://postgres@localhost:5432/shop"],
    ]);
  });

  it("asks for credentials when a local server rejects password-less users", async () => {
    const results = await detectLocalDatabases({
      env: {},
      findSqliteFiles: async () => [],
      isPortOpen: async (_host, port) => port === 3306,
      listDatabases: async () => {
        throw new Error("Access denied");
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      kind: "mysql",
      name: "MySQL on localhost:3306",
      prefill: { host: "localhost", port: 3306, user: "root" },
      ready: false,
    });
  });

  it("includes SQLite files and DATABASE_URL, masking its password, and skips saved URLs", async () => {
    const results = await detectLocalDatabases({
      env: { DATABASE_URL: "postgresql://me:secret@db.internal:5432/prod" },
      excludeUrls: ["/data/saved.db"],
      findSqliteFiles: async () => ["/data/dev.db", "/data/saved.db"],
      isPortOpen: async () => false,
    });

    expect(results.map((result) => result.name)).toEqual([
      "DATABASE_URL (prod @ db.internal)",
      "dev.db",
    ]);
    expect(results[0]?.displayUrl).toBe(
      "postgresql://me:****@db.internal:5432/prod",
    );
  });

  it("finds real SQLite files by header and skips node_modules and fake .db files", async () => {
    const project = join(dir, "project");
    await mkdir(join(project, "prisma"), { recursive: true });
    await mkdir(join(project, "node_modules", "pkg"), { recursive: true });
    const real = join(project, "prisma", "dev.db");
    new DatabaseSync(real).exec("create table t (id integer)");
    new DatabaseSync(join(project, "node_modules", "pkg", "x.sqlite")).exec(
      "create table t (id integer)",
    );
    await writeFile(join(project, "notes.db"), "not a database");

    expect(await findSqliteFiles([dir])).toEqual([real]);
  });
});
