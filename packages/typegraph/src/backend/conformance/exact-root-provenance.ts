import { isBackendDerivedFrom } from "../derive-backend";
import type { GraphBackend, TransactionBackend } from "../types";

/** Actual author-created derived backends whose registrations must be probed. */
export type ExactRootRegistrationProvenanceFixture = Readonly<{
  derivedBackends: readonly [GraphBackend, ...GraphBackend[]];
}>;

/** Honest result of provenance checks that ran or were inapplicable. */
export type ExactRootRegistrationProvenanceReport = Readonly<{
  passed: readonly string[];
  skipped: readonly string[];
}>;

type ExactRootRegistrationPredicate = (
  target: GraphBackend | TransactionBackend,
) => boolean;

/**
 * Owns exact-root registration checks shared by transport and semantics.
 *
 * Derived targets come from the backend author rather than from a projection
 * this runner manufactures. Transaction isolation is checked on a real
 * session when the backend exposes one and reported as skipped otherwise.
 */
export async function assertExactRootRegistrationProvenance(
  backend: GraphBackend,
  fixture: ExactRootRegistrationProvenanceFixture,
  isRegistered: ExactRootRegistrationPredicate,
  createError: (check: string) => Error,
): Promise<ExactRootRegistrationProvenanceReport> {
  const passed: string[] = [];
  const skipped: string[] = [];
  if (!isRegistered(backend)) throw createError("exact root registration");
  passed.push("exact root registration");

  for (const derived of fixture.derivedBackends) {
    if (!isBackendDerivedFrom(derived, backend)) {
      throw createError("derived backend lineage");
    }
  }
  passed.push("derived backend lineage");

  for (const derived of fixture.derivedBackends) {
    if (isRegistered(derived)) throw createError("derived backend isolation");
  }
  passed.push("derived backend isolation");

  if (!backend.capabilities.execution.interactiveTransactions) {
    skipped.push("transaction backend isolation");
    return { passed, skipped };
  }
  const isolated = await backend.transaction((transaction) =>
    Promise.resolve(!isRegistered(transaction)),
  );
  if (!isolated) throw createError("transaction backend isolation");
  passed.push("transaction backend isolation");
  return { passed, skipped };
}
