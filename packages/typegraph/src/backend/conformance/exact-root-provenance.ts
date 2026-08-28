/** Exact-root registration checks shared by transport and semantic conformance. */
export type ExactRootRegistrationProvenanceChecks = Readonly<{
  exactRootRegistration: () => boolean | PromiseLike<boolean>;
  derivedBackendIsolation: () => boolean | PromiseLike<boolean>;
  transactionBackendIsolation: () => boolean | PromiseLike<boolean>;
}>;

const EXACT_ROOT_PROVENANCE_CHECKS = [
  ["exact root registration", "exactRootRegistration"],
  ["derived backend isolation", "derivedBackendIsolation"],
  ["transaction backend isolation", "transactionBackendIsolation"],
] as const satisfies readonly Readonly<
  [string, keyof ExactRootRegistrationProvenanceChecks]
>[];

/**
 * Owns the shared exact-root provenance verdict for conformance runners.
 *
 * The caller supplies its boundary-specific error vocabulary while this seam
 * owns which registrations must be present or isolated.
 */
export async function assertExactRootRegistrationProvenance(
  checks: ExactRootRegistrationProvenanceChecks,
  createError: (check: string) => Error,
): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const [name, member] of EXACT_ROOT_PROVENANCE_CHECKS) {
    if (await checks[member]()) {
      passed.push(name);
      continue;
    }
    throw createError(name);
  }
  return passed;
}
