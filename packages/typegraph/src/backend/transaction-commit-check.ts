/**
 * Carries a transaction session's commit check from the backend that opened
 * the transaction to the Store code that runs inside it.
 *
 * The check itself — "can this transaction still commit?" — is decided by the
 * backend that issues the transaction's `COMMIT`, from evidence its session
 * provides (see `drizzle/execution/postgres-commit-outcome.ts`). The backend
 * runs it right before that `COMMIT`. This registry lets the Store run the
 * same check as soon as the caller's callback returns, before any work of its
 * own (a capture flush, a revision-clock advance, a pre-commit hook) reaches a
 * session the database has already aborted. It is a carrier, not a second
 * decision: a transaction backend with no registered check is one whose
 * backend provides no such evidence, and it behaves exactly as before.
 */
import { backendDerivationChain } from "./derive-backend";

/**
 * Resolves when the transaction can still commit; rejects with a
 * `TransactionRolledBackError` when the database has already aborted it.
 */
export type TransactionCommitCheck = () => Promise<void>;

const TRANSACTION_COMMIT_CHECKS = new WeakMap<object, TransactionCommitCheck>();

/** Registers the commit check of one transaction session's backend. */
export function registerTransactionCommitCheck(
  backend: object,
  check: TransactionCommitCheck,
): void {
  TRANSACTION_COMMIT_CHECKS.set(backend, check);
}

/**
 * The commit check of the session `target` executes on. Backends derived from
 * a session's backend issue their statements on that same session, so they
 * resolve its check along their derivation chain.
 */
export function resolveTransactionCommitCheck(
  target: object,
): TransactionCommitCheck | undefined {
  for (const link of backendDerivationChain(target)) {
    const check = TRANSACTION_COMMIT_CHECKS.get(link);
    if (check !== undefined) return check;
  }
  return undefined;
}
