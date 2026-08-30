import { isBackendDerivedFrom } from "../derive-backend";
import type { GraphBackend, TransactionBackend } from "../types";

/** Actual author-created derived backends whose registrations must be probed. */
export type ExactRootRegistrationProvenanceFixture = Readonly<{
  derivedBackends: readonly [
    GraphBackend | TransactionBackend,
    ...(GraphBackend | TransactionBackend)[],
  ];
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
 * Owns exact-resource registration checks shared by transport and semantics.
 *
 * Derived targets come from the backend author rather than from a projection
 * this runner manufactures. Root transaction isolation is checked on a real
 * session when the backend exposes one. That check is inapplicable when the
 * registered resource is already an open transaction session.
 */
export async function assertExactRootRegistrationProvenance(
  backend: GraphBackend | TransactionBackend,
  fixture: ExactRootRegistrationProvenanceFixture,
  isRegistered: ExactRootRegistrationPredicate,
  createError: (check: string) => Error,
  isRootRegistration: ExactRootRegistrationPredicate = isRegistered,
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

  // A session registration is already scoped to one open transaction. It has
  // no legitimate nested-transaction probe; exact registration plus derived
  // isolation are the applicable provenance evidence for that resource.
  if (backend.capabilities.execution.atomicBatch === "session") {
    skipped.push("transaction backend isolation");
    return { passed, skipped };
  }
  if (!backend.capabilities.execution.interactiveTransactions) {
    skipped.push("transaction backend isolation");
    return { passed, skipped };
  }
  if (!("transaction" in backend)) {
    throw createError("transaction backend isolation");
  }
  const isolated = await backend.transaction((transaction) =>
    Promise.resolve(!isRootRegistration(transaction)),
  );
  if (!isolated) throw createError("transaction backend isolation");
  passed.push("transaction backend isolation");
  return { passed, skipped };
}
