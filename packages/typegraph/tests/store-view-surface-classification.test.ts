import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  CURRENT_ONLY_READ_NAMES,
  EDGE_BATCH_READ_NAMES,
  EDGE_TEMPORAL_READ_NAMES,
  EDGE_WRITE_NAMES,
  NODE_TEMPORAL_READ_NAMES,
  NODE_WRITE_NAMES,
  RECORDED_POINT_READ_NAMES,
} from "../src/store/collection-surface";
import { createTestBackend } from "./test-utils";

type RuntimeTarget = Readonly<Record<string, unknown>>;

const SurfacePerson = defineNode("SurfacePerson", {
  schema: z.object({ name: z.string() }),
});

const surfaceKnows = defineEdge("surfaceKnows", {
  schema: z.object({ since: z.string().optional() }),
});

const graph = defineGraph({
  id: "store_view_surface_classification",
  nodes: { SurfacePerson: { type: SurfacePerson } },
  edges: {
    surfaceKnows: {
      type: surfaceKnows,
      from: [SurfacePerson],
      to: [SurfacePerson],
    },
  },
});

function ownFunctionNames(target: RuntimeTarget): string[] {
  return Object.keys(target)
    .filter((key) => typeof target[key] === "function")
    .toSorted();
}

function duplicateNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return [...duplicates].toSorted();
}

function flattenBuckets(buckets: readonly (readonly string[])[]): string[] {
  const methods: string[] = [];
  for (const bucket of buckets) methods.push(...bucket);
  return methods;
}

function expectExactPartition(
  surface: string,
  actual: readonly string[],
  buckets: readonly (readonly string[])[],
): void {
  const classified = flattenBuckets(buckets);
  expect(
    duplicateNames(classified),
    `${surface} duplicate classification`,
  ).toEqual([]);
  expect(classified.toSorted(), `${surface} classified methods`).toEqual(
    actual.toSorted(),
  );
}

describe("StoreView surface method classification", () => {
  it("partitions live node collection methods into temporal reads, current-only reads, and writes", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());

    expectExactPartition(
      "node collection",
      ownFunctionNames(store.nodes.SurfacePerson),
      [NODE_TEMPORAL_READ_NAMES, CURRENT_ONLY_READ_NAMES, NODE_WRITE_NAMES],
    );
  });

  it("partitions live edge collection methods into temporal reads, batch reads, and writes", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());

    expectExactPartition(
      "edge collection",
      ownFunctionNames(store.edges.surfaceKnows),
      [EDGE_TEMPORAL_READ_NAMES, EDGE_BATCH_READ_NAMES, EDGE_WRITE_NAMES],
    );
  });

  it("keeps recorded collection point reads a subset of both temporal read buckets", () => {
    for (const method of RECORDED_POINT_READ_NAMES) {
      expect(NODE_TEMPORAL_READ_NAMES).toContain(method);
      expect(EDGE_TEMPORAL_READ_NAMES).toContain(method);
    }
  });
});
