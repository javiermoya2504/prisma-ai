// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionsApi, PublicConnection } from "./client-api";
import {
  ACTIVE_CONNECTION_STORAGE_KEY,
  useDemoConnections,
} from "./use-demo-connections";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const demo: PublicConnection = {
  displayUrl: "demo",
  id: "demo",
  kind: "postgres",
  name: "Demo database",
  source: "demo",
};
const shop: PublicConnection = {
  displayUrl: "mysql://root@localhost:3306/shop",
  id: "shop",
  kind: "mysql",
  name: "shop @ localhost",
  source: "saved",
};

function renderHook(api: ConnectionsApi, demoDatabase = true) {
  const result: { current?: ReturnType<typeof useDemoConnections> } = {};
  function Harness() {
    result.current = useDemoConnections({ api, demoDatabase });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Harness)));
  return { result, root };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function api(list: ConnectionsApi["list"]): ConnectionsApi {
  return {
    detect: vi.fn(),
    list,
    remove: vi.fn(),
    save: vi.fn(),
    test: vi.fn(),
  };
}

describe("useDemoConnections", () => {
  afterEach(() => {
    localStorage.clear();
    window.location.hash = "";
  });

  it("starts on the first connection, then remembers the one the user switches to", async () => {
    const { result, root } = renderHook(api(async () => [demo, shop]));
    await flush();

    expect(result.current?.active?.id).toBe("demo");

    window.location.hash = "#table=users";
    act(() => result.current?.select(shop));

    expect(result.current?.active?.id).toBe("shop");
    expect(localStorage.getItem(ACTIVE_CONNECTION_STORAGE_KEY)).toBe("shop");
    // Table selection from the previous database must not leak into the new one.
    expect(window.location.hash).toBe("");
    act(() => root.unmount());
  });

  it("falls back to the demo database when the server refuses connection management", async () => {
    const { result, root } = renderHook(
      api(async () => {
        throw new Error("Connections can only be managed from this machine.");
      }),
    );
    await flush();

    expect(result.current?.canManage).toBe(false);
    expect(result.current?.connections.map((item) => item.id)).toEqual([
      "demo",
    ]);
    act(() => root.unmount());
  });

  it("moves to another connection when the open one is removed", async () => {
    localStorage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, "shop");
    let list = [demo, shop];
    const { result, root } = renderHook(api(async () => list));
    await flush();
    expect(result.current?.active?.id).toBe("shop");

    list = [demo];
    await act(async () => {
      await result.current?.reload();
    });

    expect(result.current?.active?.id).toBe("demo");
    act(() => root.unmount());
  });
});
