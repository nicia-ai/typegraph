/**
 * Origin evidence for the schema-fenced INSERT fast path.
 *
 * The fused statements are not merely an optional structural convenience:
 * their PostgreSQL `FOR SHARE` and SQLite transaction-fence contract is owned
 * by the bundled factories. A custom backend can expose methods with the same
 * names, and an adopted transaction is bound to a caller-owned boundary, so
 * neither is eligible by inference. Factory-owned root backends and the
 * transaction handles those factories open carry this out-of-band evidence.
 */

const ELIGIBLE_SCHEMA_FENCED_INSERT_BACKENDS = new WeakSet<object>();

/** @internal Called only by bundled factories for their root/owned-tx handles. */
export function markSchemaFencedInsertEligible<T extends object>(target: T): T {
  ELIGIBLE_SCHEMA_FENCED_INSERT_BACKENDS.add(target);
  return target;
}

/** @internal `deriveBackend` carries origin evidence across wrappers/projections. */
export function carrySchemaFencedInsertEligibility(
  derived: object,
  base: object,
): void {
  if (ELIGIBLE_SCHEMA_FENCED_INSERT_BACKENDS.has(base)) {
    ELIGIBLE_SCHEMA_FENCED_INSERT_BACKENDS.add(derived);
  }
}

/** Whether this backend originated in a bundled root or factory-owned transaction. */
export function isSchemaFencedInsertEligible(target: object): boolean {
  return ELIGIBLE_SCHEMA_FENCED_INSERT_BACKENDS.has(target);
}
