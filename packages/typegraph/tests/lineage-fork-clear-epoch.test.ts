/**
 * The second of two P1 findings from the external re-review of the lineage
 * capability: `revision()` used to report the bare recorded-clock value,
 * with no discriminator for which physical store or which `clear()` epoch
 * minted it. `GraphBranch.forkRevision` (captured by `branch()` right after
 * cloning) is exactly this bare value, and `staging.ts` feeds it straight
 * into `changesSince` with no separate origin check — unlike the BASE side,
 * which `lineageDeltaSinceAnchor` guards with its own origin comparison
 * before ever calling `changesSince`. Clearing and repopulating a
 * history-preserving FORK to the same revision count it held at
 * `forkRevision` therefore used to look unchanged. Fixed by folding the
 * origin into the revision token itself (`encodeRecordedLineageRevision`),
 * so `changesSince` refuses on an origin mismatch regardless of which caller
 * reaches it.
 *
 * This complements `tests/graph-merge/lineage-capture-completeness.test.ts`,
 * which pins the equivalent BASE-side clear/repopulate scenario: that suite
 * clears the store `merge()` targets, this one clears the FORK itself, a
 * path `lineageDeltaSinceAnchor`'s own origin guard never reaches.
 *
 * Mutation-proof note: a mutation that replaces `revision()`'s reported
 * origin with a FIXED constant (rather than removing the origin grammar
 * entirely) still makes `changesSince` answer `unbounded` for both tests
 * below, because the constant never equals the graph's live origin either —
 * the tests would pass for the wrong reason (an origin that is always wrong,
 * not an origin that genuinely tracks this graph's epoch). The
 * `forkRevision carries this graph's live origin` assertion in each test
 * closes that gap: it fails immediately under the fixed-constant mutation,
 * before `clear()` ever runs.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { computeBaseVersion } from "../src/graph-merge/base-version";
import { branchPruneTo } from "../src/graph-merge/staging";
import { diffAgainstBase } from "../src/graph-merge/state-diff";
import type { GraphBranch } from "../src/graph-merge/types";
import { asBranchId } from "../src/graph-merge/types";
import {
  readRevisionOrigin,
  recordedRelationsLineage,
} from "../src/store/recorded-capture";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "lineage-fork-clear-epoch",
  nodes: { Person: { type: Person } },
  edges: {},
});
type G = typeof graph;

const BRANCH = asBranchId("fork-clear-epoch-branch");

type BackendFactory = Readonly<{
  name: string;
  make: () => Promise<
    Readonly<{ backend: GraphBackend; cleanup: () => Promise<void> }>
  >;
}>;

const BACKENDS: readonly BackendFactory[] = [
  {
    name: "SQLite",
    make: () => {
      const { backend } = createLocalSqliteBackend();
      return Promise.resolve({ backend, cleanup: () => backend.close() });
    },
  },
  {
    name: "PGlite",
    make: async () => {
      const { backend } = await createLocalPgliteBackend({ vector: false });
      return { backend, cleanup: () => backend.close() };
    },
  },
];

describe.each(BACKENDS)(
  "origin-bearing revisions catch a cleared-and-repopulated fork [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups) await cleanup();
    });

    it("changesSince(forkRevision) is unbounded after the fork itself is cleared and repopulated to the same revision count", async () => {
      const { backend, cleanup } = await entry.make();
      cleanups.push(cleanup);
      const [forkStore] = await createStoreWithSchema(graph, backend, {
        history: true,
      });
      await forkStore.nodes.Person.create({ name: "Alice" });
      const forkLineage = recordedRelationsLineage(forkStore);
      const forkRevision = await forkLineage.revision(backend);

      // Positive-direction check: `forkRevision` must carry THIS graph's
      // live origin, not merely some origin that will later mismatch. See
      // the module mutation-proof note above for why this is required
      // alongside the `unbounded` assertion below.
      const liveOriginAtFork = await readRevisionOrigin(
        backend,
        forkStore.revisionSchema,
        forkStore.graphId,
      );
      expect(forkRevision.startsWith(`${liveOriginAtFork}:`)).toBe(true);

      await forkStore.clear();
      // Repopulated to the SAME revision count (one captured create) the
      // pre-clear reading held, but with entirely different content.
      await forkStore.nodes.Person.create({ name: "Someone else entirely" });

      const delta = await forkLineage.changesSince(
        backend,
        forkRevision,
        forkStore.graphId,
      );
      // Mutation-proof: reverting `revision()` to the bare recorded-clock
      // value (dropping the origin grammar entirely) makes this
      // `{ kind: "keys", nodes: [], edges: [] }` instead — the post-clear
      // clock coincidentally reaches the same revision number, so the bare
      // token looks unchanged even though every row is different.
      expect(delta).toEqual({ kind: "unbounded" });
    });

    it("prunes to the full diff, not an empty one, for a fork carrying a stale pre-clear forkRevision", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      try {
        const { backend: baseBackend, cleanup: baseCleanup } =
          await entry.make();
        cleanups.push(baseCleanup);
        const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
          history: true,
        });
        const alice = await baseStore.nodes.Person.create({ name: "Alice" });

        const { backend: forkBackend, cleanup: forkCleanup } =
          await entry.make();
        cleanups.push(forkCleanup);
        const [forkStore] = await createStoreWithSchema(graph, forkBackend, {
          history: true,
        });
        await forkStore.nodes.Person.create(
          { name: "Alice" },
          { id: alice.id },
        );
        const base = await computeBaseVersion(baseStore);
        const forkLineage = recordedRelationsLineage(forkStore);
        const forkRevision = await forkLineage.revision(forkBackend);

        // Positive-direction check (see the module mutation-proof note
        // above): `forkRevision` must carry this fork graph's actual live
        // origin, not an origin that only happens to differ later.
        const liveOriginAtFork = await readRevisionOrigin(
          forkBackend,
          forkStore.revisionSchema,
          forkStore.graphId,
        );
        expect(forkRevision.startsWith(`${liveOriginAtFork}:`)).toBe(true);

        await forkStore.clear();
        // Repopulated to the SAME revision count with a DIFFERENT Alice —
        // the frozen clock makes the recorded instant coincide too, so only
        // the origin distinguishes this from the pre-clear reading.
        await forkStore.nodes.Person.create(
          { name: "Alice after fork clear" },
          { id: alice.id },
        );

        const forkBranch: GraphBranch<G> = {
          id: BRANCH,
          base,
          store: forkStore,
          close: (): Promise<void> => Promise.resolve(),
          forkRevision,
        };

        const pruneTo = await branchPruneTo(baseStore, forkBranch);
        // Mutation-proof: dropping the origin grammar from `revision()`
        // makes this a `"keys"` delta with empty lists (the stale
        // `forkRevision`'s bare number coincidentally matches the
        // post-clear clock), so the diff below would never read the fork's
        // actual, post-clear row.
        expect(pruneTo).toBeUndefined();

        const diff = await diffAgainstBase(
          baseStore,
          forkStore,
          false,
          pruneTo,
        );
        const aliceModified = diff.nodes.modified.find(
          (node) => node.id === alice.id,
        );
        expect(aliceModified?.forkProps).toEqual({
          name: "Alice after fork clear",
        });
      } finally {
        vi.useRealTimers();
      }
    });
  },
);
