import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  useLiveTableRefresh,
  type UseLiveTableRefreshResult,
  walRecordsTouchTable,
} from "./use-live-table-refresh";
import { encodeStreamOffset } from "./use-stream-events";

vi.mock("../studio/context", () => ({
  useStudio: () => ({ streamsUrl: "http://streams.test" }),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TABLE = { name: "students", schema: "public" };

function streamItem(name: string, nextOffset: string) {
  return {
    created_at: "2026-11-12T00:00:00.000Z",
    epoch: 0,
    expires_at: null,
    name,
    next_offset: nextOffset,
    sealed_through: "-1",
    uploaded_through: "-1",
  };
}

interface FakeServer {
  offset: string;
  hasWal: boolean;
  batches: Map<string, unknown[]>;
  reads: string[];
}

function installFetch(server: FakeServer) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = new URL(String(input));

      if (url.pathname === "/v1/streams") {
        return Promise.resolve(
          Response.json(
            server.hasWal ? [streamItem("prisma-wal", server.offset)] : [],
          ),
        );
      }

      // Like Prisma Streams: reads take encoded offsets (the event count
      // before the batch, as an exclusive start sequence).
      const offset = url.searchParams.get("offset") ?? "";
      const count = [...server.batches.keys()].find(
        (key) => encodeStreamOffset(0, BigInt(key) - 1n) === offset,
      );

      if (count === undefined) {
        return Promise.resolve(
          Response.json({ error: "invalid offset" }, { status: 400 }),
        );
      }

      server.reads.push(count);
      return Promise.resolve(Response.json(server.batches.get(count)));
    }),
  );
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function render(initial: { isBlocked: boolean }) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const queryClient = new QueryClient();
  const refresh = vi.fn(() => Promise.resolve());
  let props = initial;
  let latest: UseLiveTableRefreshResult | undefined;

  function Harness(harnessProps: { isBlocked: boolean }) {
    latest = useLiveTableRefresh({
      isBlocked: harnessProps.isBlocked,
      refresh,
      table: TABLE,
    });
    return null;
  }

  const draw = () =>
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness {...props} />
        </QueryClientProvider>,
      );
    });

  draw();

  return {
    cleanup() {
      act(() => root.unmount());
      queryClient.clear();
    },
    latest: () => latest,
    async poll() {
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: ["streams"] });
      });
      await flush();
    },
    refresh,
    setBlocked(isBlocked: boolean) {
      props = { isBlocked };
      draw();
    },
  };
}

describe("walRecordsTouchTable", () => {
  it("matches records by their qualified table name", () => {
    expect(
      walRecordsTouchTable([{ type: "public.students" }], "public.students"),
    ).toBe(true);
    expect(
      walRecordsTouchTable([{ type: "public.courses" }], "public.students"),
    ).toBe(false);
    expect(walRecordsTouchTable({}, "public.students")).toBe(false);
  });
});

describe("useLiveTableRefresh", () => {
  let server: FakeServer;

  beforeEach(() => {
    server = { batches: new Map(), hasWal: true, offset: "10", reads: [] };
    installFetch(server);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is not live without a prisma-wal stream", async () => {
    server.hasWal = false;
    const harness = render({ isBlocked: false });
    await flush();

    expect(harness.latest()?.isLive).toBe(false);
    harness.cleanup();
  });

  it("reloads only when the new records touch the open table", async () => {
    const harness = render({ isBlocked: false });
    await flush();
    expect(harness.latest()?.isLive).toBe(true);
    expect(harness.refresh).not.toHaveBeenCalled();

    // Another table changed: nothing to reload.
    server.batches.set("10", [{ type: "public.courses" }]);
    server.offset = "11";
    await harness.poll();
    expect(server.reads).toEqual(["10"]);
    expect(harness.refresh).not.toHaveBeenCalled();

    // This table changed: reload once.
    server.batches.set("11", [
      { type: "public.courses" },
      { type: "public.students" },
    ]);
    server.offset = "13";
    await harness.poll();
    expect(server.reads).toEqual(["10", "11"]);
    expect(harness.refresh).toHaveBeenCalledTimes(1);

    harness.cleanup();
  });

  it("waits while the user is editing and reloads once they finish", async () => {
    const harness = render({ isBlocked: true });
    await flush();

    server.batches.set("10", [{ type: "public.students" }]);
    server.offset = "11";
    await harness.poll();

    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.latest()?.hasPendingChanges).toBe(true);

    harness.setBlocked(false);
    await flush();

    expect(harness.refresh).toHaveBeenCalledTimes(1);
    expect(harness.latest()?.hasPendingChanges).toBe(false);
    harness.cleanup();
  });
});
