import type { Adapter } from "../../../data/adapter";
import { createStudioBFFClient } from "../../../data/bff";
import { createMySQLAdapter } from "../../../data/mysql-core";
import { createPostgresAdapter } from "../../../data/postgres-core";
import { createSQLiteAdapter } from "../../../data/sqlite-core";
import { DEMO_CONNECTION_ID, type PublicConnection } from "./settings";

/**
 * Builds the Studio adapter that matches a connection's database kind.
 * The bundled database keeps its in-process query capture; saved PostgreSQL
 * connections get live Activity and, when turned on, pg_stat_statements-based
 * query insights.
 */
export function createConnectionAdapter(
  connection: Pick<PublicConnection, "id" | "kind" | "queryInsights">,
  options: { queryInsights: boolean },
): Adapter {
  const isDemo = connection.id === DEMO_CONNECTION_ID;
  const isSavedPostgres = !isDemo && connection.kind === "postgres";
  const queryInsightsEnabled = isDemo
    ? options.queryInsights
    : isSavedPostgres && connection.queryInsights;
  const bffClient = createStudioBFFClient({
    activity: isSavedPostgres,
    queryInsights: queryInsightsEnabled,
    url: isDemo
      ? "/api/query"
      : `/api/query?connection=${encodeURIComponent(connection.id)}`,
  });
  const requirements = {
    activity: bffClient.activity,
    executor: bffClient,
    queryInsights: queryInsightsEnabled ? bffClient.queryInsights : undefined,
  };

  switch (connection.kind) {
    case "postgres":
      return createPostgresAdapter(requirements);
    case "mysql":
      return createMySQLAdapter(requirements);
    case "sqlite":
      return createSQLiteAdapter(requirements);
  }
}
