import { statementExecutionVerdict } from "../backend/capabilities/resolve";
import { resolveWriteFencePlan } from "../backend/capabilities/write-fence";
import type { TransactionBackend } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import {
  ensureEngineSerializedWriterSlot,
  hasPendingWriteTransactionRevision,
} from "../store/operations/write-transaction";
import {
  hasPendingRecordedGraphWrites,
  runRecordedTransactionSavepoint,
} from "../store/recorded-capture";
import {
  markTransactionEffects,
  storeBackend,
  transactionBackend,
} from "../store/runtime-port";
import type { Store } from "../store/store";
import type { TransactionContext } from "../store/types";
import { MergePlanCapabilityError } from "./errors";

/** A plan's durable revision cannot fence changes still awaiting capture flush. */
export async function assertMergeTransactionPristine<G extends GraphDef>(
  target: Store<G>,
  txBackend: TransactionBackend,
): Promise<void> {
  if (
    hasPendingRecordedGraphWrites(txBackend, target.graphId) ||
    hasPendingWriteTransactionRevision(txBackend)
  ) {
    throw new MergePlanCapabilityError(
      "Apply the merge plan before writing to its target graph in this transaction.",
      { details: { capability: "mergeTransactionPristine" } },
    );
  }
  if (resolveWriteFencePlan(txBackend).kind !== "engine-serialized") return;
  const statements = statementExecutionVerdict(storeBackend(target));
  if (!statements.supported) {
    throw new MergePlanCapabilityError(
      "Adopted merge application requires transaction-scoped statement execution to acquire the engine writer slot.",
      { details: { capability: "mergeTransactionWriterSlot" } },
    );
  }
  await ensureEngineSerializedWriterSlot(
    txBackend,
    target.revisionSchema,
    statements,
  );
}

const ADOPTED_MERGE_APPLY_SAVEPOINT = "typegraph_merge_apply";

/**
 * Runs an adopted merge apply as one unit inside the caller's transaction: a
 * refusal or failure rolls every row the apply wrote back to where it began
 * before it propagates.
 *
 * The apply replays a plan one row at a time and checks some invariants only
 * once its last row has landed — the required-existence rule for the parts
 * the plan touches is deferred until then. A caller that caught a refusal
 * raised after the first write and committed would otherwise keep a
 * half-applied merge that no constraint ever judged, such as a required part
 * whose old attaching edge is gone and whose new one was never written. The
 * savepoint is the transaction's own rollback boundary, so that commit keeps
 * none of the merge's writes; the recorded-capture state that mirrors them is
 * restored with it ({@link runRecordedTransactionSavepoint}).
 *
 * A target whose transactions expose no statement execution has no savepoint
 * to take, so it is refused before anything is applied.
 */
export async function withAdoptedMergeApplySavepoint<G extends GraphDef, T>(
  target: Store<G>,
  tx: TransactionContext<G>,
  apply: () => Promise<T>,
): Promise<T> {
  const statements = statementExecutionVerdict(storeBackend(target));
  if (!statements.supported) {
    throw new MergePlanCapabilityError(
      "Adopted merge application requires transaction-scoped statement execution to roll a refused apply back atomically.",
      { details: { capability: "mergeTransactionSavepoint" } },
    );
  }
  // The rows are not the apply's only effects: the transaction context has
  // also buffered `onOperationEnd` outcomes and receipt counts for them.
  // Those are forgotten with the rows, so a caller that commits reports only
  // what it commits.
  const effects = markTransactionEffects(tx);
  try {
    return await runRecordedTransactionSavepoint(
      transactionBackend(tx),
      statements,
      ADOPTED_MERGE_APPLY_SAVEPOINT,
      async () => ({ action: "release", value: await apply() }),
    );
  } catch (error) {
    effects.discard(error);
    throw error;
  }
}
