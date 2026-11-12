import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConnectionStore, resolveConnectionsFile } from "./store";

describe("connection store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-connections-"));
  });

  afterEach(async () => {
    await rm(dir, { force: true, recursive: true });
  });

  it("persists connections in an owner-only file and de-duplicates them", async () => {
    const file = join(dir, "nested", "connections.json");
    const store = createConnectionStore(file);

    expect(await store.list()).toEqual([]);

    const first = await store.add({
      kind: "postgres",
      name: "app",
      url: "postgresql://me:pw@localhost:5432/app",
    });
    const duplicate = await store.add({
      kind: "postgres",
      name: "again",
      url: "postgresql://me:pw@localhost:5432/app",
    });

    expect(duplicate.id).toBe(first.id);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await createConnectionStore(file).list()).toEqual([first]);
    expect(await store.get(first.id)).toEqual(first);
    expect(await store.remove(first.id)).toBe(true);
    expect(await store.remove(first.id)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it("uses STUDIO_CONNECTIONS_FILE when set", () => {
    expect(
      resolveConnectionsFile({ STUDIO_CONNECTIONS_FILE: "/x/c.json" }),
    ).toBe("/x/c.json");
    expect(resolveConnectionsFile({})).toMatch(
      /\.prisma-studio-ai\/connections\.json$/,
    );
  });
});
