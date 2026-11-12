import { describe, expect, it } from "vitest";

import { getWalColumnChanges } from "./WalRowChanges";

describe("getWalColumnChanges", () => {
  it("lists only the columns an update changed, with before and after values", () => {
    expect(
      getWalColumnChanges({
        headers: { operation: "update" },
        key: "1",
        old_value: { email: null, id: 1, name: "Ada", tags: ["a"] },
        type: "public.students",
        value: {
          email: "ada@example.com",
          id: 1,
          name: "Ada",
          tags: ["a", "b"],
        },
      }),
    ).toEqual([
      { after: "ada@example.com", before: null, column: "email" },
      { after: ["a", "b"], before: ["a"], column: "tags" },
    ]);
  });

  it("returns null when the record has no previous row or is not an update", () => {
    expect(
      getWalColumnChanges({
        headers: { operation: "update" },
        old_value: null,
        value: { id: 1 },
      }),
    ).toBeNull();
    expect(
      getWalColumnChanges({
        headers: { operation: "delete" },
        old_value: { id: 1 },
        value: null,
      }),
    ).toBeNull();
    expect(getWalColumnChanges("not a record")).toBeNull();
  });
});
