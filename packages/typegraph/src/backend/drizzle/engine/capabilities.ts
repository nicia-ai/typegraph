/**
 * The capability tail every SQL engine profile's declared capabilities pass
 * through before {@link createSqlBackend} (`./create-sql-backend`) builds a
 * backend from them: derive `execution.atomicBatch` from whether the
 * profile's own execution adapter exposes a native atomic-batch primitive,
 * derive `contributions` from the profile's rebuild-support predicate, then
 * validate and freeze the result with `assertBundledCapabilityDeclarations`.
 *
 * Everything dialect-specific about capability derivation — HTTP-only
 * driver overrides, the PGlite bind-parameter cap, the pessimistic-lock
 * override validation, SQLite's execution-profile hints and graph-analytics
 * resolution — stays in `buildPostgresEngineProfile` / `buildSqliteEngineProfile`
 * and feeds `declaredCapabilities`. This module owns only the tail both of
 * them run identically on top of that.
 *
 * `contributionRebuildSupported` arrives as a dep rather than a direct
 * import of the function of the same name in `contribution-materializations.ts`:
 * this module is imported by `create-sql-backend.ts`, a published
 * entrypoint root (`./adapters/drizzle/engine`) whose runtime must not reach
 * a real Drizzle package until the operation-layer extraction folds that
 * module in for good, and `contribution-materializations.ts` imports
 * `drizzle-orm` at module scope. Each dialect builder still calls the real
 * predicate itself — it already imports that module for its inline
 * contribution members — and hands the result through as a closure.
 */
import { createAtomicSqlProgramExecutor } from "../../capabilities/atomic-sql-program";
import { assertBundledCapabilityDeclarations } from "../../capabilities/declarations";
import type { BackendCapabilities } from "../../types";
import type { SqlExecutionAdapter } from "../execution/types";

export type FinalizeEngineCapabilitiesDeps = Readonly<{
  /**
   * The profile's root execution adapter. Whether it exposes a native
   * `executeAtomicBatch` decides `execution.atomicBatch`: `"root"` when a
   * static program can run against this connection with no transaction
   * wrapper, `"none"` otherwise.
   */
  execution: SqlExecutionAdapter;
  /**
   * The profile's own answer to whether it can rebuild a durable
   * contribution marker outright, given whether this connection supports
   * interactive transactions — see the module doc comment for why this
   * arrives as a closure rather than a direct import of
   * `contributionRebuildSupported`.
   */
  contributionRebuildSupported: (interactiveTransactions: boolean) => boolean;
}>;

/**
 * Runs the capability tail shared by every SQL engine profile: derives
 * `execution.atomicBatch` and `contributions` from `declared` and `deps`,
 * then validates and freezes the result.
 *
 * Both dialect builders call this twice with the same `declared` value: once
 * themselves, to resolve the local `capabilities` their still-inline
 * operation-backend construction needs, and once more inside
 * `createSqlBackend` to resolve `EngineAssemblyContext.capabilities`. That
 * duplication is deliberate (see `EngineAssemblyContext`'s doc comment) —
 * this function stays a pure function of its arguments, never a cached
 * value, so a profile variant built by overriding `declaredCapabilities`
 * (as `tests/engine-profile-refusals.test.ts` does) is re-derived correctly
 * wherever it is called from.
 */
export function finalizeEngineCapabilities(
  declared: BackendCapabilities,
  deps: FinalizeEngineCapabilitiesDeps,
): BackendCapabilities {
  return assertBundledCapabilityDeclarations({
    ...declared,
    execution: {
      ...declared.execution,
      atomicBatch:
        createAtomicSqlProgramExecutor(deps.execution) === undefined ?
          "none"
        : "root",
    },
    contributions: {
      supported: true,
      probe: true,
      rebuild: deps.contributionRebuildSupported(
        declared.execution.interactiveTransactions,
      ),
    },
  });
}
