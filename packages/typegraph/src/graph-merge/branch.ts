/**
 * `branch()` — fork an isolated, independently-mutable working copy of a base
 * store (design §7.1).
 *
 * A branch is a {@link GraphBranch}: a fresh {@link BranchId}, the immutable
 * `base@V` token the copy forked from (computed off the ORIGINAL base store via
 * {@link computeBaseVersion}, never off the clone), a {@link Store} over the
 * branch's own backend seeded with the base's live state, and — when the
 * working copy resolves a `lineage` source — the fork-time engine revision
 * (`forkRevision`) that anchors this branch's half of the pruned merge diff.
 *
 * The copy mechanism is pluggable behind {@link WorkingCopyStrategy}. The P0
 * default is the faithful streamed-interchange clone
 * ({@link cloneWorkingCopyStrategy}),
 * which keeps this primitive backend-agnostic: the caller supplies a
 * `makeBackend` factory, and `branch()` never names a concrete backend.
 */

import { computeBaseVersion } from "./base-version";
import { BranchError } from "./errors";
import type { Result } from "./result";
import { err, ok } from "./result";
import type { EngineRevision, GraphDef } from "./typegraph-internal";
import { generateId, resolveLineage, storeBackend } from "./typegraph-internal";
import type { BranchOptions, GraphBranch } from "./types";
import { asBranchId } from "./types";
import type { MakeBackend, WorkingCopyStrategy } from "./working-copy";
import {
  cloneWorkingCopyStrategy,
  coalescedWorkingCopyClose,
} from "./working-copy";

/**
 * Creates an isolated working-copy branch of `baseStore`.
 *
 * Stamps the `base@V` token off the original base store, mints (or accepts) a
 * {@link BranchId}, and materializes the working copy via the resolved strategy.
 * The default strategy is a faithful clone over a fresh backend produced by
 * `makeBackend`; pass an explicit `strategy` to override (e.g. a future
 * logical-namespace copy-on-write).
 *
 * Returns a {@link Result}: success yields the {@link GraphBranch}; any failure
 * (base-version stamping, backend construction, streamed interchange) is wrapped in a
 * {@link BranchError} with the underlying cause attached. Errors are returned,
 * never thrown — this is internal-logic surface (the caller converts to a thrown
 * error at the framework boundary).
 *
 * @param baseStore - The store to fork. Remains untouched.
 * @param makeBackend - Factory for the working copy's backend (keeps the
 *   primitive backend-agnostic). Used only by the default clone strategy; ignored
 *   when an explicit `strategy` is supplied.
 * @param options - Optional `{ id }` to set an explicit branch id.
 * @param strategy - Optional working-copy strategy override.
 */
export async function branch<G extends GraphDef>(
  baseStore: GraphBranch<G>["store"],
  makeBackend: MakeBackend,
  options?: BranchOptions,
  strategy?: WorkingCopyStrategy<G>,
): Promise<Result<GraphBranch<G>, BranchError>> {
  try {
    const base = await computeBaseVersion(baseStore);
    const id = options?.id ?? asBranchId(generateId());
    const workingCopyStrategy =
      strategy ?? cloneWorkingCopyStrategy<G>(makeBackend);
    const store = await workingCopyStrategy.create(baseStore, base);
    // Ownership of the working copy's BACKEND transferred here: the strategy
    // closes it only on its own failures, and "only the success path hands the
    // backend to the caller, who then owns its lifecycle" (see
    // `cloneWorkingCopyStrategy`). Everything after this line therefore runs
    // inside `captureBranchForkState`, which closes it before failing — a
    // `branch()` that returned `err(...)` from here would drop the only handle to a live
    // engine (a PGlite instance, a file handle, a connection pool).
    const { schemaAnchor, forkRevision } = await captureBranchForkState(store);
    return ok({
      id,
      base,
      store,
      close: coalescedWorkingCopyClose(store),
      ...(schemaAnchor === undefined ?
        { schemaAnchor: undefined }
      : { schemaAnchor }),
      ...(forkRevision === undefined ? {} : { forkRevision }),
    });
  } catch (error) {
    return err(
      new BranchError("Failed to create working-copy branch of base store", {
        cause: error,
      }),
    );
  }
}

/**
 * Captures the clone's fork-time state: the committed schema row (the
 * merge-time drift anchor — version participates so a schema ROUND-TRIP
 * (migrate away and back, restoring the document hash while its preflights
 * mutated rows) is still detected) and, when the working copy resolves a
 * `lineage` source, the engine revision it reports right after the clone
 * completes and before any write — the baseline the pruned diff (see
 * `state-diff.ts`'s `diffAgainstBase` and `staging.ts`'s `stageBranches`)
 * measures the fork's OWN changes against. `resolveLineage` runs on the
 * WORKING COPY here, never the original `baseStore`: the fork's delta is
 * "what this clone itself has done since it was made," a question only the
 * clone's own lineage can answer. `undefined` when the working copy resolves
 * no lineage at all (no backend `lineage`, and no `history: true` capture) —
 * `stageBranches` then has no fork-side delta to prune with and diffs this
 * branch in full.
 *
 * Closes the working copy's backend if either read fails. `branch()` reports
 * every failure as a returned `err(...)` rather than a throw, so the caller
 * never receives the store and has no handle to close: without this, a
 * backend whose `getActiveSchema` or `lineage.revision()` rejects would leak
 * the engine the strategy just opened. A close failure must not mask the
 * original error.
 */
async function captureBranchForkState<G extends GraphDef>(
  store: GraphBranch<G>["store"],
): Promise<
  Readonly<{
    schemaAnchor: Readonly<{ version: number; hash: string }> | undefined;
    forkRevision: EngineRevision | undefined;
  }>
> {
  try {
    const schemaRow = await storeBackend(store).getActiveSchema(store.graphId);
    const schemaAnchor =
      schemaRow === undefined ? undefined : (
        { version: schemaRow.version, hash: schemaRow.schema_hash }
      );
    const lineage = resolveLineage(store);
    const forkRevision =
      lineage === undefined ? undefined : await lineage.revision();
    return { schemaAnchor, forkRevision };
  } catch (error) {
    try {
      await storeBackend(store).close();
    } catch {
      // Intentionally ignored — surface the original failure.
    }
    throw error;
  }
}
