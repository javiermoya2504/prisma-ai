/**
 * A per-connection feature (live history, query insights, server logs) needs
 * one-time server setup the user has to do; `code` picks the instructions the
 * UI shows.
 */
export type SetupErrorCode =
  "wal-level" | "preload" | "permission" | "log-not-found";

export class SetupError extends Error {
  constructor(
    readonly code: SetupErrorCode,
    message: string,
  ) {
    super(message);
  }
}
