// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Adapter } from "../../data/adapter";

const studioMock = vi.fn((props: Record<string, unknown>) => {
  return createElement("div", {
    "data-llm": typeof props.llm,
    "data-testid": "studio-stub",
  });
});

vi.mock("../../ui", () => ({
  Studio: (props: Record<string, unknown>) => {
    studioMock(props);
    return createElement("div", { "data-testid": "studio-stub" });
  },
}));

import type { ConnectionsApi } from "./connections/client-api";
import { DemoApp } from "./DemoShell";

const demoConnection = {
  displayUrl: "Local Prisma Postgres",
  id: "demo",
  kind: "postgres",
  name: "Demo database",
  source: "demo",
} as const;

function createConnectionsApiStub(
  connections: Awaited<ReturnType<ConnectionsApi["list"]>>,
): ConnectionsApi {
  return {
    detect: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue(connections),
    remove: vi.fn(),
    save: vi.fn(),
    test: vi.fn(),
  };
}

async function flushConnections() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("DemoApp", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    studioMock.mockClear();
  });

  it("renders Studio full-bleed with the database switcher inside Studio and no demo chrome", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(DemoApp, {
          aiEnabled: false,
          connectionsApi: createConnectionsApiStub([demoConnection]),
          createAdapter: () => ({}) as Adapter,
          demoDatabase: true,
          streamsUrl: "/api/streams",
        }),
      );
    });
    await flushConnections();

    expect(container.querySelector("header")).toBeNull();
    expect(container.textContent).not.toContain("demo");
    expect(
      container.querySelector('[data-testid="studio-stub"]'),
    ).not.toBeNull();
    expect(container.querySelector("main")?.style.height).toBe("100vh");
    const studioProps = studioMock.mock.calls.at(-1)?.[0];
    expect(studioProps).toEqual(
      expect.objectContaining({ streamsUrl: "/api/streams" }),
    );
    expect(studioProps?.databaseSwitcher).toBeTruthy();

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("starts without a database when none is available", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(DemoApp, {
          aiEnabled: false,
          connectionsApi: createConnectionsApiStub([]),
          createAdapter: () => ({}) as Adapter,
          demoDatabase: false,
          streamsUrl: "/api/streams",
        }),
      );
    });
    await flushConnections();

    expect(studioMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        hasDatabase: false,
      }),
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("returns a structured output-limit error through the shared llm hook", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "output-limit-exceeded",
          message:
            "Anthropic stopped because it reached the configured output limit of 2048 tokens before finishing the response.",
          ok: false,
        }),
        {
          headers: {
            "content-type": "application/json",
          },
          status: 200,
        },
      ),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(DemoApp, {
          aiEnabled: true,
          connectionsApi: createConnectionsApiStub([demoConnection]),
          createAdapter: () => ({}) as Adapter,
          demoDatabase: true,
          streamsUrl: "/api/streams",
        }),
      );
    });
    await flushConnections();

    const studioProps = studioMock.mock.calls.at(-1)?.[0] as
      | {
          llm?: (request: {
            prompt: string;
            task: "sql-generation";
          }) => Promise<unknown>;
        }
      | undefined;

    if (typeof studioProps?.llm !== "function") {
      throw new Error("Expected llm prop");
    }

    const response = await studioProps.llm({
      prompt: "Generate a chart",
      task: "sql-generation",
    });

    expect(response).toEqual({
      code: "output-limit-exceeded",
      message:
        "Anthropic stopped because it reached the configured output limit of 2048 tokens before finishing the response.",
      ok: false,
    });

    fetchSpy.mockRestore();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("opens the remembered connection with an adapter for its database kind", async () => {
    localStorage.setItem("studio-demo:active-connection", "saved-1");
    window.location.hash = "#table=students";
    const savedConnection = {
      displayUrl: "/data/school.db",
      id: "saved-1",
      kind: "sqlite",
      name: "school.db",
      source: "saved",
    } as const;
    const createAdapter = vi.fn(() => ({}) as Adapter);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(DemoApp, {
          aiEnabled: false,
          connectionsApi: createConnectionsApiStub([
            demoConnection,
            savedConnection,
          ]),
          createAdapter,
          demoDatabase: true,
          streamsUrl: "/api/streams",
        }),
      );
    });
    await flushConnections();

    expect(createAdapter).toHaveBeenLastCalledWith(savedConnection);
    expect(studioMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ hasDatabase: true }),
    );
    // Bundled-database streams are hidden for the user's own databases.
    expect(studioMock.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ streamsUrl: undefined }),
    );

    act(() => {
      root.unmount();
    });
    container.remove();
    localStorage.removeItem("studio-demo:active-connection");
  });
});
