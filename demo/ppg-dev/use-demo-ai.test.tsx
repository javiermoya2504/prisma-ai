// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDemoAi } from "./use-demo-ai";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("activates each provider, keeps keys only in memory, and forgets all credentials", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ ok: true, text: "SELECT 1" }));
  let current: ReturnType<typeof useDemoAi>;
  function Harness() {
    current = useDemoAi({ enabled: false, configurable: true });
    return current.aiSettings;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  const click = (label: string) =>
    act(() => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === label)
        ?.click();
    });
  expect(current!.llm).toBeUndefined();
  for (const [provider, label] of [
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
    ["gemini", "Gemini"],
  ]) {
    click(label!);
    const input = container.querySelector<HTMLInputElement>("#studio-ai-key")!;
    expect(input.type).toBe("password");
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, `secret-${provider}`);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    expect(container.textContent).toContain("Active for this session");
    await current!.llm!({ prompt: "query", task: "sql-generation" });
    const sent = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
    expect(sent.settings).toMatchObject({
      provider,
      apiKey: `secret-${provider}`,
    });
  }
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
  click("Forget keys");
  expect(current!.llm).toBeUndefined();
  expect(
    container.querySelector<HTMLInputElement>("#studio-ai-key")!.value,
  ).toBe("");
  click("OpenAI");
  expect(
    container.querySelector<HTMLInputElement>("#studio-ai-key")!.value,
  ).toBe("");
  act(() => root.unmount());
  container.remove();
});

describe("AI disabled by host", () => {
  it("exposes neither the settings nor a transport", () => {
    let current: ReturnType<typeof useDemoAi>;
    function Harness() {
      current = useDemoAi({ enabled: false, configurable: false });
      return current.aiSettings;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Harness />));
    expect(current!.llm).toBeUndefined();
    expect(current!.aiSettings).toBeUndefined();
    act(() => root.unmount());
  });
});

function renderDemoAi(navigate?: (url: string) => void) {
  const state: { current?: ReturnType<typeof useDemoAi> } = {};
  function Harness() {
    state.current = useDemoAi({ enabled: false, configurable: true, navigate });
    return state.current.aiSettings;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  const click = (label: string) =>
    act(() => {
      Array.from(container.querySelectorAll("button"))
        .find(
          (button) =>
            button.textContent === label ||
            button.getAttribute("aria-label") === label,
        )
        ?.click();
    });
  return {
    click,
    container,
    state,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function typeKey(container: HTMLElement, value: string) {
  const input = container.querySelector<HTMLInputElement>("#studio-ai-key")!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit(container: HTMLElement) {
  act(() => {
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("remember on this device", () => {
  it("restores the active key after a reload and forgets it on request", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ ok: true, text: "SELECT 1" }));
    const first = renderDemoAi();
    first.click("Anthropic");
    typeKey(first.container, "secret-remembered");
    first.click("Remember on this device");
    submit(first.container);
    expect(localStorage.getItem("studio-demo-ai:credentials")).toContain(
      "secret-remembered",
    );
    first.unmount();

    const second = renderDemoAi();
    expect(second.state.current!.llm).toBeDefined();
    await second.state.current!.llm!({ prompt: "q", task: "sql-generation" });
    expect(
      JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)).settings,
    ).toMatchObject({ provider: "anthropic", apiKey: "secret-remembered" });

    second.click("Forget keys");
    expect(localStorage.getItem("studio-demo-ai:credentials")).toBeNull();
    expect(second.state.current!.llm).toBeUndefined();
    second.unmount();
  });
});

describe("OpenRouter sign-in", () => {
  it("starts the OAuth redirect from the Connect button", async () => {
    const navigate = vi.fn();
    const view = renderDemoAi(navigate);
    view.click("OpenRouter");
    await act(async () => {
      Array.from(view.container.querySelectorAll("button"))
        .find((button) => button.textContent === "Connect with OpenRouter")!
        .click();
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled());
    expect(String(navigate.mock.calls[0]?.[0])).toMatch(
      /^https:\/\/openrouter\.ai\/auth\?/,
    );
    view.unmount();
  });

  it("activates OpenRouter when returning from the OAuth callback", async () => {
    history.replaceState(null, "", "/?code=code-1&state=state-1#view=sql");
    sessionStorage.setItem(
      "studio-demo-ai:openrouter-login",
      JSON.stringify({
        verifier: "verifier-1",
        state: "state-1",
        remember: false,
        hash: "#view=sql",
      }),
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        String(input).includes("openrouter.ai")
          ? Response.json({ key: "sk-or-new" })
          : Response.json({ ok: true, text: "SELECT 1" }),
      );
    const view = renderDemoAi();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(location.search).toBe("");
    expect(location.hash).toBe("#view=sql");
    expect(view.container.textContent).toContain("Active for this session");
    await view.state.current!.llm!({ prompt: "q", task: "sql-generation" });
    expect(
      JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body)).settings,
    ).toMatchObject({ provider: "openrouter", apiKey: "sk-or-new" });
    expect(localStorage.getItem("studio-demo-ai:credentials")).toBeNull();
    view.unmount();
  });
});
