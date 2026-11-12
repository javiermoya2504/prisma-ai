import { ArrowRight } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";

export interface WalColumnChange {
  column: string;
  before: unknown;
  after: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The columns an update changed, when its `prisma-wal` record carries the
 * previous row (`old_value`, written for tables with REPLICA IDENTITY FULL).
 * Returns null for inserts, deletes and updates without previous values.
 */
export function getWalColumnChanges(body: unknown): WalColumnChange[] | null {
  if (!isRecord(body)) return null;

  const headers = isRecord(body.headers) ? body.headers : null;

  if (
    headers?.operation !== "update" ||
    !isRecord(body.old_value) ||
    !isRecord(body.value)
  ) {
    return null;
  }

  const before = body.old_value;
  const after = body.value;
  const columns = [...new Set([...Object.keys(before), ...Object.keys(after)])];

  return columns
    .filter((column) => !sameValue(before[column], after[column]))
    .map((column) => ({
      after: after[column],
      before: before[column],
      column,
    }));
}

function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "NULL";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Before → after table for one update in the change history. */
export function WalRowChanges(props: { changes: WalColumnChange[] }) {
  const { changes } = props;

  return (
    <div
      className="mb-3 overflow-hidden rounded-md border border-border"
      data-testid="wal-row-changes"
    >
      {changes.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No column values changed.
        </p>
      ) : (
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="h-8 w-40 text-xs">Column</TableHead>
              <TableHead className="h-8 text-xs">Before</TableHead>
              <TableHead className="h-8 w-8" />
              <TableHead className="h-8 text-xs">After</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {changes.map((change) => (
              <TableRow key={change.column}>
                <TableCell className="py-1.5 font-mono text-xs">
                  {change.column}
                </TableCell>
                <TableCell className="max-w-0 py-1.5 font-mono text-xs text-muted-foreground">
                  <span className="block truncate line-through decoration-muted-foreground/50">
                    {formatValue(change.before)}
                  </span>
                </TableCell>
                <TableCell className="py-1.5">
                  <ArrowRight className="size-3 text-muted-foreground" />
                </TableCell>
                <TableCell className="max-w-0 py-1.5 font-mono text-xs text-foreground">
                  <span className="block truncate">
                    {formatValue(change.after)}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
