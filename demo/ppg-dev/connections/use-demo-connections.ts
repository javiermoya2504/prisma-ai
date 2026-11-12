import { useCallback, useEffect, useState } from "react";

import type { ConnectionsApi, PublicConnection } from "./client-api";
import { DEMO_CONNECTION_ID } from "./settings";

export const ACTIVE_CONNECTION_STORAGE_KEY = "studio-demo:active-connection";

const DEMO_CONNECTION: PublicConnection = {
  displayUrl: "Built-in sample PostgreSQL (resets on restart)",
  id: DEMO_CONNECTION_ID,
  kind: "postgres",
  liveHistory: false,
  readOnly: false,
  queryInsights: false,
  serverLogs: false,
  name: "Sample data",
  source: "demo",
};

function readStoredActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CONNECTION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredActiveId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY);
  } catch {
    // Storage can be unavailable; the choice then lasts for this tab only.
  }
}

/**
 * Loads the server's connection list and tracks which one Studio shows. The
 * choice is remembered per browser; switching resets the URL hash so the new
 * database does not inherit table/view state from the previous one.
 */
export function useDemoConnections(args: {
  api: ConnectionsApi;
  demoDatabase: boolean;
}) {
  const { api, demoDatabase } = args;
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [canManage, setCanManage] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await api.list();
      setConnections(next);
      setCanManage(true);
      return next;
    } catch {
      // Remote viewers (or older servers) only get the bundled demo database.
      const fallback = demoDatabase ? [DEMO_CONNECTION] : [];
      setConnections(fallback);
      setCanManage(false);
      return fallback;
    }
  }, [api, demoDatabase]);

  useEffect(() => {
    let cancelled = false;

    void refresh().then((list) => {
      if (cancelled) return;

      const stored = readStoredActiveId();
      const initial =
        list.find((item) => item.id === stored) ?? list[0] ?? null;
      setActiveId(initial?.id ?? null);
      setIsLoaded(true);
    });

    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const select = useCallback(
    (connection: PublicConnection) => {
      setConnections((previous) =>
        previous.some((item) => item.id === connection.id)
          ? previous
          : [...previous, connection],
      );

      if (activeId !== connection.id) {
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }

      setActiveId(connection.id);
      writeStoredActiveId(connection.id);
    },
    [activeId],
  );

  const reload = useCallback(async () => {
    const list = await refresh();

    setActiveId((previous) => {
      if (previous && list.some((item) => item.id === previous)) {
        return previous;
      }

      const next = list[0]?.id ?? null;
      writeStoredActiveId(next);
      return next;
    });
  }, [refresh]);

  return {
    active: connections.find((item) => item.id === activeId) ?? null,
    canManage,
    connections,
    isLoaded,
    reload,
    select,
  };
}
