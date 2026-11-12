import { serializeError, type StudioBFFRequest } from "../../../data/bff";
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
import {
  buildConnectionUrl,
  defaultConnectionName,
  DEMO_CONNECTION_ID,
  parseConnectionInput,
  type PublicConnection,
  redactSecrets,
  toPublicConnection,
} from "./settings";
import type { ConnectionStore } from "./store";

export const CONNECTIONS_PATH = "/api/connections";

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
}) {
  const open = options.open ?? openDatabaseConnection;
  const pool = createConnectionPool(open);
  const detect =
    options.detect ??
    ((excludeUrls: string[]) => detectLocalDatabases({ excludeUrls }));
  let lastDetection = new Map<string, DetectionResult>();

  async function listPublic(): Promise<PublicConnection[]> {
    const saved = (await options.store.list()).map(toPublicConnection);

    return options.demo.available
      ? [
          {
            displayUrl: "Local Prisma Postgres (seeded, resets on restart)",
            id: DEMO_CONNECTION_ID,
            kind: "postgres",
            name: "Demo database",
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

      return { kind: detected.kind, name: detected.name, url: detected.url };
    }

    const input = parseConnectionInput(payload);
    const url = buildConnectionUrl(input);

    return {
      kind: input.kind,
      name: input.name ?? defaultConnectionName(input.kind, url),
      url,
    };
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

      const idMatch = /^\/([\w-]+)$/.exec(subpath);

      if (idMatch && request.method === "DELETE") {
        const id = idMatch[1]!;
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

  return { closeAll: () => pool.closeAll(), handleQuery, handleRequest };
}
