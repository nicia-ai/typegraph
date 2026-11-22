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
 *
 * It also carries the view of a schema-write transaction a preflight is
 * handed: one whose `executeSchemaDdl`, a port that forwards arbitrary SQL,
 * releases control of the transaction (`native-transaction-release.ts`)
 * before its statement is sent, exactly as handing over the native handle does.
 */
import { backendDerivationChain } from "./derive-backend";

/**
 * Resolves when the transaction may still be committed; rejects with a
 * `TransactionRolledBackError` when the database has aborted it, or a
 * `TransactionOutcomeUnknownError` when TypeGraph cannot vouch for it.
 */
export type TransactionCommitCheck = () => Promise<void>;

/** The commit check of one transaction, and its preflight view. */
export type TransactionCommitEvidence = Readonly<{
  check: TransactionCommitCheck;
  /**
   * The backend a schema preflight on this transaction is handed in place of
   * the registered one, when control can leave through it.
   */
  preflightTarget?: object | undefined;
}>;

const TRANSACTION_COMMIT_EVIDENCE = new WeakMap<
  object,
  TransactionCommitEvidence
>();

/** Registers the commit evidence of one transaction's backend. */
export function registerTransactionCommitCheck(
  backend: object,
  evidence: TransactionCommitEvidence,
): void {
  TRANSACTION_COMMIT_EVIDENCE.set(backend, evidence);
}

function resolveTransactionCommitEvidence(
  target: object,
): TransactionCommitEvidence | undefined {
  for (const link of backendDerivationChain(target)) {
    const evidence = TRANSACTION_COMMIT_EVIDENCE.get(link);
    if (evidence !== undefined) return evidence;
  }
  return undefined;
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
  return resolveTransactionCommitEvidence(target)?.check;
}

/**
 * The backend a schema preflight on exactly `target` is handed: the
 * registered preflight view, or `target` itself. Exact identity, not the
 * derivation chain, so a view registered for an ancestor never replaces a
 * target's own overlays.
 */
export function resolveSchemaPreflightTarget<T extends object>(target: T): T {
  const view = TRANSACTION_COMMIT_EVIDENCE.get(target)?.preflightTarget;
  // Registered for exactly this backend by the code that built it, as a
  // derivation of it: the same surface.
  return (view as T | undefined) ?? target;
}
