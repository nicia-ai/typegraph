import type { BackendCapabilities } from "../types";

/**
 * Removes exact-root atomic execution evidence at a session boundary.
 *
 * Derived/projection constructors and transaction factories share this owner
 * so a new backend construction seam cannot accidentally retain root-only
 * execution authority.
 */
export function downgradeRootAtomicBatch(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  return {
    ...capabilities,
    execution: { ...capabilities.execution, atomicBatch: "none" },
  };
}
