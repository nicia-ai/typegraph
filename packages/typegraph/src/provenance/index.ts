import type { GraphDef } from "../core/define-graph";
import type { HistoryStore } from "../store/store";
import { type TransactionContext } from "../store/types";
import {
  assertFactsHold,
  believedFactsInCallerTransaction,
  believedFactsInOwnTransaction,
} from "./holds";
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
const RETRACT_IN_TRANSACTION_OPERATION = "provenance.retract(source, tx)";
const RETRACT_MANY_IN_TRANSACTION_OPERATION =
  "provenance.retractMany(sources, tx)";
const UN_RETRACT_IN_TRANSACTION_OPERATION = "provenance.unRetract(source, tx)";
const UN_RETRACT_MANY_IN_TRANSACTION_OPERATION =
  "provenance.unRetractMany(sources, tx)";

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

  // The four retract verbs differ only in one/many source shape, the target
  // retracted flag and the operation a caller-transaction refusal names; the
  // generics are fixed by the config, so hoist one call.
  const transition = (
    sources: readonly ProvenanceSourceInput<G, SourceKindsFromConfig<G, C>>[],
    retracted: boolean,
    tx: TransactionContext<G> | undefined,
    operation: string,
  ) =>
    runTransition<
      G,
      SourceKindsFromConfig<G, C>,
      FactKindsFromConfig<G, C>,
      JustificationKindFromConfig<G, C>
    >(store, scope, resolveTransactionScope, {
      sources,
      retracted,
      tx,
      operation,
    });

  return {
    retract: (source, tx) =>
      transition([source], true, tx, RETRACT_IN_TRANSACTION_OPERATION),
    retractMany: (sources, tx) =>
      transition(sources, true, tx, RETRACT_MANY_IN_TRANSACTION_OPERATION),
    unRetract: (source, tx) =>
      transition([source], false, tx, UN_RETRACT_IN_TRANSACTION_OPERATION),
    unRetractMany: (sources, tx) =>
      transition(sources, false, tx, UN_RETRACT_MANY_IN_TRANSACTION_OPERATION),

    async holding(tx) {
      if (tx === undefined) {
        return store.transaction((ownTransaction) =>
          believedFactsInOwnTransaction<G, FactKindsFromConfig<G, C>>(
            scope,
            ownTransaction,
          ),
        );
      }
      return believedFactsInCallerTransaction<G, FactKindsFromConfig<G, C>>(
        resolveTransactionScope(tx, HOLDING_IN_TRANSACTION_OPERATION),
        tx,
        HOLDING_IN_TRANSACTION_OPERATION,
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
