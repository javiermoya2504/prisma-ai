import { Maximize } from "lucide-react";
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

function canUseBrowserFullscreen(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.documentElement.requestFullscreen === "function"
  );
}

function isBrowserFullscreen(): boolean {
  return typeof document !== "undefined" && document.fullscreenElement != null;
}

function DemoFullscreenButton() {
  const [isFullscreen, setIsFullscreen] = useState(() => isBrowserFullscreen());
  const canEnterFullscreen = canUseBrowserFullscreen();

  useEffect(() => {
    if (!canEnterFullscreen) {
      return;
    }

    const handleFullscreenChange = () => {
      setIsFullscreen(isBrowserFullscreen());
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, [canEnterFullscreen]);

  if (!canEnterFullscreen || isFullscreen) {
    return null;
  }

  return (
    <button
      aria-label="Enter demo fullscreen"
      onClick={() => {
        void document.documentElement.requestFullscreen().catch((error) => {
          console.error("Failed to enter browser fullscreen", error);
        });
      }}
      style={{
        alignItems: "center",
        background:
          "light-dark(rgba(255, 255, 255, 0.86), rgba(30, 41, 59, 0.86))",
        border:
          "1px solid light-dark(rgba(15, 23, 42, 0.12), rgba(148, 163, 184, 0.24))",
        borderRadius: "10px",
        color: "light-dark(#0f172a, #e2e8f0)",
        cursor: "pointer",
        display: "inline-flex",
        height: "36px",
        justifyContent: "center",
        width: "36px",
      }}
      type="button"
    >
      <Maximize size={16} />
    </button>
  );
}

const defaultConnectionsApi = createConnectionsApi();

export function DemoApp(props: {
  aiEnabled: boolean;
  aiConfigurable?: boolean;
  bootId: string;
  /** Whether the bundled, seeded demo database is running. */
  demoDatabase: boolean;
  queryInsights?: boolean;
  seededAt?: string;
  streamsUrl?: string;
  connectionsApi?: ConnectionsApi;
  createAdapter?: (connection: PublicConnection) => Adapter;
}) {
  const { aiEnabled, bootId, seededAt, streamsUrl } = props;
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
    <div
      style={{
        background:
          "linear-gradient(165deg, light-dark(#f8fafc, #0b1220) 0%, light-dark(#e2e8f0, #131c2e) 40%, light-dark(#dbeafe, #1a2440) 100%)",
        display: "grid",
        gridTemplateRows: "auto 1fr",
        height: "100vh",
        width: "100%",
      }}
    >
      <header
        style={{
          alignItems: "center",
          backdropFilter: "blur(6px)",
          background:
            "light-dark(rgba(255, 255, 255, 0.86), rgba(15, 23, 42, 0.86))",
          borderBottom:
            "1px solid light-dark(rgba(15, 23, 42, 0.1), rgba(148, 163, 184, 0.2))",
          color: "light-dark(#0f172a, #e2e8f0)",
          display: "flex",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          fontSize: "13px",
          fontWeight: 500,
          gap: "10px",
          justifyContent: "space-between",
          padding: "10px 14px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: "12px",
            letterSpacing: "0.02em",
            minWidth: 0,
          }}
        >
          <strong>Studio + ppg demo</strong>
          {canManage && isLoaded ? (
            <div className="ps">
              <ConnectionSwitcher
                connections={connections}
                activeId={activeId}
                onSelect={select}
                onManage={() => setIsManagerOpen(true)}
              />
            </div>
          ) : null}
          {seededAt && isDemoActive ? (
            <span>seeded {new Date(seededAt).toLocaleString()}</span>
          ) : null}
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: "10px" }}>
          <code style={{ opacity: 0.72 }}>boot: {bootId.slice(0, 8)}</code>
          <DemoFullscreenButton />
        </div>
      </header>
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

      <main
        style={{
          display: "flex",
          minHeight: 0,
          minWidth: 0,
          overflow: "hidden",
          padding: "12px",
        }}
      >
        {isLoaded ? (
          <Studio
            key={activeId ?? "no-database"}
            adapter={adapter}
            aiSettings={aiSettings}
            hasDatabase={activeId != null}
            llm={llm}
            // Demo streams (prisma-wal, observability) describe the bundled
            // database, so they are hidden while one of the user's own
            // databases is open. Streams-only mode (no database) keeps them.
            streamsUrl={
              isDemoActive || activeId == null ? streamsUrl : undefined
            }
          />
        ) : null}
      </main>
    </div>
  );
}
