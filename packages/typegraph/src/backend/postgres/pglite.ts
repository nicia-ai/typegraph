/**
 * Local PGlite backend — Postgres-in-WASM, running in-process.
 *
 * [PGlite](https://pglite.dev/) is a full Postgres compiled to WebAssembly
 * that runs inside the Node/Bun/Deno/browser process with no server and no
 * native addon. This is the batteries-included Postgres analog of
 * `createLocalSqliteBackend`: it constructs a PGlite instance, loads the
 * pgvector extension, runs the schema DDL, and returns a ready
 * `{ backend, db }` pair whose `close()` disposes the engine.
 *
 * `@electric-sql/pglite` is an optional peer dependency. Vector support
 * additionally needs `@electric-sql/pglite-pgvector` (PGlite ≥ 0.5 ships
 * pgvector as a separate package). Install what you need:
 *
 * ```bash
 * pnpm add @electric-sql/pglite @electric-sql/pglite-pgvector
 * ```
 *
 * @example In-memory database (default, vector enabled)
 * ```typescript
 * import { createLocalPgliteBackend } from "@nicia-ai/typegraph/postgres/pglite";
 *
 * const { backend } = await createLocalPgliteBackend();
 * const store = createStore(graph, backend);
 * ```
 *
 * @example Persistent on-disk database
 * ```typescript
 * const { backend, db } = await createLocalPgliteBackend({ dataDir: "./pgdata" });
 * ```
 *
 * @example No vector support (skip the pgvector extension)
 * ```typescript
 * const { backend } = await createLocalPgliteBackend({ vector: false });
 * ```
 *
 * PGlite is single-connection and serial: there is no pooling, so concurrent
 * `store.transaction()` calls queue rather than run in parallel.
 */
import { type Extension, PGlite } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { ConfigurationError } from "../../errors";
import {
  generatePostgresDDL,
  generatePostgresMigrationSQL,
} from "../drizzle/ddl";
import {
  createPostgresBackend,
  type PostgresTables,
  tables as defaultTables,
} from "../drizzle/postgres";
import { type GraphBackend, wrapWithManagedClose } from "../types";

// ============================================================
// Types
// ============================================================

/**
 * Options for creating a local PGlite backend.
 */
export type LocalPgliteBackendOptions = Readonly<{
  /**
   * PGlite data directory. Omit for an in-memory database (the default).
   * Accepts any PGlite data-dir spec: a filesystem path (`"./pgdata"`),
   * `"memory://"`, or a browser/runtime-specific scheme such as
   * `"idb://my-db"`.
   */
  dataDir?: string;

  /**
   * Custom table definitions. Defaults to standard TypeGraph table names.
   */
  tables?: PostgresTables;

  /**
   * Controls the pgvector stack:
   *
   * - **omitted (default)** — load pgvector from `@electric-sql/pglite-pgvector`
   *   and run `CREATE EXTENSION vector`, so embedding fields work out of the
   *   box. Throws a {@link ConfigurationError} if the package isn't installed.
   * - **`false`** — skip the extension entirely; the backend advertises no
   *   vector capability (mirroring a SQLite connection without sqlite-vec).
   *   Use when a graph carries no embeddings, or to avoid the extension dep.
   * - **a PGlite `Extension`** — bring your own pgvector build or custom
   *   extension packaging. Decouples this helper from a specific pgvector
   *   package version.
   */
  vector?: false | Extension;
}>;

/**
 * Result of creating a local PGlite backend.
 */
export type LocalPgliteBackendResult = Readonly<{
  /**
   * The GraphBackend instance for use with createStore. Its `close()`
   * disposes the underlying PGlite engine.
   */
  backend: GraphBackend;

  /**
   * The underlying Drizzle database instance. Useful for direct SQL access.
   */
  db: PgliteDatabase;

  /**
   * The raw PGlite instance, for engine-specific operations such as
   * `dumpDataDir()` / `clone()` not surfaced through Drizzle.
   */
  client: PGlite;
}>;

// ============================================================
// Vector extension loading
// ============================================================

/**
 * Dynamically loads the default pgvector extension from
 * `@electric-sql/pglite-pgvector`. Kept as a runtime import so the package
 * stays an optional peer dependency — callers using `vector: false` or
 * supplying their own extension never need it installed.
 */
async function loadDefaultPgvectorExtension(): Promise<Extension> {
  try {
    const module_ = await import("@electric-sql/pglite-pgvector");
    return module_.vector;
  } catch (error) {
    throw new ConfigurationError(
      "createLocalPgliteBackend needs the pgvector extension but " +
        "`@electric-sql/pglite-pgvector` could not be loaded. Install it " +
        "(`pnpm add @electric-sql/pglite-pgvector`), pass your own `vector` " +
        "extension, or set `vector: false` to disable vector support.",
      { backend: "pglite", dependency: "@electric-sql/pglite-pgvector" },
      { cause: error },
    );
  }
}

// ============================================================
// Factory Function
// ============================================================

/**
 * Creates a TypeGraph backend backed by an in-process PGlite database.
 *
 * Constructs the PGlite engine (loading pgvector unless disabled), executes
 * the schema DDL, and wires the standard Postgres backend. The returned
 * backend owns the engine: call `backend.close()` to dispose it.
 *
 * For production Postgres, or a PGlite instance you construct yourself,
 * use `createPostgresBackend` directly with your own Drizzle database — the
 * execution fast path detects PGlite and routes it correctly.
 *
 * @param options - Configuration options
 * @returns Backend, Drizzle database, and raw PGlite client
 */
export async function createLocalPgliteBackend(
  options: LocalPgliteBackendOptions = {},
): Promise<LocalPgliteBackendResult> {
  const tables = options.tables ?? defaultTables;

  // pgvector lives in the WASM instance, so the extension must be passed at
  // construction — `CREATE EXTENSION vector` alone can't pull it in. An
  // explicitly supplied extension wins; `false` disables; otherwise load the
  // default package.
  const vectorExtension =
    options.vector === false ?
      undefined
    : (options.vector ?? (await loadDefaultPgvectorExtension()));
  const vectorEnabled = vectorExtension !== undefined;

  // Construct via the single options-object form (passing `dataDir` as a
  // field), not the positional `create(dataDir, options)` overload: with a
  // leading `undefined` dataDir, that overload silently drops `extensions`
  // ("extension vector is not available"). The options form loads them for
  // both the in-memory and on-disk cases.
  const client = await PGlite.create({
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(vectorExtension === undefined ?
      {}
    : { extensions: { vector: vectorExtension } }),
  });

  // `exec` runs a multi-statement batch (DDL + the pgvector `CREATE
  // EXTENSION` when enabled) in one round trip.
  const migrationSql =
    vectorEnabled ?
      generatePostgresMigrationSQL(tables)
    : generatePostgresDDL(tables).join("\n\n");
  await client.exec(migrationSql);

  const db = drizzle(client);
  const backend = createPostgresBackend(db, {
    tables,
    ...(vectorEnabled ? {} : { vector: false }),
  });
  const managedBackend = wrapWithManagedClose(backend, async () => {
    await client.close();
  });

  return { backend: managedBackend, db, client };
}
