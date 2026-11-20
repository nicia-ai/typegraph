import { describe, expect, it } from "vitest";

import type { InsertEdgeParams } from "../src/backend/types";
import { classifyDurableEdgeBatchOutcomes } from "../src/store/durable-edge-batch";

function params(id: string): InsertEdgeParams {
  return {
    graphId: "graph",
    id,
    kind: "knows",
    fromKind: "Person",
    fromId: "from",
    toKind: "Person",
    toId: "to",
    props: { label: id },
    matchIdentity: { name: "knows-label", key: `key-${id}` },
  };
}

describe("durable edge batch outcomes", () => {
  it("preserves duplicate-id multiplicity", () => {
    expect(
      classifyDurableEdgeBatchOutcomes(
        [params("same"), params("same")],
        [{ id: "same" }],
      ),
    ).toEqual(["created", "conflict"]);
  });

  it("keeps outcomes in attempted input order", () => {
    expect(
      classifyDurableEdgeBatchOutcomes(
        [params("first"), params("second")],
        [{ id: "second" }],
      ),
    ).toEqual(["conflict", "created"]);
  });

  it("refuses rows the backend did not attempt", () => {
    expect(() =>
      classifyDurableEdgeBatchOutcomes(
        [params("attempted")],
        [{ id: "unexpected" }],
      ),
    ).toThrow("returned rows that were not attempted");
  });
});
