/**
 * Item E.2: the "unattached" composition-orphan arm —
 * `compositionOrphansAmong`'s sibling in `src/graph-merge/merge.ts`
 * (`unattachedRequiredPartOrphansAmong` / `assertNoUnattachedRequiredParts`).
 *
 * `composition-orphan.test.ts` covers `cause: "deleted"`: a whole the plan
 * deletes leaves behind a live part the plan does not also delete. That
 * arm's walk starts FROM a planned node deletion and can never catch the
 * DIFFERENT shape this file is about: a required-existence part whose
 * composition edge canonicalization drops or collapses while BOTH
 * endpoints (part and whole) survive — no node deletion anywhere for the
 * "deleted" arm to walk from.
 *
 * Fixture: `UWhole` --uHolds(cardinality "one")-- `UPart`,
 * `partOf(UPart, UWhole, { via: uHolds, existence: "required" })`. The
 * ordinary store API can never produce a live required part with no whole
 * (create refuses a bare `partOf`-less create, and every detach site
 * refuses ending the part's only edge while it is live) — so the state this
 * arm defends against can only arise from a MERGE combining two
 * independently-valid histories, or (as constructed here, mirroring
 * `composition-orphan.test.ts`'s own "already-dead part" fixture) a branch
 * edit that bypasses the store's own write path entirely to model
 * canonicalization dropping an edge no single store write ever could.
 *
 * The branch is HAND-BUILT (`GraphBranch`'s own docblock: "the merge
 * primitive's own committed-target stand-in, `tests/`-only fixtures") rather
 * than produced by `branch()`, for two reasons:
 *
 * 1. `branch()`'s default working-copy strategy clones the fork point
 *    through `importGraphStream`, which validates a required-existence
 *    part's `partOf` PER STREAM CHUNK ("nodes" then "edges" are separate
 *    `importGraphData` calls, each with its own fresh `pendingRequiredParts`)
 *    rather than across the whole clone — so it refuses to clone ANY store
 *    holding a live required-existence part, independent of this file's
 *    fix. That gap is orthogonal to this fix and out of scope here.
 * 2. The branch's edit must be recognizable as touching the SAME inherited
 *    edge the fork point (and target) carry — which needs the branch's copy
 *    to share the fork point's exact edge id. Ordinary node-create (via
 *    `partOf`) auto-generates a fresh id for its composition edge, so the
 *    branch and the fork point would otherwise diverge on id for what is
 *    supposed to be the identical inherited row. The branch's row is
 *    instead planted with `backend.insertNode`/`insertEdge` directly,
 *    copying the fork point's OWN ids verbatim.
 *
 * The target is `forkPoint` itself: the "target evolved no differently from
 * the fork point" case `composition-orphan.test.ts` already establishes as
 * legitimate, and the simplest way to guarantee the target's copy shares
 * the fork point's exact ids too.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { rowPropsToObject } from "../../src/backend/types";
import { computeBaseVersion } from "../../src/graph-merge/base-version";
import {
  applyMergePlan,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { isErr, isOk } from "../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../src/graph-merge/types";
import { storeBackend } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const UWhole = defineNode("UWhole", { schema: z.object({}) });
const UPart = defineNode("UPart", { schema: z.object({}) });
const uHolds = defineEdge("uHolds", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-orphan-unattached-test",
  nodes: {
    UWhole: { type: UWhole },
    UPart: { type: UPart },
  },
  edges: {
    uHolds: {
      type: uHolds,
      from: [UPart],
      to: [UWhole],
      cardinality: "one",
    },
  },
  ontology: [partOf(UPart, UWhole, { via: uHolds, existence: "required" })],
});
type G = typeof graph;

const BRANCH_A = asBranchId("branch-a");

describe.each(backendMatrix())(
  "composition orphan conflict — unattached required part [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    afterEach(async () => {
      for (const cleanup of cleanups ?? []) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeStore(): Promise<Store<G>> {
      const [store] = await createStoreWithSchema(graph, await makeBackend(), {
        revisionTracking: true,
      });
      return store;
    }

    /**
     * Plants a byte-identical copy of `whole`/`part`/`edge` (read off
     * `source`) directly onto `target`'s backend via raw insert — never
     * through the ordinary create API, which would both refuse a bare
     * required-existence create and mint a fresh (non-matching) edge id.
     */
    async function plantIdenticalFixture(
      source: GraphBackend,
      target: GraphBackend,
    ): Promise<void> {
      const whole = requireDefined(
        await source.getNode(graph.id, "UWhole", "w1"),
        "fork point UWhole/w1",
      );
      const part = requireDefined(
        await source.getNode(graph.id, "UPart", "p1"),
        "fork point UPart/p1",
      );
      const [edge] = await source.findEdgesConnectedTo({
        graphId: graph.id,
        nodeKind: "UPart",
        nodeId: "p1",
      });
      const edgeRow = requireDefined(edge, "fork point uHolds edge");

      await target.insertNode({
        graphId: graph.id,
        kind: whole.kind,
        id: whole.id,
        props: rowPropsToObject(whole.props),
      });
      await target.insertNode({
        graphId: graph.id,
        kind: part.kind,
        id: part.id,
        props: rowPropsToObject(part.props),
      });
      await target.insertEdge({
        graphId: graph.id,
        id: edgeRow.id,
        kind: edgeRow.kind,
        fromKind: edgeRow.from_kind,
        fromId: edgeRow.from_id,
        toKind: edgeRow.to_kind,
        toId: edgeRow.to_id,
        props: rowPropsToObject(edgeRow.props),
      });
    }

    it("reports at plan time and refuses at apply time when a branch drops the part's only composition edge while both endpoints survive", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await forkPoint.nodes.UWhole.create({}, { id: "w1" });
      await forkPoint.nodes.UPart.create(
        {},
        { id: "p1", partOf: { kind: "UWhole", id: "w1" } },
      );
      const [forkEdge] = await forkPoint.edges.uHolds.find({});
      const forkEdgeId = requireDefined(forkEdge).id;

      // The hand-built branch: a fresh, independent backend planted with
      // the fork point's EXACT rows (same ids), so the merge recognizes its
      // edit as touching the SAME inherited edge.
      const branchStore = await makeStore();
      await plantIdenticalFixture(
        storeBackend(forkPoint),
        storeBackend(branchStore),
      );
      const branchA: GraphBranch<G> = {
        id: BRANCH_A,
        base: await computeBaseVersion(forkPoint),
        store: branchStore,
        close: () => Promise.resolve(),
      };
      // Bypasses the branch's OWN store refusal — an ordinary
      // `branchStore.edges.uHolds.delete(...)` would throw
      // `CompositionExistenceError` here, since `UPart/p1` is still live.
      // Written directly through the raw backend instead, exactly as
      // `composition-orphan.test.ts`'s "already-dead part" fixture bypasses
      // `store.nodes.Part.delete` to reach a state the ordinary write path
      // refuses by construction. The branch's diff against the fork point
      // (computed by re-reading its live rows, not a cached record) then
      // legitimately records this edge as deleted, without recording
      // `UPart/p1`'s own deletion.
      await storeBackend(branchStore).deleteEdge({
        graphId: graph.id,
        id: forkEdgeId,
      });

      // The target IS the fork point: it evolved no differently, and
      // sharing the object guarantees the same ids by construction.
      const target = forkPoint;

      const planResult = await planMergeIncremental<G>({
        forkPoint,
        target,
        branches: [branchA],
      });
      expect(isOk(planResult)).toBe(true);
      if (!isOk(planResult)) throw planResult.error;
      const artifact = planResult.data;

      // The plan-time PREVIEW: `unattachedRequiredPartOrphansAmong`'s own
      // contribution. Nothing has been written yet, so nothing else could
      // report this — proving the arm fires BEFORE any attempt to apply.
      expect(artifact.review.compositionOrphans).toEqual([
        {
          part: { kind: "UPart", id: "p1" },
          viaEdgeKind: "uHolds",
          cause: "unattached",
        },
      ]);

      // Apply is refused. For THIS construction — an explicit
      // `plan.edgeDeletes` entry naming a live required-existence
      // composition edge — `applyEdgeRows`'s ordinary
      // `edgeCollection(...).delete(...)` call reaches the composition
      // edge's PRE-EXISTING per-write detach refusal
      // (`assertCompositionExistencePreserved`) BEFORE this fix's own
      // `assertNoUnattachedRequiredParts` gets a chance to run — so the
      // thrown error is `CompositionExistenceError`, translated to
      // `MergeConstraintConflictError` at the merge boundary, not
      // `MergeCompositionOrphanError`. Either way nothing commits, which
      // is the guarantee item E.2's merge-existence audit asks for.
      // `assertNoUnattachedRequiredParts`'s OWN distinguishing value is
      // the case the per-write detach refusal cannot reach at all — a
      // composition edge silently DROPPED by canonicalization
      // (`ENDPOINT_DELETED_DROP_REASON`, `src/graph-merge/edge-repoint.ts`)
      // with no explicit delete/update call for anything to intercept.
      // `DroppedEdge` carries no endpoint data to construct that case from
      // the public API; it is documented as a residual gap
      // (`limitations.md`) rather than reproduced here.
      const applyResult = await applyMergePlan(target, artifact);
      expect(isErr(applyResult)).toBe(true);
      if (!isErr(applyResult)) throw new Error("expected apply to be refused");

      // Nothing changed on the target: the refusal fires from inside the
      // SAME apply transaction the edge deletion would have committed
      // through, so it rolls back with it.
      await expect(
        target.nodes.UWhole.getById("w1" as never),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.UPart.getById("p1" as never),
      ).resolves.toBeDefined();
      await expect(target.edges.uHolds.find({})).resolves.toEqual([
        expect.objectContaining({ id: forkEdgeId }),
      ]);
    });
    // MUTATION CHECK: comment out the `unattached` computation inside
    // `planTimeCompositionOrphans` (src/graph-merge/merge.ts) — drop its
    // call to `unattachedRequiredPartOrphansAmong` and return only
    // `deleted`. The plan-time `compositionOrphans` assertion above then
    // reports `[]` instead of the finding. (Apply still refuses either way,
    // via the pre-existing per-write detach refusal described above — that
    // refusal is what the final `find({})` assertion actually pins, not
    // this fix's own code; the `compositionOrphans` assertion is this
    // test's load-bearing check on the NEW code.)
  },
);
