import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Executor } from "../../../data/executor";
import {
  findPostgresLogFile,
  parsePostgresLogLines,
  startServerLogs,
} from "./postgres-logs";
import { startLocalStreamsServer } from "./streams-hub";

describe("parsePostgresLogLines", () => {
  it("turns Homebrew-style log lines into evlog events and attaches DETAIL/STATEMENT lines", () => {
    const events = parsePostgresLogLines([
      "2026-11-11 22:27:01.123 UTC [949] LOG:  checkpoint starting: time",
      '2026-11-11 22:27:05.500 UTC [1200] ERROR:  duplicate key value violates unique constraint "students_pkey"',
      "2026-11-11 22:27:05.500 UTC [1200] DETAIL:  Key (id)=(1) already exists.",
      "2026-11-11 22:27:05.500 UTC [1200] STATEMENT:  insert into students (id, name)",
      "\tvalues (1, 'Ada')",
      "2026-11-11 22:27:09.000 UTC [1300] WARNING:  there is no transaction in progress",
    ]);

    expect(events).toEqual([
      expect.objectContaining({
        level: "info",
        message: "checkpoint starting: time",
        pid: 949,
        service: "postgres",
        severity: "LOG",
        timestamp: "2026-11-11T22:27:01.123Z",
      }),
      expect.objectContaining({
        detail: "Key (id)=(1) already exists.",
        level: "error",
        pid: 1200,
        statement: "insert into students (id, name)\nvalues (1, 'Ada')",
      }),
      expect.objectContaining({ level: "warn", severity: "WARNING" }),
    ]);
  });

  it("keeps unknown time zones by falling back to the read time", () => {
    const now = new Date("2026-11-11T00:00:00.000Z");
    const [event] = parsePostgresLogLines(
      ["2026-11-11 22:27:01 XYZT [1] LOG:  hello"],
      now,
    );
    expect(event?.timestamp).toBe(now.toISOString());
  });
});

describe("findPostgresLogFile", () => {
  const settings = (row: Record<string, unknown>): Executor => ({
    execute: () => Promise.resolve([null, [row]] as never),
  });
  const homebrewLog = "/opt/homebrew/var/log/postgresql@17.log";

  it("uses Homebrew's launchd log only for a Homebrew-managed server", async () => {
    await expect(
      findPostgresLogFile(
        settings({
          current: null,
          data_dir: "/opt/homebrew/var/postgresql@17",
          major: 17,
        }),
        "postgresql://me@localhost:5432/app",
        (path) => path === homebrewLog,
      ),
    ).resolves.toBe(homebrewLog);

    // Same port range and version, but running in Docker: not its log.
    await expect(
      findPostgresLogFile(
        settings({
          current: null,
          data_dir: "/var/lib/postgresql/data",
          major: 17,
        }),
        "postgresql://me@localhost:55432/app",
        (path) => path === homebrewLog,
      ),
    ).rejects.toMatchObject({ code: "log-not-found" });
  });

  it("prefers the logging collector's current file and refuses remote servers", async () => {
    await expect(
      findPostgresLogFile(
        settings({
          current: "log/postgresql-Wed.log",
          data_dir: "/srv/pg",
          major: 16,
        }),
        "postgresql://me@127.0.0.1:5432/app",
        (path) => path === "/srv/pg/log/postgresql-Wed.log",
      ),
    ).resolves.toBe("/srv/pg/log/postgresql-Wed.log");

    await expect(
      findPostgresLogFile(
        settings({}),
        "postgresql://me@db.example.com:5432/app",
        () => true,
      ),
    ).rejects.toMatchObject({ code: "log-not-found" });
  });
});

describe("startServerLogs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-logs-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("follows only new lines (including after truncation) into postgres-logs", async () => {
    const logFile = join(dir, "postgresql.log");
    await writeFile(
      logFile,
      "2026-11-11 22:00:00.000 UTC [1] LOG:  old line before Studio\n",
    );
    const streams = await startLocalStreamsServer(`logs-test-${Date.now()}`);
    const session = await startServerLogs({
      logFile,
      pollIntervalMs: 20,
      streamsServerUrl: streams.url,
    });

    const readEvents = async () =>
      (await (
        await fetch(
          `${streams.url}/v1/stream/postgres-logs?offset=-1&format=json`,
        )
      ).json()) as Array<{ message: string }>;
    const waitFor = async (count: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const events = await readEvents();
        if (events.length >= count) return events;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return await readEvents();
    };

    try {
      await appendFile(
        logFile,
        "2026-11-11 22:00:01.000 UTC [2] ERROR:  first new line\n2026-11-11 22:00:02.000 UTC [2] LOG:  partial",
      );
      expect((await waitFor(1)).map((event) => event.message)).toEqual([
        "first new line",
      ]);

      // Rotation/truncation starts over at the beginning of the new file.
      await writeFile(
        logFile,
        "2026-11-11 22:00:03.000 UTC [3] LOG:  after rotation\n",
      );
      expect((await waitFor(2)).map((event) => event.message)).toEqual([
        "first new line",
        "after rotation",
      ]);
    } finally {
      await session.stop();
      await streams.close();
    }
  }, 20_000);
});
