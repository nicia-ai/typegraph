/**
 * The capability tail every SQL engine profile's declared capabilities pass
 * through before {@link createSqlBackend} (`./create-sql-backend`) builds a
 * backend from them: derive `execution.atomicBatch` from whether the
 * profile's own execution adapter exposes a native atomic-batch primitive,
 * derive `vector` from `profile.vector` and `fulltext` from `profile.fulltext`
 * (each omitted when its strategy is absent, and each deferring to a value
 * already present on `declared` when its strategy IS present — see below),
 * derive `contributions` from `contributionRebuildSupported`
 * (`../contribution-materializations`), then validate and freeze the result
 * with `assertBundledCapabilityDeclarations`.
 *
 * Everything dialect-specific about capability declaration — HTTP-only
 * driver overrides, the PGlite bind-parameter cap, the pessimistic-lock
 * override validation, SQLite's execution-profile hints and graph-analytics
 * resolution — stays in `buildPostgresEngineProfile` / `buildSqliteEngineProfile`
 * and feeds `declaredCapabilities`. Neither dialect builder bakes a DEFAULT
 * `vector` or `fulltext` value into that declaration itself: this module owns
 * the whole tail `createSqlBackend` runs once on top of `declaredCapabilities`,
 * for every dialect alike, so a profile variant built by overriding `vector`
 * or `fulltext` (as `tests/engine-profile-refusals.test.ts` does) changes
 * members and capabilities together instead of leaving one behind. The one
 * exception is a caller-supplied `capabilities.fulltext` /
 * `capabilities.vector` override (`BundledBackendCapabilityOverrides`, an
 * accepted public factory option both dialect builders forward verbatim into
 * `declaredCapabilities`): that value is data the caller asked to be applied,
 * not a stale leftover, so it wins over the strategy-derived default rather
 * than being silently dropped — an accepted option is applied or refused,
 * never ignored.
 *
 * `contributionRebuildSupported` is imported directly rather than threaded
 * through as a profile dep: `create-sql-backend.ts` (this module's only
 * caller) already imports `contribution-materializations.ts` for its
 * contribution-marker and fulltext-gate member construction, so this import
 * adds no new reach into a real Drizzle package that was not already there.
 */
import type { FulltextStrategy } from "../../../query/dialect/fulltext-strategy";
import { buildFulltextCapabilities } from "../../../query/dialect/fulltext-strategy";
import type { VectorStrategy } from "../../../query/dialect/vector-strategy";
import { buildVectorCapabilities } from "../../../query/dialect/vector-strategy";
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
  /**
   * The profile's vector strategy — `SqlEngineProfile.vector` verbatim.
   * Derives `capabilities.vector`, omitted when this is `undefined`.
   */
  vectorStrategy: VectorStrategy | undefined;
  /**
   * The profile's full-text strategy — `SqlEngineProfile.fulltext` verbatim.
   * Derives `capabilities.fulltext`, omitted when this is `undefined`, and
   * feeds `contributionRebuildSupported` alongside `fulltextTableName`.
   * A profile built with `fulltext: false` supplies `undefined`, which is
   * how the omit arm is reached.
   */
  fulltextStrategy: FulltextStrategy | undefined;
  /** The profile's physical fulltext table name, the other input `contributionRebuildSupported` needs. */
  fulltextTableName: string;
}>;

/**
 * Runs the capability tail shared by every SQL engine profile: derives
 * `execution.atomicBatch`, `vector`, `fulltext`, and `contributions` from
 * `declared` and `deps`, then validates and freezes the result.
 *
 * `createSqlBackend` is the ONE caller, on `profile.declaredCapabilities`;
 * the resulting value reaches every member group, mark site, and dialect
 * `buildOperations` closure through `EngineOperationsContext.capabilities` /
 * `EngineAssemblyContext.capabilities` rather than a second derivation, so a
 * profile variant built by overriding `declaredCapabilities`, `vector`, or
 * `fulltext` (as `tests/engine-profile-refusals.test.ts` does) is re-derived
 * correctly the one place this runs, and nothing downstream can hold a
 * stale copy.
 */
export function finalizeEngineCapabilities(
  declared: BackendCapabilities,
  deps: FinalizeEngineCapabilitiesDeps,
): BackendCapabilities {
  // Pulled out rather than left in `...declared` below: whether each
  // survives depends on whether its strategy is present, not on whether
  // `declared` happens to carry one, so the decision has to run explicitly
  // for both fields instead of riding along on a spread.
  const {
    vector: declaredVector,
    fulltext: declaredFulltext,
    ...declaredWithoutStrategyCapabilities
  } = declared;
  const atomicBatch =
    createAtomicSqlProgramExecutor(deps.execution) === undefined ? "none" : (
      "root"
    );
  return assertBundledCapabilityDeclarations({
    ...declaredWithoutStrategyCapabilities,
    execution: {
      ...declared.execution,
      atomicBatch,
      // Derived from the two facts above, never taken from `declared`: a
      // profile that hand-set this field would drift the moment either fact
      // changed underneath it. `interactiveTransactions` wins outright — an
      // engine that can hold an open callback transaction groups a write
      // that way regardless of whether it also happens to expose an atomic
      // batch primitive.
      unitOfWork:
        declared.execution.interactiveTransactions ? "interactive"
        : atomicBatch === "none" ? "none"
        : "batch",
    },
    // Absent strategy: omit outright, regardless of what `declared` carried
    // — a value left over from a builder that (wrongly) baked one in, or a
    // caller who set `capabilities.vector`/`capabilities.fulltext` for a
    // strategy this profile does not have, can never survive an absent
    // strategy by riding along on `declared`. Present strategy: a value the
    // caller actually declared wins over the strategy-derived default (an
    // accepted `BundledBackendCapabilityOverrides.vector` /
    // `.fulltext` option is applied, never silently dropped); otherwise
    // derive it fresh from the strategy.
    ...(deps.vectorStrategy === undefined ?
      {}
    : {
        vector: declaredVector ?? buildVectorCapabilities(deps.vectorStrategy),
      }),
    ...(deps.fulltextStrategy === undefined ?
      {}
    : {
        fulltext:
          declaredFulltext ?? buildFulltextCapabilities(deps.fulltextStrategy),
      }),
    contributions: {
      supported: true,
      probe: true,
      // One owner for the rebuild answer, absent strategy included: with no
      // fulltext contribution there is nothing to tear down, so the answer
      // reduces to the transactional-fence condition inside that function.
      rebuild: contributionRebuildSupported(
        deps.fulltextStrategy,
        deps.fulltextTableName,
        declared.execution.interactiveTransactions,
      ),
    },
  });
}
