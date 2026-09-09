/**
 * The conformance body a `lineage` source must pass, run here against the
 * store's recorded-relations derivation (`recordedRelationsLineage`).
 *
 * Registered into every dialect via `createIntegrationTestSuite`, so it
 * runs on both bundled dialects without a second copy of these cases.
 *
 * Only the "lineage: recorded-relations conformance" describe below is
 * portable to a future engine-native `lineage` (`backend/capabilities/
 * lineage.ts`) — it drives every case through `resolveLineage`, which an
 * engine-backed store would resolve to that engine's own `lineage` member.
 * The "lineage: capture-completeness evidence" describe is TypeGraph-specific:
 * it exercises `recordedRelationsLineage` directly and depends on the
 * TypeGraph-only distinction between `revisionTracking` and `history`, which
 * has no equivalent for an engine that mints its own revisions — an
 * engine-native `lineage` has no such gap to detect. An engine profile's own
 * suite should point at the conformance describe only.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  type EngineRevision,
  type EntityKey,
  type GraphBackend,
} from "../../../src/backend/types";
import { createRecordedInstant } from "../../../src/core/temporal";
import {
  encodeRecordedLineageRevision,
  readRevisionOrigin,
  recordedRelationsLineage,
  resolveLineage,
} from "../../../src/store/recorded-capture";

const LineagePerson = defineNode("LineagePerson", {
  schema: z.object({ name: z.string() }),
});
const lineageKnows = defineEdge("lineage_knows");

const lineageGraph = defineGraph({
  id: "lineage_recorded_relations",
  nodes: { LineagePerson: { type: LineagePerson } },
  edges: {
    lineage_knows: {
      type: lineageKnows,
      from: [LineagePerson],
      to: [LineagePerson],
    },
  },
});

const gapGraph = defineGraph({
  id: "lineage_pre_capture_gap",
  nodes: { LineagePerson: { type: LineagePerson } },
  edges: {},
});

/**
 * Identity-enabled twin of {@link gapGraph}, for the case whose earliest
 * CAPTURED commit is an identity assertion rather than a node or edge
 * write — `changesSince`'s completeness scan folding the identity-assertions
 * relation into its evidence query is what keeps that case from looking
 * like a gap. `"ignore"` is enough: this graph never folds same-id nodes
 * across kinds, it only needs `store.identity` to exist.
 */
