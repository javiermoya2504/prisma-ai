import { describe, expect, it, vi } from "vitest";

import { runAiProviderRequest } from "./ai-provider";
import { isAiSettings } from "./ai-settings";

const request = {
  prompt: "Return JSON with SQL",
  task: "sql-generation",
} as const;

describe("AI provider transport", () => {
  it.each([
    [
      "openai",
      "https://api.openai.com/v1/responses",
      {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "SELECT 1" }],
          },
        ],
      },
      "authorization",
      "Bearer test-secret",
    ],
    [
      "anthropic",
      "https://api.anthropic.com/v1/messages",
      { content: [{ type: "text", text: "SELECT 1" }] },
      "x-api-key",
      "test-secret",
    ],
    [
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent",
      {
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: "SELECT 1" }] } },
        ],
      },
      "x-goog-api-key",
      "test-secret",
    ],
    [
      "openrouter",
      "https://openrouter.ai/api/v1/chat/completions",
      {
        choices: [{ finish_reason: "stop", message: { content: "SELECT 1" } }],
      },
      "authorization",
      "Bearer test-secret",
    ],
  ] as const)(
    "routes %s only to its official endpoint",
    async (provider, url, payload, header, key) => {
      const fetchImplementation = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(payload));
      await expect(
        runAiProviderRequest({
          settings: { provider, apiKey: "test-secret", model: "test-model" },
          request,
          fetchImplementation,
        }),
      ).resolves.toEqual({ ok: true, text: "SELECT 1" });
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      const [target, init] = fetchImplementation.mock.calls[0]!;
      expect(target).toBe(url);
      expect(new Headers(init?.headers).get(header)).toBe(key);
      expect(init?.body).toContain(request.prompt);
      expect(init?.body).not.toContain("test-secret");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (provider === "openai")
        expect(JSON.parse(String(init?.body))).toMatchObject({
          store: false,
          model: "test-model",
        });
    },
  );

  it.each([
    [
      "openai",
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    ],
    ["anthropic", { stop_reason: "max_tokens" }],
    ["gemini", { candidates: [{ finishReason: "MAX_TOKENS" }] }],
    ["openrouter", { choices: [{ finish_reason: "length" }] }],
  ] as const)("reports truncated %s output", async (provider, payload) => {
    const result = await runAiProviderRequest({
      settings: { provider, apiKey: "secret", model: "test" },
      request,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json(payload)),
    });
    expect(result).toMatchObject({ ok: false, code: "output-limit-exceeded" });
  });

  it("accepts OpenRouter vendor/model IDs but keeps strict IDs elsewhere", () => {
    expect(
      isAiSettings({
        provider: "openrouter",
        apiKey: "sk-or-1",
        model: "anthropic/claude-haiku-4.5",
      }),
    ).toBe(true);
    expect(
      isAiSettings({ provider: "gemini", apiKey: "k", model: "a/b" }),
    ).toBe(false);
  });

  it("does not expose provider error bodies or credentials", async () => {
    const result = await runAiProviderRequest({
      settings: { provider: "openai", apiKey: "secret", model: "test" },
      request,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: { message: "Invalid key: secret" } },
            { status: 401 },
          ),
        ),
    });
    expect(result).toMatchObject({ ok: false, code: "request-failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).toContain("API key");
  });

  it("rejects empty successful provider responses", async () => {
    const result = await runAiProviderRequest({
      settings: { provider: "gemini", apiKey: "secret", model: "test" },
      request,
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ candidates: [] })),
    });
    expect(result).toMatchObject({ ok: false, code: "request-failed" });
  });
});
