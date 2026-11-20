import { CompilerInvariantError } from "../../../errors";
import type {
  AtomicSqlBatchExecutor,
  CompiledAtomicSqlStatement,
} from "../../capabilities/atomic-sql-program";
import {
  type DriverSavepointScope,
  runSessionSavepoint,
  SavepointRecoveryFailure,
} from "../../session-savepoint";
import type { SqlExecutionAdapter } from "./types";

type SessionAtomicBatchExecution = Readonly<{
  executeCompiled: NonNullable<SqlExecutionAdapter["executeCompiled"]>;
  runExclusive: NonNullable<SqlExecutionAdapter["runExclusive"]>;
  enterDriverScope?: DriverSavepointScope | undefined;
}>;

type SessionAtomicBatchAdapter = Readonly<{
  executeAtomicBatch: AtomicSqlBatchExecutor;
}>;

const ATOMIC_PROGRAM_SAVEPOINT = "typegraph_atomic_program";

/**
 * Adapts one already-open, exclusively reservable transaction session to the
 * closed atomic-program transport.
 *
 * `runExclusive` is load-bearing: queueing each statement independently would
 * let unrelated work on the same transaction interleave with a program. The
 * returned batch owns one queue slot for the whole savepoint scope, while the
 * outer transaction owns commit and rollback. A savepoint keeps deliberate
 * constraint refusals from aborting that outer transaction before Store
 * diagnostics can translate them to typed errors.
 */
export function createSessionAtomicBatchAdapter(
  execution: SessionAtomicBatchExecution,
): SessionAtomicBatchAdapter {
  const { executeCompiled, runExclusive, enterDriverScope } = execution;
  const port = {
    executeControl: (statement: string) =>
      executeCompiled({ sql: statement, params: [] }),
    enterDriverScope,
  };

  return {
    async executeAtomicBatch<TRow>(
      statements: readonly CompiledAtomicSqlStatement[],
    ) {
      if (statements.length === 0) return [];
      return runExclusive(async () => {
        try {
          // PostgreSQL protocol- and SQL-level prepared statements survive
          // ROLLBACK TO SAVEPOINT (verified on PostgreSQL 18), so recovery
          // restores data state without invalidating the session's cache.
          return await runSessionSavepoint(
            port,
            ATOMIC_PROGRAM_SAVEPOINT,
            async () => {
              const results: (readonly TRow[])[] = [];
              for (const statement of statements) {
                results.push(await executeCompiled<TRow>(statement));
              }
              return { action: "release", value: results };
            },
          );
        } catch (error) {
          if (error instanceof SavepointRecoveryFailure) {
            throw new CompilerInvariantError(
              "An atomic transaction session could not restore its savepoint after a failed program.",
              {},
              { cause: error },
            );
          }
          throw error;
        }
      });
    },
  };
}
