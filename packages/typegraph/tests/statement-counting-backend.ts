/**
 * The one owner of "count/classify every statement issued inside a
 * traversal's transaction". Moved out of `algorithms.test.ts` (not copied)
 * so T7 and T8's extraction-statement classification share this home with
 * the round-trip budget tests that already depended on it — a second
 * `{ ...tx }` counting helper would push
 * `tests/backend-derivation-population.test.ts`'s `TRANSACTION_SCOPED_BASELINE`
 * from 35 to 36 and fail that ratchet.
 */
import { deriveBackend } from "../src/backend/derive-backend";
import type {
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../src/backend/types";
import type {
  CompiledRowsSql,
  CompiledTemporaryStatementSql,
} from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";

/**
 * Counts every statement (row-returning and temporary) issued inside a
 * traversal's transaction, so a reintroduced per-round COUNT or meeting
 * probe fails the round-trip budget tests instead of silently doubling
 * round-trips.
 */
export function createStatementCountingBackend(
  backend: GraphBackend,
  collected: string[],
): GraphBackend {
  return deriveBackend(backend, {
    transaction<T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      return backend.transaction(async (tx) => {
        const observedTransaction: TransactionBackend = {
          ...tx,
          execute<Result>(query: CompiledRowsSql): Promise<readonly Result[]> {
            collected.push(requireDefined(backend.compileSql)(query).sql);
            return tx.execute<Result>(query);
          },
          async executeTemporaryStatement(
            query: CompiledTemporaryStatementSql,
          ): Promise<void> {
            collected.push(requireDefined(backend.compileSql)(query).sql);
            await requireDefined(tx.executeTemporaryStatement)(query);
          },
        };
        return fn(observedTransaction);
      }, options);
    },
  });
}

/** Weighted-shortest-path extraction statements captured by name. */
export type WeightedExtractionStatementCounts = Readonly<{
  /** Statements the recursive-CTE extractor issues. */
  recursive: number;
  /** Statements the predecessor-walk fallback extractor issues. */
  walk: number;
}>;

/**
 * Recognizes the recursive-CTE extractor's statement: it mentions the
 * working table's identifier prefix and opens with the recursive-CTE
 * keyword pair.
 */
function isRecursiveExtractionStatement(statement: string): boolean {
  return (
    statement.includes("typegraph_iterative_") &&
    statement.trimStart().startsWith("WITH RECURSIVE")
  );
}

/**
 * Recognizes a predecessor-walk fallback statement: it mentions the working
 * table's identifier prefix, is a plain `SELECT` (not the recursive-CTE
 * shape above), and reads the predecessor columns the walk alone needs —
 * excluding the seed/relax `INSERT … RETURNING`, `CREATE INDEX`,
 * `DROP TABLE`, and the `hasVisibleNode` node read, none of which read
 * `predecessor_id`.
 */
function isWalkExtractionStatement(statement: string): boolean {
  return (
    statement.includes("typegraph_iterative_") &&
    statement.trimStart().startsWith("SELECT") &&
    statement.includes("predecessor_id")
  );
}

/**
 * Classifies captured statement text into the two weighted-shortest-path
 * extraction shapes; everything else (seed/relax `INSERT … RETURNING`,
 * `CREATE INDEX`, `DROP TABLE`, the `hasVisibleNode` node read) is ignored.
 */
export function countWeightedExtractionStatements(
  collected: readonly string[],
): WeightedExtractionStatementCounts {
  return {
    recursive: collected.filter((statement) =>
      isRecursiveExtractionStatement(statement),
    ).length,
    walk: collected.filter((statement) => isWalkExtractionStatement(statement))
      .length,
  };
}
