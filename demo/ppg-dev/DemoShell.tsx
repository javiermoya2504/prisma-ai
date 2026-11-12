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

/**
 * Adapter for the open connection. Its identity changes only when the
 * connection or an adapter capability (query insights) changes; Studio is
 * re-mounted with it (see `key` in DemoApp) so caches never mix.
 */
export function useConnectionAdapter(
  active: PublicConnection | null,
  createAdapter: (connection: PublicConnection) => Adapter,
): Adapter {
  const id = active?.id;
  const kind = active?.kind;
  const queryInsights = active?.queryInsights === true;

  return useMemo(
    () => (active ? createAdapter({ ...active }) : createNoDatabaseAdapter()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, kind, queryInsights],
  );
}

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
  const adapter = useConnectionAdapter(active, createAdapter);
  const isDemoActive = activeId === DEMO_CONNECTION_ID;
  // The bundled database keeps its own Streams (prisma-wal, observability);
  // the user's Postgres databases get their own Streams server once live
  // history or server logs are on; streams-only mode keeps the bundled one.
  const activeStreamsUrl =
    isDemoActive || activeId == null
      ? streamsUrl
      : active?.liveHistory || active?.serverLogs
        ? `/api/connections/${encodeURIComponent(activeId)}/streams`
        : undefined;

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
          // Re-mount when live history toggles so Streams discovery restarts.
          key={`${activeId ?? "no-database"}:${active?.liveHistory ? "history" : ""}:${active?.readOnly ? "ro" : "rw"}:${active?.queryInsights ? "qi" : ""}:${active?.serverLogs ? "logs" : ""}`}
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
          readOnly={active?.readOnly === true}
          llm={llm}
          streamsUrl={activeStreamsUrl}
        />
      ) : null}
    </main>
  );
}
