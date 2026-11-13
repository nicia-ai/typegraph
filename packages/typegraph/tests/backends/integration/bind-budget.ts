/**
 * A backend that declares a small bind-parameter budget and refuses any
 * row-returning statement that exceeds it — what an engine with a low limit
 * (Cloudflare Durable Object SQLite accepts 100) does to an unsliced batch
 * statement, reproduced on every lane.
 *
 * Only `execute` is policed: the batch inserts are sized by the engine
 * profile the backend was built with, while the statements a store composes
 * itself read the budget off `capabilities` at the moment they run.
 */
import { type GraphBackend } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import {
  type TransactionBackend,
  type TransactionOptions,
} from "../../../src/backend/types";
import { countSqlParameters } from "../../../src/query/sql-fragment";
import { type CompiledRowsSql } from "../../../src/query/sql-intent";

function assertWithinBindBudget(
  statement: CompiledRowsSql,
  maxBindParameters: number,
): void {
  const bound = countSqlParameters(statement);
  if (bound > maxBindParameters) {
    throw new Error(
      `Statement bound ${String(bound)} parameters; the budget is ${String(maxBindParameters)}.`,
    );
  }
}

export function withBindBudget(
  backend: GraphBackend,
  maxBindParameters: number,
): GraphBackend {
  return deriveBackend(backend, {
    capabilities: { ...backend.capabilities, maxBindParameters },
    execute<Row>(statement: CompiledRowsSql): Promise<readonly Row[]> {
      assertWithinBindBudget(statement, maxBindParameters);
      return backend.execute<Row>(statement);
    },
    transaction<T>(
      fn: (tx: TransactionBackend) => Promise<T>,
      options?: TransactionOptions,
    ): Promise<T> {
      return backend.transaction(
        (tx) =>
          fn(
            deriveBackend(tx, {
              capabilities: { ...tx.capabilities, maxBindParameters },
              execute<Row>(
                statement: CompiledRowsSql,
              ): Promise<readonly Row[]> {
                assertWithinBindBudget(statement, maxBindParameters);
                return tx.execute<Row>(statement);
              },
            }),
          ),
        options,
      );
    },
  });
}
