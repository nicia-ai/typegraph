import { CompilerInvariantError } from "../../../errors";
import { type DriverSavepointScope } from "../../session-savepoint";
import {
  type AnyPgDatabase,
  createPostgresExecutionAdapter,
  getPinnedPostgresTransactionClient,
  isPostgresJsClient,
  type PostgresExecutionAdapterOptions,
} from "./postgres-execution";
import type {
  CompiledSqlQuery,
  ExecutableSql,
  PreparedSqlStatement,
  SqlExecutionAdapter,
} from "./types";

type ScopeExecution = Readonly<{
  db: AnyPgDatabase;
  operation: SqlExecutionAdapter;
  compiled: SqlExecutionAdapter;
}>;

/**
 * The execution surfaces of one open PostgreSQL transaction session.
 *
 * `operation` keeps ordinary transaction work on Drizzle's session; `compiled`
 * runs already-compiled statements on the pinned driver client.
 * `enterDriverScope` is present when the driver attributes a failed statement
 * to the scope whose handle issued it (postgres-js rethrows the first one when
 * its `begin` or `savepoint` scope ends). While such a scope is open, both
 * surfaces issue every statement through its handle: PostgreSQL places them
 * inside the savepoint whichever handle sent them, and routing them through it
 * keeps the driver's attribution in step with the server.
 *
 * Driver scopes on one session must nest strictly: the scope that exits is
 * always the innermost one still open. Two scopes that overlap without nesting
 * (both opened by concurrent work in one transaction, the outer one exiting
 * first) have no single innermost scope to route to, so the out-of-order exit
 * throws a `CompilerInvariantError`, and every later statement on the session
 * refuses with the same error instead of running on a scope that has ended.
 */
type PostgresTransactionSession = Readonly<{
  operation: SqlExecutionAdapter;
  compiled: SqlExecutionAdapter;
  enterDriverScope: DriverSavepointScope | undefined;
}>;

function bindScopeExecution(
  db: AnyPgDatabase,
  options: PostgresExecutionAdapterOptions | undefined,
): ScopeExecution {
  return {
    db,
    operation: createPostgresExecutionAdapter(db, options),
    compiled: createPostgresExecutionAdapter(db, {
      ...options,
      useTransactionClient: true,
    }),
  };
}

function requireScopeMember<T>(member: T | undefined, name: string): T {
  if (member !== undefined) return member;
  throw new CompilerInvariantError(
    `A PostgreSQL driver savepoint scope lost the ${name} execution member its transaction exposes.`,
    { member: name },
  );
}

/**
 * An adapter shaped like `outer` whose statements run on whichever scope
 * `current` names when they execute. A transaction handle exposes no atomic
 * batch, exclusive window or serialization classifier of its own, so these
 * four I/O members are its complete surface.
 */
function overlappingScopes(cause?: unknown): CompilerInvariantError {
  return new CompilerInvariantError(
    "Overlapping savepoint scopes in one PostgreSQL transaction: a driver savepoint scope ended while a scope opened after it was still open. Savepoint-protected writes on one transaction must not run concurrently.",
    { code: "OVERLAPPING_SAVEPOINT_SCOPES" },
    cause === undefined ? undefined : { cause },
  );
}

function routeThroughCurrentScope(
  outer: SqlExecutionAdapter,
  current: () => SqlExecutionAdapter,
): SqlExecutionAdapter {
  return {
    compile(query: ExecutableSql): CompiledSqlQuery {
      return current().compile(query);
    },
    execute<TRow>(query: ExecutableSql): Promise<readonly TRow[]> {
      return current().execute<TRow>(query);
    },
    ...(outer.executeCompiled === undefined ?
      {}
    : {
        executeCompiled<TRow>(
          compiledQuery: CompiledSqlQuery,
        ): Promise<readonly TRow[]> {
          return requireScopeMember(
            current().executeCompiled,
            "executeCompiled",
          )<TRow>(compiledQuery);
        },
      }),
    ...(outer.prepare === undefined ?
      {}
    : {
        prepare(sqlText: string): PreparedSqlStatement {
          return {
            execute<TRow>(
              params: readonly unknown[],
            ): Promise<readonly TRow[]> {
              return requireScopeMember(current().prepare, "prepare")(
                sqlText,
              ).execute<TRow>(params);
            },
          };
        },
      }),
  };
}

export function createPostgresTransactionSession(
  db: AnyPgDatabase,
  options: PostgresExecutionAdapterOptions | undefined,
): PostgresTransactionSession {
  const outer = bindScopeExecution(db, options);
  if (!isPostgresJsClient(getPinnedPostgresTransactionClient(db))) {
    return {
      operation: outer.operation,
      compiled: outer.compiled,
      enterDriverScope: undefined,
    };
  }

  const openScopes: ScopeExecution[] = [];
  const endedScopes = new WeakSet<ScopeExecution>();

  function current(): ScopeExecution {
    const innermost = openScopes.at(-1);
    if (innermost === undefined) return outer;
    if (endedScopes.has(innermost)) throw overlappingScopes();
    return innermost;
  }

  function leave(scope: ScopeExecution, cause?: unknown): void {
    endedScopes.add(scope);
    if (openScopes.at(-1) !== scope) {
      throw overlappingScopes(cause);
    }
    openScopes.pop();
  }

  // Drizzle's nested transaction on postgres-js is the driver's own
  // `savepoint()` scope, bound to a Drizzle session over its handle.
  async function enterDriverScope<T>(scope: () => Promise<T>): Promise<T> {
    return current().db.transaction(async (nested) => {
      const entered = bindScopeExecution(nested, options);
      openScopes.push(entered);
      let result: T;
      try {
        result = await scope();
      } catch (error) {
        leave(entered, error);
        throw error;
      }
      leave(entered);
      return result;
    });
  }

  return {
    operation: routeThroughCurrentScope(
      outer.operation,
      () => current().operation,
    ),
    compiled: routeThroughCurrentScope(
      outer.compiled,
      () => current().compiled,
    ),
    enterDriverScope,
  };
}
