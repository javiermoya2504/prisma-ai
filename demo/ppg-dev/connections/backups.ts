import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import postgres from "postgres";

import { createPostgresJSConnectionConfig } from "../../../data/postgresjs";
import type { DatabaseKind, StoredConnection } from "./settings";

export interface BackupInfo {
  /** File name inside the connection's backup folder. */
  id: string;
  createdAt: string;
  sizeBytes: number;
  kind: DatabaseKind;
}

const BACKUP_EXTENSIONS: Record<DatabaseKind, string> = {
  mysql: ".sql",
  postgres: ".dump",
  sqlite: ".sqlite",
};

/** `2026-11-11T22-30-05-123Z.dump`; the only names accepted from requests. */
const BACKUP_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.(dump|sql|sqlite)$/;

const TOOL_DIRECTORIES = [
  "/opt/homebrew/bin",
  "/opt/homebrew/opt/libpq/bin",
  "/opt/homebrew/opt/mysql-client/bin",
  "/usr/local/bin",
  "/usr/bin",
];

export function resolveBackupsRoot(env = process.env): string {
  return (
    env.STUDIO_BACKUPS_DIR?.trim() ||
    join(homedir(), ".prisma-studio-ai", "backups")
  );
}

export function isBackupId(value: string): boolean {
  return BACKUP_ID_PATTERN.test(value);
}

function timestampId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function idToDate(id: string): string {
  const stem = id.replace(/\.[a-z]+$/, "");
  const [day, time] = stem.split("T");
  const [hours, minutes, seconds, millis] = (time ?? "")
    .replace("Z", "")
    .split("-");
  return `${day}T${hours}:${minutes}:${seconds}.${millis}Z`;
}

/** Finds a CLI tool on PATH or in the usual Homebrew/system locations. */
export function findTool(name: string, env = process.env): string | null {
  const directories = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    ...TOOL_DIRECTORIES,
  ];

  for (const directory of directories) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function requireTool(name: string, install: string): string {
  const tool = findTool(name);

  if (!tool) {
    throw new Error(`${name} is not installed. Install it with: ${install}`);
  }

  return tool;
}

/** Runs a CLI without a shell; secrets go through env, never argv. */
function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdinFile?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      stdio: [options.stdinFile ? "pipe" : "ignore", "ignore", "pipe"],
    });
    let stderr = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    if (options.stdinFile && child.stdin) {
      void readFile(options.stdinFile)
        .then((data) => {
          child.stdin!.end(data);
        })
        .catch(reject);
    }

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const message = stderr.trim().split("\n").slice(-5).join("\n");
        reject(
          new Error(
            `${basename(command)} failed (exit ${code})${message ? `: ${message}` : ""}`,
          ),
        );
      }
    });
  });
}

/** Splits a connection URL into a password-free URL and the password. */
export function splitPassword(url: string): {
  url: string;
  password: string;
} {
  const parsed = new URL(url);
  const password = decodeURIComponent(parsed.password);
  parsed.password = "";
  return { password, url: parsed.toString() };
}

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

/** `grades_ai_restore_20261111_223005`, kept within identifier limits. */
/** Local wall-clock time, so names match what the user sees on screen. */
function localParts(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    day: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    label: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  };
}

