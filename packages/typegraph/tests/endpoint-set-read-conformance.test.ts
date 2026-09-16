import { describe, expect, it } from "vitest";

import {
  type EndpointSetReadConformanceFixture,
  runEndpointSetReadConformance,
} from "../src/backend/conformance/endpoint-set-read";
import {
  type EdgeRow,
  type FindEdgesByEndpointSetParams,
  type GraphBackend,
} from "../src/backend/types";
import { ConfigurationError } from "../src/errors";
import { createTestBackend } from "./test-utils";

const endpointEdge = {
  graph_id: "endpoint-set-conformance",
  id: "edge-1",
  kind: "knows",
  from_kind: "Person",
  from_id: "person-1",
  to_kind: "Person",
  to_id: "person-2",
  props: { since: "2024" },
  valid_from: undefined,
  valid_to: undefined,
  created_at: "2024-01-01T00:00:00.000Z",
  updated_at: "2024-01-01T00:00:00.000Z",
  deleted_at: undefined,
} satisfies EdgeRow;

function params(
  overrides: Readonly<{
    endpointIds?: readonly string[];
    limitPerEndpoint?: number;
  }> = {},
) {
  return {
    graphId: "endpoint-set-conformance",
    kind: "knows",
    side: "from" as const,
    endpointKind: "Person",
    endpointIds: overrides.endpointIds ?? [],
    ...(overrides.limitPerEndpoint === undefined ?
      {}
    : { limitPerEndpoint: overrides.limitPerEndpoint }),
  };
}

function fixture(
  backend: GraphBackend,
  successes: EndpointSetReadConformanceFixture["successes"] = [
    { name: "empty endpoint set", params: params(), expected: [] },
  ],
): EndpointSetReadConformanceFixture {
  return {
    backend,
    equal: (actual, expected) =>
      JSON.stringify(actual) === JSON.stringify(expected),
    successes,
    refusals: [
      {
        name: "non-positive endpoint limit",
        params: params({ endpointIds: ["person-1"], limitPerEndpoint: 0 }),
        errorMatches: (error) => error instanceof ConfigurationError,
      },
    ],
  };
}

function backendReturningRows(
  backend: GraphBackend,
  rows: readonly EdgeRow[],
): GraphBackend {
  const read = backend.findEdgesByEndpointSet;
  if (read === undefined) {
    throw new Error("Test backend must implement endpoint-set reads.");
  }
  return new Proxy(backend, {
    get(target, property, receiver) {
      if (property === "findEdgesByEndpointSet") {
        return (readParams: FindEdgesByEndpointSetParams) => {
          // Keep the real adapter's input refusal in the conformance fixture;
          // only successful reads are replaced with controlled rows.
          if (readParams.limitPerEndpoint === 0) return read(readParams);
          return Promise.resolve(rows);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe("endpoint-set read conformance", () => {
  it("certifies the shared success and refusal contract", async () => {
    const backend = createTestBackend();
    const report = await runEndpointSetReadConformance(fixture(backend));

    expect(report.passed).toEqual([
      "success: empty endpoint set",
      "refusal: non-positive endpoint limit",
    ]);
  });

  it("certifies a non-empty read when its rows match the expected result", async () => {
    const backend = backendReturningRows(createTestBackend(), [endpointEdge]);
    const report = await runEndpointSetReadConformance(
      fixture(backend, [
        {
          name: "one edge for the selected source",
          params: params({ endpointIds: ["person-1"] }),
          expected: [endpointEdge],
        },
      ]),
    );

    expect(report.passed).toEqual([
      "success: one edge for the selected source",
      "refusal: non-positive endpoint limit",
    ]);
  });

  it("reports the actual and expected rows when a non-empty read disagrees", async () => {
    const backend = backendReturningRows(createTestBackend(), []);

    await expect(
      runEndpointSetReadConformance(
        fixture(backend, [
          {
            name: "one edge for the selected source",
            params: params({ endpointIds: ["person-1"] }),
            expected: [endpointEdge],
          },
        ]),
      ),
    ).rejects.toMatchObject({
      name: "EndpointSetReadConformanceError",
      details: {
        check: "one edge for the selected source",
        actual: [],
        expected: [endpointEdge],
      },
    });
  });

  it("refuses certification when the endpoint-set member is absent", async () => {
    const backend = createTestBackend();
    const unsupported = new Proxy(backend, {
      get(target, property, receiver) {
        if (property === "findEdgesByEndpointSet") return;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    await expect(
      runEndpointSetReadConformance(fixture(unsupported)),
    ).rejects.toMatchObject({
      name: "EndpointSetReadConformanceError",
      details: { capability: "findEdgesByEndpointSet" },
    });
  });
});
