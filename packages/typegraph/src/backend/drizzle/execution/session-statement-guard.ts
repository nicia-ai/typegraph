/**
 * The statement seam of one native transaction session.
 *
 * Every statement a transaction-scoped first-party backend issues goes
 * through the execution adapter its dialect binds to the native transaction
 * (`createTransactionBackend` in `../sqlite.ts` and `../postgres.ts`). This
 * wraps that adapter so each statement-issuing member first asks
 * {@link admitSessionStatement} whether it may run, at the moment it would
 * be sent and in the async context of the call that sends it. A refusal is
 * returned as a rejected promise and the wrapped member is never called, so
 * nothing reaches the driver.
 *
 * Every function member of the adapter is classified below as either issuing
 * statements or not; an unclassified member is a construction-time error, so
 * a new execution member cannot silently bypass the seam.
 */
import { CompilerInvariantError } from "../../../errors";
import { admitSessionStatement } from "../../savepoint-scope-exclusion";
import type {
  CompiledSqlQuery,
  ExecutableSql,
  PreparedSqlStatement,
  SqlExecutionAdapter,
} from "./types";

/** Members that compile, configure or close, and send nothing themselves. */
const NON_STATEMENT_MEMBERS: ReadonlySet<string> = new Set([
  "compile",
  "clearStatementCache",
  "serializationFailure",
  "drainAndClose",
]);

type MemberFunction = (...args: readonly unknown[]) => unknown;

/** How each statement-issuing member names its statement for the error. */
type StatementDescriber = (
  adapter: SqlExecutionAdapter,
  args: readonly unknown[],
) => string;

function describeSqlText(sqlText: string | undefined): string {
  const keyword = /^\s*([a-z]+)/iu.exec(sqlText ?? "")?.[1];
  return keyword === undefined ?
      "A SQL statement"
    : `A ${keyword.toUpperCase()} statement`;
}

function describeExecutable(
  adapter: SqlExecutionAdapter,
  args: readonly unknown[],
): string {
  try {
    return describeSqlText(adapter.compile(args[0] as ExecutableSql).sql);
  } catch {
    return describeSqlText(undefined);
  }
}

function describeCompiled(
  _adapter: SqlExecutionAdapter,
  args: readonly unknown[],
): string {
  return describeSqlText((args[0] as CompiledSqlQuery).sql);
}

function describeText(
  _adapter: SqlExecutionAdapter,
  args: readonly unknown[],
): string {
  return describeSqlText(args[0] as string);
}

const STATEMENT_MEMBERS: Readonly<Record<string, StatementDescriber>> = {
  execute: describeExecutable,
  executeRun: describeExecutable,
  executeCompiled: describeCompiled,
  executeCompiledRun: describeCompiled,
  executeAtomicBatch: (_adapter, args) =>
    describeSqlText((args[0] as readonly CompiledSqlQuery[])[0]?.sql),
  executePreparedRunBatch: describeText,
  runExclusive: () => "An exclusive statement group",
};

/** The refusal of a statement on `session`, as a rejection, or nothing. */
function refusalOf(
  session: object,
  describe: () => string,
): Promise<never> | undefined {
  try {
    admitSessionStatement(session, describe);
    return undefined;
  } catch (error) {
    if (error instanceof Error) return Promise.reject(error);
    throw error;
  }
}

function guardPrepare(
  prepare: NonNullable<SqlExecutionAdapter["prepare"]>,
  session: object,
): SqlExecutionAdapter["prepare"] {
  return (sqlText: string): PreparedSqlStatement => {
    // Preparing sends nothing; the prepared statement is judged when it
    // executes, which may be long after it was prepared.
    const statement = prepare(sqlText);
    return {
      execute<TRow>(params: readonly unknown[]): Promise<readonly TRow[]> {
        return (
          refusalOf(session, () => describeSqlText(sqlText)) ??
          statement.execute<TRow>(params)
        );
      },
    };
  };
}

/**
 * `adapter` with every statement it would send on the native transaction
 * `session` first admitted by the savepoint-scope rule.
 */
export function guardSessionStatements<A extends SqlExecutionAdapter>(
  adapter: A,
  session: object,
): A {
  const guarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(adapter)) {
    if (typeof value !== "function" || NON_STATEMENT_MEMBERS.has(key)) {
      guarded[key] = value;
      continue;
    }
    if (key === "prepare") {
      guarded[key] = guardPrepare(
        value as NonNullable<SqlExecutionAdapter["prepare"]>,
        session,
      );
      continue;
    }
    const describe = STATEMENT_MEMBERS[key];
    if (describe === undefined) {
      throw new CompilerInvariantError(
        `Execution adapter member "${key}" is not classified as issuing statements or not, so the savepoint-scope guard cannot cover it.`,
        { member: key },
      );
    }
    const member = value as MemberFunction;
    guarded[key] = (...args: readonly unknown[]): unknown => {
      return (
        refusalOf(session, () => describe(adapter, args)) ??
        Reflect.apply(member, adapter, args)
      );
    };
  }
  return guarded as A;
}
