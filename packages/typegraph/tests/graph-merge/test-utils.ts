import { randomUUID } from "node:crypto";

import type { GraphBackend, GraphDef, Store } from "@nicia-ai/typegraph";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createLocalPgliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres/pglite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { getTableName, is, Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";

import { generatePostgresMigrationSQL } from "../../src/backend/drizzle/ddl";
import {
  createPostgresTables,
  type PostgresTableNames,
  type PostgresTables,
} from "../../src/backend/drizzle/schema/postgres";
import type { Embedder } from "../../src/graph-merge/types";
import type { importGraph } from "../../src/interchange";
import { storeBackend } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";

export function getStoreBackend<G extends GraphDef>(
  store: Store<G>,
): GraphBackend {
  return storeBackend(store);
}

export function getBackendProperty(
  backend: GraphBackend,
  property: PropertyKey,
): unknown {
  return Reflect.get(backend, property) as unknown;
}

/**
 * Backend test fixtures for the graph-merge suite.
 *
 * Two backends run fully in-process under plain `pnpm test`:
 * SQLite via better-sqlite3 (`createLocalSqliteBackend`) and Postgres via
 * PGlite + pgvector (`createLocalPgliteBackend`) — no Docker, no
 * `POSTGRES_URL`, no 5432 dependency.
 *
 * When `POSTGRES_URL` IS set, a third entry runs every suite against the real
 * server-Postgres backend (node-postgres
 * `Pool` + Drizzle) — the production driver and transaction wiring PGlite
 * cannot exercise. Each fixture gets its own throwaway schema on the shared
 * server (merge fixtures must be EMPTY and several live simultaneously per
 * test: a base plus its branches), created on `make()` and dropped by
 * `cleanup()`.
 * The `test:postgres` script selects only that server entry; the normal unit,
 * property and coverage lanes retain SQLite and PGlite.
 */

/**
 * A constructed backend paired with a disposer. Callers MUST invoke `cleanup`
 * (typically in an `afterEach`) so the underlying engine — including PGlite's
 * in-process Postgres — is released.
 */
export type MergeBackendFixture = Readonly<{
  backend: GraphBackend;
  cleanup: () => Promise<void>;
}>;

/**
 * Creates an in-memory SQLite backend fixture.
 */
export function createSqliteMergeBackend(): MergeBackendFixture {
  const { backend } = createLocalSqliteBackend();
  return {
    backend,
    cleanup: async () => {
      await backend.close();
    },
  };
}

/**
 * Creates an in-process PGlite (Postgres + pgvector) backend fixture.
 *
 * `createLocalPgliteBackend` is async because it boots the WASM Postgres
 * engine and loads the pgvector extension before returning a ready backend.
 */
export async function createPgliteMergeBackend(): Promise<MergeBackendFixture> {
  const { backend } = await createLocalPgliteBackend();
  return {
    backend,
    cleanup: async () => {
      await backend.close();
    },
  };
}

/**
 * A shared PGlite engine with independently named table sets for merge tests.
 *
 * Graph-merge property cases need several stores alive concurrently: a base and
 * its branches, and sometimes two independent materializations. Reusing one
 * default table set would make those stores collide. Instead, the engine stays
 * alive for the test file while each fixture receives its own core TypeGraph
 * tables and drops them at cleanup. This removes repeated WASM/pgvector boot
 * cost without weakening fixture isolation. Strategy-owned vector and index
 * tables remain keyed by graph identity; these property fixtures do not
 * materialize those strategies.
 */
export type SharedPgliteMergeEngine = Readonly<{
  makeFixture: () => Promise<MergeBackendFixture>;
  dispose: () => Promise<void>;
}>;

/**
 * Starts a reusable PGlite engine for a graph-merge property test file.
 */
export async function setupSharedPgliteMergeEngine(): Promise<SharedPgliteMergeEngine> {
  const { client, db } = await createLocalPgliteBackend();
  let fixtureSequence = 0;

  return {
    makeFixture: async () => {
      fixtureSequence += 1;
      const tables = createPostgresTables(
        sharedPgliteTableNames(fixtureSequence),
      );
      await client.exec(generatePostgresMigrationSQL(tables));

      const backend = createPostgresBackend(db, { tables });
      return {
        backend,
        cleanup: async () => {
          await backend.close();
          await client.exec(dropTablesSql(tables));
          const remaining = await client.query<{ tablename: string }>(
            `SELECT tablename
             FROM pg_tables
             WHERE schemaname = 'public'
               AND left(tablename, length($1)) = $1`,
            [prefixForFixture(tables)],
          );
          if (remaining.rows.length > 0) {
            throw new Error(
              `Shared PGlite fixture cleanup left tables: ${remaining.rows
                .map((row) => row.tablename)
                .join(", ")}`,
            );
          }
        },
      };
    },
    dispose: async () => {
      await client.close();
    },
  };
}

function sharedPgliteTableNames(fixtureSequence: number): PostgresTableNames {
  const prefix = `merge_fixture_${fixtureSequence}`;
  return {
    nodes: `${prefix}_nodes`,
    edges: `${prefix}_edges`,
    recordedNodes: `${prefix}_recorded_nodes`,
    recordedEdges: `${prefix}_recorded_edges`,
    recordedClock: `${prefix}_recorded_clock`,
    revisionOrigins: `${prefix}_revision_origins`,
    identityAssertions: `${prefix}_identity_assertions`,
    recordedIdentityAssertions: `${prefix}_recorded_identity_assertions`,
    identityClosure: `${prefix}_identity_closure`,
    identitySeparation: `${prefix}_identity_separation`,
    uniques: `${prefix}_uniques`,
    edgeClaims: `${prefix}_edge_claims`,
    baseSchemaVersions: `${prefix}_base_schema_versions`,
    schemaVersions: `${prefix}_schema_versions`,
    fulltext: `${prefix}_fulltext`,
    indexMaterializations: `${prefix}_index_materializations`,
    contributionMaterializations: `${prefix}_contribution_materializations`,
    kindRemovals: `${prefix}_kind_removals`,
    reconciliationMarkers: `${prefix}_reconciliation_markers`,
    graphTemplates: `${prefix}_graph_templates`,
  };
}

function prefixForFixture(tables: PostgresTables): string {
  const tableName = getTableName(tables.nodes);
  const prefix = tableName.slice(0, tableName.lastIndexOf("_nodes"));
  return prefix;
}

function dropTablesSql(tables: PostgresTables): string {
  const names = Object.values(tables)
    .filter((value) => is(value, Table))
    .map((table) => `"${getTableName(table)}"`);
  return `DROP TABLE IF EXISTS ${names.join(", ")} CASCADE`;
}

/**
 * Creates a server-Postgres backend fixture on the shared `POSTGRES_URL`
 * server, isolated in its own throwaway schema.
 *
 * The data pool pins `search_path` to the fixture schema (with `public` second
 * so extension types like pgvector's `vector` still resolve); all TypeGraph
 * DDL and DML are schema-relative, so every fixture sees an empty graph store.
 * `backend.close()` ends the data pool; the one-connection admin pool drops
 * the schema afterwards.
 */
export async function createServerPostgresMergeBackend(
  postgresUrl: string,
): Promise<MergeBackendFixture> {
  const schemaName = `merge_test_${randomUUID().replaceAll("-", "")}`;
  await runAdminQuery(postgresUrl, `CREATE SCHEMA "${schemaName}"`);

  // `max: 2` keeps the shared server's connection budget intact: the property
  // suites hold a base plus several branch fixtures alive at once, and a
  // default-size pool (10) per fixture exhausts `max_connections` ("sorry,
  // too many clients already"). Merge traffic is sequential — one connection
  // serves it; the second is headroom so a transaction never self-starves.
  const dataPool = new Pool({
    connectionString: postgresUrl,
    options: `-c search_path=${schemaName},public`,
    max: 2,
  });
  const backend = createPostgresBackend(drizzle(dataPool));

  // Force the DDL bootstrap NOW. The lazy bootstrap gate only fires when
  // `typegraph_schema_versions` is missing — and on a shared server whose
  // `public` schema already has the tables, search_path fall-through makes the
  // probe SUCCEED against `public`, so no per-schema tables would ever be
  // created and every fixture would silently share `public`'s data. Creating
  // the full table set in the fixture schema up front shadows `public` for all
  // subsequent unqualified references. (`public` stays second on the path so
  // extension types — pgvector's `vector` — still resolve.)
  if (backend.bootstrapTables === undefined) {
    await backend.close();
    throw new Error(
      "createPostgresBackend() returned no bootstrapTables(); the schema-isolated merge fixture requires it.",
    );
  }
  await backend.bootstrapTables();

  return {
    backend,
    cleanup: async () => {
      // `createPostgresBackend(db).close()` is deliberately a no-op — the
      // caller owns the connection lifecycle — so the fixture must end its
      // own pool or every fixture leaks its connections for the whole worker
      // process (the shared server then hits "too many clients").
      await backend.close();
      await dataPool.end();
      await runAdminQuery(postgresUrl, `DROP SCHEMA "${schemaName}" CASCADE`);
    },
  };
}

/**
 * Runs one admin statement (schema create/drop) on a TRANSIENT connection.
 * A per-fixture admin pool would hold an idle connection for the fixture's
 * whole lifetime — multiplied across the property suites' simultaneous
 * fixtures, enough to breach the shared server's connection limit.
 */
async function runAdminQuery(
  postgresUrl: string,
  statement: string,
): Promise<void> {
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** Fixed alphabet for {@link fakeEmbedder}: a–z plus space (27 dims). */
const EMBEDDER_ALPHABET = "abcdefghijklmnopqrstuvwxyz ";

/** Maps a text to its 27-dim lowercase character-frequency vector. */
function charFrequencyVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDER_ALPHABET.length);
  for (const char of text.toLowerCase()) {
    const index = EMBEDDER_ALPHABET.indexOf(char);
    if (index !== -1) {
      vector[index] = (vector[index] ?? 0) + 1;
    }
  }
  return vector;
}

