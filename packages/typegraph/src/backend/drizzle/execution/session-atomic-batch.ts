import { CompilerInvariantError } from "../../../errors";
import type {
  AtomicSqlProgramAdapter,
  CompiledAtomicSqlStatement,
} from "../../capabilities/atomic-sql-program";
import type { SqlExecutionAdapter } from "./types";

type SessionAtomicBatchExecution = Readonly<{
  executeCompiled: NonNullable<SqlExecutionAdapter["executeCompiled"]>;
  runExclusive: NonNullable<SqlExecutionAdapter["runExclusive"]>;
}>;

const ATOMIC_PROGRAM_SAVEPOINT = "typegraph_atomic_program";
const BEGIN_ATOMIC_PROGRAM = {
  sql: `SAVEPOINT ${ATOMIC_PROGRAM_SAVEPOINT}`,
  params: [],
} as const;
const ROLLBACK_ATOMIC_PROGRAM = {
  sql: `ROLLBACK TO SAVEPOINT ${ATOMIC_PROGRAM_SAVEPOINT}`,
  params: [],
} as const;
const RELEASE_ATOMIC_PROGRAM = {
  sql: `RELEASE SAVEPOINT ${ATOMIC_PROGRAM_SAVEPOINT}`,
  params: [],
} as const;

/**
 * Adapts one already-open, exclusively reservable transaction session to the
 * closed atomic-program transport.
 *
 * `runExclusive` is load-bearing: queueing each statement independently would
 * let unrelated work on the same transaction interleave with a program. The
 * returned batch owns one queue slot for the whole sequence, while the outer
 * transaction owns commit and rollback. A savepoint keeps deliberate
 * constraint refusals from aborting that outer transaction before Store
 * diagnostics can translate them to typed errors.
 */
export function createSessionAtomicBatchAdapter(
  execution: SessionAtomicBatchExecution,
): AtomicSqlProgramAdapter {
  const { executeCompiled, runExclusive } = execution;

  return {
    async executeAtomicBatch<TRow>(
      statements: readonly CompiledAtomicSqlStatement[],
    ) {
      if (statements.length === 0) return [];
      return runExclusive(async () => {
        await executeCompiled(BEGIN_ATOMIC_PROGRAM);
        const results: (readonly TRow[])[] = [];
        try {
          for (const statement of statements) {
            results.push(await executeCompiled<TRow>(statement));
          }
          await executeCompiled(RELEASE_ATOMIC_PROGRAM);
          return results;
        } catch (error) {
          try {
            // PostgreSQL protocol- and SQL-level prepared statements survive
            // ROLLBACK TO SAVEPOINT (verified on PostgreSQL 18), so recovery
            // restores data state without invalidating the session's cache.
            await executeCompiled(ROLLBACK_ATOMIC_PROGRAM);
            await executeCompiled(RELEASE_ATOMIC_PROGRAM);
          } catch (recoveryError) {
            const failures = new AggregateError(
              [error, recoveryError],
              "The atomic program failed and its savepoint recovery also failed.",
              { cause: error },
            );
            throw new CompilerInvariantError(
              "An atomic transaction session could not restore its savepoint after a failed program.",
              {},
              { cause: failures },
            );
          }
          throw error;
        }
      });
    },
  };
}
