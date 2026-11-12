import { Database, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "../../../ui/components/ui/alert";
import { Badge } from "../../../ui/components/ui/badge";
import { Button } from "../../../ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../ui/components/ui/dialog";
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "../../../ui/components/ui/toggle-group";
import type {
  ConnectionRequestBody,
  ConnectionsApi,
  DetectedDatabase,
  PublicConnection,
} from "./client-api";
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
    url: "",
    user: kind === "mysql" ? "root" : "",
  };
}

export function toRequestBody(form: FormState): ConnectionRequestBody {
  const name = form.name.trim() || undefined;

  if (form.kind === "sqlite") {
    return { file: form.file, kind: "sqlite", name };
  }

  if (form.mode === "url") {
    return { kind: form.kind, name, url: form.url };
  }

  return {
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
  const update = (patch: Partial<FormState>) => {
    setForm((previous) => ({ ...previous, ...patch }));
    setStatus({ kind: "idle" });
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 font-sans sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle className="text-base">Database connections</DialogTitle>
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
                  className="flex items-center gap-3 px-3 py-2"
                >
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
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`Remove ${connection.name}`}
                      disabled={busy}
                      onClick={() => {
                        void api
                          .remove(connection.id)
                          .then(onConnectionsChanged)
                          .then(() => setDetected(null))
                          .catch((error: unknown) =>
                            setStatus({
                              kind: "error",
                              message:
                                error instanceof Error
                                  ? error.message
                                  : String(error),
                            }),
                          );
                      }}
                    >
                      <Trash2 className="text-muted-foreground" />
                    </Button>
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
                3306–3307, SQLite files in your project folders and DATABASE_URL
                are checked.
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
                        {status.kind === "busy" && status.action === item.id ? (
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
