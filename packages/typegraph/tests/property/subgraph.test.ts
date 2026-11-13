/**
 * Property-Based Tests for Subgraph Extraction
 *
 * Verifies structural invariants of store.subgraph() results
 * using randomly generated graph topologies.
 */
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  indexSubgraph,
  partOf,
  type TemporalMode,
} from "../../src";
import type { GraphBackend } from "../../src/backend/types";
import { createStore, type Store } from "../../src/store";
import { compareStrings } from "../../src/utils/compare";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

// ============================================================
// Test Schema: simple chain/tree graph
// ============================================================

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const link = defineEdge("link", { schema: z.object({}) });

const propertyGraph = defineGraph({
  id: "prop_subgraph",
  nodes: { Item: { type: Item } },
  edges: {
    link: { type: link, from: [Item], to: [Item] },
  },
});

type PropertyGraph = typeof propertyGraph;

// ============================================================
// Helpers
// ============================================================

function itemRef(id: string) {
  return { kind: "Item" as const, id: asNodeId<typeof Item>(id) };
}

/**
 * Builds a chain of N items: item0 → item1 → ... → itemN-1
 * Returns all created node IDs.
 */
async function buildChain(
  store: Store<PropertyGraph>,
  length: number,
): Promise<string[]> {
  const nodeIds: string[] = [];
  for (let index = 0; index < length; index++) {
    const node = await store.nodes.Item.create({ label: `item-${index}` });
    nodeIds.push(node.id);
  }
  for (let index = 0; index < length - 1; index++) {
    await store.edges.link.create(
      { kind: "Item", id: requireDefined(nodeIds[index]) },
      { kind: "Item", id: requireDefined(nodeIds[index + 1]) },
    );
  }
  return nodeIds;
}

/**
 * Builds a star graph: center → spoke0, center → spoke1, ...
 * Returns [centerId, ...spokeIds].
 */
async function buildStar(
  store: Store<PropertyGraph>,
  spokeCount: number,
): Promise<string[]> {
  const center = await store.nodes.Item.create({ label: "center" });
  const spokeIds: string[] = [];
  for (let index = 0; index < spokeCount; index++) {
    const spoke = await store.nodes.Item.create({ label: `spoke-${index}` });
    spokeIds.push(spoke.id);
    await store.edges.link.create(center, spoke);
  }
  return [center.id, ...spokeIds];
}

// ============================================================
// Property Tests
// ============================================================

