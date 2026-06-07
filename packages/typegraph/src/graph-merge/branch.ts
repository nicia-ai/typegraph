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
 * default is the faithful export/import clone ({@link cloneWorkingCopyStrategy}),
 * which keeps this primitive backend-agnostic: the caller supplies a
 * `makeBackend` factory, and `branch()` never names a concrete backend.
 */

import { computeBaseVersion } from "./base-version";
import { BranchError } from "./errors";
import type { Result } from "./result";
import { err, ok } from "./result";
import type { GraphDef } from "./typegraph-internal";
import { generateId } from "./typegraph-internal";
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
 * (base-version stamping, backend construction, export/import) is wrapped in a
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
    return ok({ id, base, store });
  } catch (error) {
    return err(
      new BranchError("Failed to create working-copy branch of base store", {
        cause: error,
      }),
    );
  }
}
