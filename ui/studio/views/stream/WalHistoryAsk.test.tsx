import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WalHistoryAsk } from "./WalHistoryAsk";

const requestLlm =
  vi.fn<(request: { prompt: string; task: string }) => Promise<string>>();
let hasAiChangeHistory = true;

vi.mock("../../context", () => ({
  useStudio: () => ({ hasAiChangeHistory, requestLlm }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <WalHistoryAsk
        events={[{ body: { key: "1", type: "public.students" } }]}
        scope="table public.students"
      />,
    );
  });
  return {
    container,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function typeQuestion(container: HTMLElement, value: string) {
  const input = container.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("WalHistoryAsk", () => {
  afterEach(() => {
    requestLlm.mockReset();
    hasAiChangeHistory = true;
  });

  it("asks the AI about the loaded changes and shows the answer", async () => {
    requestLlm.mockResolvedValue("Ada was inserted at 10:00.");
    const { container, cleanup } = render();

    typeQuestion(container, "Who was added?");
    await act(async () => {
      container.querySelector("form")!.requestSubmit();
      await Promise.resolve();
    });

    expect(requestLlm).toHaveBeenCalledWith(
      expect.objectContaining({ task: "change-history" }),
    );
    expect(requestLlm.mock.calls[0]?.[0].prompt).toContain("Who was added?");
    expect(container.textContent).toContain("Ada was inserted at 10:00.");
    expect(container.textContent).toContain(
      "Based on the 1 most recent change",
    );
    cleanup();
  });

  it("renders nothing when no AI provider is configured", () => {
    hasAiChangeHistory = false;
    const { container, cleanup } = render();
    expect(container.innerHTML).toBe("");
    cleanup();
  });
});
