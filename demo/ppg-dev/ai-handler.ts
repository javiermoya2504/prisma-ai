import {
  STUDIO_LLM_TASKS,
  type StudioLlmResponse,
  type StudioLlmTask,
} from "../../data/llm";
import { runAiProviderRequest } from "./ai-provider";
import { type AiSettings, isAiSettings } from "./ai-settings";

export async function handleDemoAiRequest(
  request: Request,
  options: {
    enabled: boolean;
    defaultSettings?: AiSettings;
    runProvider?: typeof runAiProviderRequest;
  },
): Promise<Response> {
  const respond = (body: StudioLlmResponse, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const fail = (message: string, status: number) =>
    respond({ ok: false, code: "request-failed", message }, status);
  if (request.method !== "POST") return fail("Method Not Allowed", 405);
  const origin = request.headers.get("origin");
  if (
    (origin && origin !== new URL(request.url).origin) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    return fail("Cross-origin AI requests are not allowed.", 403);
  if (!options.enabled)
    return respond(
      {
        ok: false,
        code: "not-configured",
        message: "Studio AI is disabled by the server.",
      },
      503,
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return fail("Expected application/json.", 415);
  let payload: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 1_000_000) return fail("AI request is too large.", 413);
    payload = JSON.parse(raw) as unknown;
  } catch {
    return fail("Invalid JSON payload.", 400);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return fail("Invalid AI request.", 400);
  const {
    prompt,
    task,
    settings: suppliedSettings,
  } = payload as { prompt?: unknown; task?: unknown; settings?: unknown };
  if (
    typeof prompt !== "string" ||
    !prompt.trim() ||
    typeof task !== "string" ||
    !STUDIO_LLM_TASKS.includes(task as StudioLlmTask)
  )
    return fail("A prompt and supported task are required.", 400);
  const settings =
    suppliedSettings === undefined ? options.defaultSettings : suppliedSettings;
  if (!isAiSettings(settings))
    return fail(
      "Select a provider and enter a valid model ID and API key.",
      400,
    );
  const result = await (options.runProvider ?? runAiProviderRequest)({
    settings,
    request: { prompt, task: task as StudioLlmTask },
    signal: request.signal,
  });
  return respond(result, result.ok ? 200 : 502);
}
