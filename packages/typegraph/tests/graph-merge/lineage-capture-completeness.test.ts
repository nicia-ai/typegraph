/**
 * Two P1 findings from the external review of the lineage capability, both
 * about the recorded-relations-derived `lineage` losing track of a write it
 * cannot vouch for:
 *
 * - `Store.clear()` used to leave the durable per-graph revision-origin row
 *   untouched. A history-on store cleared and repopulated to the same
 *   revision COUNT would then mint a `base@V` token textually identical to
 *   one minted before the clear, so a pre-clear branch would merge as if
 *   nothing had happened.
 * - `recordedRelationsLineage.changesSince` used to trust the recorded
 *   relations unconditionally once this graph's clock had ever advanced. A
 *   second `Store` on the SAME database with `revisionTracking: true` (no
 *   `history`) advances the identical shared clock without ever inserting a
 *   recorded row, so its writes were invisible to `changesSince` — and to
 *   `branchPruneTo`'s pruning, which would silently drop the row from the
 *   diff instead of falling back to the full comparison that would have
 *   seen it.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { computeBaseVersion } from "../../src/graph-merge/base-version";
import { branch } from "../../src/graph-merge/branch";
import { BaseVersionMismatchError } from "../../src/graph-merge/errors";
import { merge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { branchPruneTo } from "../../src/graph-merge/staging";
import { diffAgainstBase } from "../../src/graph-merge/state-diff";
import type { GraphBranch } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import {
  recordedRelationsLineage,
  resolveLineage,
} from "../../src/store/recorded-capture";
import { storeBackend } from "../../src/store/runtime-port";
import { createSqliteMergeBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "lineage-capture-completeness",
  nodes: { Person: { type: Person } },
  edges: {},
});
type G = typeof graph;

const BRANCH = asBranchId("completeness-branch");

describe("Store.clear() rotates the origin a pre-clear branch anchored on", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  function makeMergeBackend() {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    return Promise.resolve(fixture.backend);
  }

  it("refuses a merge of a pre-clear branch after the base is cleared and repopulated to the same revision count", async () => {
    // A frozen clock isolates the origin as the ONLY thing that can move
    // the token: under `history: true`, `clear()` leaves the recorded
    // clock unseeded, so the next captured write restarts numbering from
    // revision 1 — the SAME number the pre-clear branch anchored on — and
    // with the wall clock frozen too, the RecordedInstant's timestamp
    // component matches as well. Without the frozen clock, real elapsed
    // time between the two writes would already make the tokens differ,
    // masking whether the origin rotation is doing any work at all.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const { backend, cleanup } = createSqliteMergeBackend();
      cleanups.push(cleanup);
      const [baseStore] = await createStoreWithSchema(graph, backend, {
        history: true,
      });
      await baseStore.nodes.Person.create({ name: "Alice" });

      const forkBranch = unwrap(
        await branch<G>(baseStore, makeMergeBackend, { id: BRANCH }),
      );
      await forkBranch.store.nodes.Person.create({ name: "From fork" });

      await baseStore.clear();
      await baseStore.nodes.Person.create({ name: "Bob" });

      const result = await merge<G>(baseStore, [forkBranch], {
        resolve: {},
        embedder: () => Promise.resolve([]),
        onPropertyConflict: "flag",
        branchOrder: [BRANCH],
      });

      // Mutation-proof: commenting out `clear()`'s `resetRevisionOrigin`
      // call makes this assertion fail — the merge silently succeeds
      // against a base whose entire content was replaced by the clear.
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
      }
      expect((await baseStore.nodes.Person.find()).map((p) => p.name)).toEqual([
        "Bob",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recordedRelationsLineage: capture-completeness evidence", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  it("reports unbounded once a revisionTracking-only writer sharing the graph has advanced the clock past the last captured row", async () => {
    const { backend, cleanup } = createSqliteMergeBackend();
    cleanups.push(cleanup);
    const [storeA] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const alice = await storeA.nodes.Person.create({ name: "Alice" });
    const r0 = await recordedRelationsLineage(storeA).revision(
      storeBackend(storeA),
    );

    // A SECOND store over the SAME backend and graph, revision-tracking
    // only (no history): its write advances the identical shared clock
    // without inserting a recorded row.
    const [storeB] = await createStoreWithSchema(graph, backend, {
      revisionTracking: true,
    });
    await storeB.nodes.Person.update(alice.id, { name: "Alice via B" });

    const delta = await recordedRelationsLineage(storeA).changesSince(
      storeBackend(storeA),
      r0,
      storeA.graphId,
    );

    // Mutation-proof: reverting `changesSince`'s completeness check makes
    // this report `{ kind: "keys", nodes: [], edges: [] }` instead — B's
    // write is invisible to the recorded relations.
    expect(delta).toEqual({ kind: "unbounded" });
  });

  it("does not prune away a base-side row a non-capturing revision-tracked writer touched", async () => {
    const { backend, cleanup } = createSqliteMergeBackend();
    cleanups.push(cleanup);
    const [storeA] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const alice = await storeA.nodes.Person.create({ name: "Alice" });

    // The fork is built with `history: true` DIRECTLY, on its own separate
    // backend, and its `GraphBranch` assembled by hand — `branch()`'s
    // default clone strategy never copies recorded-time history into the
    // working copy (see `working-copy.ts`), so a clone built through it
    // would resolve no `lineage` at all and this pruning path would stay
    // dormant regardless of the fix under test (the same reason
    // `tests/property/graph-merge/lineage-pruned-diff.test.ts` builds its
    // pairs this way). `alice` is replicated onto the fork by hand (same id,
    // same props) to stand in for what a real clone would have inherited —
    // a genuine merge candidate needs the fork to actually HOLD the row B
    // later edits on the base side, or a full diff would call it "deleted"
    // rather than "modified" regardless of pruning.
    const forkFixture = createSqliteMergeBackend();
    cleanups.push(forkFixture.cleanup);
    const [forkStore] = await createStoreWithSchema(
      graph,
      forkFixture.backend,
      { history: true },
    );
    await forkStore.nodes.Person.create({ name: "Alice" }, { id: alice.id });
    const base = await computeBaseVersion(storeA);
    const forkLineage = resolveLineage(forkStore);
    if (forkLineage === undefined) {
      throw new Error("expected forkStore to resolve a lineage");
    }
    const forkRevision = await forkLineage.revision(forkFixture.backend);
    const forkBranch: GraphBranch<G> = {
      id: BRANCH,
      base,
      store: forkStore,
      close: (): Promise<void> => Promise.resolve(),
      forkRevision,
    };
    // An unrelated fork edit, so the fork's own delta is non-empty and the
    // branch is a genuine merge candidate.
    await forkStore.nodes.Person.create({ name: "From fork" });

    const [storeB] = await createStoreWithSchema(graph, backend, {
      revisionTracking: true,
    });
    await storeB.nodes.Person.update(alice.id, { name: "Alice via B" });

    const pruneTo = await branchPruneTo(storeA, forkBranch);
    // Mutation-proof: reverting the completeness check makes `changesSince`
    // report an empty (but bounded) delta for the base side, so
    // `branchPruneTo` returns a `"keys"` delta that omits `alice` — the
    // assertion below fails because the pruned batch read never fetches
    // her row at all.
    expect(pruneTo).toBeUndefined();

    const diff = await diffAgainstBase(storeA, forkStore, false, pruneTo);
    const aliceModified = diff.nodes.modified.find(
      (node) => node.id === alice.id,
    );
    expect(aliceModified?.baseProps).toEqual({ name: "Alice via B" });
  });
});
