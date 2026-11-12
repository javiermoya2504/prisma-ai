import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { Executor } from "../../../data/executor";
import { asQuery } from "../../../data/query";
import { SetupError } from "./setup-error";
import { createStreamAppender } from "./streams-hub";

export const SERVER_LOGS_STREAM_NAME = "postgres-logs";

const POLL_INTERVAL_MS = 1_000;
const MAX_READ_BYTES = 1024 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** `2026-11-11 22:27:01.123 CST [949] ERROR:  message` (default prefix `%m [%p] `). */
const LINE_PATTERN =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)(?: ([A-Za-z]{2,5}|[+-]\d{2}(?::?\d{2})?))? \[(\d+)\][^A-Z]*?\b(LOG|ERROR|WARNING|FATAL|PANIC|NOTICE|INFO|DEBUG\d?|DETAIL|HINT|STATEMENT|CONTEXT|LOCATION|QUERY):\s+(.*)$/;
const ATTACHED_SEVERITIES = new Set([
  "DETAIL",
  "HINT",
  "STATEMENT",
  "CONTEXT",
  "LOCATION",
  "QUERY",
]);

export interface PostgresLogEvent {
  timestamp: string;
  level: "error" | "warn" | "info";
  severity: string;
  message: string;
  service: "postgres";
  environment: "local";
  pid: number;
  detail?: string;
  hint?: string;
  statement?: string;
  context?: string;
}

function toLevel(severity: string): PostgresLogEvent["level"] {
  if (severity === "ERROR" || severity === "FATAL" || severity === "PANIC") {
    return "error";
  }
  return severity === "WARNING" ? "warn" : "info";
}

function toTimestamp(stamp: string, zone: string | undefined, fallback: Date) {
  const parsed = new Date(zone ? `${stamp} ${zone}` : stamp.replace(" ", "T"));
  return (Number.isNaN(parsed.getTime()) ? fallback : parsed).toISOString();
}

/**
 * Parses complete log lines into evlog-style events. DETAIL/HINT/STATEMENT
 * lines (and tab-indented continuations) are attached to the event they
 * belong to instead of becoming events of their own.
 */
export function parsePostgresLogLines(
  lines: string[],
  now: Date = new Date(),
): PostgresLogEvent[] {
  const events: PostgresLogEvent[] = [];
  let last: PostgresLogEvent | null = null;
  let lastField: "message" | "detail" | "hint" | "statement" | "context" =
    "message";

  for (const line of lines) {
    if (line.trim() === "") continue;

    const match = LINE_PATTERN.exec(line);

    if (!match) {
      // Continuation of a multi-line message or statement.
      if (last) {
        last[lastField] =
          `${last[lastField] ?? ""}\n${line.replace(/^\t/, "")}`;
      }
      continue;
    }

    const [, stamp, zone, pid, severity, message] = match as unknown as [
      string,
      string,
      string | undefined,
      string,
      string,
      string,
    ];

    if (ATTACHED_SEVERITIES.has(severity) && last && last.pid === Number(pid)) {
      const field =
        severity === "DETAIL"
          ? "detail"
          : severity === "HINT"
            ? "hint"
            : severity === "STATEMENT" || severity === "QUERY"
              ? "statement"
              : "context";
      last[field] = message;
      lastField = field;
      continue;
    }

    last = {
      environment: "local",
      level: toLevel(severity),
      message,
      pid: Number(pid),
      service: "postgres",
      severity,
      timestamp: toTimestamp(stamp, zone, now),
    };
    lastField = "message";
    events.push(last);
  }

  return events;
}

