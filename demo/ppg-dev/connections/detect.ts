import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { Socket } from "node:net";
import { homedir, userInfo } from "node:os";
import { extname, join } from "node:path";

import { asQuery } from "../../../data/query";
import { type OpenConnectionFn, openDatabaseConnection } from "./drivers";
import {
  buildConnectionUrl,
  type DatabaseKind,
  defaultConnectionName,
  detectKindFromUrl,
  maskConnectionUrl,
} from "./settings";

export interface DetectedDatabase {
  id: string;
  kind: DatabaseKind;
  name: string;
  displayUrl: string;
  /** Where it was found, shown to the user. */
  origin: "port" | "file" | "env";
  /** True when it can be connected without asking for credentials. */
  ready: boolean;
  /** Prefill for the "Add connection" form when credentials are needed. */
  prefill?: { host: string; port: number; user?: string };
}

/** Detected entry plus the server-only URL used when it is connected. */
export interface DetectionResult extends DetectedDatabase {
  url: string;
}

export interface DetectDependencies {
  env?: NodeJS.ProcessEnv;
  isPortOpen?: (host: string, port: number) => Promise<boolean>;
  listDatabases?: (
    kind: "postgres" | "mysql",
    url: string,
  ) => Promise<string[]>;
  findSqliteFiles?: (dirs: string[]) => Promise<string[]>;
  sqliteScanDirs?: string[];
  excludeUrls?: string[];
}

const POSTGRES_PORTS = [5432, 5433, 5434];
const MYSQL_PORTS = [3306, 3307];
const LOCAL_HOST = "localhost";
const SQLITE_EXTENSIONS = new Set([".db", ".db3", ".sqlite", ".sqlite3"]);
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".cache",
  ".Trash",
  "Library",
  "build",
  "dist",
  "node_modules",
  "vendor",
]);
const MYSQL_SYSTEM_DATABASES = new Set([
  "information_schema",
  "mysql",
  "performance_schema",
  "sys",
]);

function detectionId(kind: DatabaseKind, url: string): string {
  return `detected-${createHash("sha256").update(`${kind}:${url}`).digest("hex").slice(0, 16)}`;
}

function toResult(
  args: Omit<DetectionResult, "id" | "displayUrl">,
): DetectionResult {
  return {
    ...args,
    displayUrl: maskConnectionUrl(args.kind, args.url),
    id: detectionId(args.kind, args.url),
  };
}

