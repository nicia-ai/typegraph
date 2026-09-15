import type { SchemaVersionRow } from "../backend/types";
import {
  ConfigurationError,
  SchemaContentConflictError,
  StaleVersionError,
} from "../errors";
import type { EvolutionPlan } from "../schema/evolution-plan";
import type { SchemaIdentity } from "../schema/types";
import { type StoreRef, type TransactionOutcome } from "./types";

/** Selects the snapshot used to plan without taking a schema write fence. */
export type PlanEvolutionOptions = Readonly<{
  /** Defaults to a fresh, read-only active-schema lookup. */
  source?: "database" | "cached";
}>;

/** Read-only reconciliation after the caller has committed its transaction. */
export type RefreshSchemaOptions<TStore> = Readonly<{
  ref?: StoreRef<TStore>;
  /** Minimum committed version expected; a matching cached snapshot needs no SQL. */
  minVersion?: number;
}>;

/** Options for applying a precomputed evolution plan on a caller transaction. */
export type EvolvedTransactionOptions = Readonly<{
  /** Finite exclusive schema-fence acquisition budget for change plans, in milliseconds. */
  waitBudgetMs?: number;
}>;

/** Schema metadata is provisional until the caller commits the outer transaction. */
export type EvolvedTransactionOutcome<T> = Readonly<{
  result: TransactionOutcome<T>["result"];
  receipt: TransactionOutcome<T>["receipt"] &
    Readonly<{ schema: SchemaIdentity }>;
}>;

interface AdoptedScopeState {
  depth: number;
  exclusive: boolean;
}

const ACTIVE_ADOPTED_TRANSACTIONS = new WeakMap<object, AdoptedScopeState>();

/** Prevent schema-lock upgrades through a nested adopted callback. */
export async function withAdoptedTransactionScope<T>(
  nativeTransaction: unknown,
  callback: () => Promise<T>,
  exclusive = false,
): Promise<T> {
  if (typeof nativeTransaction !== "object" || nativeTransaction === null) {
    return callback();
  }
  const activeScope = ACTIVE_ADOPTED_TRANSACTIONS.get(nativeTransaction);
  if (
    activeScope?.exclusive === true ||
    (exclusive && activeScope !== undefined)
  ) {
    throw new ConfigurationError(
      "An adopted callback is already active on this transaction.",
      {
        code: "ADOPTED_TRANSACTION_ALREADY_ACTIVE",
      },
    );
  }
  if (activeScope === undefined) {
    ACTIVE_ADOPTED_TRANSACTIONS.set(nativeTransaction, { depth: 1, exclusive });
  } else {
    activeScope.depth += 1;
  }
  try {
    return await callback();
  } finally {
    const scope = ACTIVE_ADOPTED_TRANSACTIONS.get(nativeTransaction);
    if (scope !== undefined) {
      scope.depth -= 1;
      if (scope.depth === 0)
        ACTIVE_ADOPTED_TRANSACTIONS.delete(nativeTransaction);
    }
  }
}

/** Refuses options that an evolution operation cannot honor. */
export function assertEvolutionOptions(
  options: object | undefined,
  allowedKeys: readonly string[],
): void {
  const unknownOptions = Object.keys(options ?? {}).filter(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownOptions.length > 0) {
    throw new ConfigurationError("Unsupported schema evolution options.", {
      code: "EVOLUTION_OPTIONS_UNSUPPORTED",
      options: unknownOptions,
    });
  }
}

/** Checks the fenced active schema against the snapshot that minted a plan. */
export function assertEvolutionPlanBaseline(
  plan: EvolutionPlan,
  active: SchemaVersionRow | undefined,
): void {
  if (active?.version !== plan.baseline.version) {
    throw new StaleVersionError({
      graphId: plan.graphId,
      expected: plan.baseline.version,
      actual: active?.version ?? 0,
    });
  }
  if (active.schema_hash !== plan.baseline.hash) {
    throw new SchemaContentConflictError({
      graphId: plan.graphId,
      version: active.version,
      existingHash: active.schema_hash,
      incomingHash: plan.baseline.hash,
    });
  }
}
