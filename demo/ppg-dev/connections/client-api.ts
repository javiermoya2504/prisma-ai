import type { DetectedDatabase } from "./detect";
import type { PublicConnection } from "./settings";

export type { DetectedDatabase, PublicConnection };

/** Body of POST /api/connections and /api/connections/test. */
export type ConnectionRequestBody =
  { detectedId: string } | Record<string, string | number | undefined>;

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
}

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
    async remove(id) {
      const response = await fetchImplementation(
        `/api/connections/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error(await readMessage(response));
    },
  };
}
