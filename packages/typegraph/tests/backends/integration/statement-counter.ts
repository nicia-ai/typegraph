import {
  deriveBackend,
  projectBackendWithout,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
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
