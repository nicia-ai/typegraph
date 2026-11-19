/**
 * Edge `bulkHardDelete(ids)`, on every backend.
 *
 * The contract is equivalence: a batch leaves exactly the state that calling
 * `hardDelete(id)` once per id inside one transaction leaves — rows, released
 * cardinality and composition claims, recorded history and the revision clock
 * — while refusing a foreign-kind id or a required-part detach before the
 * first row is removed.
 *
 * Each case names, in a comment, the mutation that must make it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionExistenceError,
  ConfigurationError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  partOf,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import {
  type HardDeleteEdgeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import {
  RECORDED_MAX_REVISION,
  recordedInstantRevision,
} from "../../../src/core/temporal";
import {
  EDGE_IDENTITY_MISMATCH_CODE,
  ValidationError,
} from "../../../src/errors";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const BhdPerson = defineNode("BhdPerson", {
  schema: z.object({ name: z.string() }),
});
const BhdEpisode = defineNode("BhdEpisode", { schema: z.object({}) });
const BhdSegment = defineNode("BhdSegment", { schema: z.object({}) });

/** Unconstrained: owes no claim. */
const bhdFollows = defineEdge("bhdFollows", { schema: z.object({}) });
/** `cardinality: "one"`: every edge holds a claim row to release. */
const bhdMentors = defineEdge("bhdMentors", { schema: z.object({}) });
/** A second kind over the same endpoints, for the cross-kind refusal. */
const bhdLikes = defineEdge("bhdLikes", { schema: z.object({}) });
/** Realizes a required-existence composition pair. */
const bhdSegmentOf = defineEdge("bhdSegmentOf", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      BhdPerson: { type: BhdPerson },
      BhdEpisode: { type: BhdEpisode },
      BhdSegment: { type: BhdSegment },
    },
    edges: {
      bhdFollows: { type: bhdFollows, from: [BhdPerson], to: [BhdPerson] },
      bhdMentors: {
        type: bhdMentors,
        from: [BhdPerson],
        to: [BhdPerson],
        cardinality: "one",
      },
      bhdLikes: { type: bhdLikes, from: [BhdPerson], to: [BhdPerson] },
      bhdSegmentOf: {
        type: bhdSegmentOf,
        from: [BhdSegment],
        to: [BhdEpisode],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(BhdSegment, BhdEpisode, {
        via: bhdSegmentOf,
        existence: "required",
      }),
    ],
  });
}

type BhdGraph = ReturnType<typeof buildGraph>;

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `edge_bulk_hard_delete_${graphIdCounter}`;
}

/** The store surface these cases write through and inspect. */
type BhdStore = Readonly<{
  graphId: string;
  backend: GraphBackend;
  edges: ReturnType<typeof createStore<BhdGraph>>["edges"];
  nodes: ReturnType<typeof createStore<BhdGraph>>["nodes"];
  transaction: ReturnType<typeof createStore<BhdGraph>>["transaction"];
  revisionNow: () => Promise<string | undefined>;
}>;

/**
 * Seeds the same rows, under the same ids, into any graph built by
 * {@link buildGraph}: live and tombstoned edges of a claim-free kind and of a
 * claim-holding kind, plus one edge of another kind.
 */
async function seedEdges(store: BhdStore): Promise<void> {
  // Sequential, so two graphs seeded alike advance their revision clocks alike.
  const people = [];
  for (const id of ["p1", "p2", "p3", "p4"]) {
    people.push(await store.nodes.BhdPerson.create({ name: id }, { id }));
  }
  const [p1, p2, p3, p4] = people.map((person) => requireDefined(person));
  const {
    bhdFollows: follows,
    bhdLikes: likes,
    bhdMentors: mentors,
  } = store.edges;
  await follows.create(
    requireDefined(p1),
    requireDefined(p2),
    {},
    { id: "f1" },
  );
  await follows.create(
    requireDefined(p1),
    requireDefined(p3),
    {},
    { id: "f2" },
  );
  await follows.create(
    requireDefined(p2),
    requireDefined(p3),
    {},
    { id: "f3" },
  );
  await follows.delete("f2" as never);
  await mentors.create(
    requireDefined(p1),
    requireDefined(p2),
    {},
    { id: "m1" },
  );
  await mentors.create(
    requireDefined(p2),
    requireDefined(p3),
    {},
    { id: "m2" },
  );
  await mentors.create(
    requireDefined(p3),
    requireDefined(p4),
    {},
    { id: "m3" },
  );
  await mentors.delete("m2" as never);
  await likes.create(requireDefined(p1), requireDefined(p2), {}, { id: "l1" });
}

