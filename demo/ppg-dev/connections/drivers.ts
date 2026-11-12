import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { createPool } from "mysql2/promise";
import postgres from "postgres";

import type { StudioBFFSqlLintResult } from "../../../data/bff";
import type { Executor } from "../../../data/executor";
import { createMySQL2Executor } from "../../../data/mysql2";
import { createNodeSQLiteExecutor } from "../../../data/node-sqlite";
import {
  createPostgresJSConnectionConfig,
  createPostgresJSExecutor,
} from "../../../data/postgresjs";
import { asQuery } from "../../../data/query";
import { lintPostgresSql } from "../sql-lint";
import type { DatabaseKind, StoredConnection } from "./settings";

const CONNECT_TIMEOUT_SECONDS = 5;

export interface OpenConnection {
  kind: DatabaseKind;
  executor: Executor;
  /** Server-side lint; omitted kinds fall back to EXPLAIN in the adapter. */
  lintSql?: (args: {
    schema?: string;
    schemaVersion?: string;
    sql: string;
  }) => Promise<StudioBFFSqlLintResult>;
  close(): Promise<void>;
}

export type OpenConnectionFn = (
  connection: Pick<StoredConnection, "kind" | "url">,
) => OpenConnection;

export const openDatabaseConnection: OpenConnectionFn = (connection) => {
  switch (connection.kind) {
    case "postgres": {
      const config = createPostgresJSConnectionConfig(connection.url);
      const client = postgres(config.connectionString, {
        ...config.options,
        connect_timeout: CONNECT_TIMEOUT_SECONDS,
        max: 4,
        onnotice: () => {},
      });

      return {
        kind: "postgres",
        executor: createPostgresJSExecutor(client),
        lintSql: (args) => lintPostgresSql({ ...args, postgresClient: client }),
        close: () => client.end({ timeout: 5 }),
      };
    }
    case "mysql": {
      const pool = createPool({
        connectTimeout: CONNECT_TIMEOUT_SECONDS * 1000,
        connectionLimit: 4,
        uri: connection.url,
      });

      return {
        kind: "mysql",
        executor: createMySQL2Executor(pool),
        close: () => pool.end(),
      };
    }
    case "sqlite": {
      // DatabaseSync creates missing files; never create one by accident.
      if (!existsSync(connection.url) || !statSync(connection.url).isFile()) {
        throw new Error(`SQLite file not found: ${connection.url}`);
      }

      const database = new DatabaseSync(connection.url);

      return {
        kind: "sqlite",
        executor: createNodeSQLiteExecutor(database),
        close: () => {
          database.close();
          return Promise.resolve();
        },
      };
    }
  }
};

/** Opens a connection, runs a trivial query, and closes it again. */
export async function testDatabaseConnection(
  connection: Pick<StoredConnection, "kind" | "url">,
  open: OpenConnectionFn = openDatabaseConnection,
): Promise<void> {
  const opened = open(connection);

  try {
    const [error] = await opened.executor.execute(asQuery("select 1 as ok"));

    if (error) throw error;
  } finally {
    await opened.close().catch(() => {});
  }
}

/** Keeps one open connection per saved connection id. */
export function createConnectionPool(open: OpenConnectionFn) {
  const openConnections = new Map<
    string,
    { url: string; connection: OpenConnection }
  >();

  return {
    get(connection: StoredConnection): OpenConnection {
      const existing = openConnections.get(connection.id);

      if (existing && existing.url === connection.url) {
        return existing.connection;
      }

      const opened = open(connection);
      openConnections.set(connection.id, {
        connection: opened,
        url: connection.url,
      });
      return opened;
    },
    async close(id: string) {
      const existing = openConnections.get(id);
      openConnections.delete(id);
      await existing?.connection.close().catch(() => {});
    },
    async closeAll() {
      const ids = [...openConnections.keys()];
      await Promise.all(ids.map((id) => this.close(id)));
    },
  };
}
