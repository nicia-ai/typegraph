/**
 * T8 — statement-count coverage for the predecessor-walk fallback (local
 * SQLite; the WS0 statement-count infrastructure this test would otherwise
 * reuse exists only on `phase2/perf-harness`, and no WS0 fixture measures
 * graph-algorithm extraction — see the commit body's R-3 declaration).
 *
 * A small `s -1-> m -1-> t` graph: the recursive-CTE extractor issues
 * exactly one extraction statement, and the predecessor-walk fallback
 * (a recursion-absent declaration) issues exactly `pathLength + 1` — one
 * selection plus one primary-key point read per hop back to the source.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Node,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { GraphBackend } from "../src/backend/types";
import {
  countWeightedExtractionStatements,
  createStatementCountingBackend,
} from "./statement-counting-backend";
import { createTestBackend } from "./test-utils";

const FallbackNode = defineNode("Node", {
  schema: z.object({ label: z.string() }),
});
const fallbackRoad = defineEdge("road", {
  schema: z.object({ cost: z.number() }),
});

const fallbackStatementCountGraph = defineGraph({
  id: "weighted_fallback_statement_count",
  nodes: { Node: { type: FallbackNode } },
  edges: {
    road: { type: fallbackRoad, from: [FallbackNode], to: [FallbackNode] },
  },
});

const REASON = "test engine has no recursive CTE";
const OPTIONS = { edges: ["road"], weightProperty: "cost" } as const;

describe("weighted-shortest-path fallback statement count", () => {
  let backend: GraphBackend;
  let source: Node<typeof FallbackNode>;
  let target: Node<typeof FallbackNode>;

  beforeEach(async () => {
    backend = createTestBackend();
    const store = createStore(fallbackStatementCountGraph, backend);
    source = await store.nodes.Node.create({ label: "s" });
    const middle = await store.nodes.Node.create({ label: "m" });
    target = await store.nodes.Node.create({ label: "t" });
    await store.edges.road.create(source, middle, { cost: 1 });
    await store.edges.road.create(middle, target, { cost: 1 });
  });

  it("issues exactly one recursive extraction statement on the bundled declaration", async () => {
    const statements: string[] = [];
    const store = createStore(
      fallbackStatementCountGraph,
      createStatementCountingBackend(backend, statements),
    );

    const path = await store.algorithms.weightedShortestPath(
      source,
      target,
      OPTIONS,
    );

    expect(path?.depth).toBe(2);
    expect(countWeightedExtractionStatements(statements)).toEqual({
      recursive: 1,
      walk: 0,
    });
  });

  it("issues exactly pathLength + 1 walk statements on a recursion-absent declaration", async () => {
    const bundledStatements: string[] = [];
    const bundledStore = createStore(
      fallbackStatementCountGraph,
      createStatementCountingBackend(backend, bundledStatements),
    );
    const bundledPath = await bundledStore.algorithms.weightedShortestPath(
      source,
      target,
      OPTIONS,
    );

    const walkStatements: string[] = [];
    const recursionAbsentBackend = deriveBackend(backend, {
      capabilities: {
        ...backend.capabilities,
        recursiveTraversal: { supported: false, reason: REASON },
      },
    });
    const walkStore = createStore(
      fallbackStatementCountGraph,
      createStatementCountingBackend(recursionAbsentBackend, walkStatements),
    );
    const walkPath = await walkStore.algorithms.weightedShortestPath(
      source,
      target,
      OPTIONS,
    );

    expect(walkPath).toEqual(bundledPath);
    const counts = countWeightedExtractionStatements(walkStatements);
    expect(counts).toEqual({
      recursive: 0,
      walk: (bundledPath?.depth ?? 0) + 1,
    });
    expect(counts.walk).toBe(bundledPath?.nodes.length);
  });
});
