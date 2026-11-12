import { useEffect, useMemo, useRef, useState } from "react";

import { useStudio } from "../studio/context";
import { createStreamReadUrl, encodeStreamOffset } from "./use-stream-events";
import { useStreams } from "./use-streams";

export const PRISMA_WAL_STREAM_NAME = "prisma-wal";
export const LIVE_TABLE_POLL_INTERVAL_MS = 2_000;

export interface UseLiveTableRefreshArgs {
  /** The table shown in the grid, or undefined when no table is open. */
  table: { schema: string; name: string } | undefined;
  /**
   * True while a refresh would get in the way: a cell editor is open, there
   * are staged (unsaved) changes, or a write is in flight. Changes that
   * arrive meanwhile are applied as soon as it turns false.
   */
  isBlocked: boolean;
  /** Reloads the table's rows. */
  refresh: () => Promise<unknown>;
}

export interface UseLiveTableRefreshResult {
  /** True when the database's change history (`prisma-wal`) is available. */
  isLive: boolean;
  /** True while changes to this table are waiting for an edit to finish. */
  hasPendingChanges: boolean;
}

interface WalRecord {
  type?: unknown;
}

/** Whether any `prisma-wal` record in the batch belongs to `tableName`. */
export function walRecordsTouchTable(
  records: unknown,
  tableName: string,
): boolean {
  return (
    Array.isArray(records) &&
    records.some(
      (record) =>
        record != null &&
        typeof record === "object" &&
        (record as WalRecord).type === tableName,
    )
  );
}

/**
 * Keeps the open table in sync with the database: when `prisma-wal` grows
 * and the new records touch this table, the rows are reloaded. The stream's
 * position comes from the shared `useStreams` listing (polled while
 * `prisma-wal` exists); only the records appended since the last position
 * are read, so changes to other tables don't reload the grid.
 */
export function useLiveTableRefresh(
  args: UseLiveTableRefreshArgs,
): UseLiveTableRefreshResult {
  const { table, isBlocked, refresh } = args;
  const { streamsUrl } = useStudio();
  const [isPolling, setIsPolling] = useState(false);
  const { streams } = useStreams({
    refreshIntervalMs: isPolling ? LIVE_TABLE_POLL_INTERVAL_MS : undefined,
  });
  const walStream = useMemo(
    () => streams.find((stream) => stream.name === PRISMA_WAL_STREAM_NAME),
    [streams],
  );
  const isLive = walStream != null && table != null;
  const tableName = table ? `${table.schema}.${table.name}` : null;
  // `next_offset` is the stream's event count; reads take encoded offsets.
  const position = walStream
    ? `${walStream.epoch}:${walStream.nextOffset}`
    : null;
  const lastPositionRef = useRef<{
    table: string;
    epoch: number;
    count: bigint;
  } | null>(null);
  const refreshRef = useRef(refresh);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  refreshRef.current = refresh;

  useEffect(() => {
    setIsPolling(isLive);
  }, [isLive]);

  // A different table starts from the stream's current position.
  useEffect(() => {
    setHasPendingChanges(false);
  }, [tableName]);

  useEffect(() => {
    if (!tableName || position == null) {
      lastPositionRef.current = null;
      return;
    }

    const [epochText = "0", countText = "0"] = position.split(":");
    let count: bigint;

    try {
      count = BigInt(countText);
    } catch {
      return;
    }

    const epoch = Number(epochText);
    const previous = lastPositionRef.current;
    lastPositionRef.current = { count, epoch, table: tableName };

    // First sight, another table, a recreated stream, or nothing new.
    if (
      !previous ||
      previous.table !== tableName ||
      previous.epoch !== epoch ||
      count <= previous.count
    ) {
      return;
    }

    const url = createStreamReadUrl(
      streamsUrl,
      PRISMA_WAL_STREAM_NAME,
      previous.count > 0n
        ? encodeStreamOffset(epoch, previous.count - 1n)
        : "-1",
    );

    if (!url) return;

    // Not aborted when the position moves again: every batch must be read.
    void fetch(url)
      .then(async (response) =>
        response.ok ? ((await response.json()) as unknown) : [],
      )
      .then((records) => {
        if (
          lastPositionRef.current?.table === tableName &&
          walRecordsTouchTable(records, tableName)
        ) {
          setHasPendingChanges(true);
        }
      })
      .catch(() => {
        // A failed read only means this batch is not applied automatically;
        // the user can still refresh the table by hand.
      });
  }, [position, streamsUrl, tableName]);

  useEffect(() => {
    if (!hasPendingChanges || isBlocked) return;

    setHasPendingChanges(false);
    void Promise.resolve(refreshRef.current()).catch(() => {
      // Errors surface through the rows query like any other refetch.
    });
  }, [hasPendingChanges, isBlocked]);

  return { hasPendingChanges, isLive };
}
