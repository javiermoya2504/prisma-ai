import {
  buildStudioLlmOutputLimitExceededMessage,
  type StudioLlmRequest,
  type StudioLlmResponse,
} from "../../data/llm";
import { AI_PROVIDERS, type AiSettings } from "./ai-settings";

const MAX_OUTPUT_TOKENS = 8192;

interface ProviderPayload {
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
}

export async function runAiProviderRequest(args: {
  settings: AiSettings;
  request: StudioLlmRequest;
  fetchImplementation?: typeof fetch;
  signal?: AbortSignal;
}): Promise<StudioLlmResponse> {
  const { settings, request, fetchImplementation = fetch } = args;
  const { provider, apiKey, model } = settings;
  const label = AI_PROVIDERS[provider].label;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  let url: string;
  let body: unknown;

  switch (provider) {
    case "openai":
      url = "https://api.openai.com/v1/responses";
      headers.authorization = `Bearer ${apiKey}`;
      body = {
        model,
        input: request.prompt,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      };
      break;
    case "anthropic":
      url = "https://api.anthropic.com/v1/messages";
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: request.prompt }],
      };
      break;
    case "gemini":
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      headers["x-goog-api-key"] = apiKey;
      body = {
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      };
      break;
    case "openrouter":
      url = "https://openrouter.ai/api/v1/chat/completions";
      headers.authorization = `Bearer ${apiKey}`;
      headers["x-title"] = "Prisma Studio";
      body = {
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: "user", content: request.prompt }],
      };
      break;
  }

  try {
    const timeout = AbortSignal.timeout(90_000);
    const response = await fetchImplementation(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: args.signal ? AbortSignal.any([timeout, args.signal]) : timeout,
    });
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? "Check your API key and model access."
          : response.status === 429
            ? "Check your quota or try again later."
            : response.status === 400 || response.status === 404
              ? "Check the model ID and its availability for your account."
              : "Try again later.";
      return {
        ok: false,
        code: "request-failed",
        message: `${label} request failed (${response.status}). ${hint}`,
      };
    }
    const payload = (await response.json()) as ProviderPayload;
    const candidate = payload.candidates?.[0];
    if (
      payload.incomplete_details?.reason === "max_output_tokens" ||
      payload.stop_reason === "max_tokens" ||
      candidate?.finishReason === "MAX_TOKENS" ||
      payload.choices?.[0]?.finish_reason === "length"
    ) {
      return {
        ok: false,
        code: "output-limit-exceeded",
        message: buildStudioLlmOutputLimitExceededMessage({
          maxTokens: MAX_OUTPUT_TOKENS,
          provider: label,
        }),
      };
    }
    let text: string | undefined;
    if (
      provider === "openai" &&
      payload.status !== "failed" &&
      payload.status !== "incomplete"
    ) {
      text = payload.output
        ?.filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((item) => item.type === "output_text")
        .map((item) => item.text ?? "")
        .join("\n");
    } else if (provider === "anthropic") {
      text = payload.content
        ?.filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
    } else if (provider === "openrouter") {
      text = payload.choices?.[0]?.message?.content ?? undefined;
    } else if (provider === "gemini" && candidate?.finishReason === "STOP") {
      text = candidate.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("\n");
    }
    return text?.trim()
      ? { ok: true, text }
      : {
          ok: false,
          code: "request-failed",
          message: `${label} did not return a complete text response. Try rephrasing your request.`,
        };
  } catch {
    return {
      ok: false,
      code: args.signal?.aborted ? "cancelled" : "request-failed",
      message: `${label} request could not complete. Check your connection or try again.`,
    };
  }
}
