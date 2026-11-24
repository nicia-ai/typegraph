/**
 * How a query built inside a transaction reaches that transaction's session
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
 * holds.
 *
 * Every terminal resolves its statement target with
 * {@link enterQueryExecution}, once per execution: the source's operation for
 * a query built in a transaction, the configured backend otherwise. Building
 * or preparing a query enters nothing; a root query allocates nothing.
 */
import { type GraphBackend } from "../../backend/types";

const QUERY_OPERATION_SOURCE: unique symbol = Symbol(
  "typegraph.queryOperationSource",
);

/**
 * Enters one operation of the session a query was built in and returns the
 * backend the operation's statements go through for that execution.
 */
export type QueryOperationSource = () => GraphBackend;

type CarriesQueryOperationSource = Readonly<{
  [QUERY_OPERATION_SOURCE]: QueryOperationSource;
}>;

function carriesQueryOperationSource(
  value: object,
): value is CarriesQueryOperationSource {
  return QUERY_OPERATION_SOURCE in value;
}

/**
 * `value` carrying `source`, or `value` itself when there is none. Spread
 * rather than mutated: a configuration is shared by every query built from
 * it.
 */
export function withQueryOperationSource<T extends object>(
  value: T,
  source: QueryOperationSource | undefined,
): T {
  return source === undefined ? value : (
      { ...value, [QUERY_OPERATION_SOURCE]: source }
    );
}

/** The source `value` carries, so a derived configuration can carry it on. */
export function queryOperationSourceOf(
  value: object,
): QueryOperationSource | undefined {
  return carriesQueryOperationSource(value) ?
      value[QUERY_OPERATION_SOURCE]
    : undefined;
}

/**
 * THE statement target of one query execution: a new operation of the
 * session the query was built in, or the configured backend (`undefined` when
 * there is none). Call it once per public terminal call, when the call
 * executes, and hand the result to everything the call runs.
 */
export function enterQueryExecution(
  value: Readonly<{ backend?: GraphBackend | undefined }>,
): GraphBackend | undefined {
  return carriesQueryOperationSource(value) ?
      value[QUERY_OPERATION_SOURCE]()
    : value.backend;
}
