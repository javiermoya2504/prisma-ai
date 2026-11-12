import { ArrowRight, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AdapterIntrospectResult } from "../../../data/adapter";
import { Alert, AlertDescription } from "../../../ui/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../ui/components/ui/select";
import { SchemaDiff } from "../../../ui/schema-diff/SchemaDiff";
import type { PublicConnection } from "./client-api";
import { createConnectionAdapter } from "./create-adapter";
import { defaultSchemaName, introspectionToContract } from "./schema-compare";

type IntrospectionState =
  | { kind: "loading" }
  | { kind: "ready"; result: AdapterIntrospectResult }
  | { kind: "error"; message: string };

/** Introspects one connection through the same BFF path Studio uses. */
function useConnectionIntrospection(
  connection: PublicConnection | undefined,
): IntrospectionState | null {
  const [state, setState] = useState<IntrospectionState | null>(null);

  useEffect(() => {
    if (!connection) {
      setState(null);
      return;
    }

    let cancelled = false;
    setState({ kind: "loading" });

    void createConnectionAdapter(connection, { queryInsights: false })
      .introspect({})
      .then(([error, result]) => {
        if (cancelled) return;
        setState(
          error
            ? { kind: "error", message: error.message }
            : { kind: "ready", result },
        );
      });

    return () => {
      cancelled = true;
    };
  }, [connection]);

  return state;
}

function schemaNamesOf(state: IntrospectionState | null): string[] {
  return state?.kind === "ready"
    ? Object.keys(state.result.schemas).sort()
    : [];
}

function Side(props: {
  label: string;
  connections: PublicConnection[];
  connectionId: string;
  onConnectionChange: (id: string) => void;
  schemas: string[];
  schema: string | null;
  onSchemaChange: (schema: string) => void;
  state: IntrospectionState | null;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Select
        value={props.connectionId}
        onValueChange={props.onConnectionChange}
      >
        <SelectTrigger
          aria-label={`${props.label} connection`}
          className="h-8 min-w-0 flex-1 text-xs"
        >
          <SelectValue placeholder="Choose a connection" />
        </SelectTrigger>
        <SelectContent className="font-sans">
          {props.connections.map((connection) => (
            <SelectItem
              key={connection.id}
              value={connection.id}
              className="text-xs"
            >
              {connection.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={props.schema ?? undefined}
        onValueChange={props.onSchemaChange}
        disabled={props.schemas.length === 0}
      >
        <SelectTrigger
          aria-label={`${props.label} schema`}
          className="h-8 w-40 shrink-0 text-xs"
        >
          {props.state?.kind === "loading" ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading…
            </span>
          ) : (
            <SelectValue placeholder="Schema" />
          )}
        </SelectTrigger>
        <SelectContent className="font-sans">
          {props.schemas.map((schema) => (
            <SelectItem key={schema} value={schema} className="text-xs">
              {schema}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * The connection to compare against: another saved connection of the same
 * kind (dev vs prod), else any other one, else the same connection.
 */
export function defaultCompareTarget(
  connections: Pick<PublicConnection, "id" | "kind" | "source">[],
  fromId: string,
): string {
  const from = connections.find((connection) => connection.id === fromId);
  const others = connections.filter((connection) => connection.id !== fromId);

  return (
    others.find(
      (connection) =>
        connection.kind === from?.kind && connection.source === "saved",
    )?.id ??
    others.find((connection) => connection.kind === from?.kind)?.id ??
    others[0]?.id ??
    fromId
  );
}

/**
 * Compares the structure of two connections (or two schemas of one) with
 * the Migrations view's diff canvas: tables and columns added, removed or
 * changed going from the left side to the right side.
 */
export function CompareSchemaDialog(props: {
  connections: PublicConnection[];
  initialConnectionId: string;
  onClose: () => void;
}) {
  const { connections } = props;
  const [leftId, setLeftId] = useState(props.initialConnectionId);
  const [rightId, setRightId] = useState(() =>
    defaultCompareTarget(connections, props.initialConnectionId),
  );
  const left = connections.find((connection) => connection.id === leftId);
  const right = connections.find((connection) => connection.id === rightId);
  const leftState = useConnectionIntrospection(left);
  const rightState = useConnectionIntrospection(right);
  const leftSchemas = useMemo(() => schemaNamesOf(leftState), [leftState]);
  const rightSchemas = useMemo(() => schemaNamesOf(rightState), [rightState]);
  const [leftSchemaChoice, setLeftSchema] = useState<string | null>(null);
  const [rightSchemaChoice, setRightSchema] = useState<string | null>(null);
  const leftSchema =
    leftSchemaChoice && leftSchemas.includes(leftSchemaChoice)
      ? leftSchemaChoice
      : defaultSchemaName(leftSchemas, null);
  const rightSchema =
    rightSchemaChoice && rightSchemas.includes(rightSchemaChoice)
      ? rightSchemaChoice
      : defaultSchemaName(rightSchemas, leftSchema);

  const before = useMemo(
    () =>
      leftState?.kind === "ready" && leftSchema
        ? introspectionToContract(leftState.result, leftSchema)
        : null,
    [leftSchema, leftState],
  );
  const after = useMemo(
    () =>
      rightState?.kind === "ready" && rightSchema
        ? introspectionToContract(rightState.result, rightSchema)
        : null,
    [rightSchema, rightState],
  );
  const errors = [
    leftState?.kind === "error" ? `${left?.name}: ${leftState.message}` : null,
    rightState?.kind === "error"
      ? `${right?.name}: ${rightState.message}`
      : null,
  ].filter((message): message is string => message !== null);
  const isReady = before != null && after != null;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : props.onClose())}>
      <DialogContent className="flex h-[88vh] max-w-[min(1400px,94vw)] flex-col gap-0 p-0 font-sans sm:max-w-[min(1400px,94vw)]">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="text-base">Compare schema</DialogTitle>
          <DialogDescription className="text-xs">
            Shows what changes going from the left schema to the right one:
            tables and columns added, removed or changed. Tables are matched by
            name. Nothing is modified.
          </DialogDescription>
          <div className="flex items-center gap-3 pt-2">
            <Side
              label="From"
              connections={connections}
              connectionId={leftId}
              onConnectionChange={(id) => {
                setLeftId(id);
                setLeftSchema(null);
              }}
              schemas={leftSchemas}
              schema={leftSchema}
              onSchemaChange={setLeftSchema}
              state={leftState}
            />
            <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
            <Side
              label="To"
              connections={connections}
              connectionId={rightId}
              onConnectionChange={(id) => {
                setRightId(id);
                setRightSchema(null);
              }}
              schemas={rightSchemas}
              schema={rightSchema}
              onSchemaChange={setRightSchema}
              state={rightState}
            />
          </div>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          {errors.length > 0 ? (
            <div className="p-6">
              <Alert variant="destructive" className="text-xs">
                <AlertDescription className="flex flex-col gap-1 text-xs">
                  {errors.map((message) => (
                    <span key={message}>{message}</span>
                  ))}
                </AlertDescription>
              </Alert>
            </div>
          ) : isReady ? (
            <SchemaDiff
              className="min-h-0 flex-1"
              before={before}
              after={after}
              title="Schema comparison"
              fromLabel={`${left?.name} (${leftSchema})`}
              toLabel={`${right?.name} (${rightSchema})`}
              missingSnapshotsMessage="Neither schema has tables."
            />
          ) : (
            <p className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Reading both schemas…
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
