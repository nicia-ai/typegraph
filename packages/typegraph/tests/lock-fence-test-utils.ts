/**
 * Shared harness for the write-fence lock-site test files (T15/T16/T17): real
 * backends (PGlite for PostgreSQL, better-sqlite3 for SQLite) with every
 * statement the underlying driver actually runs captured at TWO levels,
 * because no single one sees everything:
 *
 * - drizzle's `logger` option sees a TRANSACTION-scoped statement (a lock
 *   site reached inside `schemaWriteTransaction`'s callback — J5, J6):
 *   `src/backend/drizzle/postgres.ts`'s own comment on the tx-scoped
 *   execution adapter states a Drizzle transaction carries no `$client`, so
 *   it "routes through Drizzle's session", which the logger observes.
 * - a driver-level patch (`client.query` for PGlite, `client.prepare` for
 *   better-sqlite3) sees a TOP-LEVEL statement (J1-J4, J7/J8's non-tx reads):
 *   `postgres-execution.ts` / `sqlite-execution.ts` both bypass Drizzle's
 *   session on that path on purpose ("Bypasses Drizzle's session overhead"),
 *   which is exactly what makes the logger blind to it.
 *
 * Neither mechanism double-counts the other's statements, since each fires
 * on a disjoint execution path.
 *
 * Also exports a capabilities-overlay Proxy for the one posture a
 * first-party factory cannot construct directly: an undeclared
 * (`capabilities.writeFence` absent) target.
 */
import {
  type Extensions,
  PGlite,
  type QueryOptions,
} from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import {
  drizzle as drizzlePglite,
  type PgliteDatabase,
} from "drizzle-orm/pglite";

import {
  generatePostgresMigrationSQL,
  generateSqliteMigrationSQL,
} from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createPostgresBackend } from "../src/backend/postgres";
import {
  type BackendCapabilities,
  type GraphBackend,
} from "../src/backend/types";

type LoggedStatement = Readonly<{
  query: string;
  params: readonly unknown[];
}>;

export type LoggedBackend = Readonly<{
  backend: GraphBackend;
  statements: LoggedStatement[];
  reset: () => void;
  close: () => Promise<void>;
  /** Runs raw DDL/DML against the underlying driver, bypassing the backend. */
  execRaw: (statement: string) => Promise<void>;
}>;

export type LoggedPgliteClient = Readonly<{
  client: PGlite;
  db: PgliteDatabase;
  statements: LoggedStatement[];
  close: () => Promise<void>;
}>;

/**
 * The one PGlite-client-plus-capture primitive: a real, in-process
 * PostgreSQL-dialect connection (no Docker) with every statement the client
 * actually sends captured at both layers {@link createLoggedPostgresBackend}'s
 * own doc comment describes — a driver-level patch of `client.query` plus
 * drizzle's own `logger`, since a lock site reached inside a transaction
 * callback bypasses the top-level one.
 *
 * `extensions` and `ddl` are the caller's own choice so a vector-enabled
 * backend fixture and a vector-disabled profile fixture can each seed the
 * schema that matches their own declared capability, from this one capture
 * primitive, rather than two independent re-implementations drifting apart.
 */
export async function createLoggedPgliteClient(
  options: Readonly<{ extensions?: Extensions; ddl: string }>,
): Promise<LoggedPgliteClient> {
  const client = await PGlite.create(
    options.extensions === undefined ? {} : { extensions: options.extensions },
  );
  await client.exec(options.ddl);
  const statements: LoggedStatement[] = [];
  const originalQuery = client.query.bind(client);
  client.query = (<T>(
    query: string,
    params?: unknown[],
    queryOptions?: QueryOptions,
  ) => {
    statements.push({ query, params: params ?? [] });
    return originalQuery<T>(query, params, queryOptions);
  }) as typeof client.query;
  const db = drizzlePglite(client, {
    logger: {
      logQuery(query: string, params: unknown[]): void {
        statements.push({ query, params });
      },
    },
  });
  return { client, db, statements, close: () => client.close() };
}

/**
 * A real PostgreSQL backend (PGlite, in-process, no Docker), built from
 * {@link createLoggedPgliteClient} with the pgvector extension installed and
 * the complete bundled-factory migration SQL applied. `capabilities` — when
 * supplied — is passed as the factory's own override option, so it flows
 * into every closure the factory builds at construction time (the
 * contribution materializer's `fenceTarget` included), not just the
 * returned backend's own property.
 */
