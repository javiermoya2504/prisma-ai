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
import { STUDIO_APPLICATION_NAME, STUDIO_SQL_MARKER } from "./pg-activity";
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
  connection: Pick<StoredConnection, "kind" | "url" | "readOnly">,
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
        connection: {
          application_name: STUDIO_APPLICATION_NAME,
          // Every transaction in read-only sessions is READ ONLY, so writes
          // fail in Postgres itself, not only in the UI.
          ...(connection.readOnly
            ? { default_transaction_read_only: true }
            : {}),
        },
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

      if (connection.readOnly) {
        // Applied to each pooled connection before it serves any query.
        pool.on("connection", (pooled) => {
          void Promise.resolve(
            pooled.query("SET SESSION TRANSACTION READ ONLY"),
          ).catch(() => {});
        });
      }

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

      const database = new DatabaseSync(connection.url, {
        readOnly: connection.readOnly === true,
      });

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
    const [error] = await opened.executor.execute(
      asQuery(`select ${STUDIO_SQL_MARKER} 1 as ok`),
    );

    if (error) throw error;
  } finally {
    await opened.close().catch(() => {});
  }
}

/** Keeps one open connection per saved connection id. */
export function createConnectionPool(open: OpenConnectionFn) {
  const openConnections = new Map<
    string,
    { signature: string; connection: OpenConnection }
  >();
  const signatureOf = (connection: StoredConnection) =>
    `${connection.readOnly === true ? "ro" : "rw"}:${connection.url}`;

  return {
    get(connection: StoredConnection): OpenConnection {
      const existing = openConnections.get(connection.id);
      const signature = signatureOf(connection);

      if (existing?.signature === signature) {
        return existing.connection;
      }

      // URL or read-only mode changed: never keep using the old session.
      void existing?.connection.close().catch(() => {});

      const opened = open(connection);
      openConnections.set(connection.id, { connection: opened, signature });
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
