/**
 * One new database connection per driver, with several TypeGraph backends
 * built over it, each over its own physical table names, and every statement
 * the connection runs recorded at the driver.
 *
 * The cases that drive two Stores through one native transaction need both
 * Stores' tables to live where that transaction runs, and need to see every
 * statement either Store issues on it — the schema fences and graph locks
 * included, which a backend-member wrapper does not see when a fused
 * statement carries them. The recording therefore sits below every backend:
 * better-sqlite3's `prepare`/`exec`, libSQL's client and transaction objects
 * and PGlite's `query`/protocol seam (shared with the write-shape goldens,
 * `write-shape-recorder.ts`), node-postgres's `Client.query`, and
 * postgres-js's `debug` callback.
 *
 * `backends[0]` is the root a case opens its native transaction on; every
 * backend in `backends` reaches the same database, so any of them can adopt
 * that transaction's handle.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";

import {
  createPostgresTables,
  type PostgresTableNames,
} from "../../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../../src/backend/drizzle/schema/sqlite";
import { createPostgresBackend } from "../../src/backend/postgres";
import { createSqliteBackend } from "../../src/backend/sqlite";
import { createLibsqlBackend } from "../../src/backend/sqlite/libsql";
import type { AdapterBackend } from "../../src/backend/types";
import { requireDefined } from "../../src/utils/presence";
import {
  type EventSink,
  recordLibsqlClient,
  recordPgliteDriver,
  recordSqliteDriver,
  type WriteShapeEvent,
} from "./write-shape-recorder";

/** A complete physical table-name set for one backend over the connection. */
export type TracedTableNames = PostgresTableNames;

export type TracedConnection = Readonly<{
  /** One backend per table-name set, in the order they were asked for. */
  backends: readonly AdapterBackend<unknown>[];
  /** Every statement the connection ran since the last {@link reset}. */
  statements: () => readonly TracedStatement[];
  reset: () => void;
  close: () => Promise<void>;
}>;

/** One statement as the driver was asked to run it. */
export type TracedStatement = Readonly<{
  text: string;
  params: readonly unknown[];
}>;

/** A whole table-name set whose every table name starts with `prefix`. */
export function prefixedTableNames(prefix: string): TracedTableNames {
  return {
    nodes: `${prefix}_nodes`,
    edges: `${prefix}_edges`,
    recordedNodes: `${prefix}_recorded_nodes`,
    recordedEdges: `${prefix}_recorded_edges`,
    recordedClock: `${prefix}_recorded_clock`,
    recordedAnchors: `${prefix}_recorded_anchors`,
    storeOperations: `${prefix}_store_operations`,
    revisionOrigins: `${prefix}_revision_origins`,
    revisionChanges: `${prefix}_revision_changes`,
    identityAssertions: `${prefix}_identity_assertions`,
    recordedIdentityAssertions: `${prefix}_recorded_identity_assertions`,
    identityClosure: `${prefix}_identity_closure`,
    identitySeparation: `${prefix}_identity_separation`,
    identityTransitions: `${prefix}_identity_transitions`,
    identityTransitionRetention: `${prefix}_identity_transition_retention`,
    uniques: `${prefix}_uniques`,
    edgeClaims: `${prefix}_edge_claims`,
    baseSchemaVersions: `${prefix}_base_schema_versions`,
    schemaVersions: `${prefix}_schema_versions`,
    graphTemplates: `${prefix}_graph_templates`,
    fulltext: `${prefix}_fulltext`,
    indexMaterializations: `${prefix}_index_materializations`,
    contributionMaterializations: `${prefix}_contribution_materializations`,
    kindRemovals: `${prefix}_kind_removals`,
    reconciliationMarkers: `${prefix}_reconciliation_markers`,
    fences: `${prefix}_fences`,
  };
}

function statementLog(): Readonly<{
  sink: EventSink;
  statements: () => readonly TracedStatement[];
  reset: () => void;
  record: (text: string, params: readonly unknown[]) => void;
}> {
  const recorded: TracedStatement[] = [];
  const record = (text: string, params: readonly unknown[]) => {
    recorded.push({ text, params });
  };
  return {
    sink: (event: WriteShapeEvent) => {
      if (event.source === "sql") record(event.text, event.params);
      else if (event.source === "exchange") record(`-- ${event.line}`, []);
    },
    record,
    statements: () => [...recorded],
    reset: () => {
      recorded.length = 0;
    },
  };
}

function noFault(): undefined {
  return;
}

async function bootstrapEach(
  backends: readonly AdapterBackend<unknown>[],
): Promise<void> {
  for (const backend of backends) {
    await requireDefined(backend.bootstrapTables)();
  }
}

/** better-sqlite3: one in-memory database handle. */
export async function openTracedSqliteConnection(
  tableNameSets: readonly TracedTableNames[],
): Promise<TracedConnection> {
  const client = new Database(":memory:");
  const log = statementLog();
  recordSqliteDriver(client, log.sink, noFault);
  const db = drizzleBetterSqlite(client);
  const backends = tableNameSets.map(
    (names) =>
      createSqliteBackend(db, {
        tables: createSqliteTables(names),
      }) as AdapterBackend<unknown>,
  );
  await bootstrapEach(backends);
  log.reset();
  return {
    backends,
    statements: log.statements,
    reset: log.reset,
    close: () => {
      client.close();
      return Promise.resolve();
    },
  };
}

