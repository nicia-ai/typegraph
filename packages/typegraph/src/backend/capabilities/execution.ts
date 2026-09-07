import type {
  BackendCapabilities,
  BackendExecutionCapabilities,
} from "../types";

/**
 * THE one derivation of `execution.unitOfWork` from the other two execution
 * facts. An engine that can hold an open callback transaction groups a write
 * that way regardless of whether it also exposes an atomic batch primitive;
 * otherwise a closed atomic program is the unit when one exists, and there is
 * none at all when neither does. Every place that changes `atomicBatch` —
 * the capability tail and the two boundaries below — re-derives through this
 * function, so the two facts can never disagree on one object.
 */
export function deriveUnitOfWork(
  execution: Pick<
    BackendExecutionCapabilities,
    "interactiveTransactions" | "atomicBatch"
  >,
): NonNullable<BackendExecutionCapabilities["unitOfWork"]> {
  if (execution.interactiveTransactions) return "interactive";
  return execution.atomicBatch === "none" ? "none" : "batch";
}

/**
 * Removes exact atomic execution evidence at a backend derivation or session
 * boundary, and re-derives `unitOfWork` with it: a derived object with no
 * atomic batch is not a batch-tier backend, whatever its source was.
 *
 * Derived/projection constructors and transaction factories share this owner
 * so a new backend construction seam cannot accidentally retain execution
 * authority earned by another exact object.
 */
export function downgradeAtomicBatch(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  return {
    ...capabilities,
    execution: withUnitOfWork({
      ...capabilities.execution,
      atomicBatch: "none",
    }),
  };
}

function withUnitOfWork(
  execution: BackendExecutionCapabilities,
): BackendExecutionCapabilities {
  return { ...execution, unitOfWork: deriveUnitOfWork(execution) };
}

/**
 * Declares atomic authority for one already-open transaction session.
 *
 * Session authority is earned independently of the root verdict: a root may
 * be unable to own a multi-statement atomic boundary while its transaction
 * factory can still prove one pinned open session. The session must register
 * its own exact-resource transport and semantic profile; this declaration
 * alone never authorizes execution.
 */
export function scopeAtomicBatchToSession(
  capabilities: BackendCapabilities,
  available: boolean,
): BackendCapabilities {
  return {
    ...capabilities,
    execution: withUnitOfWork({
      ...capabilities.execution,
      atomicBatch: available ? "session" : "none",
    }),
  };
}
