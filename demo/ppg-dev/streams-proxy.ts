/**
 * Forwards a Studio Streams request (`{basePath}/...`) to a Prisma Streams
 * server. Shared by the bundled database's `/api/streams` proxy and the
 * per-connection live-history proxies.
 */
export async function proxyStreamsRequest(args: {
  request: Request;
  url: URL;
  basePath: string;
  upstreamBaseUrl: string | null;
}): Promise<Response> {
  const { basePath, request, upstreamBaseUrl, url } = args;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: { Allow: "GET,HEAD,POST,OPTIONS" },
      status: 204,
    });
  }

  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.method !== "POST"
  ) {
    return new Response("Method Not Allowed", {
      headers: { Allow: "GET,HEAD,POST,OPTIONS" },
      status: 405,
    });
  }

  if (!upstreamBaseUrl) {
    return new Response("Streams server is not ready", { status: 503 });
  }

  const proxyPathname = url.pathname.slice(basePath.length);
  const normalizedPathname = proxyPathname.length > 0 ? proxyPathname : "/";
  const upstreamUrl = new URL(
    `${normalizedPathname}${url.search}`,
    `${upstreamBaseUrl.replace(/\/+$/, "")}/`,
  );
  const headers = new Headers(request.headers);
  const body =
    request.method === "POST" ? await request.arrayBuffer() : undefined;

  headers.delete("host");

  const response = await fetch(upstreamUrl, {
    body,
    headers,
    method: request.method,
    redirect: "manual",
    signal: request.signal,
  });
  const responseHeaders = new Headers(response.headers);

  responseHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

  return new Response(response.body, {
    headers: responseHeaders,
    status: response.status,
    statusText: response.statusText,
  });
}
