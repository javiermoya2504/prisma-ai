import type { Adapter } from "../../../data/adapter";
import { createStudioBFFClient } from "../../../data/bff";
import { createMySQLAdapter } from "../../../data/mysql-core";
import { createPostgresAdapter } from "../../../data/postgres-core";
import { createSQLiteAdapter } from "../../../data/sqlite-core";
import { DEMO_CONNECTION_ID, type PublicConnection } from "./settings";

/** Builds the Studio adapter that matches a connection's database kind. */
export function createConnectionAdapter(
  connection: Pick<PublicConnection, "id" | "kind">,
  options: { queryInsights: boolean },
): Adapter {
  const isDemo = connection.id === DEMO_CONNECTION_ID;
  const queryInsightsEnabled = isDemo && options.queryInsights;
  const bffClient = createStudioBFFClient({
    queryInsights: queryInsightsEnabled,
    url: isDemo
      ? "/api/query"
      : `/api/query?connection=${encodeURIComponent(connection.id)}`,
  });
  const requirements = {
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
