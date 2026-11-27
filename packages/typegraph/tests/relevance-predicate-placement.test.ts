/**
 * A `.similarTo()` or `$fulltext.matches()` predicate is applied only as a
 * `whereNode()` match constraint on a node alias, where the standard
 * statement joins its relevance set. The builder methods that accept a
 * predicate anywhere else refuse it when they are called, before any SQL
 * exists: `having()` (which used to compile it to a constant-true term) and
 * `whereEdge()` (an edge embedding field exposes `similarTo()`, and the
 * compiler then failed on the edge alias with an internal invariant error).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  count,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  field,
} from "../src";
import { UnsupportedPredicateError } from "../src/errors";
import type { Predicate } from "../src/query/predicates";
import { requireDefined } from "../src/utils/presence";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string(), vector: embedding(2).optional() }),
});
const link = defineEdge("link", {
  schema: z.object({ vector: embedding(2).optional() }),
});
const graph = defineGraph({
  id: "relevance_placement",
  nodes: { Item: { type: Item } },
  edges: { link: { type: link, from: [Item], to: [Item] } },
});

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectPlacementRefusal(
  error: unknown,
  alias: string,
  reason: "having" | "edge_predicate",
): void {
  expect(error).toBeInstanceOf(UnsupportedPredicateError);
  expect((error as UnsupportedPredicateError).details).toEqual({
    predicate: "vector_similarity",
    alias,
    reason,
  });
}

describe("relevance predicate placement", () => {
  it("refuses similarTo() on an edge embedding in QueryBuilder.whereEdge()", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    const query = store
      .query()
      .from("Item", "a")
      .traverse("link", "e")
      .to("Item", "b");

    expectPlacementRefusal(
      refusal(() =>
        query.whereEdge("e", (edge) => edge.vector.similarTo([1, 0], 2)),
      ),
      "e",
      "edge_predicate",
    );
  });

  it("refuses a node similarTo() predicate passed to whereEdge() or having()", async () => {
    const store = await createInitializedStore(graph, createTestBackend());
    let captured: Predicate | undefined;
    store
      .query()
      .from("Item", "a")
      .whereNode("a", (item) => {
        captured = item.vector.similarTo([1, 0], 2);
        return captured;
      });
    const match = requireDefined(captured);

    expectPlacementRefusal(
      refusal(() =>
        store
          .query()
          .from("Item", "a")
          .traverse("link", "e")
          .whereEdge("e", () => match)
          .to("Item", "b"),
      ),
      "a",
      "edge_predicate",
    );
    expectPlacementRefusal(
      refusal(() =>
        store
          .query()
          .from("Item", "a")
          .groupBy("a", "name")
          .having(match.and(match).__expr)
          .aggregate({ name: field("a", "name"), n: count("a") }),
      ),
      "a",
      "having",
    );
  });
});