/**
 * A deterministic, OFFLINE stand-in for a real sentence embedder, for exercising
 * the `vector`/`hybrid` plumbing without downloading a model. Each text maps to a
 * 27-dim character-frequency vector, so cosine over the vectors correlates with
 * character overlap: a near-duplicate name ("anna rivera" ≈ "ana rivera") scores
 * far above an unrelated one ("bob lee") — enough to assert RELATIVE behavior and
 * determinism. It is a PURE function of the text, so the merge stays
 * order-independent. NOT a quality model — production injects the real
 * all-MiniLM-L6-v2 embedder from the harness.
 */
export const fakeEmbedder: Embedder = (texts) =>
  Promise.resolve(texts.map((text) => charFrequencyVector(text)));

/**
 * Builds the precomputed `text→vector` lookup `scorePair` reads, from the
 * lowercased field texts, using {@link fakeEmbedder}. Mirrors what `merge()`
 * precomputes, so a unit test can score a `vector`/`hybrid` pair directly.
 */
export async function fakeEmbeddings(
  texts: readonly string[],
): Promise<ReadonlyMap<string, Float32Array>> {
  const keys = texts.map((text) => text.toLowerCase());
  const vectors = await fakeEmbedder(keys);
  const lookup = new Map<string, Float32Array>();
  for (const [index, key] of keys.entries())
    lookup.set(key, requireDefined(vectors[index]));
  return lookup;
}

