import type {
  BATCH_POINT_READ,
  ENDPOINT_SET_READ,
} from "../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../backend/capabilities/resolve";
import type { GraphDef } from "../core/define-graph";
import { ConfigurationError } from "../errors";
import type { KindRegistry } from "../registry";
import { activeTransactionStore, storeRuntime } from "../store/runtime-port";
import type { HistoryStore } from "../store/store";
import { type TransactionContext } from "../store/types";
import {
  assertRequiredPartsOfFactWholesAreFacts,
  assertRetractionHistoryEnabled,
  normalizeConfig,
  type NormalizedConfig,
} from "./config";
import { type ProvenanceRetractionConfig } from "./types";

/**
 * A role configuration validated against one store's graph, with what a
 * support read on that store needs: its graph id, its registry and the
 * capability verdicts it minted at construction.
 */
export type CapabilityScope = Readonly<{
  graphId: string;
  registry: KindRegistry;
  config: NormalizedConfig;
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
  endpointSetRead: BundleVerdictOf<typeof ENDPOINT_SET_READ>;
}>;

/**
 * Validates `config` against `store` and binds it to that store.
 *
 * The verdicts are the store's OWN, minted once at its construction — never a
 * second resolution for the same backend — and BOUND per read against the
 * object that read runs on, so a transaction target that implements less than
 * the root still falls back instead of reaching a member it lacks.
 */
export function createCapabilityScope<G extends GraphDef>(
  store: HistoryStore<G>,
  config: ProvenanceRetractionConfig<G>,
): CapabilityScope {
  assertRetractionHistoryEnabled(store);
  const normalized = normalizeConfig(store.graph, config);
  assertRequiredPartsOfFactWholesAreFacts(store.registry, normalized);
  const runtime = storeRuntime(store);
  return {
    graphId: store.graphId,
    registry: store.registry,
    config: normalized,
    batchPointRead: runtime.batchPointRead,
    endpointSetRead: runtime.endpointSetRead,
  };
}

/** Resolves the scope a caller's transaction is read in, or refuses it. */
export type TransactionScopeResolver<G extends GraphDef> = (
  tx: TransactionContext<G>,
  operation: string,
) => CapabilityScope;

/**
 * Builds the resolver for transactions handed to a capability on `store`.
 *
 * A transaction is accepted only while it belongs to a running callback of
 * that store (`activeTransactionStore`, the one owner of that decision). A
 * context from another store, from another graph, or kept past its callback
 * would be read with this capability's roles against rows they do not
 * describe, so it is refused before any lock or read.
 *
 * An evolved callback's context belongs to the store's temporary evolved
 * view. Its transaction writes against that view's graph, so the roles are
 * validated against that graph and read through its registry — once per view.
 */
export function createTransactionScopeResolver<G extends GraphDef>(
  store: HistoryStore<G>,
  config: ProvenanceRetractionConfig<G>,
  storeScope: CapabilityScope,
): TransactionScopeResolver<G> {
  const evolvedScopes = new WeakMap<object, CapabilityScope>();
  return (tx, operation) => {
    const owner = activeTransactionStore(tx, store);
    if (owner === undefined) {
      throw new ConfigurationError(
        `${operation} requires a transaction that belongs to an active callback of the capability's store.`,
        {
          code: "PROVENANCE_TRANSACTION_NOT_OWNED",
          operation,
          graphId: store.graphId,
        },
        {
          suggestion:
            "Pass the `tx` a transaction callback of the store this capability was created on received, while that callback is still running.",
        },
      );
    }
    if (owner === store) return storeScope;
    const evolvedScope =
      evolvedScopes.get(owner) ?? createCapabilityScope(owner, config);
    evolvedScopes.set(owner, evolvedScope);
    return evolvedScope;
  };
}
