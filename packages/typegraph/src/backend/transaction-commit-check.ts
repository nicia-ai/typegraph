/**
 * Carries a transaction's commit check from the backend that opened the
 * transaction to the Store code that runs inside it.
 *
 * The check — "is the transaction this backend opened still open and healthy,
 * so that it may be committed?" — is decided by the backend that issues the
 * transaction's `COMMIT`, from the evidence its
 * `capabilities.execution.commitOutcome` declares (for `"session-marker"`, see
 * `drizzle/execution/postgres-commit-outcome.ts`). The backend runs it right
 * before that `COMMIT`. This registry lets the Store run the same check as
 * soon as the caller's callback returns, before any work of its own (a
 * revision-clock advance, a capture flush, a pre-commit hook) reaches a
 * session that is aborted or no longer inside the transaction. It is a
 * carrier, not a second decision.
 */
import { backendDerivationChain } from "./derive-backend";

/**
 * Resolves when the transaction may still be committed; rejects with a
 * `TransactionRolledBackError` when the database has aborted it, or a
 * `TransactionOutcomeUnknownError` when the session is no longer inside it.
 */
export type TransactionCommitCheck = () => Promise<void>;

const TRANSACTION_COMMIT_CHECKS = new WeakMap<object, TransactionCommitCheck>();

/** Registers the commit check of one transaction's backend. */
export function registerTransactionCommitCheck(
  backend: object,
  check: TransactionCommitCheck,
): void {
  TRANSACTION_COMMIT_CHECKS.set(backend, check);
}

/**
 * The commit check of the transaction `target` executes in, or `undefined`
 * when the backend that opened it registered none: one whose
 * `commitOutcome` evidence needs no check, one that declares none, or a
 * transaction TypeGraph did not open (an adopted transaction, a savepoint on
 * an enclosing transaction). Backends derived from a transaction's backend
 * issue their statements on that same session, so they resolve its check
 * along their derivation chain.
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
