import {
  deriveBackend,
  projectBackendWithout,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../../src/backend/types";
import { type CompiledRowsSql } from "../../../src/query/sql-intent";

export type StatementCounter = Readonly<{
  backend: GraphBackend;
  count: () => number;
  reset: () => void;
}>;

/**
 * A derived backend that counts every statement it runs through `execute` or
 * `executeRaw`. With `withoutRawExecution`, the derived backend has no
 * `executeRaw`, so a prepared query takes its AST-substitution fallback
 * rather than the packed raw-SQL path.
 */
export function createStatementCounter(
  backend: GraphBackend,
  options: Readonly<{ withoutRawExecution?: boolean }> = {},
): StatementCounter {
  const projected: GraphBackend =
    options.withoutRawExecution === true ?
      projectBackendWithout(projectGraphBackend(backend), ["executeRaw"])
    : projectGraphBackend(backend);
  const executeRaw = projected.executeRaw;
  let statementCount = 0;

  const countingBackend = deriveBackend(projected, {
    execute: <T>(query: CompiledRowsSql): Promise<readonly T[]> => {
      statementCount += 1;
      return projected.execute<T>(query);
    },
    ...(executeRaw === undefined ?
      {}
    : {
        executeRaw: <T>(
          sqlText: string,
          params: readonly unknown[],
        ): Promise<readonly T[]> => {
          statementCount += 1;
          return executeRaw<T>(sqlText, params);
        },
      }),
  });

  return {
    backend: countingBackend,
    count: () => statementCount,
    reset: () => {
      statementCount = 0;
    },
  };
}

/**
 * A derived backend that counts every statement sent inside a transaction it
 * opens, through the transaction's `execute` or `executeRaw` — the target a
 * `store.batch()` runs its items on — and none sent outside one.
 */
export function createTransactionStatementCounter(
  backend: GraphBackend,
): StatementCounter {
  const projected = projectGraphBackend(backend);
  let statementCount = 0;

  function counting(transaction: TransactionBackend): TransactionBackend {
    const executeRaw = transaction.executeRaw;
    return deriveBackend(transaction, {
      execute: <T>(query: CompiledRowsSql): Promise<readonly T[]> => {
        statementCount += 1;
        return transaction.execute<T>(query);
      },
      ...(executeRaw === undefined ?
        {}
      : {
          executeRaw: <T>(
            sqlText: string,
            params: readonly unknown[],
          ): Promise<readonly T[]> => {
            statementCount += 1;
            return executeRaw<T>(sqlText, params);
          },
        }),
    });
  }

  return {
    backend: deriveBackend(projected, {
      transaction: (fn, options) =>
        projected.transaction(
          (transaction) => fn(counting(transaction)),
          options,
        ),
    }),
    count: () => statementCount,
    reset: () => {
      statementCount = 0;
    },
  };
}
