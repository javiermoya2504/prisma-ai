import { describe, expect, it, vi } from "vitest";

import { handleDemoAiRequest } from "./ai-handler";

const valid = {
  task: "sql-generation",
  prompt: "Generate SQL",
  settings: { provider: "openai", model: "test", apiKey: "test-secret" },
};
const makeRequest = (payload: unknown, origin = "http://localhost:4310") =>
  new Request("http://localhost:4310/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(payload),
  });

describe("AI request boundary", () => {
  it("uses request-scoped credentials without requiring an environment key", async () => {
    const runProvider = vi
      .fn()
      .mockResolvedValue({ ok: true, text: "SELECT 1" });
    const response = await handleDemoAiRequest(makeRequest(valid), {
      enabled: true,
      runProvider,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(runProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: valid.settings,
        request: { task: valid.task, prompt: valid.prompt },
      }),
    );
  });

  it.each([
    null,
    [],
    {},
    { ...valid, task: "unknown" },
    { ...valid, prompt: "" },
    { ...valid, settings: { ...valid.settings, provider: "unknown" } },
    { ...valid, settings: { ...valid.settings, apiKey: "" } },
    { ...valid, settings: { ...valid.settings, model: "../other?key=secret" } },
  ])(
    "rejects invalid payloads before making a paid request",
    async (payload) => {
      const runProvider = vi.fn();
      const response = await handleDemoAiRequest(makeRequest(payload), {
        enabled: true,
        runProvider,
      });
      expect(response.status).toBe(400);
      expect(runProvider).not.toHaveBeenCalled();
    },
  );

  it("respects disabled AI and rejects cross-origin requests", async () => {
    const runProvider = vi.fn();
    expect(
      (
        await handleDemoAiRequest(makeRequest(valid), {
          enabled: false,
          runProvider,
        })
      ).status,
    ).toBe(503);
    expect(
      (
        await handleDemoAiRequest(makeRequest(valid, "https://other.example"), {
          enabled: true,
          runProvider,
        })
      ).status,
    ).toBe(403);
    expect(runProvider).not.toHaveBeenCalled();
  });
});
