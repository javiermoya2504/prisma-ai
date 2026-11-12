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

## UI

The switcher (`DropdownMenu`) sits in the demo header; management uses a standard ShadCN `Dialog` with `Field`, `Input`, `ToggleGroup`, `Badge`, `Button`, and `Alert`. No non-standard UI composite is introduced.
