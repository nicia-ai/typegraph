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
import type { WriteFencePlan } from "./write-fence";

const ELIGIBLE_SCHEMA_FENCED_INSERT_BACKENDS = new WeakSet<object>();

/**
 * Every caller that could mark a backend or transaction handle eligible goes
 * through {@link markSchemaFencedInsertEligibleUnderFence} instead of this
 * primitive directly, so eligibility can never be granted without a resolved
 * fence plan backing it.
 */
function markSchemaFencedInsertEligible<T extends object>(target: T): T {
  ELIGIBLE_SCHEMA_FENCED_INSERT_BACKENDS.add(target);
  return target;
}

/**
 * Marks `target` schema-fenced-insert eligible only when `fencePlan` actually
 * fences concurrent writers — the same `kind !== "unfenced"` gate
 * `createSqlBackend`'s root mark applies (`../drizzle/engine/marks`). The
 * bundled factories' root backend and every TypeGraph-opened transaction
 * handle earn this mark through this function, so the root and every
 * transaction handle it opens can never disagree about eligibility for the
 * same resolved plan.
 *
 * @internal Called only by bundled factories for their root/owned-tx handles.
 */
export function markSchemaFencedInsertEligibleUnderFence<T extends object>(
  target: T,
  fencePlan: WriteFencePlan,
): T {
  if (fencePlan.kind !== "unfenced") {
    markSchemaFencedInsertEligible(target);
  }
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
