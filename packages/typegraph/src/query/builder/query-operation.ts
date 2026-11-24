/**
 * How a read built inside a transaction reaches that transaction's session
 * when it executes.
 *
 * A query's public configuration (`QueryBuilderConfig`, `PreparedQueryConfig`)
 * names one `backend`, and every builder step hands that same configuration
 * on, by reference or by spread. A Store building a query inside a
 * transaction also puts a {@link QueryOperationSource} on it, under a
 * module-private key no other module can spell: a function, closed over the
 * transaction's session, that enters one operation of the session and returns
 * the backend that operation's statements go through. The configuration
 * carries the source as a value; nothing is looked up from the object a query
 * holds. The Store's other transaction reads (`batchOnce`, `neighbors`,
 * `countNeighbors`, `subgraph`, `describe`, `validateStore`) carry a source
 * the same way, on the context object their statements are sent from.
 *
 * Every terminal resolves its statement target with
 * {@link enterQueryExecution}, once per execution: the source's operation for
 * a read built in a transaction, the configured backend otherwise. Building
 * or preparing a query enters nothing; a root read allocates nothing.
 *
 * The boundary of one execution:
 *
 * - **Refusals first.** A refusal that needs no statement (an unbound
 *   parameter, a bad argument, a target or capability the read cannot use)
 *   runs before the operation is entered, so a refused call enters nothing.
 *   Compiling the statement belongs to the execution.
 * - **One call, one operation.** Work one call composes (a selective attempt
 *   and its fallback, a subgraph's closure and fetches, an analysis bracketed
 *   by schema reads) runs under the one operation the call entered.
 * - **A stream enters one operation per page.** Each page a `stream()` fetches
 *   is its own statement, issued when the consumer asks for it, and other
 *   calls on the same session may run between pages. A page is therefore its
 *   own execution: no operation is held open across the awaits between pages.
 */
import { type GraphBackend } from "../../backend/types";

const QUERY_OPERATION_SOURCE: unique symbol = Symbol(
  "typegraph.queryOperationSource",
);

/**
 * Enters one operation of the session a read was built in and returns the
 * backend the operation's statements go through for that execution: the
 * same kind of backend as the `backend` the carrying object names.
 */
export type QueryOperationSource<Backend = GraphBackend> = () => Backend;

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
 * THE statement target of one execution: a new operation of the session the
 * read was built in, or the configured backend (`undefined` when there is
 * none). Call it once per public terminal call (once per page of a stream),
 * after the call's refusals, and hand the result to everything the call runs.
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
      value[QUERY_OPERATION_SOURCE]()
    : value.backend;
}