/**
 * Everything a hard delete can leave behind for this graph, free of the graph
 * id and of wall-clock timestamps so two graphs seeded alike compare equal:
 * edge rows (with their tombstone state), edge claim rows, recorded-history
 * rows per edge id (history stores only), and the graph's revision number.
 */
async function dumpState(
  store: BhdStore,
  options: Readonly<{ history: boolean }>,
): Promise<unknown> {
  const { edgesTable, recordedEdgesTable, tables } = createSqlSchema(
    store.backend.tableNames,
  );
  const edges = await store.backend.execute<
    Readonly<{ id: string; kind: string; tombstoned: number | string }>
  >(
    asCompiledRowsSql(sql`
      SELECT id, kind,
             CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS tombstoned
      FROM ${edgesTable}
      WHERE graph_id = ${store.graphId}
      ORDER BY id
    `),
  );
  const claims = await store.backend.execute<
    Readonly<{ axis: string; claim_key: string; edge_id: string }>
  >(
    asCompiledRowsSql(sql`
      SELECT axis, ${sql.identifier("key")} AS claim_key, edge_id
      FROM ${sql.identifier(tables.edgeClaims)}
      WHERE graph_id = ${store.graphId}
      ORDER BY edge_id, axis
    `),
  );
  const recorded =
    options.history ?
      await store.backend.execute<
        Readonly<{ id: string; rows: number | string; open: number | string }>
      >(
        asCompiledRowsSql(sql`
          SELECT id, COUNT(*) AS rows,
                 SUM(CASE WHEN recorded_to = ${RECORDED_MAX_REVISION} THEN 1 ELSE 0 END) AS open
          FROM ${recordedEdgesTable}
          WHERE graph_id = ${store.graphId}
          GROUP BY id
          ORDER BY id
        `),
      )
    : [];
  const revision = await store.revisionNow();
  return {
    edges: edges.map((row) => ({
      id: row.id,
      kind: row.kind,
      tombstoned: Number(row.tombstoned) === 1,
    })),
    claims: claims.map((row) => ({
      axis: row.axis,
      key: row.claim_key,
      edgeId: row.edge_id,
    })),
    recorded: recorded.map((row) => ({
      id: row.id,
      rows: Number(row.rows),
      open: Number(row.open),
    })),
    revision:
      revision === undefined ? undefined : (
        recordedInstantRevision(revision as never)
      ),
  };
}

async function expectHardDeleteIdentityMismatch(
  operation: Promise<unknown>,
): Promise<void> {
  const error = await operation.then(
    () => {
      throw new Error("Expected an edge identity mismatch.");
    },
    (error_: unknown) => error_,
  );
  expect(error).toBeInstanceOf(ValidationError);
  if (!(error instanceof ValidationError)) throw error;
  expect(error.details.operation).toBe("hardDelete");
  expect(error.details.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: EDGE_IDENTITY_MISMATCH_CODE }),
    ]),
  );
}

class InjectedHardDeleteFailure extends Error {}

/**
 * The lane's backend without `hardDeleteEdgesBatch`, on the root and on every
 * transaction target, so `bulkHardDelete` must take its per-edge fallback.
 * Counts each `hardDeleteEdge` call and, when `failOnCall` is set, throws on
 * that call — after earlier calls have already removed their rows inside the
 * batch's transaction.
 */
function withoutHardDeleteBatch(
  backend: GraphBackend,
  failOnCall?: number,
): Readonly<{ backend: GraphBackend; calls: () => number }> {
  let calls = 0;
  function strip<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): Omit<T, "hardDeleteEdgesBatch"> {
    const stripped = projectBackendWithout(target, ["hardDeleteEdgesBatch"]);
    return deriveBackend(stripped, {
      async hardDeleteEdge(params: HardDeleteEdgeParams): Promise<boolean> {
        calls += 1;
        if (calls === failOnCall) throw new InjectedHardDeleteFailure();
        return target.hardDeleteEdge(params);
      },
    } as never);
  }
  const derived: GraphBackend = deriveBackend(strip(backend) as GraphBackend, {
    transaction: (fn, options) =>
      backend.transaction((tx) => fn(strip(tx) as TransactionBackend), options),
  });
  return { backend: derived, calls: () => calls };
}

