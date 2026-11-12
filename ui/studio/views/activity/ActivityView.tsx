import { Ban, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  StudioDatabaseActivitySnapshot,
  StudioDatabaseSession,
} from "../../../../data/database-activity";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { Switch } from "../../../components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../../components/ui/table";
import { useStudio } from "../../context";
import { StudioHeader } from "../../StudioHeader";
import type { ViewProps } from "../View";

const DEFAULT_POLLING_INTERVAL_MS = 2_000;

export function formatSessionDuration(
  startedAt: number | null,
  now: number,
): string {
  if (startedAt == null) return "—";

  const ms = Math.max(0, now - startedAt);

  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function stateVariant(state: string | null) {
  if (state === "active") return "default" as const;
  if (state?.startsWith("idle in transaction")) return "destructive" as const;
  return "secondary" as const;
}

/**
 * Live sessions of the open database (`view=activity`): who is connected and
 * what each connection is running right now, with a guarded "Cancel" for
 * runaway statements. Rendered only when the adapter exposes `activity`.
 */
export function ActivityView(_props: ViewProps) {
  const { activity } = useStudio();
  const [snapshot, setSnapshot] =
    useState<StudioDatabaseActivitySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [showIdle, setShowIdle] = useState(false);
  const [pendingCancel, setPendingCancel] =
    useState<StudioDatabaseSession | null>(null);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (!activity) return;

      const [snapshotError, next] = await activity.getSnapshot({
        abortSignal: signal,
      });

      if (signal?.aborted) return;

      if (snapshotError) {
        setError(snapshotError.message);
        return;
      }

      setError(null);
      setSnapshot(next);
    },
    [activity],
  );

  useEffect(() => {
    if (isPaused) return;

    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = setInterval(
      () => void refresh(controller.signal),
      snapshot?.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
    );

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [isPaused, refresh, snapshot?.pollingIntervalMs]);

  const sessions = useMemo(
    () =>
      (snapshot?.sessions ?? []).filter(
        (session) => showIdle || session.state !== "idle",
      ),
    [showIdle, snapshot],
  );
  const now = snapshot?.generatedAt ?? 0;

  if (!activity) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <StudioHeader />
        <div className="flex flex-1 items-center justify-center px-6 py-10 text-sm text-muted-foreground">
          Activity is not available for this database.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <StudioHeader />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-lg font-semibold text-foreground">Activity</h1>
            <p className="max-w-5xl text-sm text-muted-foreground">
              Who is connected to this database and what each connection is
              running right now.
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-4">
            <div className="flex items-center gap-2">
              <Switch
                id="studio-activity-show-idle"
                checked={showIdle}
                onCheckedChange={setShowIdle}
              />
              <Label
                htmlFor="studio-activity-show-idle"
                className="text-sm font-normal"
              >
                Show idle
              </Label>
            </div>
            <Button
              onClick={() => setIsPaused((current) => !current)}
              className="shadow-none"
              size="sm"
              type="button"
              variant="outline"
            >
              {isPaused ? (
                <Play data-icon="inline-start" />
              ) : (
                <Pause data-icon="inline-start" />
              )}
              {isPaused ? "Resume" : "Pause"}
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {cancelMessage ? (
          <p role="status" className="text-sm text-muted-foreground">
            {cancelMessage}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">Session</TableHead>
                <TableHead className="w-48">Client</TableHead>
                <TableHead className="w-40">State</TableHead>
                <TableHead className="w-24">Running</TableHead>
                <TableHead>Query</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id} data-testid="activity-session">
                  <TableCell className="font-mono text-xs">
                    {session.id}
                  </TableCell>
                  <TableCell className="text-xs">
                    <div className="flex flex-col">
                      <span className="truncate">
                        {session.application || "—"}
                        {session.isStudio ? (
                          <Badge
                            variant="outline"
                            className="ml-1.5 font-normal"
                          >
                            Studio
                          </Badge>
                        ) : null}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {[session.user, session.clientAddress]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge
                        variant={stateVariant(session.state)}
                        className="font-normal"
                      >
                        {session.state ?? "unknown"}
                      </Badge>
                      {session.waitEvent ? (
                        <span className="text-xs text-muted-foreground">
                          Waiting: {session.waitEvent}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {session.state === "active"
                      ? formatSessionDuration(session.queryStartedAt, now)
                      : "—"}
                  </TableCell>
                  <TableCell className="max-w-0">
                    <code
                      className="block truncate font-mono text-xs text-foreground/80"
                      title={session.query ?? undefined}
                    >
                      {session.query ?? "—"}
                    </code>
                  </TableCell>
                  <TableCell className="text-right">
                    {snapshot?.canCancel &&
                    session.state === "active" &&
                    !session.isStudio ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setPendingCancel(session)}
                      >
                        <Ban data-icon="inline-start" />
                        Cancel
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
              {snapshot && sessions.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-8 text-center text-sm text-muted-foreground"
                  >
                    {showIdle
                      ? "No connections."
                      : "Nothing is running right now. Turn on “Show idle” to see every connection."}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </div>

      <AlertDialog
        open={pendingCancel != null}
        onOpenChange={(open) => (open ? null : setPendingCancel(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this query?</AlertDialogTitle>
            <AlertDialogDescription>
              The statement running in session {pendingCancel?.id} stops and the
              application that sent it gets an error. The connection itself
              stays open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingCancel?.query ? (
            <code className="block max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-xs">
              {pendingCancel.query}
            </code>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const session = pendingCancel;
                setPendingCancel(null);

                if (!session) return;

                void activity
                  .cancel(session.id)
                  .then(([cancelError, result]) => {
                    setCancelMessage(
                      cancelError
                        ? `Could not cancel: ${cancelError.message}`
                        : result.cancelled
                          ? `Cancelled the query in session ${session.id}.`
                          : `Session ${session.id} had already finished.`,
                    );
                    void refresh();
                  });
              }}
            >
              Cancel query
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
