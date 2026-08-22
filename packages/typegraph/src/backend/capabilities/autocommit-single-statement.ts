/**
 * Origin evidence for the managed single-statement autocommit fast path.
 *
 * This is intentionally narrower than schema-fenced-insert eligibility. The
 * latter follows bundled transaction targets and derived wrappers because its
 * statement still runs inside an explicit transaction. Here, omitting that
 * transaction is the optimization, so only the literal root objects produced
 * by the bundled factories may opt in. In particular, this evidence is never
 * carried through `deriveBackend`, an owned transaction, or adoption of a
 * caller-owned transaction.
 */

const BUNDLED_ROOT_AUTOCOMMIT_BACKENDS = new WeakSet<object>();

/** @internal Called only by bundled factories after their root backend exists. */
export function markBundledRootAutocommitEligible<T extends object>(
  target: T,
): T {
  BUNDLED_ROOT_AUTOCOMMIT_BACKENDS.add(target);
  return target;
}

/** Whether this is the exact root backend a bundled factory created. */
export function isBundledRootAutocommitEligible(target: object): boolean {
  return BUNDLED_ROOT_AUTOCOMMIT_BACKENDS.has(target);
}
