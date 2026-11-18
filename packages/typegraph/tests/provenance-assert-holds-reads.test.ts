/**
 * `assertHolds` runs under the per-graph write lock on every guarded
 * derivation, so what it reads must be bounded by what is behind the named
 * fact, never by the size of the provenance graph.
 *
 * Every verdict a whole-graph read would give is the verdict the closure read
 * gives, so no verdict comparison can see the difference. This suite records
 * the backend reads instead: unrelated chains are seeded, and the reads one
 * `assertHolds` issues must not be a kind scan, must not be an edge read
 * without an endpoint, and must not grow with the number of unrelated chains.
 *
 * Named mutation, verified to bite: in `assertFactsHold`
 * (`src/provenance/holds.ts`) replace `loadSupportClosure(...)` with
 * `loadSupportGraph(transactionBackend(tx), scope.registry, scope.graphId,
 * scope.config, scope.batchPointRead)`. Every test below then fails.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../src/backend/types";
import { createRetractionCapability } from "../src/provenance";
import type { HistoryStore } from "../src/store-entry";
import { createTestBackend } from "./test-utils";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "provenance_assert_holds_reads",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
});

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const SMALL_GRAPH_CHAINS = 2;
const LARGE_GRAPH_CHAINS = 50;
const TARGET_FACT = { kind: "Fact", id: "target-fact" } as const;

type ReadMember =
  | "findNodesByKind"
  | "findEdgesByKind"
  | "findEdgesByEndpointSet"
  | "getNode"
  | "getNodes";
type RecordedRead = Readonly<{
  member: ReadMember;
  params: unknown;
  rows: number;
}>;
type ReadStore = HistoryStore<typeof graph>;

async function recordRead<Result>(
  reads: RecordedRead[],
  member: ReadMember,
  params: unknown,
  run: () => Promise<Result>,
): Promise<Result> {
  const result = await run();
  reads.push({ member, params, rows: countReadRows(result) });
  return result;
}

function countReadRows(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  return result === undefined ? 0 : 1;
}

/**
 * Records every read member the capability can reach, on the root and on each
 * transaction target, by decorating through the derivation seam.
 */
function recordedReadMembers(
  base: GraphBackend | TransactionBackend,
  reads: RecordedRead[],
) {
  return {
    findNodesByKind(params: Parameters<GraphBackend["findNodesByKind"]>[0]) {
      return recordRead(reads, "findNodesByKind", params, () =>
        base.findNodesByKind(params),
      );
    },
    findEdgesByKind(params: Parameters<GraphBackend["findEdgesByKind"]>[0]) {
      return recordRead(reads, "findEdgesByKind", params, () =>
        base.findEdgesByKind(params),
      );
    },
    findEdgesByEndpointSet(
      params: Parameters<
        NonNullable<GraphBackend["findEdgesByEndpointSet"]>
      >[0],
    ) {
      return recordRead(reads, "findEdgesByEndpointSet", params, () =>
        requireMember(base.findEdgesByEndpointSet)(params),
      );
    },
    getNode(...args: Parameters<GraphBackend["getNode"]>) {
      return recordRead(reads, "getNode", args, () => base.getNode(...args));
    },
    getNodes(...args: Parameters<NonNullable<GraphBackend["getNodes"]>>) {
      return recordRead(reads, "getNodes", args, () =>
        requireMember(base.getNodes)(...args),
      );
    },
  };
}

function recordReads(root: GraphBackend, reads: RecordedRead[]): GraphBackend {
  return deriveBackend(root, {
    ...recordedReadMembers(root, reads),
    transaction<R>(
      fn: (target: TransactionBackend) => Promise<R>,
      options?: Parameters<GraphBackend["transaction"]>[1],
    ): Promise<R> {
      return root.transaction(
        (target) =>
          fn(deriveBackend(target, recordedReadMembers(target, reads))),
        options,
      );
    },
  });
}

function requireMember<T>(member: T | undefined): T {
  if (member === undefined) throw new Error("backend member not provided");
  return member;
}

async function seedChain(store: ReadStore, suffix: string): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.nodes.Source.create({ label: suffix }, { id: `source-${suffix}` });
    await tx.nodes.Justification.create(
      { label: suffix },
      { id: `justification-${suffix}` },
    );
    await tx.nodes.Fact.create({ label: suffix }, { id: `${suffix}-fact` });
    await tx.edges.premiseOf.create(
      { kind: "Source", id: `source-${suffix}` },
      { kind: "Justification", id: `justification-${suffix}` },
      {},
    );
    await tx.edges.derives.create(
      { kind: "Justification", id: `justification-${suffix}` },
      { kind: "Fact", id: `${suffix}-fact` },
      {},
    );
  });
}

async function readsOfAssertHolds(
  unrelatedChains: number,
): Promise<readonly RecordedRead[]> {
  const reads: RecordedRead[] = [];
  const [store] = await createStoreWithSchema(
    graph,
    recordReads(createTestBackend(), reads),
    { history: true },
  );
  await seedChain(store, "target");
  for (let index = 0; index < unrelatedChains; index++) {
    await seedChain(store, `other-${index}`);
  }
  const provenance = createRetractionCapability(store, config);

  reads.splice(0);
  const [held] = await store.transaction((tx) =>
    provenance.assertHolds(tx, [TARGET_FACT]),
  );
  expect(held?.via).toEqual([
    { kind: "Justification", id: "justification-target" },
  ]);
  return [...reads];
}

function hasEndpoint(params: unknown): boolean {
  const filter = params as Readonly<Record<string, unknown>>;
  return filter["fromId"] !== undefined || filter["toId"] !== undefined;
}

describe("assertHolds reads only what is behind the named fact", () => {
  it("issues no kind scan and no edge read without an endpoint", async () => {
    const reads = await readsOfAssertHolds(LARGE_GRAPH_CHAINS);

    expect(reads.filter((read) => read.member === "findNodesByKind")).toEqual(
      [],
    );
    expect(
      reads.filter(
        (read) =>
          read.member === "findEdgesByKind" && !hasEndpoint(read.params),
      ),
    ).toEqual([]);
    expect(reads.length).toBeGreaterThan(0);
  });

  it("issues the same reads and returns the same rows whether the graph holds 2 or 50 unrelated chains", async () => {
    const small = await readsOfAssertHolds(SMALL_GRAPH_CHAINS);
    const large = await readsOfAssertHolds(LARGE_GRAPH_CHAINS);

    expect(large.map((read) => read.member)).toEqual(
      small.map((read) => read.member),
    );
    expect(large.map((read) => read.rows)).toEqual(
      small.map((read) => read.rows),
    );
  });
});
