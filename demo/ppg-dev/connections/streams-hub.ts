/**
 * One local Prisma Streams server per saved connection, shared by the
 * features that write to it (live history, server logs). It starts when the
 * first feature acquires it and stops when the last one releases it.
 */
export interface StreamsServerHandle {
  url: string;
  close(): Promise<void>;
}

export type StartStreamsServer = (name: string) => Promise<StreamsServerHandle>;

export async function startLocalStreamsServer(
  name: string,
): Promise<StreamsServerHandle> {
  const { startLocalDurableStreamsServer } =
    await import("@prisma/streams-local");
  const server = await startLocalDurableStreamsServer({
    hostname: "127.0.0.1",
    name,
    port: 0,
  });

  return { close: () => server.close(), url: server.exports.http.url };
}

export function createStreamsHub(
  start: StartStreamsServer = startLocalStreamsServer,
) {
  const servers = new Map<
    string,
    { handle: Promise<StreamsServerHandle>; users: Set<string>; url?: string }
  >();

  return {
    async acquire(connectionId: string, user: string): Promise<string> {
      let entry = servers.get(connectionId);

      if (!entry) {
        const handle = start(`studio-connection-${connectionId}`);
        entry = { handle, users: new Set() };
        servers.set(connectionId, entry);
        handle.catch(() => servers.delete(connectionId));
      }

      entry.users.add(user);

      try {
        const { url } = await entry.handle;
        entry.url = url;
        return url;
      } catch (error: unknown) {
        entry.users.delete(user);
        throw error;
      }
    },

    async release(connectionId: string, user: string): Promise<void> {
      const entry = servers.get(connectionId);
      if (!entry) return;

      entry.users.delete(user);
      if (entry.users.size > 0) return;

      servers.delete(connectionId);
      await (await entry.handle).close().catch(() => {});
    },

    /** URL of the running server, or null when no feature uses it. */
    url(connectionId: string): string | null {
      return servers.get(connectionId)?.url ?? null;
    },

    async closeAll(): Promise<void> {
      const entries = [...servers.values()];
      servers.clear();
      await Promise.all(
        entries.map(
          async (entry) => await (await entry.handle).close().catch(() => {}),
        ),
      );
    },
  };
}

export type StreamsHub = ReturnType<typeof createStreamsHub>;

const JSON_HEADERS = {
  connection: "close",
  "content-type": "application/json",
};

/**
 * Batches records and appends them to a stream in order. Failures are logged
 * and do not stop later batches.
 */
export function createStreamAppender(streamUrl: string, label: string) {
  let pending: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let queue = Promise.resolve();

  const flush = () => {
    timer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    queue = queue
      .then(async () => {
        const response = await fetch(streamUrl, {
          body: JSON.stringify(batch),
          headers: JSON_HEADERS,
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status} ${await response.text().catch(() => "")}`,
          );
        }
      })
      .catch((error: unknown) => {
        console.error(`[${label}] append failed`, error);
      });
  };

  return {
    push(records: unknown[]) {
      if (records.length === 0) return;
      pending.push(...records);
      timer ??= setTimeout(flush, 50);
    },
    async close() {
      if (timer) clearTimeout(timer);
      flush();
      await queue;
    },
  };
}