describe("subgraph property tests", () => {
  let backend: GraphBackend;
  let store: Store<PropertyGraph>;

  beforeEach(() => {
    backend = createTestBackend();
    store = createStore(propertyGraph, backend);
  });

  describe("chain graph invariants", () => {
    it("reachable count is min(depth+1, chainLength) from the start", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 15 }),
          fc.integer({ min: 0, max: 20 }),
          async (chainLength, maxDepth) => {
            // Fresh store per run
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth,
              },
            );

            const expected = Math.min(maxDepth + 1, chainLength);
            expect(result.nodes.length).toBe(expected);
          },
        ),
        { numRuns: 30 },
      );
    });

    it("all returned edges connect nodes in the result set", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 12 }),
          fc.integer({ min: 1, max: 15 }),
          async (chainLength, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth,
              },
            );

            const index = indexSubgraph(result);
            for (const edge of result.edges) {
              expect(
                index.node({ kind: edge.fromKind, id: edge.fromId }),
              ).toBeDefined();
              expect(
                index.node({ kind: edge.toKind, id: edge.toId }),
              ).toBeDefined();
            }
          },
        ),
        { numRuns: 30 },
      );
    });

    it("edge count equals node count - 1 for connected chain subsets", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 12 }),
          fc.integer({ min: 1, max: 15 }),
          async (chainLength, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth,
              },
            );

            // In a chain, edges = nodes - 1 (when all nodes are connected)
            // With maxDepth >= 1, root is always included so size > 0
            expect(result.nodes.length).toBeGreaterThan(0);
            expect(result.edges).toHaveLength(result.nodes.length - 1);
          },
        ),
        { numRuns: 30 },
      );
    });
  });

  describe("star graph invariants", () => {
    it("reachable count is spokeCount+1 with sufficient depth", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 20 }),
          async (spokeCount) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const allIds = await buildStar(store, spokeCount);
            const centerId = requireDefined(allIds[0]);
            const result = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth: 1,
            });

            expect(result.nodes.length).toBe(spokeCount + 1);
          },
        ),
        { numRuns: 20 },
      );
    });

    it("no duplicate node IDs in result", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 15 }),
          fc.integer({ min: 1, max: 5 }),
          async (spokeCount, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const allIds = await buildStar(store, spokeCount);
            const centerId = requireDefined(allIds[0]);
            const result = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth,
            });

            const nodeIds = result.nodes.map((node) => node.id);
            expect(new Set(nodeIds).size).toBe(nodeIds.length);
            expect(result.nodes.length).toBeLessThanOrEqual(spokeCount + 1);
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  describe("excludeRoot invariant", () => {
    it("excludeRoot always removes exactly the root from the result", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 5 }),
          async (spokeCount, maxDepth) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const allIds = await buildStar(store, spokeCount);
            const centerId = requireDefined(allIds[0]);

            const withRoot = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth,
            });
            const withoutRoot = await store.subgraph(itemRef(centerId), {
              edges: ["link"],
              maxDepth,
              excludeRoot: true,
            });

            // Without root should have exactly one fewer node
            expect(withoutRoot.nodes.length).toBe(withRoot.nodes.length - 1);
            // And that missing node is the root
            expect(
              indexSubgraph(withoutRoot).node(itemRef(centerId)),
            ).toBeUndefined();
          },
        ),
        { numRuns: 20 },
      );
    });
  });

  describe("cycle safety invariant", () => {
    it("subgraph always terminates even with cycles", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 8 }),
          async (chainLength) => {
            backend = createTestBackend();
            store = createStore(propertyGraph, backend);

            const nodeIds = await buildChain(store, chainLength);
            // Close the chain into a cycle
            await store.edges.link.create(
              { kind: "Item", id: requireDefined(nodeIds[chainLength - 1]) },
              { kind: "Item", id: requireDefined(nodeIds[0]) },
            );

            const result = await store.subgraph(
              itemRef(requireDefined(nodeIds[0])),
              {
                edges: ["link"],
                maxDepth: chainLength * 2,
              },
            );

            // All nodes in the cycle should be reachable, each exactly once
            expect(result.nodes.length).toBe(chainLength);
          },
        ),
        { numRuns: 20 },
      );
    });
  });
});

// ============================================================
// subgraph({ composition: true }) at temporal coordinates
// ============================================================

/**
 * The composition closure against a reference walk over a plain model of the
 * rows the store accepted. Folders and documents share ids, so a walk that
 * joins on id alone wanders into the other kind's node. Three realizing
 * edges: `sgSubfolderOf` (Folder part of Folder, population `one`, so an
 * ended row still binds), `sgInFolder` (Doc part `from`, `oneActive`) and
 * `sgHolds` (Folder -> Doc, part `to`: the reversed member, `oneActive`).
 * The non-composition `sgSeeAlso` must never be walked by the closure.
 *
 * At a coordinate (now, or `asOf` a fixed past instant) a composition row
 * binds when it is not deleted, has started by the instant (asOf), and — for
 * an `oneActive` kind — has not ended by it. A node is returned only while
 * visible at the coordinate, and nothing reachable only through a hidden part
 * is returned either.
 */
const SgFolder = defineNode("SgFolder", { schema: z.object({}) });
const SgDocument = defineNode("SgDoc", { schema: z.object({}) });
const sgSubfolderOf = defineEdge("sgSubfolderOf", { schema: z.object({}) });
const sgInFolder = defineEdge("sgInFolder", { schema: z.object({}) });
const sgHolds = defineEdge("sgHolds", { schema: z.object({}) });
const sgSeeAlso = defineEdge("sgSeeAlso", { schema: z.object({}) });

const compositionGraph = defineGraph({
  id: "prop_subgraph_composition",
  nodes: { SgFolder: { type: SgFolder }, SgDoc: { type: SgDocument } },
  edges: {
    sgSubfolderOf: {
      type: sgSubfolderOf,
      from: [SgFolder],
      to: [SgFolder],
      cardinality: "one",
    },
    sgInFolder: {
      type: sgInFolder,
      from: [SgDocument],
      to: [SgFolder],
      cardinality: "oneActive",
    },
    sgHolds: {
      type: sgHolds,
      from: [SgFolder],
      to: [SgDocument],
      targetCardinality: "oneActive",
    },
    sgSeeAlso: {
      type: sgSeeAlso,
      from: [SgFolder],
      to: [SgFolder, SgDocument],
    },
  },
  ontology: [
    partOf(SgFolder, SgFolder, { via: sgSubfolderOf, partSide: "from" }),
    partOf(SgDocument, SgFolder, { via: sgInFolder }),
    hasPart(SgFolder, SgDocument, { via: sgHolds }),
  ],
});