export async function createLoggedPostgresBackend(
  capabilities?: Partial<BackendCapabilities>,
): Promise<LoggedBackend> {
  const { client, db, statements, close } = await createLoggedPgliteClient({
    extensions: { vector: pgvectorExtension },
    ddl: generatePostgresMigrationSQL(),
  });
  const backend = createPostgresBackend(db, {
    vector: false,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  return {
    backend,
    statements,
    reset: () => statements.splice(0),
    close,
    execRaw: async (statement: string) => {
      await client.exec(statement);
    },
  };
}

/**
 * A real SQLite backend (better-sqlite3, in-memory). Every prepared
 * statement's `.all`/`.run`/`.get` invocation is captured by patching
 * `client.prepare` — the layer `backend.execute`/`executeStatement` calls
 * into on the synchronous fast path — for the same reason
 * {@link createLoggedPostgresBackend} patches `client.query` rather than
 * relying on drizzle's `logger`.
 */
export function createLoggedSqliteBackend(
  capabilities?: Partial<BackendCapabilities>,
): LoggedBackend {
  const client = new Database(":memory:");
  client.exec(generateSqliteMigrationSQL());
  const statements: LoggedStatement[] = [];
  const originalPrepare = client.prepare.bind(client);
  client.prepare = ((sqlText: string) => {
    const statement = originalPrepare(sqlText);
    const originalAll = statement.all.bind(statement);
    const originalRun = statement.run.bind(statement);
    const originalGet = statement.get.bind(statement);
    statement.all = (...params: unknown[]) => {
      statements.push({ query: sqlText, params });
      return originalAll(...params);
    };
    statement.run = (...params: unknown[]) => {
      statements.push({ query: sqlText, params });
      return originalRun(...params);
    };
    statement.get = (...params: unknown[]) => {
      statements.push({ query: sqlText, params });
      return originalGet(...params);
    };
    return statement;
  }) as typeof client.prepare;
  const backend = createSqliteBackend(drizzleBetterSqlite3(client), {
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  return {
    backend,
    statements,
    reset: () => statements.splice(0),
    close: () => {
      client.close();
      return Promise.resolve();
    },
    execRaw: (statement: string) => {
      client.exec(statement);
      return Promise.resolve();
    },
  };
}

/**
 * A capabilities-overlay `Proxy`: forwards every member of `base` unchanged
 * except `capabilities`.
 *
 * A lock site nested inside `schemaWriteTransaction`'s or `transaction`'s
 * callback (J5, J6, and any managed write reached through a plain
 * `backend.transaction(...)`) receives a TRANSACTION-SCOPED object the
 * factory builds from its OWN closed-over `capabilities` constant, not from
 * whatever property this wrapper exposes — so both openers are intercepted
 * too, recursively overlaying the `tx` argument the real implementation
 * hands to its callback. A lock site reached through a per-construction
 * closure outside either opener entirely (J7/J8's contribution materializer
 * `fenceTarget`) is NOT reachable through this overlay at all — those two
 * sites test the "undeclared non-factory" posture through
 * `createContributionMaterializer` directly instead (see
 * `tests/lock-fence-plan.test.ts`).
 *
 * Deliberately NOT built through `deriveBackend`/`projectBackend`: those
 * carry the first-party factory mark (`carryFirstPartyFactoryMark`), and this
 * overlay's whole purpose is to model postures the mark must NOT survive
 * into — a declared override (where the mark is irrelevant, since the
 * declared arm always wins) and the undeclared-non-factory posture (where
 * carrying the mark would silently derive from dialect instead of resolving
 * `unfenced`, which is exactly the defect class M-5 closes).
 */
export function overlayCapabilities<T extends object>(
  base: T,
  capabilities: BackendCapabilities,
): T {
  return new Proxy(base, {
    get(targetObject, property) {
      if (property === "capabilities") return capabilities;
      const value: unknown = Reflect.get(targetObject, property, targetObject);
      if (
        property === "schemaWriteTransaction" &&
        typeof value === "function"
      ) {
        const real = value as (
          graphId: string,
          fn: (tx: object) => Promise<unknown>,
        ) => Promise<unknown>;
        return (graphId: string, fn: (tx: object) => Promise<unknown>) =>
          real(graphId, (tx: object) =>
            fn(overlayCapabilities(tx, capabilities)),
          );
      }
      if (property === "transaction" && typeof value === "function") {
        const real = value as (
          fn: (tx: object) => Promise<unknown>,
          options?: unknown,
        ) => Promise<unknown>;
        return (fn: (tx: object) => Promise<unknown>, options?: unknown) =>
          real(
            (tx: object) => fn(overlayCapabilities(tx, capabilities)),
            options,
          );
      }
      return value;
    },
  });
}

/**
 * The declared-advisory-only posture: an advisory-lock mechanism with no
 * drain, so every keyed site (J1, J2, J3, J5, J7) succeeds while every drain
 * site (J4, J6, J8, J18) refuses naming `drain: "none"`.
 */
export const ADVISORY_ONLY_CAPABILITIES: NonNullable<
  BackendCapabilities["writeFence"]
> = Object.freeze({
  mechanism: "advisory",
  drain: "none",
});

/**
 * Overlays `logged`'s backend so `capabilities.writeFence` is absent.
 * `writeFence` has no mechanism that means "no fence" the way the deleted
 * legacy `pessimisticLocks` all-false shape once did, so this — an
 * undeclared, non-first-party target — is the only way left to reach an
 * `unfenced` plan on an otherwise-real backend.
 */
export function unfencedLoggedBackend(logged: LoggedBackend): LoggedBackend {
  const { writeFence: _writeFence, ...undeclared } =
    logged.backend.capabilities;
  return {
    ...logged,
    backend: overlayCapabilities(logged.backend, undeclared),
  };
}