/** A seeded store on a fresh graph: revision-tracked live, or history. */
async function createSeededStore(
  context: IntegrationTestContext,
  mode: "live" | "history",
): Promise<BhdStore> {
  const graph = buildGraph(nextGraphId());
  const store =
    mode === "history" ?
      await context.createHistoryStore(graph)
    : await context.createStore(graph, { revisionTracking: true });
  const bhdStore = store as unknown as BhdStore;
  await seedEdges(bhdStore);
  return bhdStore;
}

export function registerEdgeBulkHardDeleteIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge bulkHardDelete", () => {
    it("removes live and tombstoned edges of its kind, ignoring absent and repeated ids", async () => {
      const store = await createSeededStore(context, "live");

      await store.edges.bhdFollows.bulkHardDelete([
        "f1",
        "f2",
        "absent",
        "f1",
      ] as never);

      for (const id of ["f1", "f2"]) {
        expect(
          await store.backend.getEdge(store.graphId, id),
          `${id} must be physically removed`,
        ).toBeUndefined();
      }
      expect(await store.backend.getEdge(store.graphId, "f3")).toBeDefined();
      expect(await store.backend.getEdge(store.graphId, "l1")).toBeDefined();
    });
    // MUTATION CHECK: skip tombstoned rows in `executeEdgeHardDeleteBatch`
    // (`if (current.deleted_at) continue;`, as the soft batch does) — f2
    // survives.

    for (const mode of ["live", "history"] as const) {
      it(`leaves the state a per-id hardDelete loop in one transaction leaves (${mode} store)`, async () => {
        const looped = await createSeededStore(context, mode);
        const batched = await createSeededStore(context, mode);
        const followIds = ["f1", "f2", "absent", "f1"];
        const mentorIds = ["m1", "m2", "m2"];

        await looped.transaction(async (tx) => {
          for (const id of followIds) {
            await tx.edges.bhdFollows.hardDelete(id as never);
          }
          for (const id of mentorIds) {
            await tx.edges.bhdMentors.hardDelete(id as never);
          }
        });
        await batched.transaction(async (tx) => {
          await tx.edges.bhdFollows.bulkHardDelete(followIds as never);
          await tx.edges.bhdMentors.bulkHardDelete(mentorIds as never);
        });

        const history = mode === "history";
        const loopedState = await dumpState(looped, { history });
        expect(await dumpState(batched, { history })).toEqual(loopedState);
        expect(loopedState).toMatchObject({
          edges: [
            { id: "f3", tombstoned: false },
            { id: "l1", tombstoned: false },
            { id: "m3", tombstoned: false },
          ],
        });
      });
    }
    // MUTATION CHECK: pass `holdsCardinalityClaim: false` from
    // `executeEdgeHardDeleteBatch` — m1's claim row survives the batch, not
    // the loop, and both cases fail.

    it("releases the claims it removed, so the freed slot can be taken again", async () => {
      const store = await createSeededStore(context, "live");
      const p1 = { kind: "BhdPerson" as const, id: "p1" };
      const p4 = { kind: "BhdPerson" as const, id: "p4" };

      await store.edges.bhdMentors.bulkHardDelete(["m1"] as never);

      const replacement = await store.edges.bhdMentors.create(p1, p4, {});
      expect(replacement.fromId).toBe("p1");
    });

    it("refuses an id owned by another edge kind and deletes nothing, inside and outside a transaction", async () => {
      const store = await createSeededStore(context, "live");
      const before = await dumpState(store, { history: false });
      // The foreign id comes LAST, so a batch that wrote as it resolved would
      // already have removed f1 and f3 when the refusal is reached.
      const batch = ["f1", "f3", "l1"] as never;

      await expectHardDeleteIdentityMismatch(
        store.edges.bhdFollows.bulkHardDelete(batch),
      );
      await store.transaction(async (tx) => {
        await expectHardDeleteIdentityMismatch(
          tx.edges.bhdFollows.bulkHardDelete(batch),
        );
      });

      expect(await dumpState(store, { history: false })).toEqual(before);
    });
    // MUTATION CHECK: drop the `assertEdgeIdentityMatches` call from
    // `executeEdgeHardDeleteBatch` — the batch then resolves, the
    // kind-asserting DELETE skips l1, and f1/f3 are removed: no refusal and a
    // changed state. Issuing each member's DELETE as it is resolved, instead
    // of after the whole batch is judged, fails the in-transaction half.

    it("refuses to leave a live required part without its whole and deletes nothing of the batch", async () => {
      const store = await createSeededStore(context, "live");
      const episode = await store.nodes.BhdEpisode.create({});
      const retired = await store.nodes.BhdSegment.create(
        {},
        { partOf: { whole: { kind: "BhdEpisode", id: episode.id } } },
      );
      const live = await store.nodes.BhdSegment.create(
        {},
        { partOf: { whole: { kind: "BhdEpisode", id: episode.id } } },
      );
      await store.backend.deleteNode({
        graphId: store.graphId,
        kind: "BhdSegment",
        id: retired.id,
      });
      const segmentEdges = await store.edges.bhdSegmentOf.find({});
      const edgeIdOf = (partId: string) =>
        requireDefined(segmentEdges.find((edge) => edge.fromId === partId)).id;
      // The retired part's edge comes FIRST, so a batch that wrote as it
      // judged would remove it before refusing the live one.
      const batch = [edgeIdOf(retired.id), edgeIdOf(live.id)];
      const before = await dumpState(store, { history: false });

      const refusal = await store.edges.bhdSegmentOf
        .bulkHardDelete(batch)
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(CompositionExistenceError);
      expect((refusal as CompositionExistenceError).details).toMatchObject({
        situation: "detach",
        partId: live.id,
        edgeId: batch[1],
      });
      expect(await dumpState(store, { history: false })).toEqual(before);

      // The retired part's edge alone detaches nothing live.
      await store.edges.bhdSegmentOf.bulkHardDelete([requireDefined(batch[0])]);
      const remaining = await store.edges.bhdSegmentOf.find({});
      expect(remaining.map((edge) => edge.id)).toEqual([batch[1]]);
    });
    // MUTATION CHECK: drop the per-row `assertCompositionExistencePreserved`
    // call from `executeEdgeHardDeleteBatch` — the batch resolves and orphans
    // the live segment.

    it("is refused on a read-only view like every other edge write", async () => {
      const graph = buildGraph(nextGraphId());
      const store = await context.createStore(graph);
      await seedEdges(store);
      const view = store.asOf(new Date().toISOString()).edges
        .bhdFollows as unknown as Readonly<{
        bulkHardDelete: (ids: readonly string[]) => unknown;
      }>;

      expect(() => view.bulkHardDelete(["f1"])).toThrow(ConfigurationError);
      expect(await store.backend.getEdge(store.graphId, "f1")).toBeDefined();
    });

    it("is a no-op that advances no revision for an empty or all-absent batch", async () => {
      const store = await createSeededStore(context, "live");
      const before = await dumpState(store, { history: false });

      await store.edges.bhdFollows.bulkHardDelete([]);
      await store.edges.bhdFollows.bulkHardDelete([
        "absent-1",
        "absent-2",
      ] as never);

      expect(await dumpState(store, { history: false })).toEqual(before);
    });
    // MUTATION CHECK: drop `didWrite` from `executeEdgeHardDeleteBatch`'s
    // plan options — the all-absent batch then advances the revision.

    it("takes the per-edge fallback without the batch port, with the same result and no partial write on failure", async () => {
      const reference = await createSeededStore(context, "live");
      const fallbackSeed = await createSeededStore(context, "live");
      const batch = ["m1", "m2", "absent", "m3"] as never;

      await reference.edges.bhdMentors.bulkHardDelete(batch);

      const failing = withoutHardDeleteBatch(fallbackSeed.backend, 2);
      const failingStore = createStore(
        buildGraph(fallbackSeed.graphId),
        failing.backend,
        { revisionTracking: true },
      );
      const before = await dumpState(fallbackSeed, { history: false });
      await expect(
        failingStore.edges.bhdMentors.bulkHardDelete(batch),
      ).rejects.toBeInstanceOf(InjectedHardDeleteFailure);
      // The first member's DELETE ran before the second failed; the batch's
      // one transaction must have rolled it back.
      expect(failing.calls()).toBe(2);
      expect(await dumpState(fallbackSeed, { history: false })).toEqual(before);

      const fallback = withoutHardDeleteBatch(fallbackSeed.backend);
      const fallbackStore = createStore(
        buildGraph(fallbackSeed.graphId),
        fallback.backend,
        { revisionTracking: true },
      );
      await fallbackStore.edges.bhdMentors.bulkHardDelete(batch);
      expect(fallback.calls()).toBe(3);
      expect(await dumpState(fallbackSeed, { history: false })).toEqual(
        await dumpState(reference, { history: false }),
      );
    });
    // MUTATION CHECK: implement the collection's `bulkHardDelete` as a loop
    // of `executeEdgeHardDelete` calls, each its own transaction — m1 stays
    // removed after the injected failure (and the two refusal cases above
    // fail too).
  });
}
