import postgres, { type Sql } from "postgres";

import { createPostgresJSConnectionConfig } from "../../../data/postgresjs";
import { SetupError } from "./setup-error";
import { createStreamAppender } from "./streams-hub";

/** Publication created in the user's database while live history is on. */
export const LIVE_HISTORY_PUBLICATION = "prisma_studio_history";
/** Studio's table/row history affordances look for exactly this stream. */
export const WAL_STREAM_NAME = "prisma-wal";

const JSON_HEADERS = {
  connection: "close",
  "content-type": "application/json",
};

/** Same profile and schema `@prisma/dev` installs for its `prisma-wal`. */
const WAL_STREAM_PROFILE = {
  apiVersion: "durable.streams/profile/v1",
  profile: {
    kind: "state-protocol",
    touch: { enabled: true, onMissingBefore: "coarse" },
  },
};

const WAL_STREAM_SCHEMA = {
  apiVersion: "durable.streams/schema-registry/v1",
  schema: {
    additionalProperties: true,
    properties: {
      headers: {
        properties: {
          operation: { type: "string" },
          timestamp: { format: "date-time", type: "string" },
        },
        required: ["timestamp", "operation"],
        type: "object",
      },
      key: { type: "string" },
      type: { type: "string" },
    },
    required: ["type", "key", "headers"],
    type: "object",
  },
  search: {
    aliases: { rowKey: "key", table: "type" },
    fields: {
      eventTime: {
        bindings: [{ jsonPointer: "/headers/timestamp", version: 1 }],
        column: true,
        exact: true,
        exists: true,
        kind: "date",
        sortable: true,
      },
      key: {
        bindings: [{ jsonPointer: "/key", version: 1 }],
        exact: true,
        exists: true,
        kind: "keyword",
      },
      operation: {
        bindings: [{ jsonPointer: "/headers/operation", version: 1 }],
        exact: true,
        exists: true,
        kind: "keyword",
      },
      type: {
        bindings: [{ jsonPointer: "/type", version: 1 }],
        exact: true,
        exists: true,
        kind: "keyword",
      },
    },
    primaryTimestampField: "eventTime",
  },
};

export interface WalRecord {
  type: string;
  key: string;
  value: Record<string, unknown> | null;
  old_value: Record<string, unknown> | null;
  headers: { operation: "insert" | "update" | "delete"; timestamp: string };
}

interface ChangeInfo {
  command: "insert" | "update" | "delete";
  relation: { schema: string; table: string; keys: Array<{ name: string }> };
  key?: boolean;
  old?: Record<string, unknown> | null;
}

