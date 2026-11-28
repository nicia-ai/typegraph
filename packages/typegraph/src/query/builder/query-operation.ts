/**
 * How a read built inside a transaction reaches that transaction's session
 * when it executes.
 *
 * A query's public configuration (`QueryBuilderConfig`, `PreparedQueryConfig`)
 * names one `backend`, and every builder step hands that same configuration
 * on, by reference or by spread. A Store building a query inside a
 * transaction also puts a {@link QueryOperationSource} on it, under a
 * module-private key no other module can spell: a pair of functions, closed
 * over the transaction's session, that admit one read call on the session and
 * return the backend its statements go through, and release it. The configuration
 * carries the source as a value; nothing is looked up from the object a query
 * holds. The Store's other transaction reads (`batchOnce`, `neighbors`,
 * `countNeighbors`, `subgraph`, `describe`, `validateStore`) carry a source
 * the same way, on the context object their statements are sent from.
 *
 * Every terminal resolves its statement target with
 * {@link enterQueryExecution}, once per execution: one operation of the
 * session for a read built in a transaction, counted as a running read call,
 * the configured backend otherwise; and releases it with
 * {@link exitQueryExecution} once the execution has settled. Building or
 * preparing a query enters nothing; a root read allocates nothing.
 *
 * The boundary of one execution:
 *
 * - **Refusals first.** A refusal that needs no statement (an unbound
 *   parameter, a bad argument, a target or capability the read cannot use)
 *   runs before the read is admitted, so a refused call enters nothing.
 *   Compiling the statement belongs to the execution.
 * - **A read is a call.** It is refused at admission while another call's
 *   savepoint unit is open on the session, and it is in flight from admission
 *   until its execution settles, so a unit another call tries to open
 *   meanwhile is refused.
 * - **One call, one admission.** Work one call composes (a selective attempt
 *   and its fallback, a subgraph's closure and fetches, an analysis bracketed
 *   by schema reads) runs under the one admission the call took.
 * - **A stream admits each page on its own.** Each page a `stream()` fetches
 *   is its own statement, issued when the consumer asks for it, and other
 *   calls on the same session may run between pages. A page is therefore its
 *   own execution: nothing is held in flight across the awaits between pages,
 *   so a unit may open between pages, and the next page is then refused.
 */
import { type GraphBackend } from "../../backend/types";

const QUERY_OPERATION_SOURCE: unique symbol = Symbol(
  "typegraph.queryOperationSource",
);

/**
 * How one execution of a read built in a transaction is admitted on that
 * transaction's session: `enter` admits it as a read call and returns the
 * backend its statements go through for that execution (the same kind of
 * backend as the `backend` the carrying object names), and `exit` releases
 * it once the execution has settled.
 */
export type QueryOperationSource<Backend = GraphBackend> = Readonly<{
  enter: () => Backend;
  exit: () => void;
}>;

type CarriesQueryOperationSource<Backend> = Readonly<{
  [QUERY_OPERATION_SOURCE]: QueryOperationSource<Backend>;
}>;

/**
 * Whether `value` carries a source. Only {@link withQueryOperationSource}
 * attaches one, and it types the source by `value`'s own `backend`.
 */
function carriesQueryOperationSource<Backend>(
  value: Readonly<{ backend?: Backend }>,
): value is Readonly<{ backend?: Backend }> &
  CarriesQueryOperationSource<NonNullable<Backend>> {
  return QUERY_OPERATION_SOURCE in value;
}

/**
 * `value` carrying `source`, or `value` itself when there is none. Spread
 * rather than mutated: a configuration is shared by every query built from
 * it. `value` is a configuration or a read context, never a backend; a
 * backend is decorated only through `deriveBackend`.
 */
export function withQueryOperationSource<
  T extends Readonly<{ backend?: unknown }>,
>(
  value: T,
  source: QueryOperationSource<NonNullable<T["backend"]>> | undefined,
): T {
  return source === undefined ? value : (
      { ...value, [QUERY_OPERATION_SOURCE]: source }
    );
}

/** The source `value` carries, so a derived configuration can carry it on. */
export function queryOperationSourceOf<Backend>(
  value: Readonly<{ backend?: Backend }>,
): QueryOperationSource<NonNullable<Backend>> | undefined {
  return carriesQueryOperationSource(value) ?
      value[QUERY_OPERATION_SOURCE]
    : undefined;
}

/**
 * THE statement target of one execution: the session the read was built in,
 * admitted as a read call, or the configured backend (`undefined` when there
 * is none). Call it once per public terminal call (once per page of a
 * stream), after the call's refusals, inside the call's promise (it throws
 * its refusal), and hand the result to everything the call runs. Pair it with
 * {@link exitQueryExecution} in a `finally` once the execution has settled.
 */
export function enterQueryExecution<Backend>(
  value: Readonly<{ backend: Backend }>,
): Backend;
export function enterQueryExecution<Backend>(
  value: Readonly<{ backend?: Backend | undefined }>,
): Backend | undefined;
export function enterQueryExecution<Backend>(
  value: Readonly<{ backend?: Backend | undefined }>,
): Backend | undefined {
  return carriesQueryOperationSource(value) ?
      value[QUERY_OPERATION_SOURCE].enter()
    : value.backend;
}

/**
 * Releases the execution {@link enterQueryExecution} admitted on `value`,
 * once that execution has settled; nothing for a read without a source.
 */
export function exitQueryExecution(
  value: Readonly<{ backend?: unknown }>,
): void {
  if (carriesQueryOperationSource(value)) value[QUERY_OPERATION_SOURCE].exit();
}
