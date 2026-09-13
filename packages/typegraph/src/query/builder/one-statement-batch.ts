import type { GraphBackend, TransactionBackend } from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { getDialect } from "../dialect";
import { sql, type SqlFragment } from "../sql-fragment";
import { asCompiledRowsSql } from "../sql-intent";
import type {
  EmbeddableOneStatementRead,
  OneStatementBatchableQuery,
  OneStatementBatchResults,
} from "./types";

const ORDER_COLUMN = "typegraphbatchordinal";
const ORDER_KEY_PREFIX = "typegraphbatchorder";

export function oneStatementBatchOrderColumn(index: number): string {
  return `${ORDER_KEY_PREFIX}${index}`;
}

function buildOrdinalOrder(
  rowAlias: string,
  orderBy: ReturnType<
    NonNullable<
      OneStatementBatchableQuery<unknown>["compileOneStatementBatchItem"]
    >
  >["orderBy"],
): SqlFragment {
  if (orderBy.length === 0) return sql.empty();
  const row = sql.identifier(rowAlias);
  const terms = orderBy.flatMap((order) => {
    const column = sql`${row}.${sql.identifier(order.column)}`;
    const nullDirection =
      order.nulls === "first" ? sql.raw("DESC") : sql.raw("ASC");
    return [
      sql`(${column} IS NULL) ${nullDirection}`,
      sql`${column} ${sql.raw(order.direction.toUpperCase())}`,
    ];
  });
  return sql`ORDER BY ${sql.join(terms, sql`, `)}`;
}

type BatchEnvelopeRow = Readonly<{
  batch_index: number | string;
  payload: unknown;
}>;

/** Executes independent relational reads through one database statement. */
export async function executeOneStatementBatch<
  const Queries extends readonly EmbeddableOneStatementRead<unknown>[],
>(
  backend: GraphBackend | TransactionBackend,
  queries: Queries,
): Promise<OneStatementBatchResults<Queries>> {
  const dialect = getDialect(backend.dialect);
  const items = queries.map((query) => {
    const compile = query.compileOneStatementBatchItem;
    if (compile === undefined) {
      throw new ConfigurationError(
        "Read cannot be embedded in store.batchOnce().",
        { operation: "batchOnce" },
        {
          suggestion:
            "Pass a fluent relational query or a set-oriented read returned by the store's query helpers.",
        },
      );
    }
    return compile.call(query);
  });
  const ctes: SqlFragment[] = [];
  const branches: SqlFragment[] = [];

  for (const [index, item] of items.entries()) {
    const reservedAlias = item.outputNames.find(
      (outputName) =>
        outputName === ORDER_COLUMN || outputName.startsWith(ORDER_KEY_PREFIX),
    );
    if (reservedAlias !== undefined) {
      throw new ConfigurationError(
        `Query output alias "${reservedAlias}" is reserved by store.batchOnce().`,
        { operation: "batchOnce", alias: reservedAlias },
      );
    }
    const sourceName = `typegraph_batch_source_${index}`;
    const rowsName = `typegraph_batch_rows_${index}`;
    const ordinalOrder = buildOrdinalOrder(sourceName, item.orderBy);
    ctes.push(
      sql`${sql.identifier(sourceName)} AS (${item.query})`,
      sql`${sql.identifier(rowsName)} AS (SELECT ${sql.identifier(sourceName)}.*, ROW_NUMBER() OVER (${ordinalOrder}) AS ${sql.identifier(ORDER_COLUMN)} FROM ${sql.identifier(sourceName)})`,
    );
    const payload = dialect.orderedRowsJsonArray(
      rowsName,
      item.outputNames,
      ORDER_COLUMN,
    );
    branches.push(sql`SELECT ${index} AS batch_index, ${payload} AS payload`);
  }

  const statement = asCompiledRowsSql(
    sql`WITH ${sql.join(ctes, sql`, `)} SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) AS typegraph_batch_envelope ORDER BY batch_index`,
  );
  const envelopes = await backend.execute<BatchEnvelopeRow>(statement);
  const payloads = new Map<number, readonly Record<string, unknown>[]>();
  for (const envelope of envelopes) {
    payloads.set(Number(envelope.batch_index), parsePayload(envelope.payload));
  }

  return items.map((item, index) =>
    item.mapRows(payloads.get(index) ?? []),
  ) as OneStatementBatchResults<Queries>;
}

function parsePayload(value: unknown): readonly Record<string, unknown>[] {
  const parsed: unknown =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) {
    throw new ConfigurationError(
      "One-statement batch returned a non-array JSON payload.",
      { operation: "batchOnce" },
    );
  }
  return parsed.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new ConfigurationError(
        "One-statement batch returned a non-object row.",
        { operation: "batchOnce" },
      );
    }
    return row as Record<string, unknown>;
  });
}
