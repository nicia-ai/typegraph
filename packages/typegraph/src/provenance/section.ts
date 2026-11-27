/**
 * The provenance section of a native transaction: THE one rule for which
 * capability calls may overlap on one transaction. A retraction verb decides
 * its writes from one support read and then writes, so it holds the section
 * exclusively; `holding(tx)` and `assertHolds(tx)` only read support, so they
 * hold it shared. Two reads may overlap; a verb and anything else may not.
 *
 * The graph lock a call holds excludes other transactions, not other calls on
 * the same one. Without this rule a read that straddled a verb's writes could
 * return a believed set no order of the two calls produces (part of a close
 * pass applied, the rest not), and an `assertHolds(tx)` that read while a
 * verb was between its decision and its writes would vouch for a fact that
 * verb had already decided to close.
 *
 * The section is shared only where the sessions share their native
 * transaction's state, which is only on proof (`session.native`): two
 * adoptions of one caller-begun transaction on a connection-level handle
 * (better-sqlite3) each get a state of their own and are not refused.
 * Overlap there is unsupported and its result undefined (a fact can commit
 * live with no support); the transaction-session rule that refuses an
 * adopted call while another context is active removes it for every
 * feature, so no provenance-specific guard is added for it here.
 */
import { ConfigurationError } from "../errors";
import {
  runExclusiveSection,
  runSharedSection,
} from "../store/native-transaction-state";
import { transactionContextNativeState } from "../store/operation-scope";

/** Whether a call writes (a verb) or only reads support. */
export type ProvenanceSectionMode = "exclusive" | "shared";

/**
 * The refusal of a call started on a transaction while a call it may not
 * overlap is still running there: `operation` is the refused call,
 * `runningOperation` the one still running.
 */
function overlappingProvenanceCallError(
  operation: string,
  runningOperation: string,
  graphId: string,
): ConfigurationError {
  return new ConfigurationError(
    `${operation} was called while ${runningOperation} was still running on the same transaction.`,
    {
      code: "PROVENANCE_TRANSITION_OVERLAPPING",
      operation,
      runningOperation,
      graphId,
    },
    {
      suggestion:
        "Await each retraction verb before starting another provenance call on the same transaction, and await holding(tx) and assertHolds(tx) before starting a verb there; pass sources together to retractMany(sources, tx) or unRetractMany(sources, tx).",
    },
  );
}

/**
 * Runs `fn` in the provenance section of `graphId` on the native transaction
 * `tx` runs on, in `mode`, or refuses `operation` before `fn` runs, so a
 * refused call issues no statement and the transaction stays usable.
 *
 * The refusal is decided on the context session's native state without
 * entering an operation, so `fn` runs the call's other refusals (its locks)
 * and enters the call's one operation after them
 * (`enterTransactionOperation`), as every privileged call does.
 */
export function runInProvenanceSection<T>(
  tx: Parameters<typeof transactionContextNativeState>[0],
  call: Readonly<{
    graphId: string;
    operation: string;
    mode: ProvenanceSectionMode;
  }>,
  fn: () => Promise<T>,
): Promise<T> {
  const run =
    call.mode === "exclusive" ? runExclusiveSection : runSharedSection;
  return run(
    transactionContextNativeState(tx),
    {
      key: `provenance-transition\u0000${call.graphId}`,
      operation: call.operation,
    },
    (runningOperation) =>
      overlappingProvenanceCallError(
        call.operation,
        runningOperation,
        call.graphId,
      ),
    fn,
  );
}
