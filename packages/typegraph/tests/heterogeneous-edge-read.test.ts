import { describe, expect, it } from "vitest";

import { resolveHeterogeneousEdgeRead } from "../src/backend/edge-endpoint-sets";
import { ConfigurationError } from "../src/errors";

describe("resolveHeterogeneousEdgeRead", () => {
  it("deduplicates endpoint pairs and edge kinds while preserving order", () => {
    const resolved = resolveHeterogeneousEdgeRead(
      {
        graphId: "graph",
        side: "from",
        endpoints: [
          { kind: "Person", id: "1" },
          { kind: "Company", id: "1" },
          { kind: "Person", id: "1" },
        ],
        edgeKinds: ["owns", "worksAt", "owns"],
      },
      12,
    );

    expect(resolved.endpoints).toEqual([
      { kind: "Person", id: "1" },
      { kind: "Company", id: "1" },
    ]);
    expect(resolved.edgeKinds).toEqual(["owns", "worksAt"]);
    expect(resolved.endpointChunkSize).toBe(3);
  });

  it("rejects a request that cannot fit one endpoint pair", () => {
    expect(() =>
      resolveHeterogeneousEdgeRead(
        {
          graphId: "graph",
          side: "from",
          endpoints: [{ kind: "Person", id: "1" }],
          edgeKinds: ["a", "b"],
        },
        7,
      ),
    ).toThrow(ConfigurationError);
  });

  it("rejects an invalid per-endpoint cap", () => {
    expect(() =>
      resolveHeterogeneousEdgeRead(
        {
          graphId: "graph",
          side: "from",
          endpoints: [{ kind: "Person", id: "1" }],
          edgeKinds: ["owns"],
          limitPerEndpoint: 0,
        },
        999,
      ),
    ).toThrow(ConfigurationError);
  });
});
