import { serializeError, type StudioBFFRequest } from "../../../data/bff";
import type { Executor } from "../../../data/executor";
import { proxyStreamsRequest } from "../streams-proxy";
import { type BackupService, createBackupService } from "./backups";
import {
  type DetectionResult,
  detectLocalDatabases,
  toDetectedDatabase,
} from "./detect";
import {
  createConnectionPool,
  type OpenConnectionFn,
  openDatabaseConnection,
  testDatabaseConnection,
} from "./drivers";
import { dropPublication, startLiveHistory } from "./live-history";
import { cancelPostgresQuery, getPostgresActivity } from "./pg-activity";
import {
  createPgStatStatementsInsights,
  prepareQueryInsights,
} from "./pg-stat-statements";
import { findPostgresLogFile, startServerLogs } from "./postgres-logs";
import {
  buildConnectionUrl,
  defaultConnectionName,
  DEMO_CONNECTION_ID,
  parseConnectionInput,
  type PublicConnection,
  redactSecrets,
  type StoredConnection,
  toPublicConnection,
} from "./settings";
import { listReplicaIdentities, setReplicaIdentity } from "./replica-identity";
import { SetupError } from "./setup-error";
import type { ConnectionStore } from "./store";
import { createStreamsHub, type StreamsHub } from "./streams-hub";

export const CONNECTIONS_PATH = "/api/connections";

/** Per-connection features that write into the connection's Streams server. */
const STREAM_FEATURES = ["liveHistory", "serverLogs"] as const;
type StreamFeature = (typeof STREAM_FEATURES)[number];
const FEATURE_LABELS: Record<StreamFeature, string> = {
  liveHistory: "Live history",
  serverLogs: "Server logs",
};

interface FeatureSession {
  tableCount?: number;
  stop(): Promise<void>;
}

const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "localhost",
]);

