import type { BackendCapabilities } from "../types";

/**
 * Removes exact atomic execution evidence at a backend derivation or session
 * boundary.
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
    execution: {
      ...capabilities.execution,
      atomicBatch: "none",
    },
  };
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
    execution: {
      ...capabilities.execution,
      atomicBatch: available ? "session" : "none",
    },
  };
}
