# Demo Database Connections Architecture

This document is normative for how the local `ppg-dev` demo opens databases other than its bundled, seeded Prisma Postgres instance.

Studio core is unchanged by this subsystem: it still receives exactly one `adapter` per mount. Connection management, credentials, detection, and per-connection query routing all live in the demo host (`demo/ppg-dev/connections/`).

## Scope

- saving PostgreSQL, MySQL, and SQLite connections from the UI (host/user/password fields, a connection URL, or a SQLite file path)
- detecting local databases without user input
- switching the mounted Studio between connections
- routing Studio BFF requests to the selected connection

## Canonical Components

- [`demo/ppg-dev/connections/settings.ts`](../demo/ppg-dev/connections/settings.ts): kinds, URL building/validation, password masking and redaction
- [`demo/ppg-dev/connections/store.ts`](../demo/ppg-dev/connections/store.ts): on-disk store
- [`demo/ppg-dev/connections/drivers.ts`](../demo/ppg-dev/connections/drivers.ts): opens executors (`postgres` + `createPostgresJSExecutor`, `mysql2` pool + `createMySQL2Executor`, `node:sqlite` + `createNodeSQLiteExecutor`)
- [`demo/ppg-dev/connections/detect.ts`](../demo/ppg-dev/connections/detect.ts): local detection
- [`demo/ppg-dev/connections/handler.ts`](../demo/ppg-dev/connections/handler.ts): `/api/connections` routes and saved-connection BFF execution
- [`demo/ppg-dev/connections/create-adapter.ts`](../demo/ppg-dev/connections/create-adapter.ts): picks `createPostgresAdapter` / `createMySQLAdapter` / `createSQLiteAdapter`
- [`demo/ppg-dev/connections/use-demo-connections.ts`](../demo/ppg-dev/connections/use-demo-connections.ts) and [`ConnectionManager.tsx`](../demo/ppg-dev/connections/ConnectionManager.tsx): browser state and UI
- [`demo/ppg-dev/DemoShell.tsx`](../demo/ppg-dev/DemoShell.tsx), [`demo/ppg-dev/server.ts`](../demo/ppg-dev/server.ts)

## Rules

- Credentials MUST stay on the demo server. Saved connections are written to `STUDIO_CONNECTIONS_FILE` (default `~/.prisma-studio-ai/connections.json`) with mode `0600`. The browser only ever receives `PublicConnection` (password masked) and detection results without URLs; detected entries are connected by `detectedId`.
- Connection errors returned to the browser MUST pass through `redactSecrets`.
- `/api/connections*` and `/api/query?connection=<id>` for saved connections MUST only be served to loopback clients (Bun `requestIP`) and same-origin requests, because they hold credentials and run arbitrary SQL. Remote viewers keep the bundled demo database only.
- A connection is saved only after a successful `select 1` test.
- The bundled demo database keeps the id `demo` and the original `/api/query` path, serialized query queue, Query Insights store, and Postgres lint. Saved connections use `/api/query?connection=<id>`; Postgres connections lint server-side through `lintPostgresSql`, MySQL/SQLite reply `Invalid procedure` so the adapters fall back to EXPLAIN linting.
- Opening SQLite MUST NOT create a missing file.
- Detection never saves anything. It probes `localhost` ports 5432–5434 (trying the OS user, then `postgres`, without a password) and 3306–3307 (`root` without a password), lists their databases when that works, otherwise returns a "needs credentials" entry with a form prefill. It also scans `STUDIO_SQLITE_SCAN_DIRS` (default: common project folders in the home directory plus the working directory) for files with the SQLite header, bounded by depth and entry count, and reports `DATABASE_URL`. Already-saved URLs and the demo URL are excluded.
- Switching connections re-mounts `<Studio>` with `key=<connection id>` and a new adapter, clears the URL hash so table/view state does not leak across databases, and remembers the choice in `localStorage` (`studio-demo:active-connection`).
- Demo Streams (prisma-wal, observability) describe the bundled database, so `streamsUrl` is passed only while the demo database is open (or in streams-only mode with no database).

## Monitoring For Saved PostgreSQL Connections

- Every saved PostgreSQL connection's adapter enables the Activity bridge (see [database-activity.md](database-activity.md)). Query insights are enabled when the connection's `queryInsights` flag is on (see [query-insights.md](query-insights.md)).
- The demo re-creates the adapter (`useConnectionAdapter`) when that flag changes and re-mounts Studio, so the Queries item appears and disappears immediately.
- The BFF handler answers `query-insights`, `activity` and `activity-cancel` only for PostgreSQL. Other engines reply `Invalid procedure`.