type CompositionGraph = typeof compositionGraph;
type SgNodeKind = "SgFolder" | "SgDoc";
type SgEdgeKind = "sgSubfolderOf" | "sgInFolder" | "sgHolds" | "sgSeeAlso";

const SG_NODE_IDS = ["n0", "n1", "n2", "n3"] as const;
/** Every node exists from here, so every asOf instant below can see it. */
const SG_NODE_FROM = "1980-01-01T00:00:00.000Z";
/** A hidden node's window ends here: visible at the 1995 instant, hidden after. */
const SG_NODE_ENDED = "2005-01-01T00:00:00.000Z";
const SG_EDGE_FROM = ["1990-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"];
const SG_EDGE_TO = [undefined, "2010-01-01T00:00:00.000Z"] as const;
const SG_INSTANTS = [
  "1995-01-01T00:00:00.000Z",
  "2005-06-01T00:00:00.000Z",
  "2015-01-01T00:00:00.000Z",
] as const;

const SG_OPEN_ROWS_KINDS: ReadonlySet<SgEdgeKind> = new Set([
  "sgInFolder",
  "sgHolds",
]);

/** Each realizing edge kind's stored (from, to) kinds and which end is the whole. */
const SG_EDGE_SHAPES: Readonly<
  Record<
    SgEdgeKind,
    Readonly<{ from: SgNodeKind; to: SgNodeKind; wholeSide: "from" | "to" }>
  >
> = {
  sgSubfolderOf: { from: "SgFolder", to: "SgFolder", wholeSide: "to" },
  sgInFolder: { from: "SgDoc", to: "SgFolder", wholeSide: "to" },
  sgHolds: { from: "SgFolder", to: "SgDoc", wholeSide: "from" },
  sgSeeAlso: { from: "SgFolder", to: "SgDoc", wholeSide: "from" },
};

type SgNodeSpec = Readonly<{ kind: SgNodeKind; id: string; hidden: boolean }>;
/** `whole` and `part` index a node of the kind the edge kind places on each side. */
type SgEdgeSpec = Readonly<{
  kind: SgEdgeKind;
  whole: number;
  part: number;
  validFrom: number;
  validTo: number;
  deleted: boolean;
}>;
type SgCoordinate =
  Readonly<{ mode: "current" }> | Readonly<{ mode: "asOf"; asOf: string }>;

type SgModelEdge = Readonly<{
  id: string;
  kind: SgEdgeKind;
  fromKey: string;
  toKey: string;
  validFrom: string;
  validTo: string | undefined;
  deleted: boolean;
}>;

function sgKey(kind: SgNodeKind, id: string): string {
  return `${kind}:${id}`;
}

function sgNodeVisible(hidden: boolean, coordinate: SgCoordinate): boolean {
  if (!hidden) return true;
  return coordinate.mode === "asOf" && coordinate.asOf < SG_NODE_ENDED;
}

function sgEdgeBinds(edge: SgModelEdge, coordinate: SgCoordinate): boolean {
  if (edge.kind === "sgSeeAlso" || edge.deleted) return false;
  if (coordinate.mode === "asOf" && edge.validFrom > coordinate.asOf) {
    return false;
  }
  if (!SG_OPEN_ROWS_KINDS.has(edge.kind)) return true;
  if (edge.validTo === undefined) return true;
  return coordinate.mode === "asOf" && edge.validTo > coordinate.asOf;
}

/** The reference closure: nodes and edges the root's owned unit returns. */
function sgExpectedClosure(
  rootKey: string,
  hiddenKeys: ReadonlySet<string>,
  edges: readonly SgModelEdge[],
  coordinate: SgCoordinate,
): Readonly<{ nodes: readonly string[]; edges: readonly string[] }> {
  const visible = (key: string) =>
    sgNodeVisible(hiddenKeys.has(key), coordinate);
  const nodes = new Set<string>([rootKey]);
  const edgeIds = new Set<string>();
  const frontier = [rootKey];
  while (frontier.length > 0) {
    const whole = requireDefined(frontier.pop());
    for (const edge of edges) {
      if (!sgEdgeBinds(edge, coordinate)) continue;
      const wholeSide = SG_EDGE_SHAPES[edge.kind].wholeSide;
      const [wholeKey, partKey] =
        wholeSide === "to" ?
          [edge.toKey, edge.fromKey]
        : [edge.fromKey, edge.toKey];
      if (wholeKey !== whole || !visible(partKey)) continue;
      edgeIds.add(edge.id);
      if (nodes.has(partKey)) continue;
      nodes.add(partKey);
      frontier.push(partKey);
    }
  }
  return {
    nodes: [...nodes].toSorted(compareStrings),
    edges: [...edgeIds].toSorted(compareStrings),
  };
}

