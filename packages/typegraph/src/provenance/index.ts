import type { GraphDef } from "../core/define-graph";
import type { HistoryStore } from "../store/store";
import { assertFactsHold, believedFacts } from "./holds";
import { createCapabilityScope, createTransactionScopeResolver } from "./scope";
import { runTransition } from "./transition";
import {
  type FactKindsFromConfig,
  type JustificationKindFromConfig,
  type ProvenanceRetractionConfig,
  type ProvenanceSourceInput,
  type RetractionCapability,
  type SourceKindsFromConfig,
} from "./types";

export type {
  ContributionDiagnostic,
  ContributionDiagnosticState,
  ContributionRepairEntry,
  ContributionRepairResult,
} from "../backend/types";
export {
  FactNotHoldingError,
  type FactNotHoldingErrorDetails,
  type FactNotHoldingFailure,
  type FactNotHoldingJustification,
  type FactNotHoldingPremise,
  type FactNotHoldingPremiseReason,
  type FactNotHoldingReason,
} from "../errors";
export type { CompiledOneStatementRead } from "../query";
export type { BatchReadBuilder } from "../store";
export type {
  ProvenanceFactInput,
  ProvenanceFactRef,
  ProvenanceJustificationRef,
  ProvenanceNodeRef,
  ProvenanceRetractionConfig,
  ProvenanceSourceInput,
  RetractionCapability,
  RetractionReport,
  SurvivedVia,
} from "./types";

const HOLDING_IN_TRANSACTION_OPERATION = "provenance.holding(tx)";

export function createRetractionCapability<
  G extends GraphDef,
  const C extends ProvenanceRetractionConfig<G>,
>(
  store: HistoryStore<G>,
  config: C,
): RetractionCapability<
  G,
  SourceKindsFromConfig<G, C>,
  FactKindsFromConfig<G, C>,
  JustificationKindFromConfig<G, C>
> {
  const scope = createCapabilityScope(store, config);
  const resolveTransactionScope = createTransactionScopeResolver(
    store,
    config,
    scope,
  );

  // The four retract verbs differ only in one/many source shape and the target
  // retracted flag; the generics are fixed by the config, so hoist one call.
  const transition = (
    sources: readonly ProvenanceSourceInput<G, SourceKindsFromConfig<G, C>>[],
    retracted: boolean,
  ) =>
    runTransition<
      G,
      SourceKindsFromConfig<G, C>,
      FactKindsFromConfig<G, C>,
      JustificationKindFromConfig<G, C>
    >(store, scope.config, sources, retracted, scope.batchPointRead);

  return {
    retract: (source) => transition([source], true),
    retractMany: (sources) => transition(sources, true),
    unRetract: (source) => transition([source], false),
    unRetractMany: (sources) => transition(sources, false),

    async holding(tx) {
      if (tx === undefined) {
        return store.transaction((ownTransaction) =>
          believedFacts<G, FactKindsFromConfig<G, C>>(scope, ownTransaction),
        );
      }
      return believedFacts<G, FactKindsFromConfig<G, C>>(
        resolveTransactionScope(tx, HOLDING_IN_TRANSACTION_OPERATION),
        tx,
      );
    },

    assertHolds: (tx, facts) =>
      assertFactsHold<
        G,
        FactKindsFromConfig<G, C>,
        JustificationKindFromConfig<G, C>
      >(resolveTransactionScope, tx, facts),
  };
}
