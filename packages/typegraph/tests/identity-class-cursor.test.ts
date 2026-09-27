import { describe, expect, it } from "vitest";

import {
  decodeIdentityClassCursor,
  encodeIdentityClassCursor,
  type IdentityClassCursorScope,
} from "../src/identity/class-cursor";

const coordinate = {
  valid: { mode: "asOf", asOf: "2026-01-02T03:04:05.000Z" },
} as const;

const scope: IdentityClassCursorScope = {
  graphId: "graph-a",
  coordinate,
  kinds: ["Person", "Company"],
};

describe("identity class cursor", () => {
  it("round trips representative and normalizes kind filter order", () => {
    const cursor = encodeIdentityClassCursor(scope, {
      kind: "Person",
      id: "member:7",
    });

    expect(
      decodeIdentityClassCursor(cursor, {
        ...scope,
        kinds: ["Company", "Person"],
      }),
    ).toEqual({ kind: "Person", id: "member:7" });
    expect(
      decodeIdentityClassCursor(
        encodeIdentityClassCursor(scope, { kind: "Person", id: "id-😀" }),
        scope,
      ),
    ).toEqual({ kind: "Person", id: "id-😀" });
  });

  it.each([
    ["graph", { ...scope, graphId: "graph-b" }],
    [
      "coordinate",
      {
        ...scope,
        coordinate: {
          valid: { mode: "asOf", asOf: "2026-01-03T03:04:05.000Z" },
        },
      },
    ],
    ["kind filter", { ...scope, kinds: ["Person"] }],
  ])("rejects a cursor with a different %s scope", (_label, differentScope) => {
    const cursor = encodeIdentityClassCursor(scope, {
      kind: "Person",
      id: "one",
    });

    expect(() =>
      decodeIdentityClassCursor(
        cursor,
        differentScope as IdentityClassCursorScope,
      ),
    ).toThrow("does not match this graph, coordinate, or kind filter");
  });
});
