import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioBFFRequest } from "../../../data/bff";
import { asQuery } from "../../../data/query";
import { createConnectionsService } from "./handler";
import { createConnectionStore } from "./store";

const local = { remoteAddress: "127.0.0.1" };

function request(path: string, init?: RequestInit) {
  return new Request(`http://localhost:4310${path}`, init);
}

function postJson(path: string, body: unknown) {
  return request(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

describe("connections service", () => {
  let dir: string;
  let sqliteFile: string;
  let storeFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-handler-"));
    sqliteFile = join(dir, "school.db");
    storeFile = join(dir, "connections.json");
    const database = new DatabaseSync(sqliteFile);
    database.exec(
      "create table students (id integer primary key, name text); insert into students (name) values ('Ada'), ('Linus');",
    );
    database.close();
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  function createService(
    overrides: Partial<Parameters<typeof createConnectionsService>[0]> = {},
  ) {
    return createConnectionsService({
      demo: { available: true, url: "postgresql://demo@localhost:51214/demo" },
      store: createConnectionStore(storeFile),
      ...overrides,
    });
  }

  it("refuses requests from other machines or other origins", async () => {
    const service = createService();

    expect(
      (
        await service.handleRequest(request("/api/connections"), {
          remoteAddress: "192.168.1.20",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await service.handleRequest(
          request("/api/connections", {
            headers: { origin: "https://evil.example" },
          }),
          local,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await service.handleQuery(
          {
            procedure: "query",
            query: asQuery("select 1"),
          } as StudioBFFRequest,
          "any",
          { remoteAddress: "10.0.0.5" },
        )
      ).status,
    ).toBe(403);
  });

  it("saves a working SQLite connection and runs Studio queries against it", async () => {
    const service = createService();
    const saved = await service.handleRequest(
      postJson("/api/connections", { file: sqliteFile, kind: "sqlite" }),
      local,
    );

    expect(saved.status).toBe(201);
    const { connection } = (await saved.json()) as {
      connection: { id: string; name: string; kind: string };
    };
    expect(connection).toMatchObject({ kind: "sqlite", name: "school.db" });

    const list = (await (
      await service.handleRequest(request("/api/connections"), local)
    ).json()) as { connections: Array<{ id: string; source: string }> };
    expect(list.connections.map((item) => item.source)).toEqual([
      "demo",
      "saved",
    ]);

    const response = await service.handleQuery(
      {
        procedure: "query",
        query: asQuery("select name from students order by id"),
      } as StudioBFFRequest,
      connection.id,
      local,
    );
    expect(await response.json()).toEqual([
      null,
      [{ name: "Ada" }, { name: "Linus" }],
    ]);

    const lint = await service.handleQuery(
      { procedure: "sql-lint", sql: "select 1" } as StudioBFFRequest,
      connection.id,
      local,
    );
    // SQLite has no server-side lint, so the adapter falls back to EXPLAIN.
    expect(lint.status).toBe(400);
    expect(await lint.text()).toBe("Invalid procedure");

    await service.closeAll();
  });

  it("does not save connections that fail, and hides their password", async () => {
    const service = createService({
      open: () => ({
        close: async () => {},
        executor: {
          execute: async () => [
            new Error('password authentication failed for "hunter2"'),
          ],
        },
        kind: "postgres",
      }),
    });

    const response = await service.handleRequest(
      postJson("/api/connections", {
        host: "db.example.com",
        kind: "postgres",
        password: "hunter2",
        user: "admin",
      }),
      local,
    );

    expect(response.status).toBe(422);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("Could not connect");
    expect(body).not.toContain("hunter2");
    await expect(readFile(storeFile, "utf8")).rejects.toThrow();
  });

  it("connects a detected database by id without sending its URL to the browser", async () => {
    const detect = vi.fn().mockResolvedValue([
      {
        displayUrl: sqliteFile,
        id: "detected-1",
        kind: "sqlite",
        name: "school.db",
        origin: "file",
        ready: true,
        url: sqliteFile,
      },
    ]);
    const service = createService({ detect });

    const detected = (await (
      await service.handleRequest(request("/api/connections/detect"), local)
    ).json()) as { detected: Array<Record<string, unknown>> };
    expect(detected.detected[0]).not.toHaveProperty("url");
    expect(detect).toHaveBeenCalledWith([
      "postgresql://demo@localhost:51214/demo",
    ]);

    const saved = await service.handleRequest(
      postJson("/api/connections", { detectedId: "detected-1" }),
      local,
    );
    expect(saved.status).toBe(201);

    const { connection } = (await saved.json()) as {
      connection: { id: string };
    };
    const removed = await service.handleRequest(
      request(`/api/connections/${connection.id}`, { method: "DELETE" }),
      local,
    );
    expect(removed.status).toBe(204);
    expect(
      (
        await service.handleQuery(
          {
            procedure: "query",
            query: asQuery("select 1"),
          } as StudioBFFRequest,
          connection.id,
          local,
        )
      ).status,
    ).toBe(404);
  });

  it("tests a connection without saving it", async () => {
    const service = createService();
    const ok = await service.handleRequest(
      postJson("/api/connections/test", { file: sqliteFile, kind: "sqlite" }),
      local,
    );
    const missing = await service.handleRequest(
      postJson("/api/connections/test", {
        file: join(dir, "missing.db"),
        kind: "sqlite",
      }),
      local,
    );

    expect(await ok.json()).toEqual({ ok: true });
    expect(await missing.json()).toMatchObject({
      message: expect.stringContaining("SQLite file not found"),
      ok: false,
    });
    await expect(readFile(storeFile, "utf8")).rejects.toThrow();
  });
});