## Server Logs (`postgres-logs`)

Canonical component: [`demo/ppg-dev/connections/postgres-logs.ts`](../demo/ppg-dev/connections/postgres-logs.ts).

- This feature is opt-in per saved PostgreSQL connection ("Server logs"), and only works for servers on this machine. The log file is found as follows:
  - **Logging collector:** `pg_current_logfile()`, resolved against `data_directory`.
  - **Homebrew launchd log:** `/opt/homebrew/var/log/postgresql@<major>.log`, or the same under `/usr/local`. It is used only when the server's `data_directory` is inside that Homebrew prefix, so a Docker server on the same version and machine never picks up another server's log.
  - When neither is found, the server returns `409 { code: "log-not-found" }`.
- The file is followed from its current end (older lines are not imported), with truncation and rotation handled. Lines are parsed using the default `%m [%p] ` prefix into evlog events `{timestamp, level, severity, message, pid, service: "postgres", environment: "local"}`. DETAIL, HINT, STATEMENT and CONTEXT lines and tab continuations attach to their event.
- Events go to an `evlog`-profile stream named `postgres-logs` on the connection's Streams server.

## Per-Connection Streams Server

[`demo/ppg-dev/connections/streams-hub.ts`](../demo/ppg-dev/connections/streams-hub.ts) owns one `@prisma/streams-local` server per connection (`studio-connection-<id>`). It is shared by live history and server logs:

- Each feature acquires and releases the server.
- The server starts with the first feature and stops with the last.
- `createStreamAppender` batches writes for both features.
- The streams proxy and `streamsUrl` are active while either feature is on.

## Read-Only Connections

- A saved connection can be marked read-only when it is added or later from its actions menu (`PATCH /api/connections/<id>`). The flag is stored with the connection.
- Read-only MUST be enforced by the database session, not only by the UI:
  - PostgreSQL sessions start with `default_transaction_read_only = on`
  - MySQL pooled connections run `SET SESSION TRANSACTION READ ONLY` before serving queries
  - SQLite files are opened with `readOnly: true`
