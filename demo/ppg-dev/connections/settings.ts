export const DATABASE_KINDS = ["postgres", "mysql", "sqlite"] as const;

export type DatabaseKind = (typeof DATABASE_KINDS)[number];

export const DATABASE_KIND_LABELS: Record<DatabaseKind, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
};

export const DEFAULT_PORTS: Record<Exclude<DatabaseKind, "sqlite">, number> = {
  mysql: 3306,
  postgres: 5432,
};

export const DEMO_CONNECTION_ID = "demo";

/** A saved connection as stored on the demo server (includes credentials). */
export interface StoredConnection {
  id: string;
  name: string;
  kind: DatabaseKind;
  /** Connection URL for Postgres/MySQL, absolute file path for SQLite. */
  url: string;
}

/** What the browser sees: never contains a password. */
export interface PublicConnection {
  id: string;
  name: string;
  kind: DatabaseKind;
  /** URL with the password masked, or the SQLite file path. */
  displayUrl: string;
  source: "demo" | "saved";
}

/** Fields the "Add connection" form sends. */
export type ConnectionInput =
  | { name?: string; kind: DatabaseKind; url: string }
  | {
      name?: string;
      kind: Exclude<DatabaseKind, "sqlite">;
      host: string;
      port?: number;
      user?: string;
      password?: string;
      database?: string;
    }
  | { name?: string; kind: "sqlite"; file: string };

export function isDatabaseKind(value: unknown): value is DatabaseKind {
  return (
    typeof value === "string" &&
    (DATABASE_KINDS as readonly string[]).includes(value)
  );
}

export function detectKindFromUrl(url: string): DatabaseKind | null {
  const trimmed = url.trim();

  if (/^postgres(ql)?:\/\//i.test(trimmed)) return "postgres";
  if (/^(mysql|mariadb):\/\//i.test(trimmed)) return "mysql";
  if (/^(file|sqlite):/i.test(trimmed)) return "sqlite";
  if (/\.(db|db3|sqlite|sqlite3)$/i.test(trimmed)) return "sqlite";

  return null;
}

function stripSqlitePrefix(value: string): string {
  return value
    .trim()
    .replace(/^sqlite:(\/\/)?/i, "")
    .replace(/^file:(\/\/)?/i, "");
}

/**
 * Normalizes form input into a stored URL. Throws a user-facing error when the
 * input cannot describe a connection.
 */
export function buildConnectionUrl(input: ConnectionInput): string {
  if ("url" in input) {
    const url = input.url.trim();

    if (!url) throw new Error("Enter a connection URL.");

    if (input.kind === "sqlite") {
      const file = stripSqlitePrefix(url);

      if (!file.startsWith("/")) {
        throw new Error("Enter the absolute path of the SQLite file.");
      }

      return file;
    }

    const detected = detectKindFromUrl(url);

    if (detected !== input.kind) {
      throw new Error(
        input.kind === "postgres"
          ? "PostgreSQL URLs start with postgres:// or postgresql://."
          : "MySQL URLs start with mysql://.",
      );
    }

    try {
      new URL(url);
    } catch {
      throw new Error("The connection URL is not valid.");
    }

    return input.kind === "mysql" ? url.replace(/^mariadb:/i, "mysql:") : url;
  }

  if (input.kind === "sqlite") {
    const file = stripSqlitePrefix(input.file);

    if (!file.startsWith("/")) {
      throw new Error("Enter the absolute path of the SQLite file.");
    }

    return file;
  }

  const host = input.host.trim();

  if (!host || /[/@?#\s]/.test(host)) {
    throw new Error("Enter a valid host, for example localhost.");
  }

  const port = input.port ?? DEFAULT_PORTS[input.kind];

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Enter a port between 1 and 65535.");
  }

  const url = new URL(
    `${input.kind === "postgres" ? "postgresql" : "mysql"}://placeholder`,
  );
  url.hostname = host;
  url.port = String(port);

  if (input.user?.trim()) url.username = encodeURIComponent(input.user.trim());
  if (input.password) url.password = encodeURIComponent(input.password);

  const database = input.database?.trim();

  if (database) url.pathname = `/${encodeURIComponent(database)}`;

  return url.toString();
}

/** Replaces the password in a URL so it can be shown to the browser. */
export function maskConnectionUrl(kind: DatabaseKind, url: string): string {
  if (kind === "sqlite") return url;

  try {
    const parsed = new URL(url);

    if (parsed.password) parsed.password = "****";

    return parsed.toString();
  } catch {
    return "(invalid URL)";
  }
}

export function defaultConnectionName(kind: DatabaseKind, url: string): string {
  if (kind === "sqlite") {
    return url.split("/").filter(Boolean).at(-1) ?? "SQLite";
  }

  try {
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));

    return database ? `${database} @ ${parsed.hostname}` : parsed.hostname;
  } catch {
    return DATABASE_KIND_LABELS[kind];
  }
}

export function toPublicConnection(
  connection: StoredConnection,
): PublicConnection {
  return {
    displayUrl: maskConnectionUrl(connection.kind, connection.url),
    id: connection.id,
    kind: connection.kind,
    name: connection.name,
    source: "saved",
  };
}

/** Removes credentials from error text before it is sent to the browser. */
export function redactSecrets(message: string, url: string): string {
  try {
    const parsed = new URL(url);
    const secrets = [
      parsed.password,
      decodeURIComponent(parsed.password),
    ].filter((secret) => secret.length > 0);

    return secrets.reduce(
      (text, secret) => text.split(secret).join("****"),
      message,
    );
  } catch {
    return message;
  }
}

export function parseConnectionInput(value: unknown): ConnectionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid connection payload.");
  }

  const record = value as Record<string, unknown>;
  const { kind } = record;

  if (!isDatabaseKind(kind)) {
    throw new Error("Choose PostgreSQL, MySQL or SQLite.");
  }

  const name =
    typeof record.name === "string" && record.name.trim()
      ? record.name.trim().slice(0, 80)
      : undefined;

  if (typeof record.url === "string") {
    return { kind, name, url: record.url };
  }

  if (kind === "sqlite") {
    if (typeof record.file !== "string") {
      throw new Error("Enter the absolute path of the SQLite file.");
    }

    return { file: record.file, kind, name };
  }

  if (typeof record.host !== "string") {
    throw new Error("Enter a host.");
  }

  const optionalString = (key: string) =>
    typeof record[key] === "string" ? record[key] : undefined;
  const port =
    typeof record.port === "number"
      ? record.port
      : typeof record.port === "string" && record.port.trim()
        ? Number(record.port)
        : undefined;

  return {
    database: optionalString("database"),
    host: record.host,
    kind,
    name,
    password: optionalString("password"),
    port,
    user: optionalString("user"),
  };
}
