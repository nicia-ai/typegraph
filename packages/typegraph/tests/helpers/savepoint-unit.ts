import {
  enterTransactionOperation,
  type Operation,
  type OperationBackend,
} from "../../src/store/operation-scope";

/**
 * Where a test drives `runRecordedTransactionSavepoint` inside the transaction
 * of `context`: a new operation of the context's own session, and its handle,
 * as the two leading arguments. A savepoint unit runs in the operation of the
 * call that takes it, so a unit entered from a fresh session over the
 * context's backend would find none of the state the context's session
 * carries.
 */
export function savepointUnitEntry(
  context: Parameters<typeof enterTransactionOperation>[0],
): readonly [Operation, OperationBackend] {
  const operation = enterTransactionOperation(context);
  return [operation, operation.backend];
}
