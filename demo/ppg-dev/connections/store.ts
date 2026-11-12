import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isDatabaseKind, type StoredConnection } from "./settings";

export function resolveConnectionsFile(env = process.env): string {
  return (
    env.STUDIO_CONNECTIONS_FILE?.trim() ||
    join(homedir(), ".prisma-studio-ai", "connections.json")
  );
}

export interface ConnectionStore {
  list(): Promise<StoredConnection[]>;
  get(id: string): Promise<StoredConnection | undefined>;
  add(connection: Omit<StoredConnection, "id">): Promise<StoredConnection>;
  remove(id: string): Promise<boolean>;
}

function isStoredConnection(value: unknown): value is StoredConnection {
  if (typeof value !== "object" || value === null) return false;

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.url === "string" &&
    isDatabaseKind(record.kind)
  );
}

/**
 * Saved connections live in a JSON file outside the repository, readable only
 * by the current OS user (0600), because they contain database passwords.
 */
export function createConnectionStore(file: string): ConnectionStore {
  let queue = Promise.resolve();

  async function read(): Promise<StoredConnection[]> {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as {
        connections?: unknown;
      };

      return Array.isArray(parsed.connections)
        ? parsed.connections.filter(isStoredConnection)
        : [];
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function write(connections: StoredConnection[]) {
    await mkdir(dirname(file), { mode: 0o700, recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ connections }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, file);
    await chmod(file, 0o600);
  }

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    list: () => serialize(read),
    get: (id) =>
      serialize(async () => (await read()).find((item) => item.id === id)),
    add: (connection) =>
      serialize(async () => {
        const connections = await read();
        const existing = connections.find(
          (item) =>
            item.kind === connection.kind && item.url === connection.url,
        );

        if (existing) return existing;

        const saved = { ...connection, id: randomUUID() };
        await write([...connections, saved]);
        return saved;
      }),
    remove: (id) =>
      serialize(async () => {
        const connections = await read();
        const next = connections.filter((item) => item.id !== id);

        if (next.length === connections.length) return false;

        await write(next);
        return true;
      }),
  };
}
