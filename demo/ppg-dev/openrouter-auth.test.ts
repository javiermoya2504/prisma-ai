// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeOpenRouterLogin,
  startOpenRouterLogin,
} from "./openrouter-auth";

async function sha256Base64Url(input: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("OpenRouter PKCE login", () => {
  it("redirects to OpenRouter with an S256 challenge and a localhost callback", async () => {
    const navigate = vi.fn();
    await startOpenRouterLogin({
      currentUrl: "http://localhost:4310/#view=sql",
      navigate,
      remember: true,
    });

    const target = new URL(navigate.mock.calls[0]![0] as string);
    expect(target.origin + target.pathname).toBe("https://openrouter.ai/auth");
    expect(target.searchParams.get("callback_url")).toBe(
      "http://localhost:4310/",
    );
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    const pending = JSON.parse(
      sessionStorage.getItem("studio-demo-ai:openrouter-login")!,
    );
    expect(target.searchParams.get("code_challenge")).toBe(
      await sha256Base64Url(pending.verifier),
    );
    expect(target.searchParams.get("state")).toBe(pending.state);
    expect(pending).toMatchObject({ remember: true, hash: "#view=sql" });
  });

  it("exchanges the returned code for a key and cleans the URL", async () => {
    sessionStorage.setItem(
      "studio-demo-ai:openrouter-login",
      JSON.stringify({
        verifier: "verifier-1",
        state: "state-1",
        remember: false,
        hash: "#view=sql",
      }),
    );
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ key: "sk-or-new" }));

    const result = await completeOpenRouterLogin({
      currentUrl: "http://localhost:4310/?code=code-1&state=state-1",
      fetchImplementation,
    });

    expect(result).toEqual({
      key: "sk-or-new",
      remember: false,
      cleanUrl: "http://localhost:4310/#view=sql",
    });
    const [target, init] = fetchImplementation.mock.calls[0]!;
    expect(target).toBe("https://openrouter.ai/api/v1/auth/keys");
    expect(JSON.parse(String(init?.body))).toEqual({
      code: "code-1",
      code_verifier: "verifier-1",
      code_challenge_method: "S256",
    });
    expect(
      sessionStorage.getItem("studio-demo-ai:openrouter-login"),
    ).toBeNull();
  });

  it("ignores URLs without a code and rejects a mismatched state", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    await expect(
      completeOpenRouterLogin({
        currentUrl: "http://localhost:4310/#view=sql",
        fetchImplementation,
      }),
    ).resolves.toBeNull();

    sessionStorage.setItem(
      "studio-demo-ai:openrouter-login",
      JSON.stringify({
        verifier: "v",
        state: "expected",
        remember: false,
        hash: "",
      }),
    );
    await expect(
      completeOpenRouterLogin({
        currentUrl: "http://localhost:4310/?code=c&state=forged",
        fetchImplementation,
      }),
    ).rejects.toThrow("OpenRouter sign-in");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
