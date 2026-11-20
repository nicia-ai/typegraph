/**
 * Exact durable contribution marker required by one atomic SQL program.
 *
 * The signature is resolved locally from the active strategy declaration. The
 * program proves this complete identity against durable database state inside
 * the same atomic submission as the projection write, so a cold backend does
 * not need a separate marker-read round trip before dispatch.
 */
export type AtomicContributionEvidence = Readonly<{
  graphId: string;
  logicalName: string;
  owner: string;
  tableName: string;
  signature: string;
}>;

/** Bind cost contributed by one exact contribution-marker predicate. */
export const ATOMIC_CONTRIBUTION_EVIDENCE_BIND_COUNT = 5;

/** Refusal-row identity/timestamp binds plus the expected marker-count bind. */
export const ATOMIC_CONTRIBUTION_ASSERTION_FIXED_BIND_COUNT = 6;
