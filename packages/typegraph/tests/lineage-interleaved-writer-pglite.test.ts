/**
 * PGlite parity check for one of the two P1 findings from the external
 * re-review of the lineage capability: `changesSince`'s completeness check
 * used to compare the graph's current clock against the LARGEST revision any
 * recorded relation had evidence for. That is a heuristic, not proof: a
 * tracking-only writer (T) can update row A at revision N with no recorded
 * row, and a LATER capturing writer (H) can update row B at N+1 WITH a
 * recorded row — the maximum catches back up to the clock, so `changesSince`
 * reports `{ kind: "keys" }` containing B but silently omitting A. Fixed by
 * proving completeness directly: every integer revision in `(since, current]`
 * must carry direct evidence, not merely the largest one.
 *
 * `tests/graph-merge/lineage-capture-completeness.test.ts` already pins this
 * fix on SQLite; this file re-runs the identical scenario on PGlite so the
 * fix is proven backend-agnostic rather than SQLite-specific — the shared
 * query in `evidencedRevisionCount` gives no reason to expect divergence,
 * but nothing here relies on that assumption going untested.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { computeBaseVersion } from "../src/graph-merge/base-version";
import { branchPruneTo } from "../src/graph-merge/staging";
import { diffAgainstBase } from "../src/graph-merge/state-diff";
import type { GraphBranch } from "../src/graph-merge/types";
import { asBranchId } from "../src/graph-merge/types";
import { recordedRelationsLineage } from "../src/store/recorded-capture";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "lineage-interleaved-writer-pglite",
  nodes: { Person: { type: Person } },
  edges: {},
});
type G = typeof graph;

const BRANCH = asBranchId("interleaved-writer-pglite-branch");

describe("per-revision evidence catches an interleaved non-capturing writer [PGlite]", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function makeBackend() {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    cleanups.push(() => backend.close());
    return backend;
  }

  it("changesSince(N-1) is unbounded when a tracking-only writer updates A at N and a capturing writer updates B at N+1", async () => {
    const backend = await makeBackend();
    const [historyStore] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const alice = await historyStore.nodes.Person.create({ name: "Alice" });
    const lineage = recordedRelationsLineage(historyStore);
    // Revision N-1: right after Alice's own captured create.
    const rBeforeGap = await lineage.revision(backend);

    // T: a second Store over the SAME backend/graph, revision-tracking only
    // (no history). Its write allocates revision N with NO recorded row to
    // show for it.
    const [trackingStore] = await createStoreWithSchema(graph, backend, {
      revisionTracking: true,
    });
    await trackingStore.nodes.Person.update(alice.id, {
      name: "Alice via T",
    });

    // H: the SAME capturing store makes a later, fully-captured commit at
    // revision N+1 — the largest-evidence-revision heuristic would have
    // caught up to this and called the span complete.
    await historyStore.nodes.Person.create({ name: "Bob" });

    const delta = await lineage.changesSince(
      backend,
      rBeforeGap,
      historyStore.graphId,
    );
    // Mutation-proof: reverting `changesSince`'s completeness check to the
    // largest-evidenced-revision comparison makes this
    // `{ kind: "keys", nodes: [{ kind: "Person", id: bob.id }], edges: [] }`
    // instead — Alice's update via T is silently missing from the delta.
    expect(delta).toEqual({ kind: "unbounded" });
  });

  it("does not drop A's tracking-only update from a pruned merge diff", async () => {
    const baseBackend = await makeBackend();
    const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
      history: true,
    });
    const alice = await baseStore.nodes.Person.create({ name: "Alice" });

    // The fork is built with `history: true` directly, on its own separate
    // backend, and its `GraphBranch` assembled by hand — `branch()`'s
    // default clone strategy never copies recorded-time history into the
    // working copy, so a clone built that way never resolves a
    // recorded-relations `lineage` and this pruning path stays dormant
    // regardless of the fix under test (see
    // `tests/property/graph-merge/lineage-pruned-diff.test.ts`, which builds
    // its pairs the same way). `alice` is replicated by hand to stand in for
    // what a real clone would have inherited.
    const forkBackend = await makeBackend();
    const [forkStore] = await createStoreWithSchema(graph, forkBackend, {
      history: true,
    });
    await forkStore.nodes.Person.create({ name: "Alice" }, { id: alice.id });
    const base = await computeBaseVersion(baseStore);
    const forkLineage = recordedRelationsLineage(forkStore);
    const forkRevision = await forkLineage.revision(forkBackend);
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

    // T: a tracking-only writer on the BASE backend touches Alice AFTER the
    // fork point, at a revision with no recorded row.
    const [trackingStore] = await createStoreWithSchema(graph, baseBackend, {
      revisionTracking: true,
    });
    await trackingStore.nodes.Person.update(alice.id, {
      name: "Alice via T",
    });

    const pruneTo = await branchPruneTo(baseStore, forkBranch);
    // Mutation-proof: reverting the completeness check makes `changesSince`
    // report an empty (but bounded) delta for the base side, so
    // `branchPruneTo` returns a `"keys"` delta that omits `alice` — the
    // assertion below fails because the pruned batch read never fetches her
    // row at all.
    expect(pruneTo).toBeUndefined();

    const diff = await diffAgainstBase(baseStore, forkStore, false, pruneTo);
    const aliceModified = diff.nodes.modified.find(
      (node) => node.id === alice.id,
    );
    expect(aliceModified?.baseProps).toEqual({ name: "Alice via T" });
  });
});