function isLocalHost(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Finds the server's log file. Only works for servers on this machine:
 * the logging collector's current file when it is on, otherwise the usual
 * Homebrew locations (where launchd writes the server's stderr).
 */
export async function findPostgresLogFile(
  executor: Executor,
  connectionUrl: string,
  fileExists: (path: string) => boolean = existsSync,
): Promise<string> {
  if (!isLocalHost(connectionUrl)) {
    throw new SetupError(
      "log-not-found",
      "Server logs can only be read for PostgreSQL running on this computer.",
    );
  }

  const [error, rows] = await executor.execute(
    asQuery<{ current: string | null; data_dir: string | null; major: number }>(
      `select pg_current_logfile() as current,
              current_setting('data_directory', true) as data_dir,
              current_setting('server_version_num')::int / 10000 as major`,
    ),
  );

  if (error) throw error;

  const [settings] = rows;
  const dataDir = settings?.data_dir ?? null;
  const candidates: string[] = [];

  // The logging collector's file lives in this server's data directory, which
  // only exists on this machine when the server runs here (not in Docker).
  if (settings?.current && dataDir) {
    candidates.push(
      isAbsolute(settings.current)
        ? settings.current
        : join(dataDir, settings.current),
    );
  }

  // Homebrew's launchd log only belongs to this server when its data
  // directory is Homebrew's (another local server on the same port range,
  // e.g. Docker, must not pick it up).
  for (const prefix of ["/opt/homebrew/var", "/usr/local/var"]) {
    if (!dataDir?.startsWith(`${prefix}/`)) continue;

    const logRoot = join(prefix, "log");
    if (settings?.major) {
      candidates.push(join(logRoot, `postgresql@${settings.major}.log`));
    }
    candidates.push(
      join(logRoot, "postgres.log"),
      join(logRoot, "postgresql.log"),
    );
  }

  const found = candidates.find((candidate) => fileExists(candidate));

  if (!found) {
    throw new SetupError(
      "log-not-found",
      "Could not find this server's log file on this computer. For a local server, turn on logging_collector in postgresql.conf and restart PostgreSQL. Servers in Docker or elsewhere write their logs outside this computer.",
    );
  }

  return found;
}

/** Creates `postgres-logs` as an evlog stream (same profile as app events). */
export async function installServerLogsStream(
  serverUrl: string,
): Promise<string> {
  const streamUrl = new URL(
    `/v1/stream/${SERVER_LOGS_STREAM_NAME}`,
    serverUrl,
  ).toString();
  const headers = { connection: "close", "content-type": "application/json" };
  const created = await fetch(streamUrl, { headers, method: "PUT" });

  if (!created.ok && created.status !== 409) {
    throw new Error(
      `Failed to create ${SERVER_LOGS_STREAM_NAME}: HTTP ${created.status}`,
    );
  }

  const profiled = await fetch(`${streamUrl}/_profile`, {
    body: JSON.stringify({
      apiVersion: "durable.streams/profile/v1",
      profile: { kind: "evlog" },
    }),
    headers,
    method: "POST",
  });

  if (!profiled.ok) {
    throw new Error(
      `Failed to configure ${SERVER_LOGS_STREAM_NAME}: HTTP ${profiled.status} ${await profiled.text().catch(() => "")}`,
    );
  }

  return streamUrl;
}

export interface ServerLogsSession {
  logFile: string;
  stop(): Promise<void>;
}

/**
 * Follows the log file from its current end (older lines are not imported)
 * and appends new lines to `postgres-logs`. Handles truncation and rotation
 * by starting over from the beginning of the new file.
 */
export async function startServerLogs(args: {
  logFile: string;
  streamsServerUrl: string;
  pollIntervalMs?: number;
}): Promise<ServerLogsSession> {
  const streamUrl = await installServerLogsStream(args.streamsServerUrl);
  const appender = createStreamAppender(streamUrl, "server-logs");
  let offset = (await stat(args.logFile)).size;
  let carry = "";
  let stopped = false;
  let reading = Promise.resolve();

  const readNew = async () => {
    let size: number;

    try {
      size = (await stat(args.logFile)).size;
    } catch {
      return;
    }

    if (size < offset) {
      offset = 0;
      carry = "";
    }

    if (size === offset) return;

    const length = Math.min(size - offset, MAX_READ_BYTES);
    const handle = await open(args.logFile, "r");

    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      offset += length;
      const text = carry + buffer.toString("utf8");
      const lines = text.split("\n");
      carry = lines.pop() ?? "";
      appender.push(parsePostgresLogLines(lines));
    } finally {
      await handle.close();
    }
  };

  const timer = setInterval(() => {
    if (stopped) return;
    reading = reading.then(readNew).catch((error: unknown) => {
      console.error("[server-logs] read failed", error);
    });
  }, args.pollIntervalMs ?? POLL_INTERVAL_MS);

  return {
    logFile: args.logFile,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await reading;
      await appender.close();
    },
  };
}