function keyPart(value: unknown): string | null {
  if (value === null) return "null";
  if (value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/** Matches `@prisma/dev`: `value` for one key column, `a=1|b=2` for several. */
function rowKey(
  row: Record<string, unknown> | null,
  keys: Array<{ name: string }>,
): string | null {
  if (!row || keys.length === 0) return null;

  const parts: string[] = [];

  for (const { name } of keys) {
    const part = keyPart(row[name]);
    if (part == null) return null;
    parts.push(keys.length === 1 ? part : `${name}=${part}`);
  }

  return parts.join("|");
}

function onlyKeys(
  row: Record<string, unknown>,
  keys: Array<{ name: string }>,
): Record<string, unknown> {
  return Object.fromEntries(keys.map(({ name }) => [name, row[name]]));
}

/**
 * Converts one logical-replication change (postgres.js `subscribe`) into
 * `prisma-wal` State Protocol records, the same shape `@prisma/dev` writes.
 */
export function toWalRecords(
  row: Record<string, unknown> | null,
  info: ChangeInfo,
  timestamp: string,
  primaryKeys: ReadonlyMap<string, string[]> = new Map(),
): WalRecord[] {
  const type = `${info.relation.schema}.${info.relation.table}`;
  // With REPLICA IDENTITY FULL every column is flagged as an identity
  // column, so rows are keyed by their primary key when the table has one.
  const keys =
    primaryKeys.get(type)?.map((name) => ({ name })) ?? info.relation.keys;

  if (info.command === "insert") {
    const key = rowKey(row, keys);
    return row && key
      ? [
          {
            headers: { operation: "insert", timestamp },
            key,
            old_value: null,
            type,
            value: row,
          },
        ]
      : [];
  }

  if (info.command === "delete") {
    const key = rowKey(row, keys);
    // With the default replica identity only key columns are sent.
    const oldValue = row && info.key ? onlyKeys(row, keys) : row;
    return key
      ? [
          {
            headers: { operation: "delete", timestamp },
            key,
            old_value: oldValue,
            type,
            value: null,
          },
        ]
      : [];
  }

  const newKey = rowKey(row, keys);
  const oldRow = info.old ?? null;
  const oldKey = oldRow ? rowKey(oldRow, keys) : newKey;

  if (!row || !newKey || !oldKey) return [];

  if (oldKey !== newKey) {
    return [
      {
        headers: { operation: "delete", timestamp },
        key: oldKey,
        old_value: info.key && oldRow ? onlyKeys(oldRow, keys) : oldRow,
        type,
        value: null,
      },
      {
        headers: { operation: "insert", timestamp },
        key: newKey,
        old_value: null,
        type,
        value: row,
      },
    ];
  }

  return [
    {
      headers: { operation: "update", timestamp },
      key: newKey,
      // Postgres only sends the previous row with REPLICA IDENTITY FULL.
      old_value: info.key ? null : oldRow,
      type,
      value: row,
    },
  ];
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function openClient(
  url: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
): Sql {
  const config = createPostgresJSConnectionConfig(url);
  return postgres(config.connectionString, {
    ...config.options,
    connect_timeout: 5,
    max: 1,
    onnotice: () => {},
    ...options,
  });
}

/**
 * Tables that can be published without breaking writes: a publication that
 * includes a table without a replica identity makes Postgres reject UPDATE
 * and DELETE on it, so those tables are left out.
 */
export async function listPublishableTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ schema: string; name: string }[]>`
    select n.nspname as schema, c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind = 'r'
      and not c.relispartition
      and n.nspname not in ('pg_catalog', 'information_schema')
      and n.nspname not like 'pg\\_%'
      and (
        c.relreplident in ('f', 'i')
        or (c.relreplident = 'd' and exists (
          select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary
        ))
      )
    order by 1, 2
  `;

  return rows.map((row) => `${quoteIdent(row.schema)}.${quoteIdent(row.name)}`);
}

/** Primary key columns (in key order) of every table, by `schema.table`. */
export async function loadPrimaryKeys(
  url: string,
): Promise<Map<string, string[]>> {
  const sql = openClient(url);

  try {
    const rows = await sql<{ table: string; columns: string[] }[]>`
      select n.nspname || '.' || c.relname as table,
             array_agg(a.attname::text order by k.ordinality) as columns
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_namespace n on n.oid = c.relnamespace
        cross join lateral unnest(i.indkey) with ordinality as k(attnum, ordinality)
        join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
       where i.indisprimary
         and n.nspname not in ('pg_catalog', 'information_schema')
       group by 1
    `;

    return new Map(rows.map((row) => [row.table, row.columns]));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Creates or refreshes the publication with the current publishable tables. */
export async function preparePublication(url: string): Promise<number> {
  const sql = openClient(url);

  try {
    const [{ wal_level: walLevel } = { wal_level: "" }] = await sql<
      { wal_level: string }[]
    >`show wal_level`;

    if (walLevel !== "logical") {
      throw new SetupError(
        "wal-level",
        `Live history needs wal_level = logical (this server uses "${walLevel}").`,
      );
    }

    const tables = await listPublishableTables(sql);

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(
          `drop publication if exists ${quoteIdent(LIVE_HISTORY_PUBLICATION)}`,
        );
        await tx.unsafe(
          `create publication ${quoteIdent(LIVE_HISTORY_PUBLICATION)}${
            tables.length ? ` for table ${tables.join(", ")}` : ""
          }`,
        );
      });
    } catch (error: unknown) {
      throw new SetupError(
        "permission",
        `Could not create the "${LIVE_HISTORY_PUBLICATION}" publication: ${
          error instanceof Error ? error.message : String(error)
        }. The user needs to own the tables (or be a superuser).`,
      );
    }

    return tables.length;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function dropPublication(url: string): Promise<void> {
  const sql = openClient(url);

  try {
    await sql.unsafe(
      `drop publication if exists ${quoteIdent(LIVE_HISTORY_PUBLICATION)}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ensureOk(response: Response, action: string) {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${action}: HTTP ${response.status} ${body}`.trim());
  }
}

/** Creates `prisma-wal` with the profile and schema Studio expects. */
export async function installWalStream(serverUrl: string): Promise<string> {
  const streamUrl = new URL(
    `/v1/stream/${encodeURIComponent(WAL_STREAM_NAME)}`,
    serverUrl,
  ).toString();

  await ensureOk(
    await fetch(streamUrl, { headers: JSON_HEADERS, method: "PUT" }),
    "Failed to create prisma-wal",
  );
  await ensureOk(
    await fetch(`${streamUrl}/_profile`, {
      body: JSON.stringify(WAL_STREAM_PROFILE),
      headers: JSON_HEADERS,
      method: "POST",
    }),
    "Failed to configure prisma-wal",
  );

  const registry = (await (
    await fetch(`${streamUrl}/_schema`, { headers: JSON_HEADERS })
  ).json()) as { currentVersion?: number };

  if (!registry.currentVersion) {
    await ensureOk(
      await fetch(`${streamUrl}/_schema`, {
        body: JSON.stringify(WAL_STREAM_SCHEMA),
        headers: JSON_HEADERS,
        method: "POST",
      }),
      "Failed to install the prisma-wal schema",
    );
  }

  return streamUrl;
}

export interface LiveHistorySession {
  tableCount: number;
  stop(): Promise<void>;
}

/**
 * Streams every committed change of the database into `prisma-wal` on the
 * connection's local Prisma Streams server. Uses a TEMPORARY replication
 * slot, which Postgres drops as soon as this connection ends (including
 * crashes), so a stopped Studio can never make the server retain WAL.
 */
export async function startLiveHistory(args: {
  connectionId: string;
  url: string;
  streamsServerUrl: string;
}): Promise<LiveHistorySession> {
  const tableCount = await preparePublication(args.url);
  const primaryKeys = await loadPrimaryKeys(args.url);
  const streamUrl = await installWalStream(args.streamsServerUrl);
  const appender = createStreamAppender(streamUrl, "live-history");
  const replication = openClient(args.url, {
    publications: LIVE_HISTORY_PUBLICATION,
  });

  try {
    await replication.subscribe(
      "*",
      (row, info) => {
        appender.push(
          toWalRecords(
            row as Record<string, unknown> | null,
            info as unknown as ChangeInfo,
            new Date().toISOString(),
            primaryKeys,
          ),
        );
      },
      () => {},
      () => {
        console.error("[live-history] replication stream error; reconnecting");
      },
    );
  } catch (error: unknown) {
    await replication.end({ timeout: 5 }).catch(() => {});
    throw error;
  }

  return {
    async stop() {
      await replication.end({ timeout: 5 }).catch(() => {});
      await appender.close();
    },
    tableCount,
  };
}
