import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioBFFRequest } from "../../../data/bff";
import { asQuery } from "../../../data/query";
import { createConnectionsService } from "./handler";
import { SetupError } from "./setup-error";
import { createConnectionStore } from "./store";
import { createStreamsHub } from "./streams-hub";

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

  it("switches a saved connection to read-only and refuses Studio edits on it", async () => {
    const service = createService();
    const saved = await service.handleRequest(
      postJson("/api/connections", { file: sqliteFile, kind: "sqlite" }),
      local,
    );
    const { connection } = (await saved.json()) as {
      connection: { id: string; readOnly: boolean };
    };
    expect(connection.readOnly).toBe(false);

    const patched = await service.handleRequest(
      request(`/api/connections/${connection.id}`, {
        body: JSON.stringify({ readOnly: true }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
      local,
    );
    expect(await patched.json()).toMatchObject({
      connection: { readOnly: true },
    });

    const edit = await service.handleQuery(
      {
        procedure: "transaction",
        queries: [asQuery("update students set name = 'x'")],
      } as StudioBFFRequest,
      connection.id,
      local,
    );
    expect(JSON.stringify(await edit.json())).toContain("read-only");

    // Raw SQL writes are rejected by SQLite itself (read-only file handle).
    const raw = await service.handleQuery(
      {
        procedure: "query",
        query: asQuery("delete from students"),
      } as StudioBFFRequest,
      connection.id,
      local,
    );
    expect(JSON.stringify(await raw.json())).toMatch(/readonly/i);

    const rows = await service.handleQuery(
      {
        procedure: "query",
        query: asQuery("select count(*) as n from students"),
      } as StudioBFFRequest,
      connection.id,
      local,
    );
    expect(await rows.json()).toEqual([null, [{ n: 2 }]]);
    await service.closeAll();
  });

  it("creates, restores (as a new connection) and deletes backups", async () => {
    const service = createConnectionsService({
      backups: (await import("./backups")).createBackupService(
        join(dir, "backups"),
      ),
      demo: { available: false },
      store: createConnectionStore(storeFile),
    });
    const saved = await service.handleRequest(
      postJson("/api/connections", { file: sqliteFile, kind: "sqlite" }),
      local,
    );
    const { connection } = (await saved.json()) as {
      connection: { id: string };
    };
    const base = `/api/connections/${connection.id}/backups`;

    const created = await service.handleRequest(
      request(base, { method: "POST" }),
      local,
    );
    expect(created.status).toBe(201);
    const { backup } = (await created.json()) as { backup: { id: string } };

    const listed = (await (
      await service.handleRequest(request(base), local)
    ).json()) as { backups: Array<{ id: string }> };
    expect(listed.backups.map((item) => item.id)).toEqual([backup.id]);

    const restored = await service.handleRequest(
      request(`${base}/${backup.id}/restore`, { method: "POST" }),
      local,
    );
    expect(restored.status).toBe(201);
    const list = (await (
      await service.handleRequest(request("/api/connections"), local)
    ).json()) as { connections: Array<{ name: string }> };
    expect(list.connections).toHaveLength(2);
    expect(list.connections[1]?.name).toContain("restored");

    expect(
      (
        await service.handleRequest(
          request(`${base}/${backup.id}`, { method: "DELETE" }),
          local,
        )
      ).status,
    ).toBe(204);
    await service.closeAll();
  });

  describe("live history", () => {
    let upstream: Server;
    let upstreamUrl: string;
    const seenPaths: string[] = [];

    beforeEach(async () => {
      upstream = createServer((req, res) => {
        seenPaths.push(req.url ?? "");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify([{ name: "prisma-wal" }]));
      });
      await new Promise<void>((resolve) => upstream.listen(0, resolve));
      upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    });

    afterEach(async () => {
      await new Promise((resolve) => upstream.close(resolve));
    });

    async function savePostgres(
      service: ReturnType<typeof createConnectionsService>,
    ) {
      const response = await service.handleRequest(
        postJson("/api/connections", {
          kind: "postgres",
          url: "postgresql://me:pw@localhost:5432/grades",
        }),
        local,
      );
      return ((await response.json()) as { connection: { id: string } })
        .connection.id;
    }

    function createHistoryService(
      start: Parameters<typeof createConnectionsService>[0]["liveHistory"],
      serverLogs?: Parameters<typeof createConnectionsService>[0]["serverLogs"],
    ) {
      return createService({
        liveHistory: start,
        serverLogs,
        // Every connection's Streams server is the fake upstream.
        streamsHub: createStreamsHub(() =>
          Promise.resolve({ close: () => Promise.resolve(), url: upstreamUrl }),
        ),
        open: () => ({
          close: async () => {},
          executor: {
            execute: () => Promise.resolve([null, [{ ok: 1 }]] as never),
          },
          kind: "postgres",
        }),
      });
    }

    it("turns on, proxies the connection's own prisma-wal Streams server, survives restarts, and turns off cleanly", async () => {
      const stop = vi.fn(() => Promise.resolve());
      const dropPublication = vi.fn(() => Promise.resolve());
      const start = vi.fn(() => Promise.resolve({ stop, tableCount: 4 }));
      const service = createHistoryService({ dropPublication, start });
      const id = await savePostgres(service);

      const enabled = await service.handleRequest(
        request(`/api/connections/${id}/live-history`, { method: "POST" }),
        local,
      );
      expect(await enabled.json()).toMatchObject({
        connection: { id, liveHistory: true },
        tableCount: 4,
      });
      expect(start).toHaveBeenCalledWith({
        connectionId: id,
        streamsServerUrl: upstreamUrl,
        url: "postgresql://me:pw@localhost:5432/grades",
      });

      const proxied = await service.handleRequest(
        request(`/api/connections/${id}/streams/v1/streams?limit=10`),
        local,
      );
      expect(await proxied.json()).toEqual([{ name: "prisma-wal" }]);
      expect(seenPaths.at(-1)).toBe("/v1/streams?limit=10");

      // A new server process resumes history for connections that had it on.
      const restarted = createHistoryService({ dropPublication, start });
      await restarted.resumeStreamFeatures();
      expect(start).toHaveBeenCalledTimes(2);
      await restarted.closeAll();
      expect(dropPublication).not.toHaveBeenCalled();

      const disabled = await service.handleRequest(
        request(`/api/connections/${id}/live-history`, { method: "DELETE" }),
        local,
      );
      expect(await disabled.json()).toMatchObject({
        connection: { liveHistory: false },
      });
      expect(stop).toHaveBeenCalled();
      expect(dropPublication).toHaveBeenCalledWith(
        "postgresql://me:pw@localhost:5432/grades",
      );
      expect(
        (
          await service.handleRequest(
            request(`/api/connections/${id}/streams/v1/streams`),
            local,
          )
        ).status,
      ).toBe(503);
    });

    it("keeps the read-only setting when live history is turned on and off", async () => {
      const service = createHistoryService({
        dropPublication: vi.fn(() => Promise.resolve()),
        start: vi.fn(() =>
          Promise.resolve({
            stop: () => Promise.resolve(),
            tableCount: 1,
          }),
        ),
      });
      const id = await savePostgres(service);
      await service.handleRequest(
        request(`/api/connections/${id}`, {
          body: JSON.stringify({ readOnly: true }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        }),
        local,
      );

      for (const method of ["POST", "DELETE"]) {
        const response = await service.handleRequest(
          request(`/api/connections/${id}/live-history`, { method }),
          local,
        );
        expect(await response.json()).toMatchObject({
          connection: { readOnly: true },
        });
      }
    });

    it("refuses to change a table's replica identity on a read-only connection", async () => {
      const service = createHistoryService({
        dropPublication: vi.fn(),
        start: vi.fn(),
      });
      const id = await savePostgres(service);
      await service.handleRequest(
        request(`/api/connections/${id}`, {
          body: JSON.stringify({ readOnly: true }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        }),
        local,
      );

      const response = await service.handleRequest(
        request(`/api/connections/${id}/replica-identity`, {
          body: JSON.stringify({
            full: true,
            name: "students",
            schema: "public",
          }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        }),
        local,
      );

      expect(response.status).toBe(403);
    });

    it("explains when the server is not configured for logical replication", async () => {
      const service = createHistoryService({
        dropPublication: vi.fn(),
        start: vi.fn(() =>
          Promise.reject(
            new SetupError(
              "wal-level",
              'Live history needs wal_level = logical (this server uses "replica").',
            ),
          ),
        ),
      });
      const id = await savePostgres(service);
      const response = await service.handleRequest(
        request(`/api/connections/${id}/live-history`, { method: "POST" }),
        local,
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "wal-level" });
      const list = (await (
        await service.handleRequest(request("/api/connections"), local)
      ).json()) as { connections: Array<{ id: string; liveHistory: boolean }> };
      expect(list.connections.find((item) => item.id === id)?.liveHistory).toBe(
        false,
      );
    });

    it("streams server logs on the same Streams server and keeps it running until both features are off", async () => {
      const historyStop = vi.fn(() => Promise.resolve());
      const logsStop = vi.fn(() => Promise.resolve());
      const closeServer = vi.fn(() => Promise.resolve());
      const startServer = vi.fn(() =>
        Promise.resolve({ close: closeServer, url: upstreamUrl }),
      );
      const service = createService({
        liveHistory: {
          dropPublication: vi.fn(() => Promise.resolve()),
          start: vi.fn(() =>
            Promise.resolve({ stop: historyStop, tableCount: 1 }),
          ),
        },
        open: () => ({
          close: async () => {},
          executor: {
            execute: () => Promise.resolve([null, [{ ok: 1 }]] as never),
          },
          kind: "postgres",
        }),
        serverLogs: {
          start: vi.fn(() => Promise.resolve({ stop: logsStop })),
        },
        streamsHub: createStreamsHub(startServer),
      });
      const id = await savePostgres(service);
      const toggle = (feature: string, method: string) =>
        service.handleRequest(
          request(`/api/connections/${id}/${feature}`, { method }),
          local,
        );

      expect(await (await toggle("server-logs", "POST")).json()).toMatchObject({
        connection: { serverLogs: true },
      });
      await toggle("live-history", "POST");
      expect(startServer).toHaveBeenCalledTimes(1);

      await toggle("server-logs", "DELETE");
      expect(logsStop).toHaveBeenCalled();
      expect(closeServer).not.toHaveBeenCalled();

      await toggle("live-history", "DELETE");
      expect(closeServer).toHaveBeenCalledTimes(1);
    });

    it("explains when the server log file cannot be found", async () => {
      const service = createHistoryService(
        {
          dropPublication: vi.fn(),
          start: vi.fn(),
        },
        {
          start: () =>
            Promise.reject(
              new SetupError(
                "log-not-found",
                "Could not find this server's log file.",
              ),
            ),
        },
      );
      const id = await savePostgres(service);
      const response = await service.handleRequest(
        request(`/api/connections/${id}/server-logs`, { method: "POST" }),
        local,
      );

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "log-not-found" });
    });

    it("is only offered for PostgreSQL", async () => {
      const service = createService();
      const saved = await service.handleRequest(
        postJson("/api/connections", { file: sqliteFile, kind: "sqlite" }),
        local,
      );
      const { connection } = (await saved.json()) as {
        connection: { id: string };
      };

      const response = await service.handleRequest(
        request(`/api/connections/${connection.id}/live-history`, {
          method: "POST",
        }),
        local,
      );
      expect(response.status).toBe(400);
      await service.closeAll();
    });
  });
});
