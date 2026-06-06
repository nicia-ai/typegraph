/**
 * Pluggable working-copy strategy: how `branch()` produces an isolated,
 * independently-mutable copy of a base store.
 *
 * The P0 default is a faithful CLONE via the public interchange API
 * ({@link cloneWorkingCopyStrategy}): `exportGraph` the base, then `importGraph`
 * into a fresh store on a caller-provided backend. IDs are preserved by
 * interchange, so the diff engine (T3) can key on stable ids across base and
 * fork. This leverages public entrypoints only, needs zero schema changes, and
 * behaves identically across SQLite and Postgres.
 *
 * INTERCHANGE FIDELITY LIMITATION (verified, design §13.x): the interchange
 * `meta` schema has no `deletedAt` field, so a base row that is already
 * soft-deleted would round-trip into the clone as LIVE (its tombstone lost). A
 * resurrected row would then read as a spurious `new` node in the fork's diff —
 * the base row is non-live, so `diffNodeKind` takes its `!isLive(base)` branch and
 * reports the (live, clone-resurrected) row as an addition — silently re-creating a
 * deleted node on commit. We therefore export with `includeDeleted: false`: the
 * clone carries only the base's LIVE state, exactly what `branch()` needs. The
 * merge state-diff is still computed against the ORIGINAL base store (live rows
 * only) as the immutable reference, never against the clone (clones regenerate
 * `created_at`/`updated_at`, which would otherwise destabilize `base@V`).
 *
 * Logical-namespace (copy-on-write within one backend, no full data copy) is a
 * future strategy slot — see the `WorkingCopyStrategy` interface — deferred past
 * P0.
 */

import { BranchError } from "./errors";
import type { GraphBackend, GraphDef, Store } from "./typegraph-internal";
import { createStoreWithSchema } from "./typegraph-internal";
import { exportGraph, importGraph } from "./typegraph-internal";

/**
 * Batch size for the clone's `importGraph` pass. Large enough to keep
 * round-trips low on demo-scale graphs; correctness is independent of the value.
 */
const CLONE_IMPORT_BATCH_SIZE = 1000;

/**
 * How `branch()` materializes a working copy of a base store.
 *
 * `create` receives the live base store and returns a fresh, independently
 * mutable {@link Store} over the SAME graph definition, seeded with the base's
 * current state. Mutating the returned store MUST NOT affect the base.
 *
 * The single method is the only extension point: alternative strategies
 * (e.g. a future logical-namespace copy-on-write within one backend) implement
 * the same contract.
 */
export type WorkingCopyStrategy<G extends GraphDef> = Readonly<{
  create: (baseStore: Store<G>) => Promise<Store<G>>;
}>;

/**
 * Factory for a caller-provided backend. `branch()` stays backend-agnostic by
 * delegating backend construction to the caller: the clone strategy calls this
 * once per `create()` to obtain the fresh backend that backs the working copy.
 *
 * Returning a promise lets async backends (e.g. PGlite, which boots an
 * in-process Postgres engine) be constructed lazily at branch time.
 */
export type MakeBackend = () => Promise<GraphBackend>;

/**
 * The P0 default working-copy strategy: faithful clone via export/import.
 *
 * On each `create(baseStore)`:
 *   1. `exportGraph(baseStore, { includeMeta: true, includeDeleted: false })` —
 *      `includeMeta: true` carries `created_at`/`updated_at`; `includeDeleted:
 *      false` keeps the clone to LIVE rows only. Shipping soft-deleted rows is
 *      unsafe: the meta schema has no `deletedAt`, so they would import as live and
 *      resurrect on the fork's diff (see the fidelity note above). `branch()` only
 *      needs the base's live state.
 *   2. Create a fresh store over the caller-provided backend with the SAME graph
 *      definition via `createStoreWithSchema`.
 *   3. `importGraph(freshStore, data, { onConflict: "skip", ... })` — ids are
 *      preserved so the diff engine can key on them. `onConflict: "skip"` makes
 *      a re-import idempotent against a non-empty target. `importGraph` RETURNS
 *      `{ success, errors }` rather than throwing on a per-row rejection, so its
 *      result is checked: a clone that silently dropped rows would make the fork's
 *      diff report phantom deletions, so any import failure fails the branch.
 *
 * @param makeBackend - Constructs the fresh backend the working copy is built on.
 */
export function cloneWorkingCopyStrategy<G extends GraphDef>(
  makeBackend: MakeBackend,
): WorkingCopyStrategy<G> {
  return {
    create: async (baseStore: Store<G>): Promise<Store<G>> => {
      const data = await exportGraph(baseStore, {
        includeMeta: true,
        includeDeleted: false,
      });
      const backend = await makeBackend();
      const [freshStore] = await createStoreWithSchema(
        baseStore.graph,
        backend,
      );
      const result = await importGraph(freshStore, data, {
        onConflict: "skip",
        onUnknownProperty: "error",
        validateReferences: true,
        batchSize: CLONE_IMPORT_BATCH_SIZE,
      });
      if (!result.success) {
        throw new BranchError(
          "Clone import failed: the working copy is missing rows the base store contains.",
          { details: { errors: result.errors } },
        );
      }
      return freshStore;
    },
  };
}
