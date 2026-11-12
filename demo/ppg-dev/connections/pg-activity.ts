import type {
  StudioDatabaseActivitySnapshot,
  StudioDatabaseSession,
} from "../../../data/database-activity";
import type { Executor } from "../../../data/executor";
import { asQuery } from "../../../data/query";

/** `application_name` Studio uses on its own PostgreSQL sessions. */
export const STUDIO_APPLICATION_NAME = "Prisma Studio";

/**
 * Marker for Studio's own monitoring SQL, placed right after `select`:
 * pg_stat_statements drops leading comments but keeps inner ones, so query
 * insights can leave Studio's traffic out of the user's list.
 */
export const STUDIO_SQL_MARKER = "/* prisma-studio */";

const POLLING_INTERVAL_MS = 2_000;

interface ActivityRow {
  id: string;
  user: string | null;
  application: string | null;
  client_address: string | null;
  state: string | null;
  query: string | null;
  query_started_at: string | number | null;
  wait_event: string | null;
  is_self: boolean;
}

async function run<T>(
  executor: Executor,
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  const [error, rows] = await executor.execute({
    ...asQuery<T>(sql),
    parameters,
  } as never);
  if (error) throw error;
  return rows as T[];
}

/** Client sessions connected to the current database (`pg_stat_activity`). */
export async function getPostgresActivity(
  executor: Executor,
  options: { canCancel: boolean; now?: () => number },
): Promise<StudioDatabaseActivitySnapshot> {
  const rows = await run<ActivityRow>(
    executor,
    `select ${STUDIO_SQL_MARKER} pid::text as id,
            usename as "user",
            nullif(application_name, '') as application,
            client_addr::text as client_address,
            state,
            nullif(query, '') as query,
            (extract(epoch from query_start) * 1000)::bigint as query_started_at,
            case when wait_event is not null
              then wait_event_type || ': ' || wait_event end as wait_event,
            pid = pg_backend_pid() as is_self
       from pg_stat_activity
      where datname = current_database()
        and backend_type = 'client backend'
      order by (state = 'active') desc, query_start nulls last`,
  );

  const sessions: StudioDatabaseSession[] = rows.map((row) => ({
    application: row.application,
    clientAddress: row.client_address,
    id: row.id,
    isStudio: row.is_self || row.application === STUDIO_APPLICATION_NAME,
    query: row.query,
    queryStartedAt:
      row.query_started_at == null ? null : Number(row.query_started_at),
    state: row.state,
    user: row.user,
    waitEvent: row.wait_event,
  }));

  return {
    canCancel: options.canCancel,
    generatedAt: (options.now ?? Date.now)(),
    pollingIntervalMs: POLLING_INTERVAL_MS,
    sessions,
  };
}

/**
 * Cancels the statement a session in the current database is running.
 * Returns false when the session no longer exists there.
 */
export async function cancelPostgresQuery(
  executor: Executor,
  sessionId: string,
): Promise<boolean> {
  if (!/^\d+$/.test(sessionId)) throw new Error("Invalid session id.");

  const rows = await run<{ cancelled: boolean }>(
    executor,
    `select ${STUDIO_SQL_MARKER} pg_cancel_backend(pid) as cancelled
       from pg_stat_activity
      where pid = $1 and datname = current_database()`,
    [Number(sessionId)],
  );

  return rows[0]?.cancelled === true;
}