const sgEdgeSpecArbitrary: fc.Arbitrary<SgEdgeSpec> = fc
  .constantFrom<SgEdgeKind>(
    "sgSubfolderOf",
    "sgInFolder",
    "sgHolds",
    "sgSeeAlso",
  )
  .chain((kind) =>
    fc.record({
      kind: fc.constant(kind),
      // A subfolder hangs under a lower-numbered folder most of the time, so
      // the trees under `n0` and `n1` grow deep; the rest may close a cycle.
      ...(kind === "sgSubfolderOf" ?
        {
          part: fc.integer({ min: 1, max: SG_NODE_IDS.length - 1 }),
          whole: fc.nat({ max: SG_NODE_IDS.length - 1 }),
        }
      : {
          part: fc.nat({ max: SG_NODE_IDS.length - 1 }),
          whole: fc.nat({ max: SG_NODE_IDS.length - 2 }),
        }),
      // Most rows bind at every coordinate; the rest start or end in between.
      validFrom: fc
        .integer({ min: 0, max: 3 })
        .map((roll) => (roll === 0 ? 1 : 0)),
      validTo: fc
        .integer({ min: 0, max: 3 })
        .map((roll) => (roll === 0 ? 1 : 0)),
      deleted: fc.integer({ min: 0, max: 4 }).map((roll) => roll === 0),
    }),
  );

const sgCoordinateArbitrary: fc.Arbitrary<SgCoordinate> = fc.oneof(
  fc.constant({ mode: "current" } as const),
  fc
    .constantFrom(...SG_INSTANTS)
    .map((asOf) => ({ mode: "asOf", asOf }) as const),
);

const sgScenarioArbitrary = fc.record({
  hidden: fc.array(
    fc.integer({ min: 0, max: 3 }).map((roll) => roll === 0),
    {
      minLength: 2 * SG_NODE_IDS.length,
      maxLength: 2 * SG_NODE_IDS.length,
    },
  ),
  edges: fc.array(sgEdgeSpecArbitrary, { minLength: 1, maxLength: 16 }),
  root: fc.nat({ max: 1 }),
  coordinates: fc.array(sgCoordinateArbitrary, {
    minLength: 1,
    maxLength: 3,
  }),
});

/** The refusals a random composition write may earn; the property only reads what was accepted. */
const SG_EXPECTED_REFUSALS: ReadonlySet<string> = new Set([
  "CardinalityError",
  "CompositionError",
  "EdgeAcyclicityError",
]);

describe("subgraph({ composition: true }) property: the owned unit at a temporal coordinate", () => {
  it("returns exactly the reference closure of the rows the store accepted", async () => {
    await fc.assert(
      fc.asyncProperty(sgScenarioArbitrary, async (scenario) => {
        const backend = createTestBackend();
        try {
          const store = createStore(compositionGraph, backend);
          const nodes: SgNodeSpec[] = (["SgFolder", "SgDoc"] as const).flatMap(
            (kind, kindIndex) =>
              SG_NODE_IDS.map((id, index) => ({
                kind,
                id,
                hidden: requireDefined(
                  scenario.hidden[kindIndex * SG_NODE_IDS.length + index],
                ),
              })),
          );
          for (const node of nodes) {
            const window = {
              id: node.id,
              validFrom: SG_NODE_FROM,
              ...(node.hidden && { validTo: SG_NODE_ENDED }),
            };
            await (node.kind === "SgFolder" ?
              store.nodes.SgFolder.create({}, window)
            : store.nodes.SgDoc.create({}, window));
          }
          const hiddenKeys = new Set(
            nodes
              .filter((node) => node.hidden)
              .map((node) => sgKey(node.kind, node.id)),
          );

          const edges = await writeSgEdges(store, scenario.edges);
          const rootId = requireDefined(SG_NODE_IDS[scenario.root]);
          const rootKey = sgKey("SgFolder", rootId);

          for (const coordinate of scenario.coordinates) {
            if (!sgNodeVisible(hiddenKeys.has(rootKey), coordinate)) continue;
            const result = await store.subgraph(
              { kind: "SgFolder", id: asNodeId<typeof SgFolder>(rootId) },
              {
                edges: [],
                composition: true,
                temporalMode: coordinate.mode satisfies TemporalMode,
                ...(coordinate.mode === "asOf" && { asOf: coordinate.asOf }),
              },
            );
            expect({
              coordinate,
              nodes: result.nodes
                .map((node) => sgKey(node.kind, node.id))
                .toSorted(compareStrings),
              edges: result.edges
                .map((edge) => edge.id)
                .toSorted(compareStrings),
            }).toEqual({
              coordinate,
              ...sgExpectedClosure(rootKey, hiddenKeys, edges, coordinate),
            });
          }
        } finally {
          await backend.close();
        }
      }),
      { numRuns: propertyRuns({ ci: 100, local: 250 }) },
    );
  }, 120_000);
});

