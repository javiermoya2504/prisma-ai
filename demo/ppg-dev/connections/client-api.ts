import type { BackupInfo } from "./backups";
import type { DetectedDatabase } from "./detect";
import type { TableReplicaIdentity } from "./replica-identity";
import type { PublicConnection } from "./settings";
import type { SetupErrorCode } from "./setup-error";

export type {
  BackupInfo,
  DetectedDatabase,
  PublicConnection,
  TableReplicaIdentity,
};

/** Body of POST /api/connections and /api/connections/test. */
export type ConnectionRequestBody =
  | { detectedId: string; readOnly?: boolean }
  | Record<string, string | number | boolean | undefined>;

async function readMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === "string") return payload.message;
  } catch {
    // Fall through to the status text.
  }

  return `Request failed (${response.status})`;
}

export interface ConnectionsApi {
  list(): Promise<PublicConnection[]>;
  detect(): Promise<DetectedDatabase[]>;
  test(body: ConnectionRequestBody): Promise<{ ok: boolean; message?: string }>;
  save(body: ConnectionRequestBody): Promise<PublicConnection>;
  remove(id: string): Promise<void>;
  setLiveHistory(id: string, enabled: boolean): Promise<FeatureToggleResult>;
  setQueryInsights(id: string, enabled: boolean): Promise<FeatureToggleResult>;
  setServerLogs(id: string, enabled: boolean): Promise<FeatureToggleResult>;
  update(
    id: string,
    patch: { readOnly?: boolean; name?: string },
  ): Promise<PublicConnection>;
  listBackups(id: string): Promise<BackupInfo[]>;
  createBackup(id: string): Promise<BackupInfo>;
  restoreBackup(id: string, backupId: string): Promise<PublicConnection>;
  removeBackup(id: string, backupId: string): Promise<void>;
  listReplicaIdentities(id: string): Promise<TableReplicaIdentity[]>;
  setReplicaIdentity(
    id: string,
    table: { schema: string; name: string },
    full: boolean,
  ): Promise<TableReplicaIdentity>;
}

export type FeatureToggleResult =
  | { ok: true; connection: PublicConnection; tableCount?: number }
  | { ok: false; code: SetupErrorCode | "failed"; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createConnectionsApi(
  fetchImplementation: FetchLike = (input, init) => fetch(input, init),
): ConnectionsApi {
  const post = (path: string, body: ConnectionRequestBody) =>
    fetchImplementation(path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

  async function toggleFeature(
    id: string,
    feature: "live-history" | "query-insights" | "server-logs",
    enabled: boolean,
  ): Promise<FeatureToggleResult> {
    const response = await fetchImplementation(
      `/api/connections/${encodeURIComponent(id)}/${feature}`,
      { method: enabled ? "POST" : "DELETE" },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      code?: SetupErrorCode;
      connection?: PublicConnection;
      message?: string;
      tableCount?: number;
    };

    if (!response.ok || !payload.connection) {
      return {
        code: payload.code ?? "failed",
        message: payload.message ?? `Request failed (${response.status})`,
        ok: false,
      };
    }

    return {
      connection: payload.connection,
      ok: true,
      tableCount: payload.tableCount,
    };
  }

  return {
    async list() {
      const response = await fetchImplementation("/api/connections");
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { connections: PublicConnection[] })
        .connections;
    },
    async detect() {
      const response = await fetchImplementation("/api/connections/detect");
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { detected: DetectedDatabase[] })
        .detected;
    },
    async test(body) {
      const response = await post("/api/connections/test", body);
      if (!response.ok)
        return { message: await readMessage(response), ok: false };
      return (await response.json()) as { ok: boolean; message?: string };
    },
    async save(body) {
      const response = await post("/api/connections", body);
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { connection: PublicConnection })
        .connection;
    },
    setLiveHistory: (id, enabled) => toggleFeature(id, "live-history", enabled),
    setQueryInsights: (id, enabled) =>
      toggleFeature(id, "query-insights", enabled),
    setServerLogs: (id, enabled) => toggleFeature(id, "server-logs", enabled),
    async update(id, patch) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}`,
        {
          body: JSON.stringify(patch),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { connection: PublicConnection })
        .connection;
    },
    async listBackups(id) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}/backups`,
      );
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { backups: BackupInfo[] }).backups;
    },
    async createBackup(id) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}/backups`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { backup: BackupInfo }).backup;
    },
    async restoreBackup(id, backupId) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}/restore`,
        { method: "POST" },
      );
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { connection: PublicConnection })
        .connection;
    },
    async removeBackup(id, backupId) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}/backups/${encodeURIComponent(backupId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(await readMessage(response));
    },
    async listReplicaIdentities(id) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}/replica-identity`,
      );
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { tables: TableReplicaIdentity[] })
        .tables;
    },
    async setReplicaIdentity(id, table, full) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}/replica-identity`,
        {
          body: JSON.stringify({ ...table, full }),
          headers: { "content-type": "application/json" },
          method: "PUT",
        },
      );
      if (!response.ok) throw new Error(await readMessage(response));
      return ((await response.json()) as { table: TableReplicaIdentity }).table;
    },
    async remove(id) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(await readMessage(response));
    },
  };
}
