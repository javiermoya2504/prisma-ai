# Database Activity Architecture

This document is normative for the Studio Activity view (`view=activity`) and its optional embedder bridge.

Database activity MUST be provided by the embedder. Studio does not query server internals itself; it renders snapshots from an injected provider, like Query Insights.

## Canonical Components

- [`data/database-activity.ts`](../data/database-activity.ts): `StudioDatabaseActivity`, `StudioDatabaseActivitySnapshot`, `StudioDatabaseSession`
- [`data/adapter.ts`](../data/adapter.ts): `AdapterRequirements.activity`, `Adapter.activity`
- [`data/bff/bff-client.ts`](../data/bff/bff-client.ts): `activity: true` client option, `activity` / `activity-cancel` procedures
- [`ui/studio/context.tsx`](../ui/studio/context.tsx): `activity`, `hasActivity`
- [`ui/hooks/use-navigation.tsx`](../ui/hooks/use-navigation.tsx), [`ui/studio/Navigation.tsx`](../ui/studio/Navigation.tsx)
- [`ui/studio/views/activity/ActivityView.tsx`](../ui/studio/views/activity/ActivityView.tsx)
- Demo provider: [`demo/ppg-dev/connections/pg-activity.ts`](../demo/ppg-dev/connections/pg-activity.ts)

## Embedder Contract

- `Adapter.activity` is optional and is an adapter capability (passed through `AdapterRequirements`), not a top-level Studio prop.
- Studio MUST hide the `Activity` navigation item when it is absent, and a stale `view=activity` URL MUST resolve to the default view.
- `getSnapshot()` returns every client session of the open database: `id` (used for cancelling), `user`, `application`, `clientAddress`, `state`, `query`, `queryStartedAt` (Unix ms), `waitEvent`, and `isStudio` (Studio's own sessions).
- `canCancel` tells Studio whether to offer cancelling (false for read-only connections). The provider MUST also refuse `cancel` itself in that case.
- `cancel(sessionId)` cancels the running statement only (not the session) and returns `{ cancelled: false }` when the session no longer exists.
- `pollingIntervalMs` sets the refresh cadence (default 2 s).

## View Behavior

- The view polls while visible and can be paused. Idle sessions are hidden by default ("Show idle").
- Running time is shown only for `active` sessions. `idle in transaction` is highlighted because it holds locks.
- Cancel is offered only for active, non-Studio sessions when `canCancel` is true, and always goes through a confirmation `AlertDialog`.
- Built from standard ShadCN components (`Table`, `Badge`, `Switch`, `Button`, `AlertDialog`) inside the shared `StudioHeader` layout used by Queries.

## Demo Provider (PostgreSQL)

- Reads `pg_stat_activity` for `datname = current_database()` and `backend_type = 'client backend'`. Studio's sessions use `application_name = 'Prisma Studio'` and are flagged `isStudio`.
- Cancels with `pg_cancel_backend(pid)`, only for pids in the current database.
- Studio's monitoring SQL carries the `/* prisma-studio */` marker right after the first keyword (pg_stat_statements keeps inner comments but drops leading ones), so query insights can exclude it.