- The server also rejects the BFF `transaction` procedure (Studio's edit path) for read-only connections with a clear message.
- The connection pool keys sessions by URL and mode, so toggling read-only never reuses a writable session.
- In the UI the demo passes `readOnly` to `<Studio>`. Studio's public `readOnly` prop folds into the existing per-table `readonly` (tables without a primary key) in `ActiveTableView`, which disables cell editing and paste, hides Insert row and row deletion, disables the command-palette insert, and shows a "Read-only" badge in the table header.
- A deliberate `SET default_transaction_read_only = off` typed in the SQL editor can still lift the PostgreSQL guard. Read-only protects against mistakes; it is not an access-control boundary. Use a database role without write grants for that.

## Backups

Canonical component: [`demo/ppg-dev/connections/backups.ts`](../demo/ppg-dev/connections/backups.ts).

- Backups are files under `STUDIO_BACKUPS_DIR` (default `~/.prisma-studio-ai/backups/<connection id>/`), created with mode `0700` folders and named `<ISO timestamp>.<ext>`. Only names matching that pattern are accepted from requests, so paths cannot escape the folder.
- Each engine has its own tool:
  - PostgreSQL uses `pg_dump --format=custom --no-owner --no-privileges`
  - MySQL uses `mysqldump --single-transaction --routines --triggers`
  - SQLite uses `VACUUM INTO`, which gives a consistent copy while the file is in use
- Tools are found on `PATH` or in the usual Homebrew locations. A missing tool is reported with its install command.
- Passwords are passed to the CLI tools through `PGPASSWORD` / `MYSQL_PWD`, never on the command line.
- Restoring MUST NOT overwrite the original. It always creates a new database named `<original>_restore_<yyyymmdd>_<hhmmss>` (local time, at most 63 characters) on the same server, or a new SQLite file under `~/.prisma-studio-ai/restores`. It then saves that as a new connection and opens it.
  - PostgreSQL restores use `pg_restore --exit-on-error`, and the new database is dropped again if the restore fails.
- Routes:
  - `GET` and `POST` `/api/connections/<id>/backups`
  - `POST /api/connections/<id>/backups/<backup>/restore`
  - `DELETE /api/connections/<id>/backups/<backup>`
  - All of them follow the same loopback and same-origin rules as the other connection routes.

## Live History (`prisma-wal`) For Saved PostgreSQL Connections

Canonical component: [`demo/ppg-dev/connections/live-history.ts`](../demo/ppg-dev/connections/live-history.ts).

- Live history is opt-in per saved PostgreSQL connection (`liveHistory` flag in the store) and is turned on from the connections dialog. It resumes automatically when the server starts (`resumeLiveHistory`).
- It requires `wal_level = logical`. The server checks this first and returns `409 { code: "wal-level" }` before touching the database; the UI explains the one-time `ALTER SYSTEM` + restart. Studio never changes server configuration or restarts PostgreSQL itself.
- Turning it on (re)creates the publication `prisma_studio_history` with only the tables that have a replica identity (a primary key, `USING INDEX`, or `FULL`). Tables without one MUST NOT be published, because Postgres then rejects UPDATE/DELETE on them.
- Changes are read with postgres.js `subscribe` (pgoutput) over a TEMPORARY replication slot. Postgres drops it when the connection ends, including crashes, so a stopped Studio can never make the server retain WAL.
- History is written to the connection's shared Streams server (see "Per-Connection Streams Server") as a `prisma-wal` stream using the same state-protocol profile, schema, record shape (`type`, `key`, `value`, `old_value`, `headers.operation/timestamp`) and key encoding (`value` or `col=value|col=value`) as `@prisma/dev`. That keeps Studio's table/row history affordances working unchanged. With the default replica identity, updates carry no `old_value` and deletes carry only key columns.
- The browser reaches it through `/api/connections/<id>/streams/*` (loopback + same-origin only), which the demo passes to Studio as `streamsUrl` while that connection is open. Turning live history on or off re-mounts Studio so stream discovery restarts.
- Turning it off stops the subscription and Streams server and drops the publication, leaving the database as it was. Removing the connection does the same.
- Records are keyed by the table's primary key (loaded when live history starts). postgres.js reports every column as an identity column for `REPLICA IDENTITY FULL` tables, so keying by `relation.keys` would turn each update into a delete + insert with a changing key; `relation.keys` is only the fallback for tables without a primary key.
- "Previous values for updates…" ([`replica-identity.ts`](../demo/ppg-dev/connections/replica-identity.ts)) lists tables with a primary key or already FULL (`GET /api/connections/<id>/replica-identity`) and switches one table between `REPLICA IDENTITY FULL` and `DEFAULT` (`PUT { schema, name, full }`). Only listed tables can be changed, read-only connections get `403`, and nothing is applied without the user turning the table's switch on. FULL tables then carry the whole previous row in `old_value`, which Studio renders as a before/after table.
- Both `/api/streams` and the per-connection proxies share [`demo/ppg-dev/streams-proxy.ts`](../demo/ppg-dev/streams-proxy.ts).

## Schema Comparison

Canonical components: [`demo/ppg-dev/connections/schema-compare.ts`](../demo/ppg-dev/connections/schema-compare.ts) and [`demo/ppg-dev/connections/CompareSchemaDialog.tsx`](../demo/ppg-dev/connections/CompareSchemaDialog.tsx).

- "Compare schema…" (connection actions menu) introspects both sides in the browser through the same adapter and BFF route Studio uses (`createConnectionAdapter(...).introspect`), so every database kind works and no new server route exists.
- `introspectionToContract` converts one introspected schema into the contract document `parseContractSnapshot` reads (domain models with field→column bindings, storage tables with native types, nullability, defaults, primary keys; FKs inside the schema as `N:1` relations; enum columns as enums). Models are named by table without schema so differently named schemas (MySQL databases, `public` vs `app`) still match. Introspection has no index data, so index changes are not shown.
- The diff renders with the exported `SchemaDiff` component (Migrations view canvas + schema panel) inside a standard ShadCN `Dialog`; no SQL operations are passed, so no migration SQL is shown. The default target is another saved connection of the same kind.

## UI

The demo has no chrome of its own: `<Studio>` fills the viewport and the page title is "Prisma Studio", so the host reads as a single Studio app.

The database picker is rendered inside Studio through the public `databaseSwitcher?: ReactNode` prop. Studio places that slot at the top of the navigation sidebar, directly above the schema selector (and also when no database is open, so a first connection can be added). The demo fills it with a standard ShadCN `Select` labelled "Database" (same trigger as the "Schema" selector) whose last option opens "Manage connections…". Management uses a standard ShadCN `Dialog` with `Field`, `Input`, `ToggleGroup`, `Badge`, `Button`, and `Alert`; it inherits Studio's `.ps` scope, fonts, and dark mode. No non-standard UI composite is introduced.

The bundled seeded database is listed as "Sample data".
