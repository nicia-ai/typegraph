/**
 * `branch()` — fork an isolated, independently-mutable working copy of a base
 * store (design §7.1).
 *
 * A branch is a {@link GraphBranch}: a fresh {@link BranchId}, the immutable
 * `base@V` token the copy forked from (computed off the ORIGINAL base store via
 * {@link computeBaseVersion}, never off the clone), and a {@link Store} over the
 * branch's own backend seeded with the base's live state.
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
import type { GraphDef } from "./typegraph-internal";
import { generateId, storeBackend } from "./typegraph-internal";
import type { BranchOptions, GraphBranch } from "./types";
import { asBranchId } from "./types";
import type { MakeBackend, WorkingCopyStrategy } from "./working-copy";
import { cloneWorkingCopyStrategy } from "./working-copy";

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
    const store = await workingCopyStrategy.create(baseStore);
    // Ownership of the working copy's BACKEND transferred here: the strategy
    // closes it only on its own failures, and "only the success path hands the
    // backend to the caller, who then owns its lifecycle" (see
    // `cloneWorkingCopyStrategy`). Everything after this line therefore runs
    // inside `captureBranchSchemaAnchor`, which closes it before failing — a
    // `branch()` that returned `err(...)` from here would drop the only handle to a live
    // engine (a PGlite instance, a file handle, a connection pool).
    const schemaAnchor = await captureBranchSchemaAnchor(store);
    return ok({
      id,
      base,
      store,
      ...(schemaAnchor === undefined ?
        { schemaAnchor: undefined }
      : { schemaAnchor }),
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
 * Captures the clone's committed schema row as the merge-time drift anchor.
 * Version participates so a schema ROUND-TRIP (migrate away and back, restoring
 * the document hash while its preflights mutated rows) is still detected.
 *
 * Closes the working copy's backend if the read fails. `branch()` reports every
 * failure as a returned `err(...)` rather than a throw, so the caller never
 * receives the store and has no handle to close: without this, a backend whose
 * `getActiveSchema` rejects would leak the engine the strategy just opened. A
 * close failure must not mask the original error.
 */
export async function captureBranchSchemaAnchor<G extends GraphDef>(
  store: GraphBranch<G>["store"],
): Promise<Readonly<{ version: number; hash: string }> | undefined> {
  try {
    const schemaRow = await storeBackend(store).getActiveSchema(store.graphId);
    return schemaRow === undefined ? undefined : (
        { version: schemaRow.version, hash: schemaRow.schema_hash }
      );
  } catch (error) {
    try {
      await storeBackend(store).close();
    } catch {
      // Intentionally ignored — surface the original failure.
    }
    throw error;
  }
}
