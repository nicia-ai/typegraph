import { backendDerivationRoot } from "../../backend/derive-backend";
import type { GraphBackend, TransactionBackend } from "../../backend/types";
import { ConfigurationError } from "../../errors";
import { getDialect } from "../dialect";
import { compileOrderTerm } from "../order";
import { sql, type SqlFragment } from "../sql-fragment";
import { asCompiledRowsSql } from "../sql-intent";
import { groupOneStatementBatchItems } from "./one-statement-sharing";
import type {
  EmbeddableOneStatementRead,
  OneStatementBatchableQuery,
  OneStatementBatchResults,
} from "./types";

/** Execution choices for a one-statement read batch. */
export type BatchOnceOptions = Readonly<{
  /** Share hydration among compatible subgraphs. Recommended for overlapping, payload-heavy roots. Defaults to false. */
  shareSubgraphs?: boolean;
}>;

const ORDER_COLUMN = "typegraphbatchordinal";
const ORDER_KEY_PREFIX = "typegraphbatchorder";

/** SQLite's default compound-select ceiling; kept as the portable request cap. */
const MAX_ONE_STATEMENT_BATCH_READS = 500;

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
  const terms = orderBy.map((order) => {
    const column = sql`${row}.${sql.identifier(order.column)}`;
    return compileOrderTerm(column, order.direction, order.nulls);
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
  graphId: string,
  queries: Queries,
  options: BatchOnceOptions = {},
): Promise<OneStatementBatchResults<Queries>> {
  if (
    options.shareSubgraphs !== undefined &&
    typeof options.shareSubgraphs !== "boolean"
  )
    throw new ConfigurationError("batchOnce shareSubgraphs must be a boolean.");
  if (queries.length === 0) return [] as OneStatementBatchResults<Queries>;
  if (queries.length > MAX_ONE_STATEMENT_BATCH_READS) {
    throw new ConfigurationError(
      `store.batchOnce() accepts at most ${MAX_ONE_STATEMENT_BATCH_READS} reads in one statement.`,
      {
        operation: "batchOnce",
        reads: queries.length,
        maxReads: MAX_ONE_STATEMENT_BATCH_READS,
      },
    );
  }
  if (!backend.capabilities.windowFunctions) {
    throw new ConfigurationError(
      "store.batchOnce() requires backend window-function support.",
      {
        operation: "batchOnce",
        capability: "windowFunctions",
        backend: backend.dialect,
      },
    );
  }
  const dialect = getDialect(backend.dialect);
  const executionTarget = backendDerivationRoot(backend);
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
    const item = compile.call(query);
    if (item.provenance.graphId !== graphId) {
      throw new ConfigurationError(
        "store.batchOnce() cannot combine reads from different graphs.",
        {
          operation: "batchOnce",
          expectedGraphId: graphId,
          receivedGraphId: item.provenance.graphId,
        },
      );
    }
    if (item.provenance.executionTarget !== executionTarget) {
      throw new ConfigurationError(
        "store.batchOnce() cannot rebind a read to a different database or transaction target.",
        { operation: "batchOnce", graphId },
        {
          suggestion:
            "Build fluent queries from the same Store or transaction context whose batchOnce() method executes them.",
        },
      );
    }
    return item;
  });
  const ctes: SqlFragment[] = [];
  const branches: SqlFragment[] = [];

  for (const item of items) {
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
  }
  const groups = groupOneStatementBatchItems(
    items,
    options.shareSubgraphs === true,
  );
  for (const [index, { item }] of groups.entries()) {
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
  const bindCount = statement.chunks.filter(
    (chunk) => chunk.kind === "parameter",
  ).length;
  const bindBudget = backend.capabilities.maxBindParameters;
  if (bindBudget !== undefined && bindCount > bindBudget) {
    throw new ConfigurationError(
      "store.batchOnce() cannot fit the requested reads in one statement's bind-parameter budget.",
      { operation: "batchOnce", bindCount, bindBudget },
      {
        suggestion:
          "Split the reads into explicit batchOnce() calls or reduce their filters. batchOnce() never chunks or falls back to sequential execution.",
      },
    );
  }
  const envelopes = await backend.execute<BatchEnvelopeRow>(statement);
  const payloads = new Map<number, readonly Record<string, unknown>[]>();
  for (const envelope of envelopes) {
    payloads.set(Number(envelope.batch_index), parsePayload(envelope.payload));
  }

  const results: unknown[] = Array.from({ length: items.length });
  for (const [index, group] of groups.entries()) {
    const values = group.item.mapRows(payloads.get(index) ?? []);
    for (const [offset, requestIndex] of group.indices.entries())
      results[requestIndex] = values[offset];
  }
  return results as OneStatementBatchResults<Queries>;
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
