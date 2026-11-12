import type { ExecuteOptions } from "./executor";
import type { Either } from "./type-utils";

/** One connection to the database as the server currently sees it. */
export interface StudioDatabaseSession {
  /** Server process/connection id; used to cancel its running query. */
  id: string;
  user: string | null;
  application: string | null;
  clientAddress: string | null;
  /** e.g. `active`, `idle`, `idle in transaction`. */
  state: string | null;
  /** Current (or last, when idle) statement. */
  query: string | null;
  /** Unix ms when the current/last statement started. */
  queryStartedAt: number | null;
  /** What the session is waiting on, e.g. `Lock: transactionid`. */
  waitEvent: string | null;
  /** The session belongs to Studio itself. */
  isStudio: boolean;
}

export interface StudioDatabaseActivitySnapshot {
  generatedAt: number;
  pollingIntervalMs?: number;
  /** Whether `cancel` is allowed (e.g. false for read-only connections). */
  canCancel: boolean;
  sessions: StudioDatabaseSession[];
}

/**
 * Optional live view of database sessions, provided by the embedder (usually
 * through the Studio BFF bridge). Studio shows the Activity view only when an
 * adapter exposes it.
 */
export interface StudioDatabaseActivity {
  getSnapshot(
    options?: ExecuteOptions,
  ): Promise<Either<Error, StudioDatabaseActivitySnapshot>>;
  /** Cancels the statement a session is running (not the session itself). */
  cancel(
    sessionId: string,
    options?: ExecuteOptions,
  ): Promise<Either<Error, { cancelled: boolean }>>;
}