export function isPortOpen(
  host: string,
  port: number,
  timeoutMs = 400,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

export async function listDatabases(
  kind: "postgres" | "mysql",
  url: string,
  openConnection: OpenConnectionFn = openDatabaseConnection,
): Promise<string[]> {
  const connection = openConnection({ kind, url });

  try {
    const sql =
      kind === "postgres"
        ? "select datname as name from pg_database where not datistemplate and datallowconn order by 1"
        : "select schema_name as name from information_schema.schemata order by 1";
    const [error, rows] = await connection.executor.execute(
      asQuery<{ name: string }>(sql),
    );

    if (error) throw error;

    return rows
      .map((row) => String(row.name ?? (row as Record<string, unknown>).NAME))
      .filter(
        (name) => kind === "postgres" || !MYSQL_SYSTEM_DATABASES.has(name),
      );
  } finally {
    await connection.close().catch(() => {});
  }
}

async function hasSqliteHeader(file: string): Promise<boolean> {
  try {
    const handle = await open(file, "r");

    try {
      const buffer = Buffer.alloc(16);
      await handle.read(buffer, 0, 16, 0);
      return buffer.toString("latin1") === "SQLite format 3\0";
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Shallow, bounded walk for SQLite files under the given directories. */
export async function findSqliteFiles(
  dirs: string[],
  options: { maxDepth?: number; maxEntries?: number; maxFiles?: number } = {},
): Promise<string[]> {
  const { maxDepth = 4, maxEntries = 20_000, maxFiles = 50 } = options;
  const found: string[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || visited > maxEntries || found.length >= maxFiles) {
      return;
    }

    let entries;

    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      visited += 1;

      if (visited > maxEntries || found.length >= maxFiles) return;

      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (
          !SKIPPED_DIRECTORIES.has(entry.name) &&
          !entry.name.startsWith(".")
        ) {
          await walk(path, depth + 1);
        }
      } else if (
        entry.isFile() &&
        SQLITE_EXTENSIONS.has(extname(entry.name).toLowerCase()) &&
        (await hasSqliteHeader(path))
      ) {
        found.push(path);
      }
    }
  }

  for (const dir of dirs) await walk(dir, 0);

  return found;
}

export function defaultSqliteScanDirs(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.STUDIO_SQLITE_SCAN_DIRS?.split(":").filter(Boolean);

  if (configured?.length) return configured;

  const home = homedir();

  return ["Github", "GitHub", "Projects", "Developer", "code", "dev", "Desktop"]
    .map((name) => join(home, name))
    .concat(process.cwd());
}

function currentOsUser(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

/**
 * Looks for databases on this machine: Postgres/MySQL servers on their default
 * local ports (trying password-less local users), SQLite files in common
 * project folders, and DATABASE_URL. Nothing is saved until the user connects.
 */
export async function detectLocalDatabases(
  dependencies: DetectDependencies = {},
): Promise<DetectionResult[]> {
  const env = dependencies.env ?? process.env;
  const portOpen = dependencies.isPortOpen ?? isPortOpen;
  const list = dependencies.listDatabases ?? listDatabases;
  const findFiles = dependencies.findSqliteFiles ?? findSqliteFiles;
  const excluded = new Set(dependencies.excludeUrls ?? []);
  const results: DetectionResult[] = [];

  async function detectServer(
    kind: "postgres" | "mysql",
    port: number,
    users: string[],
  ) {
    if (!(await portOpen(LOCAL_HOST, port))) return [];

    for (const user of users) {
      const serverUrl = buildConnectionUrl({
        database: kind === "postgres" ? "postgres" : undefined,
        host: LOCAL_HOST,
        kind,
        port,
        user,
      });

      try {
        const databases = await list(kind, serverUrl);

        return databases.map((database) => {
          const url = buildConnectionUrl({
            database,
            host: LOCAL_HOST,
            kind,
            port,
            user,
          });

          return toResult({
            kind,
            name: defaultConnectionName(kind, url),
            origin: "port",
            ready: true,
            url,
          });
        });
      } catch {
        // Try the next user; fall through to a credentials prompt.
      }
    }

    const url = buildConnectionUrl({ host: LOCAL_HOST, kind, port });

    return [
      toResult({
        kind,
        name: `${kind === "postgres" ? "PostgreSQL" : "MySQL"} on ${LOCAL_HOST}:${port}`,
        origin: "port",
        prefill: { host: LOCAL_HOST, port, user: users.at(-1) },
        ready: false,
        url,
      }),
    ];
  }

  const osUser = currentOsUser();
  const postgresUsers = [
    ...new Set([osUser, "postgres"].filter(Boolean)),
  ] as string[];
  const tasks: Array<Promise<DetectionResult[]>> = [
    ...POSTGRES_PORTS.map((port) =>
      detectServer("postgres", port, postgresUsers),
    ),
    ...MYSQL_PORTS.map((port) => detectServer("mysql", port, ["root"])),
    findFiles(dependencies.sqliteScanDirs ?? defaultSqliteScanDirs(env)).then(
      (files) =>
        files.map((file) =>
          toResult({
            kind: "sqlite",
            name: defaultConnectionName("sqlite", file),
            origin: "file",
            ready: true,
            url: file,
          }),
        ),
    ),
  ];

  const envUrl = env.DATABASE_URL?.trim();
  const envKind = envUrl ? detectKindFromUrl(envUrl) : null;

  if (envUrl && envKind) {
    try {
      const url = buildConnectionUrl({ kind: envKind, url: envUrl });
      results.push(
        toResult({
          kind: envKind,
          name: `DATABASE_URL (${defaultConnectionName(envKind, url)})`,
          origin: "env",
          ready: true,
          url,
        }),
      );
    } catch {
      // Ignore malformed DATABASE_URL values.
    }
  }

  for (const settled of await Promise.allSettled(tasks)) {
    if (settled.status === "fulfilled") results.push(...settled.value);
  }

  const seen = new Set<string>();

  return results.filter((result) => {
    if (excluded.has(result.url) || seen.has(result.id)) return false;
    seen.add(result.id);
    return true;
  });
}

export function toDetectedDatabase(result: DetectionResult): DetectedDatabase {
  const { url: _url, ...rest } = result;
  return rest;
}
