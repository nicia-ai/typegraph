import { statementExecutionVerdict } from "../backend/capabilities/resolve";
import { resolveWriteFencePlan } from "../backend/capabilities/write-fence";
import type { TransactionBackend } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import {
  ensureEngineSerializedWriterSlot,
  hasPendingWriteTransactionRevision,
} from "../store/operations/write-transaction";
import { hasPendingRecordedGraphWrites } from "../store/recorded-capture";
import { storeBackend } from "../store/runtime-port";
import type { Store } from "../store/store";
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
