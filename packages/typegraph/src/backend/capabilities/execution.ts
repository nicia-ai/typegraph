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
 * Rebinds root atomic authority to one already-open transaction session.
 *
 * The session must still register its own exact-resource transport and
 * semantic profile. This declaration alone never authorizes execution.
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
