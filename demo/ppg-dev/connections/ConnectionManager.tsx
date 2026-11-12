import {
  Archive,
  Database,
  GitCompare,
  Loader2,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "../../../ui/components/ui/alert";
import { Badge } from "../../../ui/components/ui/badge";
import { Button } from "../../../ui/components/ui/button";
import { Checkbox } from "../../../ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../ui/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../../ui/components/ui/field";
import { Input } from "../../../ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "../../../ui/components/ui/select";
import { Separator } from "../../../ui/components/ui/separator";
import { Switch } from "../../../ui/components/ui/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "../../../ui/components/ui/toggle-group";
import type {
  BackupInfo,
  ConnectionRequestBody,
  ConnectionsApi,
  DetectedDatabase,
  FeatureToggleResult,
  PublicConnection,
  TableReplicaIdentity,
} from "./client-api";
import { CompareSchemaDialog } from "./CompareSchemaDialog";
import {
  DATABASE_KIND_LABELS,
  DATABASE_KINDS,
  type DatabaseKind,
  DEFAULT_PORTS,
  isDatabaseKind,
} from "./settings";

const MANAGE_CONNECTIONS_VALUE = "__manage-connections__";

/**
 * Database picker rendered in Studio's sidebar through the `databaseSwitcher`
 * slot. It is the same ShadCN `Select` as Studio's schema selector, so the two
 * read as one control group.
 */
export function ConnectionSwitcher(props: {
  connections: PublicConnection[];
  activeId: string | null;
  onSelect: (connection: PublicConnection) => void;
  onManage: () => void;
}) {
  return (
    <Select
      value={props.activeId ?? undefined}
      onValueChange={(value) => {
        if (value === MANAGE_CONNECTIONS_VALUE) {
          props.onManage();
          return;
        }

        const connection = props.connections.find((item) => item.id === value);
        if (connection) props.onSelect(connection);
      }}
    >
      <SelectTrigger
        // Long names truncate inside the trigger instead of pushing the
        // chevron out, matching the schema selector's footprint.
        className="text-xs [&>div]:min-w-0 [&>div>span:last-child]:truncate"
        label="Database"
        aria-label="Switch database"
      >
        <SelectValue placeholder="Add a database" />
      </SelectTrigger>
      <SelectContent>
        {props.connections.map((connection) => (
          <SelectItem
            key={connection.id}
            value={connection.id}
            className="text-xs"
          >
            {connection.name}
          </SelectItem>
        ))}
        {props.connections.length > 0 ? <SelectSeparator /> : null}
        <SelectItem
          value={MANAGE_CONNECTIONS_VALUE}
          className="text-xs text-muted-foreground"
        >
          Manage connections…
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

type FormMode = "fields" | "url";

interface FormState {
  kind: DatabaseKind;
  mode: FormMode;
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  url: string;
  file: string;
  readOnly: boolean;
}

function emptyForm(kind: DatabaseKind = "postgres"): FormState {
  return {
    database: "",
    file: "",
    host: "localhost",
    kind,
    mode: "fields",
    name: "",
    password: "",
    port: kind === "sqlite" ? "" : String(DEFAULT_PORTS[kind]),
    readOnly: false,
    url: "",
    user: kind === "mysql" ? "root" : "",
  };
}

export function toRequestBody(form: FormState): ConnectionRequestBody {
  const name = form.name.trim() || undefined;
  const { readOnly } = form;

  if (form.kind === "sqlite") {
    return { file: form.file, kind: "sqlite", name, readOnly };
  }

  if (form.mode === "url") {
    return { kind: form.kind, name, readOnly, url: form.url };
  }

  return {
    readOnly,
    database: form.database,
    host: form.host,
    kind: form.kind,
    name,
    password: form.password,
    port: form.port,
    user: form.user,
  };
}

export function ConnectionsDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: ConnectionsApi;
  connections: PublicConnection[];
  activeId: string | null;
  onOpenConnection: (connection: PublicConnection) => void;
  onConnectionsChanged: () => Promise<void>;
}) {
  const { api, onConnectionsChanged, onOpenConnection } = props;
  const [detected, setDetected] = useState<DetectedDatabase[] | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "busy"; action: "test" | "save" | string }
    | { kind: "ok"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const runDetection = useCallback(async () => {
    setIsDetecting(true);
    setDetectError(null);

    try {
      setDetected(await api.detect());
    } catch (error: unknown) {
      setDetectError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDetecting(false);
    }
  }, [api]);

  useEffect(() => {
    if (props.open && detected === null && !isDetecting) {
      void runDetection();
    }
  }, [detected, isDetecting, props.open, runDetection]);

  const saveAndOpen = async (body: ConnectionRequestBody, action: string) => {
    setStatus({ action, kind: "busy" });

    try {
      const saved = await api.save(body);
      await onConnectionsChanged();
      setDetected(null);
      setStatus({ kind: "idle" });
      setForm(emptyForm(form.kind));
      onOpenConnection(saved);
      props.onOpenChange(false);
    } catch (error: unknown) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const testConnection = async () => {
    setStatus({ action: "test", kind: "busy" });
    const result = await api.test(toRequestBody(form));
    setStatus(
      result.ok
        ? { kind: "ok", message: "Connection works." }
        : { kind: "error", message: result.message ?? "Could not connect." },
    );
  };

  const busy = status.kind === "busy";
  const [compareConnectionId, setCompareConnectionId] = useState<string | null>(
    null,
  );
  const [backupsConnection, setBackupsConnection] =
    useState<PublicConnection | null>(null);
  const reportError = (error: unknown) =>
    setStatus({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  const update = (patch: Partial<FormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setStatus({ kind: "idle" });
  };

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 font-sans sm:max-w-2xl">
          <DialogHeader className="border-b px-6 py-4">
            <DialogTitle className="text-base">
              Database connections
            </DialogTitle>
            <DialogDescription className="text-xs">
              Open any PostgreSQL, MySQL or SQLite database on this computer or
              your own servers.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-6 py-5">
            <section
              aria-labelledby="saved-connections"
              className="flex flex-col gap-2"
            >
              <h3 id="saved-connections" className="text-sm font-medium">
                Your connections
              </h3>
              <ul className="flex flex-col divide-y rounded-md border">
                {props.connections.map((connection) => (
                  <li
                    key={connection.id}
                    className="flex flex-col gap-2 px-3 py-2"
                  >
                    <div className="flex items-center gap-3">
                      <Database className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm">
                            {connection.name}
                          </span>
                          <Badge variant="secondary" className="font-normal">
                            {DATABASE_KIND_LABELS[connection.kind]}
                          </Badge>
                          {connection.id === props.activeId ? (
                            <Badge variant="outline" className="font-normal">
                              Active
                            </Badge>
                          ) : null}
                          {connection.readOnly ? (
                            <Badge
                              variant="outline"
                              className="gap-1 font-normal text-muted-foreground"
                            >
                              <Lock className="size-3" />
                              Read-only
                            </Badge>
                          ) : null}
                        </div>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {connection.displayUrl}
                        </p>
                      </div>
                      {connection.id !== props.activeId ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            onOpenConnection(connection);
                            props.onOpenChange(false);
                          }}
                        >
                          Open
                        </Button>
                      ) : null}
                      {connection.source === "saved" ? (
                        <ConnectionActionsMenu
                          connection={connection}
                          disabled={busy}
                          onReadOnlyChange={(readOnly) => {
                            void api
                              .update(connection.id, { readOnly })
                              .then(onConnectionsChanged)
                              .catch(reportError);
                          }}
                          onOpenBackups={() => setBackupsConnection(connection)}
                          onCompare={() =>
                            setCompareConnectionId(connection.id)
                          }
                          onRemove={() => {
                            void api
                              .remove(connection.id)
                              .then(onConnectionsChanged)
                              .then(() => setDetected(null))
                              .catch(reportError);
                          }}
                        />
                      ) : null}
                    </div>
                    {connection.source === "saved" &&
                    connection.kind === "postgres" ? (
                      <PostgresFeatureControls
                        connection={connection}
                        api={api}
                        onChanged={onConnectionsChanged}
                      />
                    ) : null}
                  </li>
                ))}
                {props.connections.length === 0 ? (
                  <li className="px-3 py-4 text-sm text-muted-foreground">
                    No connections yet. Pick one found below or add your own.
                  </li>
                ) : null}
              </ul>
            </section>

            <section
              aria-labelledby="detected-databases"
              className="flex flex-col gap-2"
            >
              <div className="flex items-center justify-between">
                <h3 id="detected-databases" className="text-sm font-medium">
                  Found on this computer
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isDetecting}
                  onClick={() => void runDetection()}
                >
                  <RefreshCw
                    className={isDetecting ? "animate-spin" : undefined}
                  />
                  Scan again
                </Button>
              </div>
              {detectError ? (
                <p className="text-xs text-destructive">{detectError}</p>
              ) : null}
              {isDetecting && !detected ? (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Looking for local PostgreSQL, MySQL and SQLite databases…
                </p>
              ) : null}
              {detected && detected.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing new found. Local servers on ports 5432–5434 and
                  3306–3307, SQLite files in your project folders and
                  DATABASE_URL are checked.
                </p>
              ) : null}
              {detected && detected.length > 0 ? (
                <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
                  {detected.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm">{item.name}</span>
                          <Badge variant="secondary" className="font-normal">
                            {DATABASE_KIND_LABELS[item.kind]}
                          </Badge>
                        </div>
                        <p className="truncate font-mono text-xs text-muted-foreground">
                          {item.displayUrl}
                        </p>
                      </div>
                      {item.ready ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void saveAndOpen({ detectedId: item.id }, item.id)
                          }
                        >
                          {status.kind === "busy" &&
                          status.action === item.id ? (
                            <Loader2 className="animate-spin" />
                          ) : null}
                          Connect
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setForm({
                              ...emptyForm(item.kind),
                              host: item.prefill?.host ?? "localhost",
                              port: String(item.prefill?.port ?? ""),
                              user: item.prefill?.user ?? "",
                            });
                            setStatus({
                              kind: "ok",
                              message: `Enter the user and password for ${item.name}.`,
                            });
                            document
                              .getElementById("studio-connection-form")
                              ?.scrollIntoView({ behavior: "smooth" });
                          }}
                        >
                          Add credentials
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            <Separator />

            <section
              aria-labelledby="add-connection"
              className="flex flex-col gap-3"
            >
              <h3 id="add-connection" className="text-sm font-medium">
                Add a connection
              </h3>
              <form
                id="studio-connection-form"
                onSubmit={(event: FormEvent) => {
                  event.preventDefault();
                  void saveAndOpen(toRequestBody(form), "save");
                }}
              >
                <FieldGroup className="gap-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      aria-label="Database type"
                      value={form.kind}
                      onValueChange={(value) => {
                        if (isDatabaseKind(value)) {
                          setForm({ ...emptyForm(value), mode: form.mode });
                          setStatus({ kind: "idle" });
                        }
                      }}
                    >
                      {DATABASE_KINDS.map((kind) => (
                        <ToggleGroupItem
                          key={kind}
                          value={kind}
                          className="px-3 text-xs font-normal"
                        >
                          {DATABASE_KIND_LABELS[kind]}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    {form.kind !== "sqlite" ? (
                      <ToggleGroup
                        type="single"
                        variant="outline"
                        size="sm"
                        aria-label="Connection input"
                        className="ml-auto"
                        value={form.mode}
                        onValueChange={(value) => {
                          if (value === "fields" || value === "url") {
                            update({ mode: value });
                          }
                        }}
                      >
                        <ToggleGroupItem
                          value="fields"
                          className="px-3 text-xs font-normal"
                        >
                          Host and user
                        </ToggleGroupItem>
                        <ToggleGroupItem
                          value="url"
                          className="px-3 text-xs font-normal"
                        >
                          URL
                        </ToggleGroupItem>
                      </ToggleGroup>
                    ) : null}
                  </div>

                  {form.kind === "sqlite" ? (
                    <TextField
                      id="studio-connection-file"
                      label="Database file"
                      placeholder="/Users/you/project/dev.db"
                      value={form.file}
                      onChange={(file) => update({ file })}
                      description="Absolute path to an existing .db, .sqlite or .sqlite3 file."
                    />
                  ) : form.mode === "url" ? (
                    <TextField
                      id="studio-connection-url"
                      label="Connection URL"
                      placeholder={
                        form.kind === "postgres"
                          ? "postgresql://user:password@host:5432/database"
                          : "mysql://user:password@host:3306/database"
                      }
                      value={form.url}
                      onChange={(url) => update({ url })}
                    />
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
                      <TextField
                        className="sm:col-span-4"
                        id="studio-connection-host"
                        label="Host"
                        placeholder="localhost or db.example.com"
                        value={form.host}
                        onChange={(host) => update({ host })}
                      />
                      <TextField
                        className="sm:col-span-2"
                        id="studio-connection-port"
                        label="Port"
                        inputMode="numeric"
                        value={form.port}
                        onChange={(port) => update({ port })}
                      />
                      <TextField
                        className="sm:col-span-3"
                        id="studio-connection-user"
                        label="User"
                        value={form.user}
                        onChange={(user) => update({ user })}
                      />
                      <TextField
                        className="sm:col-span-3"
                        id="studio-connection-password"
                        label="Password"
                        type="password"
                        value={form.password}
                        onChange={(password) => update({ password })}
                      />
                      <TextField
                        className="sm:col-span-6"
                        id="studio-connection-database"
                        label="Database"
                        placeholder={
                          form.kind === "postgres" ? "postgres" : "my_app"
                        }
                        value={form.database}
                        onChange={(database) => update({ database })}
                      />
                    </div>
                  )}

                  <TextField
                    id="studio-connection-name"
                    label="Name (optional)"
                    placeholder="Shown in the database switcher"
                    value={form.name}
                    onChange={(name) => update({ name })}
                    mono={false}
                  />

                  <Field orientation="horizontal" className="items-start gap-2">
                    <Checkbox
                      id="studio-connection-read-only"
                      checked={form.readOnly}
                      onCheckedChange={(checked) =>
                        update({ readOnly: checked === true })
                      }
                    />
                    <div className="flex flex-col gap-0.5">
                      <FieldLabel
                        htmlFor="studio-connection-read-only"
                        className="text-xs font-normal"
                      >
                        Read-only
                      </FieldLabel>
                      <FieldDescription className="text-xs">
                        Opens the database in read-only sessions and hides
                        editing. Recommended for production databases.
                      </FieldDescription>
                    </div>
                  </Field>

                  {status.kind === "error" ? (
                    <Alert variant="destructive" className="text-xs">
                      <AlertDescription className="text-xs">
                        {status.message}
                      </AlertDescription>
                    </Alert>
                  ) : null}
                  {status.kind === "ok" ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      {status.message}
                    </p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="submit" size="sm" disabled={busy}>
                      {status.kind === "busy" && status.action === "save" ? (
                        <Loader2 className="animate-spin" />
                      ) : (
                        <Plus />
                      )}
                      Save and open
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void testConnection()}
                    >
                      {status.kind === "busy" && status.action === "test" ? (
                        <Loader2 className="animate-spin" />
                      ) : null}
                      Test connection
                    </Button>
                  </div>
                  <FieldDescription className="text-xs">
                    Saved connections, including passwords, are stored by the
                    Studio server in a file only your user can read
                    (~/.prisma-studio-ai/connections.json). They are never sent
                    back to the browser.
                  </FieldDescription>
                </FieldGroup>
              </form>
            </section>
          </div>
        </DialogContent>
      </Dialog>
      {compareConnectionId ? (
        <CompareSchemaDialog
          connections={props.connections}
          initialConnectionId={compareConnectionId}
          onClose={() => setCompareConnectionId(null)}
        />
      ) : null}
      {backupsConnection ? (
        <BackupsDialog
          api={api}
          connection={backupsConnection}
          onClose={() => setBackupsConnection(null)}
          onRestored={async (restored) => {
            await onConnectionsChanged();
            setBackupsConnection(null);
            onOpenConnection(restored);
            props.onOpenChange(false);
          }}
        />
      ) : null}
    </>
  );
}

function ConnectionActionsMenu(props: {
  connection: PublicConnection;
  disabled: boolean;
  onReadOnlyChange: (readOnly: boolean) => void;
  onOpenBackups: () => void;
  onCompare: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label={`More actions for ${props.connection.name}`}
          disabled={props.disabled}
        >
          <MoreHorizontal className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52 font-sans">
        <DropdownMenuCheckboxItem
          checked={props.connection.readOnly}
          onCheckedChange={(checked) => props.onReadOnlyChange(checked)}
          className="text-xs"
        >
          Read-only
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem
          onSelect={props.onOpenBackups}
          className="gap-2 text-xs"
        >
          <Archive className="size-3.5" />
          Backups…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={props.onCompare} className="gap-2 text-xs">
          <GitCompare className="size-3.5" />
          Compare schema…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={props.onRemove}
          className="gap-2 text-xs text-destructive focus:text-destructive"
        >
          <Trash2 className="size-3.5" />
          Remove connection
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Lists a connection's backups. Restoring always creates a new database (or
 * SQLite file) and a new connection; the original is never overwritten.
 */
function BackupsDialog(props: {
  api: ConnectionsApi;
  connection: PublicConnection;
  onClose: () => void;
  onRestored: (connection: PublicConnection) => Promise<void>;
}) {
  const { api, connection } = props;
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setBackups(await api.listBackups(connection.id));
    } catch (listError: unknown) {
      setError(
        listError instanceof Error ? listError.message : String(listError),
      );
      setBackups([]);
    }
  }, [api, connection.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    setPending(key);
    setError(null);

    try {
      await action();
    } catch (actionError: unknown) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : String(actionError),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : props.onClose())}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 font-sans sm:max-w-lg">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="text-base">
            Backups · {connection.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Stored on this computer in ~/.prisma-studio-ai/backups. Restoring
            creates a new database next to the original and never overwrites it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5">
          <div>
            <Button
              size="sm"
              disabled={pending != null}
              onClick={() =>
                void runAction("create", async () => {
                  await api.createBackup(connection.id);
                  await refresh();
                })
              }
            >
              {pending === "create" ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Archive />
              )}
              {pending === "create" ? "Backing up…" : "Back up now"}
            </Button>
          </div>

          {error ? (
            <Alert variant="destructive" className="text-xs">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          ) : null}

          {backups === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading backups…
            </p>
          ) : backups.length === 0 ? (
            <p className="text-xs text-muted-foreground">No backups yet.</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {backups.map((backup) => (
                <li key={backup.id} className="flex flex-col gap-2 px-3 py-2">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        {new Date(backup.createdAt).toLocaleString()}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {formatBytes(backup.sizeBytes)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending != null}
                      onClick={() => setConfirmRestore(backup.id)}
                    >
                      Restore…
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Delete backup"
                      disabled={pending != null}
                      onClick={() =>
                        void runAction(`delete:${backup.id}`, async () => {
                          await api.removeBackup(connection.id, backup.id);
                          await refresh();
                        })
                      }
                    >
                      <Trash2 className="text-muted-foreground" />
                    </Button>
                  </div>
                  {confirmRestore === backup.id ? (
                    <Alert className="text-xs">
                      <AlertDescription className="flex flex-col gap-2 text-xs">
                        <span>
                          This creates a new{" "}
                          {connection.kind === "sqlite" ? "file" : "database"}{" "}
                          with this backup&apos;s data and opens it.{" "}
                          {connection.name} stays as it is.
                        </span>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            disabled={pending != null}
                            onClick={() =>
                              void runAction(
                                `restore:${backup.id}`,
                                async () => {
                                  const restored = await api.restoreBackup(
                                    connection.id,
                                    backup.id,
                                  );
                                  await props.onRestored(restored);
                                },
                              )
                            }
                          >
                            {pending === `restore:${backup.id}` ? (
                              <Loader2 className="animate-spin" />
                            ) : null}
                            Restore as new database
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending != null}
                            onClick={() => setConfirmRestore(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </AlertDescription>
                    </Alert>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** One-time server setup instructions for a feature that needs it. */
function SetupInstructions(props: { code: string }) {
  if (props.code === "wal-level") {
    return (
      <>
        <span>
          Run this once, then restart PostgreSQL. Nothing else in the database
          changes until you turn live history on.
        </span>
        <code className="block rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          psql -d postgres -c &quot;ALTER SYSTEM SET wal_level = logical&quot;
        </code>
        <RestartHint flag="-c wal_level=logical" />
      </>
    );
  }

  if (props.code === "preload") {
    return (
      <>
        <span>
          Run this once, then restart PostgreSQL. If shared_preload_libraries
          already lists other libraries, keep them in the list.
        </span>
        <code className="block rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
          psql -d postgres -c &quot;ALTER SYSTEM SET shared_preload_libraries =
          &apos;pg_stat_statements&apos;&quot;
        </code>
        <RestartHint flag="-c shared_preload_libraries=pg_stat_statements" />
      </>
    );
  }

  return null;
}

function RestartHint(props: { flag: string }) {
  return (
    <span>
      Homebrew:{" "}
      <code className="font-mono">
        brew services restart postgresql@&lt;version&gt;
      </code>
      . Docker: start the container with{" "}
      <code className="font-mono">{props.flag}</code>.
    </span>
  );
}

/**
 * A per-connection PostgreSQL feature switch (live history, query insights).
 * Shows what the feature does, its state, and setup steps when the server
 * still needs configuring.
 */
function FeatureSwitch(props: {
  id: string;
  label: string;
  checked: boolean;
  offDescription: string;
  onDescription: (detail?: number) => string;
  toggle: (enabled: boolean) => Promise<FeatureToggleResult>;
  onChanged: () => Promise<void>;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "enabled"; detail?: number }
    | { kind: "error"; code: string; message: string }
  >({ kind: "idle" });

  const toggle = async (enabled: boolean) => {
    setState({ kind: "busy" });
    const result = await props.toggle(enabled);

    if (!result.ok) {
      setState({ code: result.code, kind: "error", message: result.message });
      return;
    }

    await props.onChanged();
    setState(
      enabled
        ? { detail: result.tableCount, kind: "enabled" }
        : { kind: "idle" },
    );
  };

  const isSetupHint =
    state.kind === "error" &&
    state.code !== "failed" &&
    state.code !== "permission";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Switch
          id={props.id}
          checked={props.checked}
          disabled={state.kind === "busy"}
          onCheckedChange={(checked) => void toggle(checked)}
        />
        <FieldLabel htmlFor={props.id} className="text-xs font-normal">
          {props.label}
        </FieldLabel>
        {state.kind === "busy" ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        ) : null}
        <span className="text-xs text-muted-foreground">
          {props.checked
            ? props.onDescription(
                state.kind === "enabled" ? state.detail : undefined,
              )
            : props.offDescription}
        </span>
      </div>
      {state.kind === "error" ? (
        <Alert
          variant={isSetupHint ? "default" : "destructive"}
          className="text-xs"
        >
          <AlertDescription className="flex flex-col gap-2 text-xs">
            <span>{state.message}</span>
            <SetupInstructions code={state.code} />
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Per-table REPLICA IDENTITY FULL, so live history keeps the previous row of
 * every update and delete. Each switch changes the user's table right away.
 */
function PreviousValuesDialog(props: {
  api: ConnectionsApi;
  connection: PublicConnection;
  onClose: () => void;
}) {
  const { api, connection } = props;
  const [tables, setTables] = useState<TableReplicaIdentity[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tableKey = (table: { schema: string; name: string }) =>
    `${table.schema}.${table.name}`;

  useEffect(() => {
    let cancelled = false;

    api
      .listReplicaIdentities(connection.id)
      .then((result) => {
        if (!cancelled) setTables(result);
      })
      .catch((listError: unknown) => {
        if (cancelled) return;
        setError(
          listError instanceof Error ? listError.message : String(listError),
        );
        setTables([]);
      });

    return () => {
      cancelled = true;
    };
  }, [api, connection.id]);

  const toggle = async (table: TableReplicaIdentity, full: boolean) => {
    setPending(tableKey(table));
    setError(null);

    try {
      const updated = await api.setReplicaIdentity(connection.id, table, full);
      setTables((current) =>
        (current ?? []).map((item) =>
          tableKey(item) === tableKey(updated) ? updated : item,
        ),
      );
    } catch (toggleError: unknown) {
      setError(
        toggleError instanceof Error
          ? toggleError.message
          : String(toggleError),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? null : props.onClose())}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 font-sans sm:max-w-lg">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="text-base">
            Previous values · {connection.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            By default PostgreSQL only records the new row of an update. Turn a
            table on to also keep the previous values, so history shows what
            changed. This runs ALTER TABLE … REPLICA IDENTITY FULL on that table
            and makes its updates and deletes write more WAL. Turning it off
            restores the default.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5">
          {connection.readOnly ? (
            <Alert className="text-xs">
              <AlertDescription className="text-xs">
                This connection is read-only, so tables can&apos;t be changed.
              </AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive" className="text-xs">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          ) : null}
          {tables === null ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Loading tables…
            </p>
          ) : tables.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No tables with a primary key.
            </p>
          ) : (
            <ul className="flex flex-col divide-y rounded-md border">
              {tables.map((table) => {
                const key = tableKey(table);
                const id = `previous-values-${connection.id}-${key}`;

                return (
                  <li key={key} className="flex items-center gap-3 px-3 py-2">
                    <Switch
                      id={id}
                      checked={table.full}
                      disabled={connection.readOnly || pending != null}
                      onCheckedChange={(checked) => void toggle(table, checked)}
                    />
                    <FieldLabel
                      htmlFor={id}
                      className="flex-1 font-mono text-xs font-normal"
                    >
                      {key}
                    </FieldLabel>
                    {pending === key ? (
                      <Loader2 className="size-3 animate-spin text-muted-foreground" />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PostgresFeatureControls(props: {
  connection: PublicConnection;
  api: ConnectionsApi;
  onChanged: () => Promise<void>;
}) {
  const { api, connection, onChanged } = props;
  const [isPreviousValuesOpen, setPreviousValuesOpen] = useState(false);

  return (
    <div className="flex flex-col gap-2 pl-7">
      <FeatureSwitch
        id={`live-history-${connection.id}`}
        label="Live history"
        checked={connection.liveHistory}
        offDescription="See every insert, update and delete as it happens"
        onDescription={(tableCount) =>
          tableCount === undefined
            ? "Recording changes to the prisma-wal stream"
            : `Recording changes in ${tableCount} table${tableCount === 1 ? "" : "s"} to the prisma-wal stream`
        }
        toggle={(enabled) => api.setLiveHistory(connection.id, enabled)}
        onChanged={onChanged}
      />
      {connection.liveHistory ? (
        <div className="pl-11">
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            onClick={() => setPreviousValuesOpen(true)}
          >
            Previous values for updates…
          </Button>
        </div>
      ) : null}
      {isPreviousValuesOpen ? (
        <PreviousValuesDialog
          api={api}
          connection={connection}
          onClose={() => setPreviousValuesOpen(false)}
        />
      ) : null}
      <FeatureSwitch
        id={`query-insights-${connection.id}`}
        label="Query insights"
        checked={connection.queryInsights}
        offDescription="Find slow and frequent queries from any app"
        onDescription={() => "Shown in Queries (from pg_stat_statements)"}
        toggle={(enabled) => api.setQueryInsights(connection.id, enabled)}
        onChanged={onChanged}
      />
      <FeatureSwitch
        id={`server-logs-${connection.id}`}
        label="Server logs"
        checked={connection.serverLogs}
        offDescription="Follow PostgreSQL's log (errors, warnings) as a stream"
        onDescription={() =>
          "Writing new log lines to the postgres-logs stream"
        }
        toggle={(enabled) => api.setServerLogs(connection.id, enabled)}
        onChanged={onChanged}
      />
    </div>
  );
}

function TextField(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  description?: string;
  type?: "text" | "password";
  inputMode?: "numeric";
  className?: string;
  mono?: boolean;
}) {
  return (
    <Field className={`gap-1.5 ${props.className ?? ""}`}>
      <FieldLabel htmlFor={props.id} className="text-xs">
        {props.label}
      </FieldLabel>
      <Input
        id={props.id}
        type={props.type ?? "text"}
        inputMode={props.inputMode}
        autoComplete="off"
        spellCheck={false}
        placeholder={props.placeholder}
        className={`h-8 text-xs md:text-xs ${props.mono === false ? "" : "font-mono"}`}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {props.description ? (
        <FieldDescription className="text-xs">
          {props.description}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