export function restoredDatabaseName(original: string, date = new Date()) {
  const { day, time } = localParts(date);
  const stamp = `${day}_${time}`;
  const suffix = `_restore_${stamp}`;
  const base = (original || "database").replace(/[^\w]/g, "_");
  return `${base.slice(0, 63 - suffix.length)}${suffix}`;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function mysqlArgs(url: string): { args: string[]; password: string } {
  const parsed = new URL(url);
  const args = [`--host=${parsed.hostname}`, `--port=${parsed.port || "3306"}`];

  if (parsed.username) {
    args.push(`--user=${decodeURIComponent(parsed.username)}`);
  }

  return { args, password: decodeURIComponent(parsed.password) };
}

export interface BackupService {
  list(connection: StoredConnection): Promise<BackupInfo[]>;
  create(connection: StoredConnection): Promise<BackupInfo>;
  remove(connection: StoredConnection, id: string): Promise<void>;
  /**
   * Restores into a NEW database/file and returns its connection details.
   * The original database is never touched.
   */
  restore(
    connection: StoredConnection,
    id: string,
  ): Promise<{ name: string; url: string }>;
}

export function createBackupService(
  root: string = resolveBackupsRoot(),
): BackupService {
  const folderFor = (connection: StoredConnection) => join(root, connection.id);

  async function info(
    connection: StoredConnection,
    id: string,
  ): Promise<BackupInfo> {
    const { size } = await stat(join(folderFor(connection), id));
    return {
      createdAt: idToDate(id),
      id,
      kind: connection.kind,
      sizeBytes: size,
    };
  }

  function assertId(id: string) {
    if (!isBackupId(id)) throw new Error("Unknown backup.");
  }

  return {
    async list(connection) {
      let names: string[];

      try {
        names = await readdir(folderFor(connection));
      } catch {
        return [];
      }

      const backups = await Promise.all(
        names.filter(isBackupId).map((id) => info(connection, id)),
      );

      return backups.sort((a, b) => b.id.localeCompare(a.id));
    },

    async create(connection) {
      const folder = folderFor(connection);
      await mkdir(folder, { mode: 0o700, recursive: true });
      const id = `${timestampId()}${BACKUP_EXTENSIONS[connection.kind]}`;
      const file = join(folder, id);

      try {
        if (connection.kind === "postgres") {
          const { password, url } = splitPassword(connection.url);
          await run(
            requireTool("pg_dump", "brew install libpq"),
            [
              "--format=custom",
              "--no-owner",
              "--no-privileges",
              `--file=${file}`,
              `--dbname=${url}`,
            ],
            { env: password ? { PGPASSWORD: password } : {} },
          );
        } else if (connection.kind === "mysql") {
          const { args, password } = mysqlArgs(connection.url);
          await run(
            requireTool("mysqldump", "brew install mysql-client"),
            [
              ...args,
              "--single-transaction",
              "--routines",
              "--triggers",
              `--result-file=${file}`,
              databaseName(connection.url),
            ],
            { env: password ? { MYSQL_PWD: password } : {} },
          );
        } else {
          // VACUUM INTO writes a consistent copy even while the file is in use.
          const database = new DatabaseSync(connection.url, { readOnly: true });
          try {
            database.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
          } finally {
            database.close();
          }
        }
      } catch (error: unknown) {
        await rm(file, { force: true });
        throw error;
      }

      return await info(connection, id);
    },

    async remove(connection, id) {
      assertId(id);
      await rm(join(folderFor(connection), id), { force: true });
    },

    async restore(connection, id) {
      assertId(id);
      const file = join(folderFor(connection), id);

      if (!existsSync(file)) throw new Error("Unknown backup.");

      const when = localParts(new Date(idToDate(id))).label;

      if (connection.kind === "sqlite") {
        const restoresFolder = join(root, "..", "restores");
        await mkdir(restoresFolder, { mode: 0o700, recursive: true });
        const stem = basename(connection.url, extname(connection.url));
        const target = join(restoresFolder, `${restoredDatabaseName(stem)}.db`);
        await copyFile(file, target);
        return { name: `${stem} (restored ${when})`, url: target };
      }

      const original = databaseName(connection.url);
      const targetName = restoredDatabaseName(original);
      const targetUrl = withDatabase(connection.url, targetName);

      if (connection.kind === "postgres") {
        const config = createPostgresJSConnectionConfig(connection.url);
        const admin = postgres(config.connectionString, {
          ...config.options,
          connect_timeout: 5,
          max: 1,
          onnotice: () => {},
        });

        try {
          await admin.unsafe(`create database ${quoteIdent(targetName)}`);
        } finally {
          await admin.end({ timeout: 5 });
        }

        const { password, url } = splitPassword(targetUrl);

        try {
          await run(
            requireTool("pg_restore", "brew install libpq"),
            [
              "--no-owner",
              "--no-privileges",
              "--exit-on-error",
              `--dbname=${url}`,
              file,
            ],
            { env: password ? { PGPASSWORD: password } : {} },
          );
        } catch (error: unknown) {
          const cleanup = postgres(config.connectionString, {
            ...config.options,
            max: 1,
            onnotice: () => {},
          });
          await cleanup
            .unsafe(`drop database if exists ${quoteIdent(targetName)}`)
            .catch(() => {});
          await cleanup.end({ timeout: 5 });
          throw error;
        }
      } else {
        const mysql = requireTool("mysql", "brew install mysql-client");
        const { args, password } = mysqlArgs(connection.url);
        const env = password ? { MYSQL_PWD: password } : {};
        await run(mysql, [...args, "-e", `CREATE DATABASE \`${targetName}\``], {
          env,
        });
        await run(mysql, [...args, targetName], { env, stdinFile: file });
      }

      return { name: `${original} (restored ${when})`, url: targetUrl };
    },
  };
}
