import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeModeToggle } from "./ThemeModeToggle";

const setThemeModeSpy = vi.fn();
let studioState = { isDarkMode: false, themeMode: "system" };

vi.mock("./context", () => ({
  useStudio: () => ({ ...studioState, setThemeMode: setThemeModeSpy }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function pointerDownLeft(element: Element) {
  const PointerEventConstructor =
    globalThis.PointerEvent ?? globalThis.MouseEvent;

  element.dispatchEvent(
    new PointerEventConstructor("pointerdown", {
      bubbles: true,
      button: 0,
      cancelable: true,
      ctrlKey: false,
    }),
  );
}

describe("ThemeModeToggle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setThemeModeSpy.mockClear();
    studioState = { isDarkMode: false, themeMode: "system" };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("lets the user pick light, dark or system from a visible button", () => {
    act(() => root.render(<ThemeModeToggle />));

    const trigger = container.querySelector(
      '[data-testid="studio-theme-toggle"]',
    );
    expect(trigger?.getAttribute("aria-label")).toBe("Theme");

    act(() => pointerDownLeft(trigger!));

    const items = [
      ...document.querySelectorAll('[role="menuitemradio"]'),
    ] as HTMLElement[];
    expect(items.map((item) => item.textContent)).toEqual([
      "Light",
      "Dark",
      "System",
    ]);
    expect(
      items.find((item) => item.textContent === "System")?.dataset.state,
    ).toBe("checked");

    act(() => items.find((item) => item.textContent === "Dark")!.click());

    expect(setThemeModeSpy).toHaveBeenCalledWith("dark");
  });

  it("shows the moon icon while dark mode is active", () => {
    studioState = { isDarkMode: true, themeMode: "dark" };
    act(() => root.render(<ThemeModeToggle />));

    expect(
      container
        .querySelector('[data-testid="studio-theme-toggle"] svg')
        ?.classList.contains("lucide-moon"),
    ).toBe(true);
  });
});
