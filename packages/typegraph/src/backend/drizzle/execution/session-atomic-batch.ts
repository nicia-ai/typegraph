import { CompilerInvariantError } from "../../../errors";
import type {
  AtomicSqlProgramAdapter,
  CompiledAtomicSqlStatement,
} from "../../capabilities/atomic-sql-program";
import type { SqlExecutionAdapter } from "./types";

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
  adapter: SqlExecutionAdapter,
): AtomicSqlProgramAdapter | undefined {
  const runExclusive = adapter.runExclusive;
  if (runExclusive === undefined || adapter.executeCompiled === undefined) {
    return;
  }

  return {
    async executeAtomicBatch<TRow>(
      statements: readonly CompiledAtomicSqlStatement[],
    ) {
      return runExclusive(async (connection) => {
        const executeCompiled = connection.executeCompiled;
        if (executeCompiled === undefined) {
          throw new CompilerInvariantError(
            "An atomic transaction session lost compiled execution inside its exclusive boundary.",
          );
        }
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
            await executeCompiled(ROLLBACK_ATOMIC_PROGRAM);
            await executeCompiled(RELEASE_ATOMIC_PROGRAM);
          } catch (recoveryError) {
            throw new CompilerInvariantError(
              "An atomic transaction session could not restore its savepoint after a failed program.",
              {},
              { cause: recoveryError },
            );
          }
          throw error;
        }
      });
    },
  };
}
