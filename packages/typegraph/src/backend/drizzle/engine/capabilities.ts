/**
 * The capability tail every SQL engine profile's declared capabilities pass
 * through before {@link createSqlBackend} (`./create-sql-backend`) builds a
 * backend from them: derive `execution.atomicBatch` from whether the
 * profile's own execution adapter exposes a native atomic-batch primitive,
 * derive `contributions` from `contributionRebuildSupported`
 * (`../contribution-materializations`), then validate and freeze the result
 * with `assertBundledCapabilityDeclarations`.
 *
 * Everything dialect-specific about capability derivation — HTTP-only
 * driver overrides, the PGlite bind-parameter cap, the pessimistic-lock
 * override validation, SQLite's execution-profile hints and graph-analytics
 * resolution — stays in `buildPostgresEngineProfile` / `buildSqliteEngineProfile`
 * and feeds `declaredCapabilities`. This module owns only the tail both of
 * them run identically on top of that.
 *
 * `contributionRebuildSupported` is imported directly rather than threaded
 * through as a profile dep: `create-sql-backend.ts` (this module's only
 * caller alongside the two dialect factories) already imports
 * `contribution-materializations.ts` for its contribution-marker and
 * fulltext-gate member construction, so this import adds no new reach into
 * a real Drizzle package that was not already there.
 */
import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import { createAtomicSqlProgramExecutor } from "../../capabilities/atomic-sql-program";
import { assertBundledCapabilityDeclarations } from "../../capabilities/declarations";
import type { BackendCapabilities } from "../../types";
import { contributionRebuildSupported } from "../contribution-materializations";
import type { SqlExecutionAdapter } from "../execution/types";

export type FinalizeEngineCapabilitiesDeps = Readonly<{
  /**
   * The profile's root execution adapter. Whether it exposes a native
   * `executeAtomicBatch` decides `execution.atomicBatch`: `"root"` when a
   * static program can run against this connection with no transaction
   * wrapper, `"none"` otherwise.
   */
  execution: SqlExecutionAdapter;
  /** The profile's full-text strategy, one of the two inputs `contributionRebuildSupported` needs. */
  fulltextStrategy: FulltextStrategy;
  /** The profile's physical fulltext table name, the other input `contributionRebuildSupported` needs. */
  fulltextTableName: string;
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
      rebuild: contributionRebuildSupported(
        deps.fulltextStrategy,
        deps.fulltextTableName,
        declared.execution.interactiveTransactions,
      ),
    },
  });
}
