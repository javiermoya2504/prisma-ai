import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  StudioDatabaseActivity,
  StudioDatabaseActivitySnapshot,
} from "../../../../data/database-activity";

let activity: StudioDatabaseActivity | undefined;

vi.mock("../../context", () => ({
  useStudio: () => ({
    activity,
    isNavigationOpen: true,
    toggleNavigation: vi.fn(),
  }),
}));

import { ActivityView, formatSessionDuration } from "./ActivityView";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: StudioDatabaseActivitySnapshot = {
  canCancel: true,
  generatedAt: 10_000,
  pollingIntervalMs: 60_000,
  sessions: [
    {
      application: "grades-api",
      clientAddress: "127.0.0.1",
      id: "4242",
      isStudio: false,
      query: "select pg_sleep(30)",
      queryStartedAt: 7_500,
      state: "active",
      user: "javier",
      waitEvent: "Timeout: PgSleep",
    },
    {
      application: "Prisma Studio",
      clientAddress: null,
      id: "1",
      isStudio: true,
      query: "select * from pg_stat_activity",
      queryStartedAt: 9_990,
      state: "active",
      user: "javier",
      waitEvent: null,
    },
    {
      application: "psql",
      clientAddress: null,
      id: "77",
      isStudio: false,
      query: "select 1",
      queryStartedAt: 1_000,
      state: "idle",
      user: "javier",
      waitEvent: null,
    },
  ],
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("ActivityView", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("formats how long a statement has been running", () => {
    expect(formatSessionDuration(1_000, 1_250)).toBe("250 ms");
    expect(formatSessionDuration(0, 2_500)).toBe("2.5 s");
    expect(formatSessionDuration(0, 180_000)).toBe("3 min");
    expect(formatSessionDuration(null, 1)).toBe("—");
  });

  it("lists running sessions, hides idle ones, and cancels only after confirmation", async () => {
    const cancel = vi.fn(() =>
      Promise.resolve([null, { cancelled: true }] as const),
    );
    activity = {
      cancel,
      getSnapshot: vi.fn(() => Promise.resolve([null, snapshot] as const)),
    } as unknown as StudioDatabaseActivity;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => root.render(<ActivityView />));
    await flush();

    const rows = container.querySelectorAll('[data-testid="activity-session"]');
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain("select pg_sleep(30)");
    expect(container.textContent).toContain("2.5 s");
    expect(container.textContent).not.toContain("psql");

    // Studio's own session cannot be cancelled from here.
    const cancelButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((button) => button.textContent === "Cancel");
    expect(cancelButtons).toHaveLength(1);

    act(() => cancelButtons[0]!.click());
    await flush();
    expect(cancel).not.toHaveBeenCalled();

    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Cancel query",
    );
    act(() => confirm!.click());
    await flush();

    expect(cancel).toHaveBeenCalledWith("4242");
    expect(container.textContent).toContain(
      "Cancelled the query in session 4242.",
    );

    act(() => root.unmount());
  });
});
