import {
  enterOperation,
  enterTransactionOperation,
  type Operation,
  type OperationBackend,
  operationSession,
} from "../../src/store/operation-scope";
import { transactionChildSurface } from "../../src/store/runtime-port";

/**
 * Where a test drives `runRecordedTransactionSavepoint` inside the transaction
 * of `context`: a new operation of the context's own session, and its handle,
 * as the two leading arguments. A savepoint unit runs in the operation of the
 * call that takes it, so a unit entered from a fresh session over the
 * context's backend would find none of the state the context's session
 * carries.
 *
 * With `parent`, the operation is that operation's child instead: a unit
 * nested inside the unit `parent` holds, which a call of another root would
 * be refused from opening.
 */
export function savepointUnitEntry(
  context: Parameters<typeof enterTransactionOperation>[0],
  parent?: Operation,
): readonly [Operation, OperationBackend] {
  const operation =
    parent === undefined ?
      enterTransactionOperation(context)
    : enterOperation(operationSession(parent), parent);
  return [operation, operation.backend];
}

/**
 * The collections of `context` whose writes run as children of `operation`,
 * the operation a test's savepoint unit was entered with
 * ({@link savepointUnitEntry}): the writes a unit's own call composes. A
 * write through `context`'s own collections while that unit is open is
 * another call's, and is refused.
 */
export function savepointUnitChild<
  Context extends Readonly<{ nodes: object; edges: object }> &
    Parameters<typeof transactionChildSurface>[0],
>(context: Context, operation: Operation): Pick<Context, "nodes" | "edges"> {
  const child = transactionChildSurface(context, operation);
  return {
    nodes: child.nodes,
    edges: child.edges,
  };
}
