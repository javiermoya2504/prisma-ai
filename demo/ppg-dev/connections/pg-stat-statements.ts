import type { Executor } from "../../../data/executor";
import { asQuery } from "../../../data/query";
import type {
  StudioQueryInsightQuery,
  StudioQueryInsightsSnapshot,
  StudioQueryInsightsSnapshotRequest,
} from "../../../data/query-insights";
import { extractTablesFromSql, shouldRecordQuery } from "../query-insights";
import { STUDIO_SQL_MARKER } from "./pg-activity";
import { SetupError } from "./setup-error";

const MAX_ROWS = 500;
const POLLING_INTERVAL_MS = 5_000;

interface StatementRow {
  id: string;
  query: string;
  calls: string | number;
  mean_ms: string | number;
  min_ms: string | number;
  max_ms: string | number;
  rows: string | number;
  reads: string | number;
}

async function run<T>(
  executor: Executor,
  sql: string,
  parameters: unknown[] = [],
) {
  const [error, rows] = await executor.execute({
    ...asQuery<T>(sql),
    parameters,
  } as never);
  if (error) throw error;
  return rows as T[];
}

/**
 * Makes sure `pg_stat_statements` can be read on this database: the library
 * must be preloaded by the server (a restart the user has to do) and the
 * extension must exist in the database (created here when possible).
 */
export async function prepareQueryInsights(executor: Executor): Promise<void> {
  const [preload] = await run<{ shared_preload_libraries: string }>(
    executor,
    "show shared_preload_libraries",
  );
  const libraries = (preload?.shared_preload_libraries ?? "")
    .split(",")
    .map((library) => library.trim().replace(/^"|"$/g, ""));

  if (!libraries.includes("pg_stat_statements")) {
    throw new SetupError(
      "preload",
      "Query insights need the pg_stat_statements library, which PostgreSQL only loads at startup.",
    );
  }

  try {
    // Kept out of the user's schemas so its views don't show up as tables.
    if (!(await findExtensionSchema(executor))) {
      await run(
        executor,
        `create ${STUDIO_SQL_MARKER} schema if not exists ${MONITORING_SCHEMA}`,
      );
      await run(
        executor,
        `create ${STUDIO_SQL_MARKER} extension pg_stat_statements schema ${MONITORING_SCHEMA}`,
      );
    }
  } catch (error: unknown) {
    throw new SetupError(
      "permission",
      `Could not create the pg_stat_statements extension: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const schema = await findExtensionSchema(executor);
  await run(
    executor,
    `select ${STUDIO_SQL_MARKER} 1 from ${quoteIdent(schema!)}.pg_stat_statements limit 1`,
  );
}

/** Schema Studio creates the extension in when the database lacks it. */
export const MONITORING_SCHEMA = "studio_monitoring";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function findExtensionSchema(executor: Executor): Promise<string | null> {
  const [row] = await run<{ schema: string }>(
    executor,
    `select ${STUDIO_SQL_MARKER} n.nspname as schema
       from pg_extension e
       join pg_namespace n on n.oid = e.extnamespace
      where e.extname = 'pg_stat_statements'`,
  );
  return row?.schema ?? null;
}

/** Statements that only read system catalogs (Studio's own monitoring). */
function isSystemOnly(tables: string[]): boolean {
  return (
    tables.length > 0 &&
    tables.every(
      (table) =>
        table.startsWith("information_schema.") ||
        (table.split(".").at(-1) ?? "").startsWith("pg_"),
    )
  );
}

/**
 * Query insights for a saved PostgreSQL connection, read from
 * `pg_stat_statements` (already parameterized SQL, aggregated by query id).
 * It has no "last executed" column, so `lastSeen` is when Studio first
 * observed the query or its call count growing.
 */
export function createPgStatStatementsInsights(now: () => number = Date.now) {
  const observed = new Map<string, { calls: number; lastSeen: number }>();

  return {
    async getSnapshot(
      executor: Executor,
      request: StudioQueryInsightsSnapshotRequest,
    ): Promise<StudioQueryInsightsSnapshot> {
      const generatedAt = now();
      const limit = Math.min(
        Number.isSafeInteger(request.limit) && (request.limit ?? 0) > 0
          ? request.limit!
          : MAX_ROWS,
        MAX_ROWS,
      );
      const schema = (await findExtensionSchema(executor)) ?? "public";
      const rows = await run<StatementRow>(
        executor,
        `select ${STUDIO_SQL_MARKER} s.queryid::text as id,
                s.query,
                s.calls,
                s.mean_exec_time as mean_ms,
                s.min_exec_time as min_ms,
                s.max_exec_time as max_ms,
                s.rows,
                s.shared_blks_hit + s.shared_blks_read as reads
           from ${quoteIdent(schema)}.pg_stat_statements s
           join pg_database d on d.oid = s.dbid
          where d.datname = current_database()
            and s.toplevel
          order by s.total_exec_time desc
          limit $1`,
        [MAX_ROWS],
      );

      const queries: StudioQueryInsightQuery[] = [];

      for (const row of rows) {
        // Skip Studio's own catalog/introspection traffic and utility statements.
        if (
          !row.id ||
          row.query.includes(STUDIO_SQL_MARKER) ||
          !shouldRecordQuery(row.query)
        ) {
          continue;
        }

        // Utility statements and session/timezone probes.
        if (
          /^\s*(set|show|begin|commit|rollback|deallocate)\b/i.test(
            row.query,
          ) ||
          /^\s*select current_setting\(/i.test(row.query)
        ) {
          continue;
        }

        const tables = extractTablesFromSql(row.query);
        if (isSystemOnly(tables)) continue;

        const calls = Number(row.calls);
        const previous = observed.get(row.id);
        const lastSeen =
          previous && previous.calls === calls
            ? previous.lastSeen
            : generatedAt;
        observed.set(row.id, { calls, lastSeen });

        if (request.since != null && lastSeen < request.since) continue;

        queries.push({
          count: calls,
          duration: Number(row.mean_ms),
          id: row.id,
          lastSeen,
          maxDurationMs: Number(row.max_ms),
          minDurationMs: Number(row.min_ms),
          query: row.query,
          reads: Number(row.reads),
          rowsReturned: Number(row.rows),
          tables,
        });

        if (queries.length >= limit) break;
      }

      return { generatedAt, pollingIntervalMs: POLLING_INTERVAL_MS, queries };
    },
  };
}
