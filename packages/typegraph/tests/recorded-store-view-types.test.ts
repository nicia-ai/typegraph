/**
 * Type-level tests for the narrow {@link RecordedStoreView} surface. The whole
 * point of the recorded view is that it exposes only reconstructing-safe reads;
 * these assertions fail `pnpm typecheck` if that surface ever widens or the
 * collections regain write/broad-read methods.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  asRecordedInstant,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  RecordedStoreView,
} from "../src";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

const graph = defineGraph({
  id: "recorded-types",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const VALID_AT = "2026-01-01T00:00:00.000Z";
const RECORDED_AT = asRecordedInstant("2026-02-02T00:00:00.000Z");

describe("RecordedStoreView typed surface", () => {
  it("exposes only reconstructing-safe reads", () => {
    const store = createStore(graph, createTestBackend(), { history: true });
    const recorded = store.asOfRecorded(RECORDED_AT);

    // Both entry points resolve to the same narrow view type.
    expectTypeOf(recorded).toEqualTypeOf<RecordedStoreView<typeof graph>>();
    expectTypeOf(store.asOf(VALID_AT).asOfRecorded(RECORDED_AT)).toEqualTypeOf<
      RecordedStoreView<typeof graph>
    >();

    // Reconstructing reads are present...
    expectTypeOf(recorded).toHaveProperty("query");
    expectTypeOf(recorded).toHaveProperty("subgraph");
    expectTypeOf(recorded).toHaveProperty("shortestPath");
    expectTypeOf(recorded).toHaveProperty("reachable");
    expectTypeOf(recorded).toHaveProperty("degree");
    expectTypeOf(recorded).toHaveProperty("nodes");
    expectTypeOf(recorded).toHaveProperty("edges");
    // ...but the live-state search facade is intentionally absent.
    expectTypeOf(recorded).not.toHaveProperty("search");

    // Node collections are narrowed to point reconstruction only — broad reads
    // (find / count) and every write are absent.
    expectTypeOf(recorded.nodes.Person).toHaveProperty("getById");
    expectTypeOf(recorded.nodes.Person).toHaveProperty("getByIds");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("find");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("count");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("create");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("update");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("delete");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("findFrom");

    // Edge collections likewise — point reads only; the endpoint reads that the
    // valid-time StoreView *does* support stay absent here (recorded-time
    // endpoint reads are not yet reconstructed), as do all writes.
    expectTypeOf(recorded.edges.knows).toHaveProperty("getById");
    expectTypeOf(recorded.edges.knows).toHaveProperty("getByIds");
    expectTypeOf(recorded.edges.knows).not.toHaveProperty("find");
    expectTypeOf(recorded.edges.knows).not.toHaveProperty("findFrom");
    expectTypeOf(recorded.edges.knows).not.toHaveProperty("findTo");
    expectTypeOf(recorded.edges.knows).not.toHaveProperty("findByEndpoints");
    expectTypeOf(recorded.edges.knows).not.toHaveProperty("create");
    expectTypeOf(recorded.edges.knows).not.toHaveProperty("update");
    expectTypeOf(recorded.edges.knows).not.toHaveProperty("delete");

    // The coordinate is exposed as read-only accessors, not re-pinning methods:
    // a RecordedStoreView cannot widen back via .asOf(...) / .asOfRecorded(...).
    expectTypeOf(recorded.asOfRecorded).toBeString();
    expectTypeOf(recorded.asOf).not.toBeFunction();
    expectTypeOf(recorded.mode).not.toBeFunction();

    expect(recorded).toBeInstanceOf(RecordedStoreView);
  });
});
