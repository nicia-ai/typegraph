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
 * `includeTemporal: true` carries `validFrom`/`validTo` through unchanged,
 * preserving the base's exact valid-time window on the clone: create-time
 * paths default an omitted `validFrom` to the row's own creation instant
 * (see #240), and export/import round-trip a still-open-left `valid_from`
 * (e.g. a row that predates the #240 fix) as an explicit `null` rather than
 * silently dropping it — see `InterchangeNodeSchema.validFrom`'s doc.
 * Without either half of this, the clone's re-import would re-stamp the
 * affected base rows to the CLONE's creation instant instead — narrowing
 * their validity window and making `asOf` reads on the fork diverge from
 * identical reads on the base for any instant between the row's real
 * creation and the clone.
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
 *
 * The returned backend MUST be EMPTY (no rows for the base graph): the clone
 * seeds it from the base via `importGraph` with `onConflict: "error"`, so a
 * pre-existing row is surfaced as a {@link BranchError} rather than silently
 * skipped (which would leave the working copy diverging from the base).
 */
export type MakeBackend = () => Promise<GraphBackend>;

/**
 * The P0 default working-copy strategy: faithful clone via export/import.
 *
 * On each `create(baseStore)`:
 *   1. `exportGraph(baseStore, { includeMeta: true, includeTemporal: true,
 *      includeDeleted: false })` — `includeMeta: true` carries
 *      `created_at`/`updated_at`; `includeTemporal: true` carries
 *      `validFrom`/`validTo` so the clone's valid-time window matches the base's
 *      exactly (see the fidelity note above); `includeDeleted: false` keeps the
 *      clone to LIVE rows only. Shipping soft-deleted rows is unsafe: the meta
 *      schema has no `deletedAt`, so they would import as live and resurrect on
 *      the fork's diff (see the fidelity note above). `branch()` only needs the
 *      base's live state.
 *   2. Create a fresh store over the caller-provided backend with the SAME graph
 *      definition via `createStoreWithSchema`.
 *   3. `importGraph(freshStore, data, { onConflict: "error", ... })` — ids are
 *      preserved so the diff engine can key on them. `onConflict: "error"`
 *      requires the backend to be EMPTY: a pre-existing row is a contract
 *      violation that must surface loudly, never be silently skipped (a skipped
 *      row would leave the clone diverging from the base, so the fork's diff would
 *      report phantom modifications/deletions). `importGraph` RETURNS
 *      `{ success, errors }` rather than throwing on a per-row rejection, so its
 *      result is checked and any failure fails the branch.
 *
 * The backend `makeBackend()` returns is opened here, so any failure AFTER it is
 * created closes it before rethrowing — only the success path hands the backend
 * (via the returned store) to the caller, who then owns its lifecycle.
 *
 * @param makeBackend - Constructs the fresh, EMPTY backend the working copy is
 *   built on.
 */
export function cloneWorkingCopyStrategy<G extends GraphDef>(
  makeBackend: MakeBackend,
): WorkingCopyStrategy<G> {
  return {
    create: async (baseStore: Store<G>): Promise<Store<G>> => {
      const data = await exportGraph(baseStore, {
        includeMeta: true,
        includeTemporal: true,
        includeDeleted: false,
      });
      const backend = await makeBackend();
      try {
        const [freshStore] = await createStoreWithSchema(
          baseStore.graph,
          backend,
        );
        const result = await importGraph(freshStore, data, {
          onConflict: "error",
          onUnknownProperty: "error",
          validateReferences: true,
          batchSize: CLONE_IMPORT_BATCH_SIZE,
        });
        if (!result.success) {
          throw new BranchError(
            "Clone import failed: the working copy could not be seeded from the base store. The backend returned by makeBackend() must be empty.",
            { details: { errors: result.errors } },
          );
        }
        return freshStore;
      } catch (error) {
        // The backend was opened above; close it on any failure so its
        // connection / file handle / in-process engine cannot leak. A close
        // failure must not mask the original error.
        try {
          await backend.close();
        } catch {
          // Intentionally ignored — surface the original branch failure.
        }
        throw error;
      }
    },
  };
}