export function isLoopbackAddress(address: string | null | undefined) {
  return address != null && LOOPBACK_ADDRESSES.has(address);
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  return (
    (!origin || origin === new URL(request.url).origin) &&
    request.headers.get("sec-fetch-site") !== "cross-site"
  );
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createConnectionsService(options: {
  store: ConnectionStore;
  demo: { available: boolean; url?: string | null };
  open?: OpenConnectionFn;
  detect?: (excludeUrls: string[]) => Promise<DetectionResult[]>;
  liveHistory?: {
    start: typeof startLiveHistory;
    dropPublication: typeof dropPublication;
  };
  serverLogs?: {
    start: (args: {
      connection: StoredConnection;
      executor: Executor;
      streamsServerUrl: string;
    }) => Promise<FeatureSession>;
  };
  streamsHub?: StreamsHub;
  backups?: BackupService;
}) {
  const backups = options.backups ?? createBackupService();
  const liveHistory = options.liveHistory ?? {
    dropPublication,
    start: startLiveHistory,
  };
  const serverLogs = options.serverLogs ?? {
    start: async ({ connection, executor, streamsServerUrl }) =>
      await startServerLogs({
        logFile: await findPostgresLogFile(executor, connection.url),
        streamsServerUrl,
      }),
  };
  const hub = options.streamsHub ?? createStreamsHub();
  const featureSessions = new Map<string, FeatureSession>();
  const startingFeatures = new Map<string, Promise<FeatureSession>>();
  const featureKey = (feature: StreamFeature, id: string) => `${feature}:${id}`;
  const isRunning = (feature: StreamFeature, id: string) =>
    featureSessions.has(featureKey(feature, id));
  const insightsProviders = new Map<
    string,
    ReturnType<typeof createPgStatStatementsInsights>
  >();
  const insightsFor = (id: string) => {
    let provider = insightsProviders.get(id);
    if (!provider) {
      provider = createPgStatStatementsInsights();
      insightsProviders.set(id, provider);
    }
    return provider;
  };
  const open = options.open ?? openDatabaseConnection;
  const pool = createConnectionPool(open);
  const detect =
    options.detect ??
    ((excludeUrls: string[]) => detectLocalDatabases({ excludeUrls }));
  let lastDetection = new Map<string, DetectionResult>();

  async function listPublic(): Promise<PublicConnection[]> {
    const saved = (await options.store.list()).map(publicOf);

    return options.demo.available
      ? [
          {
            displayUrl: "Built-in sample PostgreSQL (resets on restart)",
            id: DEMO_CONNECTION_ID,
            kind: "postgres",
            liveHistory: false,
            readOnly: false,
            queryInsights: false,
            serverLogs: false,
            name: "Sample data",
            source: "demo",
          },
          ...saved,
        ]
      : saved;
  }

  function resolveCandidate(payload: unknown) {
    const record = (payload ?? {}) as Record<string, unknown>;

    if (typeof record.detectedId === "string") {
      const detected = lastDetection.get(record.detectedId);

      if (!detected) throw new Error("Run detection again and retry.");

      return {
        kind: detected.kind,
        name: detected.name,
        readOnly: record.readOnly === true,
        url: detected.url,
      };
    }

    const input = parseConnectionInput(payload);
    const url = buildConnectionUrl(input);

    return {
      kind: input.kind,
      name: input.name ?? defaultConnectionName(input.kind, url),
      readOnly: record.readOnly === true,
      url,
    };
  }

  /** Public view with what is actually running, not just what was requested. */
  function publicOf(connection: StoredConnection): PublicConnection {
    return {
      ...toPublicConnection(connection),
      liveHistory: isRunning("liveHistory", connection.id),
      serverLogs: isRunning("serverLogs", connection.id),
    };
  }

  async function startFeature(
    feature: StreamFeature,
    connection: StoredConnection,
  ): Promise<FeatureSession> {
    const key = featureKey(feature, connection.id);
    const running = featureSessions.get(key);
    if (running) return running;

    let starting = startingFeatures.get(key);

    if (!starting) {
      starting = (async () => {
        const streamsServerUrl = await hub.acquire(connection.id, feature);

        try {
          const session =
            feature === "liveHistory"
              ? await liveHistory.start({
                  connectionId: connection.id,
                  streamsServerUrl,
                  url: connection.url,
                })
              : await serverLogs.start({
                  connection,
                  executor: pool.get(connection).executor,
                  streamsServerUrl,
                });
          featureSessions.set(key, session);
          return session;
        } catch (error: unknown) {
          await hub.release(connection.id, feature);
          throw error;
        }
      })().finally(() => startingFeatures.delete(key));
      startingFeatures.set(key, starting);
    }

    return await starting;
  }

  async function stopFeature(feature: StreamFeature, id: string) {
    const key = featureKey(feature, id);
    const session = featureSessions.get(key);
    featureSessions.delete(key);
    await session?.stop();
    await hub.release(id, feature);
  }

  /** Restarts live history and server logs for connections that had them on. */
  async function resumeStreamFeatures() {
    for (const connection of await options.store.list()) {
      if (connection.kind !== "postgres") continue;

      for (const feature of STREAM_FEATURES) {
        if (!connection[feature]) continue;

        try {
          await startFeature(feature, connection);
          console.info(
            `[connections] ${FEATURE_LABELS[feature]} resumed for ${connection.name}`,
          );
        } catch (error: unknown) {
          console.warn(
            `[connections] could not resume ${FEATURE_LABELS[feature]} for ${connection.name}: ${redactSecrets(errorMessage(error), connection.url)}`,
          );
        }
      }
    }
  }

  async function handleRequest(
    request: Request,
    context: { remoteAddress: string | null },
  ): Promise<Response> {
    // Connections hold credentials and run arbitrary SQL: local browser only.
    if (!isLoopbackAddress(context.remoteAddress) || !isSameOrigin(request)) {
      return json(
        { message: "Connections can only be managed from this machine." },
        403,
      );
    }

    const url = new URL(request.url);
    const subpath = url.pathname.slice(CONNECTIONS_PATH.length);

    try {
      if (subpath === "" && request.method === "GET") {
        return json({ connections: await listPublic() });
      }

      if (subpath === "/detect" && request.method === "GET") {
        const saved = await options.store.list();
        const results = await detect([
          ...saved.map((connection) => connection.url),
          ...(options.demo.url ? [options.demo.url] : []),
        ]);
        lastDetection = new Map(results.map((result) => [result.id, result]));
        return json({ detected: results.map(toDetectedDatabase) });
      }

      if (subpath === "/test" && request.method === "POST") {
        const candidate = resolveCandidate(await request.json());

        try {
          await testDatabaseConnection(candidate, open);
          return json({ ok: true });
        } catch (error: unknown) {
          return json({
            message: redactSecrets(errorMessage(error), candidate.url),
            ok: false,
          });
        }
      }

      if (subpath === "" && request.method === "POST") {
        const candidate = resolveCandidate(await request.json());

        try {
          await testDatabaseConnection(candidate, open);
        } catch (error: unknown) {
          return json(
            {
              message: `Could not connect: ${redactSecrets(errorMessage(error), candidate.url)}`,
            },
            422,
          );
        }

        const saved = await options.store.add(candidate);
        return json({ connection: toPublicConnection(saved) }, 201);
      }

      const streamsMatch = /^\/([\w-]+)\/streams(?:\/.*)?$/.exec(subpath);

      if (streamsMatch) {
        const id = streamsMatch[1]!;
        return await proxyStreamsRequest({
          basePath: `${CONNECTIONS_PATH}/${id}/streams`,
          request,
          upstreamBaseUrl: hub.url(id),
          url,
        });
      }

      const backupsMatch =
        /^\/([\w-]+)\/backups(?:\/([\w.-]+)(\/restore)?)?$/.exec(subpath);

      if (backupsMatch) {
        const [, connectionId, backupId, restore] = backupsMatch;
        const stored = await options.store.get(connectionId!);

        if (!stored) return json({ message: "Connection not found." }, 404);

        const fail = (error: unknown) =>
          json(
            { message: redactSecrets(errorMessage(error), stored.url) },
            500,
          );

        if (!backupId && request.method === "GET") {
          return json({ backups: await backups.list(stored) });
        }

        if (!backupId && request.method === "POST") {
          try {
            return json({ backup: await backups.create(stored) }, 201);
          } catch (error: unknown) {
            return fail(error);
          }
        }

        if (backupId && restore && request.method === "POST") {
          try {
            const restored = await backups.restore(stored, backupId);
            const saved = await options.store.add({
              kind: stored.kind,
              name: restored.name,
              url: restored.url,
            });
            return json({ connection: toPublicConnection(saved) }, 201);
          } catch (error: unknown) {
            return fail(error);
          }
        }

        if (backupId && !restore && request.method === "DELETE") {
          await backups.remove(stored, backupId);
          return new Response(null, { status: 204 });
        }
      }

      const insightsMatch = /^\/([\w-]+)\/query-insights$/.exec(subpath);

      if (insightsMatch) {
        const stored = await options.store.get(insightsMatch[1]!);

        if (!stored) return json({ message: "Connection not found." }, 404);

        if (stored.kind !== "postgres") {
          return json(
            { message: "Query insights are available for PostgreSQL only." },
            400,
          );
        }

        if (request.method === "POST") {
          try {
            await prepareQueryInsights(pool.get(stored).executor);
          } catch (error: unknown) {
            return json(
              {
                code: error instanceof SetupError ? error.code : "failed",
                message: redactSecrets(errorMessage(error), stored.url),
              },
              error instanceof SetupError ? 409 : 500,
            );
          }
        }

        if (request.method === "POST" || request.method === "DELETE") {
          // Turning it off only hides the view; the extension stays because
          // other tools may rely on it.
          const updated = await options.store.update(stored.id, {
            queryInsights: request.method === "POST",
          });
          return json({ connection: publicOf(updated!) });
        }
      }

      const identityMatch = /^\/([\w-]+)\/replica-identity$/.exec(subpath);

      if (identityMatch) {
        const stored = await options.store.get(identityMatch[1]!);

        if (!stored) return json({ message: "Connection not found." }, 404);

        if (stored.kind !== "postgres") {
          return json(
            { message: "Previous values are available for PostgreSQL only." },
            400,
          );
        }

        const fail = (error: unknown) =>
          json(
            {
              code: error instanceof SetupError ? error.code : "failed",
              message: redactSecrets(errorMessage(error), stored.url),
            },
            error instanceof SetupError ? 409 : 500,
          );

        if (request.method === "GET") {
          try {
            return json({
              tables: await listReplicaIdentities(pool.get(stored).executor),
            });
          } catch (error: unknown) {
            return fail(error);
          }
        }

        if (request.method === "PUT") {
          if (stored.readOnly) {
            return json({ message: "This connection is read-only." }, 403);
          }

          const body = (await request.json()) as Record<string, unknown>;

          if (
            typeof body.schema !== "string" ||
            typeof body.name !== "string" ||
            typeof body.full !== "boolean"
          ) {
            return json({ message: "Expected { schema, name, full }." }, 400);
          }

          try {
            return json({
              table: await setReplicaIdentity(
                pool.get(stored).executor,
                { name: body.name, schema: body.schema },
                body.full,
              ),
            });
          } catch (error: unknown) {
            return fail(error);
          }
        }
      }

      const featureMatch = /^\/([\w-]+)\/(live-history|server-logs)$/.exec(
        subpath,
      );

      if (featureMatch) {
        const feature: StreamFeature =
          featureMatch[2] === "live-history" ? "liveHistory" : "serverLogs";
        const stored = await options.store.get(featureMatch[1]!);

        if (!stored) return json({ message: "Connection not found." }, 404);

        if (stored.kind !== "postgres") {
          return json(
            {
              message: `${FEATURE_LABELS[feature]} is available for PostgreSQL only.`,
            },
            400,
          );
        }

        if (request.method === "POST") {
          try {
            const session = await startFeature(feature, stored);
            const updated = await options.store.update(stored.id, {
              [feature]: true,
            });
            return json({
              connection: publicOf(updated!),
              ...("tableCount" in session
                ? { tableCount: session.tableCount }
                : {}),
            });
          } catch (error: unknown) {
            return json(
              {
                code: error instanceof SetupError ? error.code : "failed",
                message: redactSecrets(errorMessage(error), stored.url),
              },
              error instanceof SetupError ? 409 : 500,
            );
          }
        }

        if (request.method === "DELETE") {
          await stopFeature(feature, stored.id);

          if (feature === "liveHistory") {
            // Leave the user's database exactly as it was before.
            await liveHistory.dropPublication(stored.url).catch(() => {});
          }

          const updated = await options.store.update(stored.id, {
            [feature]: false,
          });
          return json({ connection: publicOf(updated!) });
        }
      }

      const idMatch = /^\/([\w-]+)$/.exec(subpath);

      if (idMatch && request.method === "PATCH") {
        const id = idMatch[1]!;
        const body = (await request.json()) as Record<string, unknown>;
        const patch: Partial<Omit<StoredConnection, "id">> = {};

        if (typeof body.readOnly === "boolean") patch.readOnly = body.readOnly;
        if (typeof body.name === "string" && body.name.trim()) {
          patch.name = body.name.trim().slice(0, 80);
        }

        const updated = await options.store.update(id, patch);

        if (!updated) return json({ message: "Connection not found." }, 404);

        // Reopen with the new mode on the next query.
        await pool.close(id);
        return json({ connection: publicOf(updated) });
      }

      if (idMatch && request.method === "DELETE") {
        const id = idMatch[1]!;
        const stored = await options.store.get(id);

        for (const feature of STREAM_FEATURES) {
          if (isRunning(feature, id)) await stopFeature(feature, id);
        }

        if (stored?.liveHistory) {
          await liveHistory.dropPublication(stored.url).catch(() => {});
        }

        await pool.close(id);
        const removed = await options.store.remove(id);
        return removed
          ? new Response(null, { status: 204 })
          : json({ message: "Connection not found." }, 404);
      }

      return json({ message: "Not Found" }, 404);
    } catch (error: unknown) {
      return json({ message: errorMessage(error) }, 400);
    }
  }

  /** Executes a Studio BFF request against a saved connection. */
  async function handleQuery(
    payload: StudioBFFRequest,
    connectionId: string,
    context: { remoteAddress: string | null },
  ): Promise<Response> {
    if (!isLoopbackAddress(context.remoteAddress)) {
      return new Response("Saved connections are only available locally.", {
        status: 403,
      });
    }

    const stored = await options.store.get(connectionId);

    if (!stored) {
      return new Response("Connection not found", { status: 404 });
    }

    let connection;

    try {
      connection = pool.get(stored);
    } catch (error: unknown) {
      return Response.json([serializeError(error)]);
    }

    const { executor } = connection;

    try {
      switch (payload.procedure) {
        case "query-insights": {
          if (stored.kind !== "postgres" || !stored.queryInsights) {
            return new Response("Invalid procedure", { status: 400 });
          }

          return Response.json([
            null,
            await insightsFor(stored.id).getSnapshot(executor, payload),
          ]);
        }
        case "activity": {
          if (stored.kind !== "postgres") {
            return new Response("Invalid procedure", { status: 400 });
          }

          return Response.json([
            null,
            await getPostgresActivity(executor, {
              canCancel: !stored.readOnly,
            }),
          ]);
        }
        case "activity-cancel": {
          if (stored.kind !== "postgres") {
            return new Response("Invalid procedure", { status: 400 });
          }

          if (stored.readOnly) {
            return Response.json([
              serializeError(
                new Error(
                  "Cancelling queries is disabled on read-only connections.",
                ),
              ),
            ]);
          }

          return Response.json([
            null,
            {
              cancelled: await cancelPostgresQuery(executor, payload.sessionId),
            },
          ]);
        }
        case "query": {
          const [error, result] = await executor.execute(payload.query, {
            schema: payload.schema,
          });
          return Response.json([error ? serializeError(error) : null, result]);
        }
        case "sequence": {
          const [first, second] = payload.sequence;
          const [firstError, firstResult] = await executor.execute(first);

          if (firstError) return Response.json([[serializeError(firstError)]]);

          const [secondError, secondResult] = await executor.execute(second);

          return Response.json(
            secondError
              ? [[null, firstResult], [serializeError(secondError)]]
              : [
                  [null, firstResult],
                  [null, secondResult],
                ],
          );
        }
        case "transaction": {
          if (stored.readOnly) {
            // Studio edits (update/insert/delete) arrive as transactions.
            return Response.json([
              serializeError(
                new Error(
                  "This connection is read-only. Turn off read-only in Manage connections to edit data.",
                ),
              ),
            ]);
          }

          if (typeof executor.executeTransaction !== "function") {
            return new Response("Transaction execution is not supported", {
              status: 501,
            });
          }

          const [error, result] = await executor.executeTransaction(
            payload.queries,
          );
          return Response.json([error ? serializeError(error) : null, result]);
        }
        case "sql-lint": {
          if (!connection.lintSql) {
            // The adapter falls back to EXPLAIN-based linting on this reply.
            return new Response("Invalid procedure", { status: 400 });
          }

          return Response.json([
            null,
            await connection.lintSql({
              schema: payload.schema,
              schemaVersion: payload.schemaVersion,
              sql: payload.sql,
            }),
          ]);
        }
        default:
          return new Response("Invalid procedure", { status: 400 });
      }
    } catch (error: unknown) {
      return Response.json([serializeError(error)]);
    }
  }

  return {
    async closeAll() {
      // Stopping ends the temporary replication slots; publications and the
      // "on" flag stay so history resumes on the next start.
      await Promise.all(
        [...featureSessions.keys()].map((key) => {
          const [feature, id] = key.split(/:(.*)/s) as [StreamFeature, string];
          return stopFeature(feature, id);
        }),
      );
      await hub.closeAll();
      await pool.closeAll();
    },
    handleQuery,
    handleRequest,
    resumeStreamFeatures,
  };
}
