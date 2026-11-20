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

  it("deduplicates and budgets exact directed pairs independently", () => {
    const resolved = resolveHeterogeneousEdgeRead(
      {
        graphId: "graph",
        side: "from",
        endpoints: [
          {
            kind: "Person",
            id: "hub",
            opposite: { kind: "Person", id: "first" },
          },
          {
            kind: "Person",
            id: "hub",
            opposite: { kind: "Person", id: "second" },
          },
          {
            kind: "Person",
            id: "hub",
            opposite: { kind: "Person", id: "first" },
          },
        ],
        edgeKinds: ["knows"],
      },
      13,
    );

    expect(resolved.endpoints).toHaveLength(2);
    expect(resolved.endpointChunkSize).toBe(2);
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

  it("refuses mixed incident and exact-pair endpoint modes", () => {
    expect(() =>
      resolveHeterogeneousEdgeRead(
        {
          graphId: "graph",
          side: "from",
          endpoints: [
            { kind: "Person", id: "hub" },
            {
              kind: "Person",
              id: "hub",
              opposite: { kind: "Person", id: "target" },
            },
          ],
          edgeKinds: ["knows"],
        },
        999,
      ),
    ).toThrow(
      expect.objectContaining({
        details: {
          code: "EDGE_HETEROGENEOUS_READ_MIXED_ENDPOINT_MODES",
          graphId: "graph",
        },
      }),
    );
  });
});
