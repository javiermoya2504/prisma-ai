import { useEffect, useMemo, useState } from "react";

import type { Adapter } from "../../data/adapter";
import { Studio } from "../../ui";
import {
  type ConnectionsApi,
  createConnectionsApi,
} from "./connections/client-api";
import {
  ConnectionsDialog,
  ConnectionSwitcher,
} from "./connections/ConnectionManager";
import { createConnectionAdapter } from "./connections/create-adapter";
import {
  DEMO_CONNECTION_ID,
  type PublicConnection,
} from "./connections/settings";
import { useDemoConnections } from "./connections/use-demo-connections";
import { createNoDatabaseAdapter } from "./no-database-adapter";
import { useDemoAi } from "./use-demo-ai";

const defaultConnectionsApi = createConnectionsApi();

export function DemoApp(props: {
  aiEnabled: boolean;
  aiConfigurable?: boolean;
  /** Whether the bundled, seeded demo database is running. */
  demoDatabase: boolean;
  queryInsights?: boolean;
  streamsUrl?: string;
  connectionsApi?: ConnectionsApi;
  createAdapter?: (connection: PublicConnection) => Adapter;
}) {
  const { aiEnabled, streamsUrl } = props;
  const queryInsights = props.queryInsights ?? props.demoDatabase;
  const createAdapter =
    props.createAdapter ??
    ((connection: PublicConnection) =>
      createConnectionAdapter(connection, { queryInsights }));
  const { llm, aiSettings } = useDemoAi({
    enabled: aiEnabled,
    configurable: props.aiConfigurable ?? true,
  });
  const connectionsApi = props.connectionsApi ?? defaultConnectionsApi;
  const { active, canManage, connections, isLoaded, reload, select } =
    useDemoConnections({
      api: connectionsApi,
      demoDatabase: props.demoDatabase,
    });
  const [isManagerOpen, setIsManagerOpen] = useState(false);
  const activeId = active?.id ?? null;
  const activeKind = active?.kind;
  // Adapter identity must only change when the connection does; Studio is
  // re-mounted per connection (see `key` below) so caches never mix.
  const adapter = useMemo(
    () =>
      activeId && activeKind
        ? createAdapter({ ...active })
        : createNoDatabaseAdapter(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, activeKind],
  );
  const isDemoActive = activeId === DEMO_CONNECTION_ID;

  useEffect(() => {
    if (isLoaded && canManage && connections.length === 0) {
      setIsManagerOpen(true);
    }
  }, [canManage, connections.length, isLoaded]);

  return (
    <main
      style={{
        display: "flex",
        height: "100vh",
        minHeight: 0,
        minWidth: 0,
        overflow: "hidden",
        width: "100%",
      }}
    >
      {canManage ? (
        <ConnectionsDialog
          open={isManagerOpen}
          onOpenChange={setIsManagerOpen}
          api={connectionsApi}
          connections={connections}
          activeId={activeId}
          onOpenConnection={select}
          onConnectionsChanged={reload}
        />
      ) : null}
      {isLoaded ? (
        <Studio
          key={activeId ?? "no-database"}
          adapter={adapter}
          aiSettings={aiSettings}
          databaseSwitcher={
            canManage ? (
              <ConnectionSwitcher
                connections={connections}
                activeId={activeId}
                onSelect={select}
                onManage={() => setIsManagerOpen(true)}
              />
            ) : undefined
          }
          hasDatabase={activeId != null}
          llm={llm}
          // Bundled-database streams (prisma-wal, observability) are hidden
          // while one of the user's own databases is open. Streams-only mode
          // (no database) keeps them.
          streamsUrl={isDemoActive || activeId == null ? streamsUrl : undefined}
        />
      ) : null}
    </main>
  );
}