/** libSQL: one local file client. */
export async function openTracedLibsqlConnection(
  tableNameSets: readonly TracedTableNames[],
): Promise<TracedConnection> {
  const directory = mkdtempSync(path.join(tmpdir(), "typegraph-traced-"));
  const client = createClient({
    url: `file:${path.join(directory, "graph.db")}`,
  });
  const log = statementLog();
  recordLibsqlClient(client, log.sink, noFault);
  const backends: AdapterBackend<unknown>[] = [];
  for (const names of tableNameSets) {
    const { backend } = await createLibsqlBackend(client, {
      tables: createSqliteTables(names),
    });
    backends.push(backend as AdapterBackend<unknown>);
  }
  await bootstrapEach(backends);
  log.reset();
  return {
    backends,
    statements: log.statements,
    reset: log.reset,
    close: () => {
      client.close();
      rmSync(directory, { recursive: true, force: true });
      return Promise.resolve();
    },
  };
}

/** PGlite: one in-process instance. */
export async function openTracedPgliteConnection(
  tableNameSets: readonly TracedTableNames[],
): Promise<TracedConnection> {
  const client = await PGlite.create();
  const log = statementLog();
  recordPgliteDriver(client, log.sink, noFault);
  const db = drizzlePglite(client);
  const backends = tableNameSets.map(
    (names) =>
      createPostgresBackend(db, {
        tables: createPostgresTables(names),
      }) as AdapterBackend<unknown>,
  );
  await bootstrapEach(backends);
  log.reset();
  return {
    backends,
    statements: log.statements,
    reset: log.reset,
    close: () => client.close(),
  };
}

/** The SQL text of a `pg` query argument: a string or a query config. */
function nodePostgresQueryText(query: unknown): string | undefined {
  if (typeof query === "string") return query;
  if (typeof query === "object" && query !== null && "text" in query) {
    const text: unknown = query.text;
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
}

function nodePostgresQueryParams(
  query: unknown,
  values: unknown,
): readonly unknown[] {
  if (Array.isArray(values)) return values as unknown[];
  if (typeof query === "object" && query !== null && "values" in query) {
    const carried: unknown = query.values;
    if (Array.isArray(carried)) return carried as unknown[];
  }
  return [];
}

async function dropTableNameSets(
  drop: (statement: string) => Promise<unknown>,
  tableNameSets: readonly TracedTableNames[],
): Promise<void> {
  const names = tableNameSets.flatMap((names) => Object.values(names));
  await drop(
    `DROP TABLE IF EXISTS ${names.map((name) => `"${name}"`).join(", ")} CASCADE`,
  );
}

/** node-postgres: a one-connection pool whose client records each query. */
export async function openTracedNodePostgresConnection(
  databaseUrl: string,
  tableNameSets: readonly TracedTableNames[],
): Promise<TracedConnection> {
  const log = statementLog();
  class TracedClient extends pg.Client {
    override query(...args: unknown[]): never {
      const [query, values] = args;
      const text = nodePostgresQueryText(query);
      if (text !== undefined) {
        log.record(text, nodePostgresQueryParams(query, values));
      }
      return (super.query as (...queryArguments: unknown[]) => never)(...args);
    }
  }
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    Client: TracedClient,
  });
  const db = drizzleNodePostgres(pool);
  const backends = tableNameSets.map(
    (names) =>
      createPostgresBackend(db, {
        tables: createPostgresTables(names),
      }) as AdapterBackend<unknown>,
  );
  await dropTableNameSets((statement) => pool.query(statement), tableNameSets);
  await bootstrapEach(backends);
  log.reset();
  return {
    backends,
    statements: log.statements,
    reset: log.reset,
    async close() {
      await dropTableNameSets(
        (statement) => pool.query(statement),
        tableNameSets,
      );
      await pool.end();
    },
  };
}

/** postgres-js: a one-connection client whose `debug` hook records each query. */
export async function openTracedPostgresJsConnection(
  databaseUrl: string,
  tableNameSets: readonly TracedTableNames[],
): Promise<TracedConnection> {
  const log = statementLog();
  const client = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {
      // DROP ... IF EXISTS notices are expected.
    },
    debug: (_connection, query, parameters) => {
      log.record(query, parameters as readonly unknown[]);
    },
  });
  const db = drizzlePostgresJs(client);
  const backends = tableNameSets.map(
    (names) =>
      createPostgresBackend(db, {
        tables: createPostgresTables(names),
      }) as AdapterBackend<unknown>,
  );
  await dropTableNameSets(
    (statement) => client.unsafe(statement),
    tableNameSets,
  );
  await bootstrapEach(backends);
  log.reset();
  return {
    backends,
    statements: log.statements,
    reset: log.reset,
    async close() {
      await dropTableNameSets(
        (statement) => client.unsafe(statement),
        tableNameSets,
      );
      await client.end();
    },
  };
}