const identityGapGraph = defineGraph({
  id: "lineage_identity_gap",
  nodes: { LineagePerson: { type: LineagePerson } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

function byId(left: EntityKey, right: EntityKey): number {
  return (
    left.id < right.id ? -1
    : left.id > right.id ? 1
    : 0
  );
}

function sortedKeys(keys: readonly EntityKey[]): readonly EntityKey[] {
  return [...keys].toSorted((left, right) => byId(left, right));
}

/**
 * The one thing this conformance body needs from its caller: a backend to
 * build a fresh history store against. A real `IntegrationTestContext`
 * (whose `getStore()` returns a whole `Store`) satisfies this structurally,
 * as does the minimal object `tests/lineage-recorded-relations.test.ts`
 * builds directly — and it is small enough that an engine profile outside
 * this repository can satisfy it without depending on this test suite's
 * internal `IntegrationTestContext` type.
 */
export type LineageConformanceContext = Readonly<{
  getStore: () => Readonly<{ backend: GraphBackend }>;
}>;

export function registerLineageConformanceIntegrationTests(
  context: LineageConformanceContext,
): void {
  describe("lineage: recorded-relations conformance", () => {
    it("reports exactly the node and edge keys touched since an earlier revision", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      const r0 = await lineage.revision(backend);
      const alice = await store.nodes.LineagePerson.create({ name: "Alice" });
      const bob = await store.nodes.LineagePerson.create({ name: "Bob" });
      const edge = await store.edges.lineage_knows.create(alice, bob, {});

      const delta = await lineage.changesSince(backend, r0, store.graphId);
      if (delta.kind !== "keys") throw new Error("expected a keys delta");
      expect(sortedKeys(delta.nodes)).toEqual(
        sortedKeys([
          { kind: "LineagePerson", id: alice.id },
          { kind: "LineagePerson", id: bob.id },
        ]),
      );
      expect(delta.edges).toEqual([{ kind: "lineage_knows", id: edge.id }]);
    });

    it("reports no changes since the current revision", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      await store.nodes.LineagePerson.create({ name: "Carol" });
      const rNow = await lineage.revision(backend);

      const delta = await lineage.changesSince(backend, rNow, store.graphId);
      expect(delta).toEqual({ kind: "keys", nodes: [], edges: [] });
    });

    it("reports a hard-deleted node's key", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      const dave = await store.nodes.LineagePerson.create({ name: "Dave" });
      const rBeforeDelete = await lineage.revision(backend);
      await store.nodes.LineagePerson.hardDelete(dave.id);

      const delta = await lineage.changesSince(
        backend,
        rBeforeDelete,
        store.graphId,
      );
      expect(delta).toEqual({
        kind: "keys",
        nodes: [{ kind: "LineagePerson", id: dave.id }],
        edges: [],
      });
    });

    it("reports a resurrected node's key exactly once", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      const erin = await store.nodes.LineagePerson.create({ name: "Erin" });
      const rBeforeDelete = await lineage.revision(backend);
      await store.nodes.LineagePerson.delete(erin.id);
      await store.nodes.LineagePerson.upsertById(erin.id, {
        name: "Erin restored",
      });

      const delta = await lineage.changesSince(
        backend,
        rBeforeDelete,
        store.graphId,
      );
      if (delta.kind !== "keys") throw new Error("expected a keys delta");
      expect(delta.nodes.filter((key) => key.id === erin.id)).toHaveLength(1);
    });

    it("reports unbounded for an unknown revision", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      const delta = await lineage.changesSince(
        backend,
        "not-a-revision-this-lineage-minted" as EngineRevision,
        store.graphId,
      );
      expect(delta).toEqual({ kind: "unbounded" });
    });

    it("reports unbounded for a well-formed revision newer than the clock", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      await store.nodes.LineagePerson.create({ name: "Frank" });
      // Mint the origin (via a real `revision()` read) before fabricating a
      // revision that carries it but is newer than anything the clock has
      // reached — `EngineRevision` is opaque, so this builds a well-formed
      // token through the SAME grammar `revision()` uses rather than
      // decoding one.
      await lineage.revision(backend);
      const origin = await readRevisionOrigin(
        backend,
        store.revisionSchema,
        store.graphId,
      );
      if (origin === undefined) throw new Error("expected a minted origin");
      const futureRevision = encodeRecordedLineageRevision(
        origin,
        createRecordedInstant(1_000_000, "2099-01-01T00:00:00.000Z"),
      );

      const delta = await lineage.changesSince(
        backend,
        futureRevision,
        store.graphId,
      );
      expect(delta).toEqual({ kind: "unbounded" });
    });

    it("reports unbounded for a well-formed revision whose origin does not match this graph's live origin", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      await store.nodes.LineagePerson.create({ name: "Alice" });
      // Mint this graph's real origin (via revision()), then fabricate a
      // revision that carries a DIFFERENT one — the shape a numerically
      // coincidental revision from an unrelated database, or one minted
      // before a `Store.clear()` rotated the origin, would take.
      await lineage.revision(backend);
      const foreignRevision = encodeRecordedLineageRevision(
        "a-different-store-entirely",
        undefined,
      );

      const delta = await lineage.changesSince(
        backend,
        foreignRevision,
        store.graphId,
      );
      expect(delta).toEqual({ kind: "unbounded" });
    });

    it("refuses changesSince for a graph other than the one it was derived from", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      const r0 = await lineage.revision(backend);
      await expect(
        lineage.changesSince(backend, r0, "some-other-graph"),
      ).rejects.toThrow(/different graph/);
    });

    it("calls changesSince from inside store.transaction with the transaction handle as the session, and the caller-serialized reentrancy guard does not fire", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(lineageGraph, backend, {
        history: true,
      });
      const lineage = resolveLineage(store);
      if (lineage === undefined) throw new Error("expected a resolved lineage");

      const r0 = await lineage.revision(backend);
      const alice = await store.nodes.LineagePerson.create({ name: "Alice" });

      // The transaction handle IS the session passed to both members here —
      // exactly the shape `assertTargetUnchanged` (`graph-merge/merge.ts`)
      // uses at commit time. Reading on the handle it is given, rather than
      // on a separately-held connection, is what lets this run from inside
      // an open transaction on the bundled caller-serialized SQLite backend
      // without colliding with its own reentrancy guard (contrast
      // `tests/graph-merge/base-version-engine-anchor.test.ts`'s
      // ignores-the-session case, which deliberately reads through a
      // different connection and DOES collide).
      const delta = await backend.transaction(async (tx) => {
        return lineage.changesSince(tx, r0, store.graphId);
      });
      if (delta.kind !== "keys") throw new Error("expected a keys delta");
      expect(delta.nodes).toEqual([{ kind: "LineagePerson", id: alice.id }]);
    });
  });

  describe("lineage: capture-completeness evidence", () => {
    it("reports unbounded when an interleaved non-capturing writer leaves a revision with no recorded evidence", async () => {
      const backend = context.getStore().backend;
      const [historyStore] = await createStoreWithSchema(gapGraph, backend, {
        history: true,
      });
      const lineage = recordedRelationsLineage(historyStore);
      // Read BEFORE either writer touches the graph — mints the origin and
      // anchors on the genesis revision.
      const earlyRevision = await lineage.revision(backend);

      // A SECOND store over the SAME backend and graph, revision-tracking
      // only (no history): its write advances the shared clock without
      // ever inserting a recorded row.
      const [trackingStore] = await createStoreWithSchema(gapGraph, backend, {
        revisionTracking: true,
      });
      await trackingStore.nodes.LineagePerson.create({ name: "Untracked" });

      // A LATER capturing commit on the SAME graph. Per-revision evidence
      // (see `lineage.ts`'s module doc) catches the gap regardless of this
      // later commit's own evidence — a ceiling-only check would not.
      await historyStore.nodes.LineagePerson.create({ name: "Captured" });

      const delta = await lineage.changesSince(
        backend,
        earlyRevision,
        historyStore.graphId,
      );
      expect(delta).toEqual({ kind: "unbounded" });
    });

    it("does not report unbounded when the earliest captured commit is an identity assertion, not a node or edge write", async () => {
      const backend = context.getStore().backend;
      const [historyStore] = await createStoreWithSchema(
        identityGapGraph,
        backend,
        { history: true },
      );
      const lineage = recordedRelationsLineage(historyStore);
      const first = await historyStore.nodes.LineagePerson.create({
        name: "First",
      });
      const second = await historyStore.nodes.LineagePerson.create({
        name: "Second",
      });
      const boundaryRevision = await lineage.revision(backend);

      // The next commit this graph captures touches ONLY the
      // identity-assertions relation — no node or edge row. Without the
      // completeness evidence query folding that relation into its scan,
      // this revision would look like a gap (the recorded nodes/edges
      // tables' own evidence is the LATER "Captured" write below).
      await historyStore.identity.assertSame(first, second);
      const captured = await historyStore.nodes.LineagePerson.create({
        name: "Captured",
      });

      const delta = await lineage.changesSince(
        backend,
        boundaryRevision,
        historyStore.graphId,
      );
      if (delta.kind !== "keys") {
        throw new Error(
          "expected the identity-assertion evidence to keep this revision in bounds, not report unbounded",
        );
      }
      expect(delta.nodes).toEqual([{ kind: "LineagePerson", id: captured.id }]);
      expect(delta.edges).toEqual([]);
    });
  });
}