/** The identity profile the merge suites' interchange fixtures declare. */
const IDENTITY_PROFILE = "typegraph-identity-v1" as const;

/**
 * A minimal interchange document carrying ONE `same` assertion between two
 * nodes of `kind` — how a merge test stages identity truth into a branch
 * through `importGraph`. The endpoints are emitted in code-point order because
 * the import path rejects a non-normalized pair.
 */
export function identityAssertionDocument(
  kind: string,
  id: string,
  a: string,
  b: string,
  validFrom = new Date().toISOString(),
): Parameters<typeof importGraph>[1] {
  const refA = { kind, id: a };
  const refB = { kind, id: b };
  const [left, right] = a < b ? [refA, refB] : [refB, refA];
  return {
    formatVersion: "2.0",
    exportedAt: "2024-01-01T00:00:00.000Z",
    source: { type: "external" },
    nodes: [],
    edges: [],
    identity: {
      profile: IDENTITY_PROFILE,
      mode: "state",
      assertions: [
        {
          id,
          relation: "same",
          a: left,
          b: right,
          validFrom,
        },
      ],
    },
  };
}

/**
 * A named backend factory used to parameterize `describe.each` suites.
 */
export type BackendMatrixEntry = Readonly<{
  name: string;
  make: () => Promise<MergeBackendFixture>;
}>;

/**
 * Returns the default local matrix, adding the server when POSTGRES_URL is
 * set. TYPEGRAPH_TEST_BACKEND=postgres selects only the server for the dedicated
 * lane and refuses to run without a URL. SQLite's synchronous factory is
 * wrapped so every entry shares the async make() signature.
 */
export function backendMatrix(): readonly BackendMatrixEntry[] {
  const selectedBackend = process.env["TYPEGRAPH_TEST_BACKEND"];
  if (selectedBackend !== undefined && selectedBackend !== "postgres") {
    throw new Error(`Unsupported TYPEGRAPH_TEST_BACKEND: ${selectedBackend}`);
  }
  const postgresUrl = process.env["POSTGRES_URL"];
  if (selectedBackend === "postgres") {
    if (postgresUrl === undefined || postgresUrl === "") {
      throw new Error("TYPEGRAPH_TEST_BACKEND=postgres requires POSTGRES_URL");
    }
    return [
      {
        name: "Postgres",
        make: () => createServerPostgresMergeBackend(postgresUrl),
      },
    ];
  }
  const entries: BackendMatrixEntry[] = [
    {
      name: "SQLite",
      make: () => Promise.resolve(createSqliteMergeBackend()),
    },
    {
      name: "PGlite",
      make: () => createPgliteMergeBackend(),
    },
  ];
  if (postgresUrl !== undefined && postgresUrl !== "") {
    entries.push({
      name: "Postgres",
      make: () => createServerPostgresMergeBackend(postgresUrl),
    });
  }
  return entries;
}