/** Writes `specs` in order, keeping the rows the store accepts; soft-deletes the ones marked deleted. */
async function writeSgEdges(
  store: Store<CompositionGraph>,
  specs: readonly SgEdgeSpec[],
): Promise<readonly SgModelEdge[]> {
  const accepted: SgModelEdge[] = [];
  for (const spec of specs) {
    const shape = SG_EDGE_SHAPES[spec.kind];
    const [fromIndex, toIndex] =
      shape.wholeSide === "to" ?
        [spec.part, spec.whole]
      : [spec.whole, spec.part];
    const fromId = requireDefined(SG_NODE_IDS[fromIndex]);
    const toId = requireDefined(SG_NODE_IDS[toIndex]);
    const validFrom = requireDefined(SG_EDGE_FROM[spec.validFrom]);
    const validTo = SG_EDGE_TO[spec.validTo];
    const window = { validFrom, ...(validTo !== undefined && { validTo }) };
    const from = { kind: shape.from, id: fromId } as const;
    const to = { kind: shape.to, id: toId } as const;
    let created: Readonly<{ id: string }>;
    try {
      created = await createSgEdge(store, spec.kind, from, to, window);
    } catch (error) {
      if (error instanceof Error && SG_EXPECTED_REFUSALS.has(error.name)) {
        continue;
      }
      throw error;
    }
    if (spec.deleted) await deleteSgEdge(store, spec.kind, created.id);
    accepted.push({
      id: created.id,
      kind: spec.kind,
      fromKey: sgKey(shape.from, fromId),
      toKey: sgKey(shape.to, toId),
      validFrom,
      validTo,
      deleted: spec.deleted,
    });
  }
  return accepted;
}

type SgEndpoint = Readonly<{ kind: SgNodeKind; id: string }>;
type SgWindow = Readonly<{ validFrom: string; validTo?: string }>;

function createSgEdge(
  store: Store<CompositionGraph>,
  kind: SgEdgeKind,
  from: SgEndpoint,
  to: SgEndpoint,
  window: SgWindow,
): Promise<Readonly<{ id: string }>> {
  const folder = (endpoint: SgEndpoint) => ({
    kind: "SgFolder" as const,
    id: endpoint.id,
  });
  const document = (endpoint: SgEndpoint) => ({
    kind: "SgDoc" as const,
    id: endpoint.id,
  });
  switch (kind) {
    case "sgSubfolderOf": {
      return store.edges.sgSubfolderOf.create(
        folder(from),
        folder(to),
        {},
        window,
      );
    }
    case "sgInFolder": {
      return store.edges.sgInFolder.create(
        document(from),
        folder(to),
        {},
        window,
      );
    }
    case "sgHolds": {
      return store.edges.sgHolds.create(folder(from), document(to), {}, window);
    }
    case "sgSeeAlso": {
      return store.edges.sgSeeAlso.create(
        folder(from),
        document(to),
        {},
        window,
      );
    }
  }
}

function deleteSgEdge(
  store: Store<CompositionGraph>,
  kind: SgEdgeKind,
  id: string,
): Promise<void> {
  switch (kind) {
    case "sgSubfolderOf": {
      return store.edges.sgSubfolderOf.delete(
        asEdgeId<typeof sgSubfolderOf>(id),
      );
    }
    case "sgInFolder": {
      return store.edges.sgInFolder.delete(asEdgeId<typeof sgInFolder>(id));
    }
    case "sgHolds": {
      return store.edges.sgHolds.delete(asEdgeId<typeof sgHolds>(id));
    }
    case "sgSeeAlso": {
      return store.edges.sgSeeAlso.delete(asEdgeId<typeof sgSeeAlso>(id));
    }
  }
}
