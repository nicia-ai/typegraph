/**
 * Type-level tests for the narrow {@link RecordedStoreView} surface. The whole
 * point of the recorded view is that it exposes only reconstructing-safe reads;
 * these assertions fail `pnpm typecheck` if that surface ever widens or the
 * collections regain write/broad-read methods.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  asRecordedInstant,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Edge,
  type Node,
  type RecordedAdjacencyEntry,
  type RecordedAdjacencyPage,
  recordedRelation,
  type RecordedScanPage,
  RecordedStoreView,
  sql,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { createEngineRecordedInstant } from "../src/core/temporal";
import { createSqlSchema } from "../src/query/compiler/schema";
import { storeRuntime } from "../src/store/runtime-port";
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
const RECORDED_AT = asRecordedInstant(
  "r1:0000000000000001:2026-02-02T00:00:00.000Z",
);

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
    expectTypeOf(recorded).toHaveProperty("weightedShortestPath");
    expectTypeOf(recorded).toHaveProperty("pageRank");
    expectTypeOf(recorded).toHaveProperty("personalizedPageRank");
    expectTypeOf(recorded).toHaveProperty("labelPropagation");
    expectTypeOf(recorded).toHaveProperty("reachable");
    expectTypeOf(recorded).toHaveProperty("degree");
    expectTypeOf(recorded).toHaveProperty("nodes");
    expectTypeOf(recorded).toHaveProperty("edges");
    expectTypeOf<
      ReturnType<typeof recorded.adjacency<"knows">>
    >().toEqualTypeOf<
      Promise<
        RecordedAdjacencyPage<RecordedAdjacencyEntry<typeof graph, "knows">>
      >
    >();
    // @ts-expect-error Edge filters must name graph-declared edge kinds.
    type UnknownEdges = Parameters<typeof recorded.adjacency<"missing">>;
    expectTypeOf<UnknownEdges>().toBeArray();
    // ...but the live-state search facade is intentionally absent.
    expectTypeOf(recorded).not.toHaveProperty("search");

    // Node collections expose point reads plus bounded deterministic scans;
    // broad reads (find / count) and every write remain absent.
    expectTypeOf(recorded.nodes.Person).toHaveProperty("getById");
    expectTypeOf(recorded.nodes.Person).toHaveProperty("getByIds");
    expectTypeOf(recorded.nodes.Person).toHaveProperty("scan");
    expectTypeOf<ReturnType<typeof recorded.nodes.Person.scan>>().toEqualTypeOf<
      Promise<RecordedScanPage<Node<typeof Person>>>
    >();
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("find");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("count");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("create");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("update");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("delete");
    expectTypeOf(recorded.nodes.Person).not.toHaveProperty("findFrom");

    // Edge collections likewise add bounded scans; the endpoint reads that the
    // valid-time StoreView supports stay absent here, as do all writes.
    expectTypeOf(recorded.edges.knows).toHaveProperty("getById");
    expectTypeOf(recorded.edges.knows).toHaveProperty("getByIds");
    expectTypeOf(recorded.edges.knows).toHaveProperty("scan");
    expectTypeOf<ReturnType<typeof recorded.edges.knows.scan>>().toEqualTypeOf<
      Promise<
        RecordedScanPage<Edge<typeof knows, typeof Person, typeof Person>>
      >
    >();
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
  it("refuses a runtime port without the optional adjacency reader", async () => {
    const store = createStore(graph, createTestBackend(), { history: true });
    Object.defineProperty(storeRuntime(store), "recordedAdjacency", {
      value: undefined,
    });
    await expect(
      store
        .asOfRecorded(RECORDED_AT)
        .adjacency({ kind: "Person", id: asNodeId<typeof Person>("root") }),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "RECORDED_ADJACENCY_UNSUPPORTED_RUNTIME" },
    });
  });
  it("refuses external and engine-native sources before executing adjacency SQL", async () => {
    const root = {
      kind: "Person" as const,
      id: asNodeId<typeof Person>("root"),
    };
    const external = createStore(graph, createTestBackend(), {
      recordedRead: recordedRelation({ schema: createSqlSchema() }),
    });
    await expect(
      external.asOfRecorded(RECORDED_AT).adjacency(root),
    ).rejects.toMatchObject({
      details: { code: "RECORDED_ADJACENCY_UNSUPPORTED_SOURCE" },
    });
    const native = createStore(
      graph,
      deriveBackend(createTestBackend(), {
        recordedTime: {
          source: (table) => sql.identifier(`native_${table}`),
          revisionNow: () =>
            Promise.resolve({ revision: "r1", recordedAt: VALID_AT }),
        },
      }),
      { history: true },
    );
    await expect(
      native
        .asOfRecorded(createEngineRecordedInstant("r1", VALID_AT))
        .adjacency(root),
    ).rejects.toMatchObject({
      details: { code: "RECORDED_ADJACENCY_UNSUPPORTED_SOURCE" },
    });
  });
});
