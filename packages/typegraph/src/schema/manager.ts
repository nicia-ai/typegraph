/**
 * Schema manager for TypeGraph.
 *
 * Provides schema lifecycle management:
 * - Initialization on first store creation
 * - Validation on store open
 * - Auto-migration for safe changes
 * - Error reporting for breaking changes
 */
import {
  type CommitSchemaVersionIfKindsEmptyResult,
  type CommitSchemaVersionParams,
  type GraphBackend,
  type PopulatedSchemaKind,
  type SchemaKindEmptinessProbe,
  type SchemaVersionRow,
  type TransactionBackend,
} from "../backend/types";
import {
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import { type KindEntity } from "../core/types";
import {
  ConfigurationError,
  DatabaseOperationError,
  MigrationError,
  StaleVersionError,
} from "../errors";
import { mergeGraphExtension } from "../graph-extension/merge";
import { stripGraphExtension } from "../graph-extension/remove";
import {
  ensureIdentitySchemaStorage,
  identitySchemaCommitPreflight,
} from "../identity/schema-transition";
import { createSqlSchema, type SqlSchema } from "../query/compiler/schema";
import { buildKindRegistry } from "../registry";
import { freezeDeep } from "../utils/object";
import { isMissingTableError } from "../utils/sql-errors";
import {
  computeSchemaDiff,
  getMigrationActions,
  isBackwardsCompatible,
  type SchemaDiff,
} from "./migration";
import {
  computeSchemaHash,
  getSchemaHash,
  serializeSchema,
} from "./serializer";
import { type SerializedSchema, serializedSchemaZod } from "./types";

/**
 * Bounded LRU cache for `parseSerializedSchema` results, keyed on the
 * raw schema_doc string. Multi-tenant servers re-read the same row
 * across tenants on every store boot, and the full Zod parse + JSON
 * walk is ~0.5ms on a 50KB schema. Capped at 100 entries (~5MB worst
 * case) so a long-running process holding many distinct schemas
 * doesn't grow the cache unbounded.
 */
const PARSE_CACHE_LIMIT = 100;
const PARSE_CACHE = new Map<string, SerializedSchema>();

/**
 * Parses and validates a serialized schema document from the database.
 *
 * Uses the Zod schema to validate the full nested structure, catching
 * corruption, incompatible schema versions, or truncated JSON at the
 * parse boundary rather than letting invalid data propagate silently.
 */
export function parseSerializedSchema(json: string): SerializedSchema {
  const cached = PARSE_CACHE.get(json);
  if (cached !== undefined) {
    // LRU touch: re-insert to mark as most-recently-used.
    PARSE_CACHE.delete(json);
    PARSE_CACHE.set(json, cached);
    return cached;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DatabaseOperationError(
      "Stored schema document is not valid JSON",
      { operation: "select", entity: "schema" },
    );
  }

  const result = serializedSchemaZod.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new DatabaseOperationError(
      `Stored schema document is malformed: ${issues}`,
      { operation: "select", entity: "schema" },
    );
  }

  // The Zod schema validates enum fields (temporalMode, cardinality, etc.)
  // against the real literal unions. The cast is sound — the only
  // broadening is `.loose()` on objects (extra fields), not on enum
  // values.
  const validated = freezeDeep(result.data as SerializedSchema);

  if (PARSE_CACHE.size >= PARSE_CACHE_LIMIT) {
    // Drop the oldest entry. JS Map iteration is insertion-ordered, so
    // the first key is the least-recently-used.
    const oldest = PARSE_CACHE.keys().next().value;
    if (oldest !== undefined) PARSE_CACHE.delete(oldest);
  }
  PARSE_CACHE.set(json, validated);
  return validated;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Reads the active schema row, bootstrapping the base tables on the
 * first call against an empty database.
 *
 * Deliberately does NOT materialize runtime contributions (fulltext)
 * here. Contribution DDL is derived from the *current code graph*; when
 * the persisted schema is behind by a breaking change, running it here
 * would apply vN+1 DDL against the vN table shape before `ensureSchema`
 * computes the diff and throws `MigrationError`. On Postgres the first
 * failing statement poisons the surrounding transaction, so the error
 * that escapes is the idempotent marker-table
 * `CREATE TABLE IF NOT EXISTS` (collateral damage) rather than a clean
 * `MigrationError` — breaking the documented migrate-on-`MigrationError`
 * recovery path (#143). `createStoreWithSchema` is the single canonical
 * durable-marker writer (#135) and materializes runtime contributions
 * only AFTER the schema gate has run, so the breaking-change check is
 * always reached first.
 */
export async function loadActiveSchemaWithBootstrap(
  backend: GraphBackend,
  graphId: string,
): Promise<SchemaVersionRow | undefined> {
  try {
    return await backend.getActiveSchema(graphId);
  } catch (error) {
    if (backend.bootstrapTables && isMissingTableError(error)) {
      await backend.bootstrapTables();
      return await backend.getActiveSchema(graphId);
    }
    throw error;
  }
}

/**
 * Reads the active schema, parses it, and folds any persisted graph-extension
 * document into the supplied compile-time graph. Returns the
 * merged graph alongside the prefetched row + parsed schema so the
 * caller can pass them through to `ensureSchema` without paying for a
 * second `getActiveSchema` round trip or a second
 * `serializedSchemaZod` walk.
 *
 * Throws `ConfigurationError` if the persisted graph-extension document
 * references a compile-time kind that no longer exists (the
 * startup-conflict case).
 */
export async function loadAndMergeGraphExtensionDocument<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
): Promise<
  Readonly<{
    graph: G;
    activeRow: SchemaVersionRow | undefined;
    storedSchema: SerializedSchema | undefined;
  }>
> {
  const activeRow = await loadActiveSchemaWithBootstrap(backend, graph.id);
  if (activeRow === undefined) {
    return { graph, activeRow: undefined, storedSchema: undefined };
  }
  const { graph: merged, storedSchema } = mergeStoredGraphExtension(
    graph,
    activeRow,
  );
  return { graph: merged, activeRow, storedSchema };
}

/**
 * Pure parse + extension-merge + deprecated-kind application. Factored
 * out so the SELECT-only verifier (`assertSchemaCurrent`) can fold the
 * persisted graph extension into the supplied graph without paying for a
 * second `getActiveSchema` round trip or going through the
 * bootstrap-capable loader.
 *
 * **The persisted document is the sole authority on extension kinds.** The
 * supplied graph's own extension slice is stripped before the stored one is
 * applied, so the result is a function of `activeRow` alone. Without this, a
 * caller passing an already-merged graph — `store.graph` is public and
 * returns one — resurrects extension kinds another writer has since removed:
 * `unionDocuments` unions the local slice back in and the absent-from-stored
 * kinds win. That silently undoes `Store.removeKinds` while its
 * `typegraph_kind_removals` row stays queued, leaving a kind the schema calls
 * live with a pending cleanup that later deletes its rows.
 *
 * A compile-time graph has no extension slice, so the strip is a no-op for
 * the `createStoreWithSchema` / `assertSchemaCurrent` callers. Mirrors
 * `Store.#catchUpToStored`, which has stripped for this exact reason.
 */
function mergeStoredGraphExtension<G extends GraphDef>(
  graph: G,
  activeRow: SchemaVersionRow,
): Readonly<{ graph: G; storedSchema: SerializedSchema }> {
  const storedSchema = parseSerializedSchema(activeRow.schema_doc);
  const compileTimeGraph = stripGraphExtension(graph);
  const merged =
    storedSchema.extension === undefined ?
      compileTimeGraph
    : mergeGraphExtension(compileTimeGraph, storedSchema.extension);
  return {
    graph: applyDeprecatedKinds(merged, storedSchema.deprecatedKinds),
    storedSchema,
  };
}

/**
 * Returns a graph carrying the supplied deprecated-kind names. Used by
 * the loader to propagate `SerializedSchema.deprecatedKinds` onto the
 * `GraphDef` that the Store sees, and by `Store.deprecateKinds` /
 * `Store.undeprecateKinds` to construct the next graph.
 *
 * Returns the original graph reference when the desired set already
 * matches `graph.deprecatedKinds` — covers both the no-deprecations
 * load path (empty equals empty) and the loader's restart-with-same-
 * persisted-set hot path. Skips a Set allocation + spread + freeze.
 */
export function applyDeprecatedKinds<G extends GraphDef>(
  graph: G,
  names: Iterable<string> | undefined,
): G {
  const current = graph.deprecatedKinds;
  // Identity short-circuit: callers commonly pass `graph.deprecatedKinds`
  // directly (or another graph's set that was carried through unchanged).
  if (names === current) return graph;

  const nextSet: ReadonlySet<string> =
    names === undefined ? new Set<string>()
    : names instanceof Set ? (names as ReadonlySet<string>)
    : new Set<string>(names);

  if (nextSet.size === 0 && current.size === 0) return graph;
  if (
    nextSet.size === current.size &&
    [...nextSet].every((name) => current.has(name))
  ) {
    return graph;
  }
  return Object.freeze({
    ...graph,
    deprecatedKinds: Object.freeze(new Set(nextSet)),
  });
}

// ============================================================
// Types
// ============================================================

/**
 * Result of schema validation.
 *
 * The `initialized` and `migrated` statuses carry the committed
 * `SchemaVersionRow` directly so callers building post-commit metadata
 * (e.g. `Store.deprecateKinds`) can skip a `getActiveSchema` round-trip.
 */
export type SchemaValidationResult =
  | {
      status: "initialized";
      version: number;
      committedRow: SchemaVersionRow;
    }
  | { status: "unchanged"; version: number }
  | {
      status: "migrated";
      fromVersion: number;
      toVersion: number;
      diff: SchemaDiff;
      committedRow: SchemaVersionRow;
    }
  | { status: "pending"; version: number; diff: SchemaDiff }
  | { status: "breaking"; diff: SchemaDiff; actions: readonly string[] };

/**
 * Context passed to migration lifecycle hooks.
 *
 * Hooks are intended for observability (logging, metrics, alerts),
 * not for data transformations. Use an explicit migration runner
 * for backfill scripts — see the schema evolution guide.
 */
export type MigrationHookContext = Readonly<{
  graphId: string;
  fromVersion: number;
  toVersion: number;
  diff: SchemaDiff;
}>;

/**
 * Options for schema management.
 */
export type SchemaManagerOptions = Readonly<{
  /** If true, auto-migrate safe changes. Default: true */
  autoMigrate?: boolean;
  /** If true, throw on breaking changes. Default: true */
  throwOnBreaking?: boolean;
  /**
   * Whether `createStoreWithSchema` brings the base-relation system
   * indexes up to the running library version at boot. Default:
   * `"materialize"`. Pass `"skip"` when a boot must not run potentially
   * long index builds inline (e.g. a large PostgreSQL deployment behind a
   * readiness probe) — then run `store.materializeSystemIndexes()`
   * out-of-band after upgrading.
   */
  systemIndexes?: "materialize" | "skip";
  /** Called before a safe auto-migration is applied. For observability only. */
  onBeforeMigrate?: (context: MigrationHookContext) => void | Promise<void>;
  /** Called after a safe auto-migration is applied. For observability only. */
  onAfterMigrate?: (context: MigrationHookContext) => void | Promise<void>;
  /**
   * The effective `SqlSchema` (custom table names) the graph's Store reads.
   * Identity schema commits derive their mandatory closure preflight from it;
   * the preflight itself is never accepted from callers, so it cannot be
   * substituted or suppressed.
   */
  schema?: SqlSchema;
}>;

// ============================================================
// Schema Manager
// ============================================================

/**
 * Ensures the schema is initialized and up-to-date.
 *
 * This is the main entry point for schema management. It:
 * 1. Initializes the schema if this is the first run (version 1)
 * 2. Returns "unchanged" if the schema matches the current graph
 * 3. Auto-migrates safe changes if autoMigrate is true
 * 4. Throws MigrationError for breaking changes if throwOnBreaking is true
 *
 * @param backend - The database backend
 * @param graph - The current graph definition
 * @param options - Schema management options
 * @returns The result of schema validation
 * @throws MigrationError if breaking changes detected and throwOnBreaking is true
 */
export async function ensureSchema<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  options?: SchemaManagerOptions & {
    /**
     * Pre-fetched active row + parsed stored schema. When the loader
     * (`createStoreWithSchema`) has already paid for `getActiveSchema`
     * and `parseSerializedSchema` to peek at `extension`, it
     * passes the results through here so `ensureSchema` doesn't repeat
     * the round trip + Zod walk on every Store boot.
     */
    preloaded?: Readonly<{
      activeRow: SchemaVersionRow | undefined;
      storedSchema: SerializedSchema | undefined;
    }>;
  },
): Promise<SchemaValidationResult> {
  const autoMigrate = options?.autoMigrate ?? true;
  const throwOnBreaking = options?.throwOnBreaking ?? true;

  // When `preloaded` is supplied we trust both fields verbatim, even
  // when `activeRow` is undefined — that means the loader explicitly
  // checked and saw no schema yet. Falling back to `??` would refetch
  // and could observe a row that another process committed in the
  // race window between the loader's read and this point; ensureSchema
  // would then diff a persisted schema with graph extensions against the
  // unmerged graph and throw a misleading MigrationError. With the
  // sentinel check the race surfaces as a clean `StaleVersionError`
  // from `commitSchemaVersion` inside `initializeSchema` instead.
  const preloaded = options?.preloaded;
  const activeSchema =
    preloaded === undefined ?
      await loadActiveSchemaWithBootstrap(backend, graph.id)
    : preloaded.activeRow;

  if (activeSchema === undefined) {
    // No schema exists - initialize with version 1. Only the effective
    // `SqlSchema` is threaded through; `initializeSchema` derives the
    // mandatory identity preflight itself, so no public first-commit path
    // can skip or replace the enablement work.
    const result = await initializeSchema(backend, graph, {
      ...(options?.schema === undefined ? {} : { schema: options.schema }),
    });
    return {
      status: "initialized",
      version: result.version,
      committedRow: result,
    };
  }

  // Quick hash check first — uses the per-graph hash cache so repeated
  // boots against the same graph reference skip the full serialize +
  // SHA-256 walk. When the hash matches, we never need the
  // `currentSchema` or the `storedSchema` (no diff is computed), so
  // defer those allocations until they're actually needed.
  const storedHash = activeSchema.schema_hash;
  const currentHash = await getSchemaHash(graph, activeSchema.version + 1);

  if (storedHash === currentHash) {
    return { status: "unchanged", version: activeSchema.version };
  }

  // Hashes differ - serialize both sides to compute the diff.
  const storedSchema =
    preloaded?.storedSchema ?? parseSerializedSchema(activeSchema.schema_doc);
  const currentSchema = serializeSchema(graph, activeSchema.version + 1);
  const diff = computeSchemaDiff(storedSchema, currentSchema);

  if (!diff.hasChanges) {
    // Hash changed but no semantic changes (shouldn't happen, but handle it)
    return { status: "unchanged", version: activeSchema.version };
  }

  // Check if changes are backwards compatible
  if (isBackwardsCompatible(diff)) {
    if (autoMigrate) {
      // Safe changes - auto-migrate
      const hookContext: MigrationHookContext = {
        graphId: graph.id,
        fromVersion: activeSchema.version,
        toVersion: activeSchema.version + 1,
        diff,
      };
      await options?.onBeforeMigrate?.(hookContext);
      // An identity-enabled commit must never land without the closure
      // preflight, whichever public path drove it. It is derived HERE —
      // never accepted from the caller — so it cannot be substituted or
      // suppressed; `options.schema` only points it at the effective tables.
      const preflight =
        graph.identity === undefined ?
          undefined
        : await prepareIdentitySchemaCommit(backend, graph, {
            enablement: storedSchema.identity === undefined,
            ...(options?.schema === undefined ?
              {}
            : { schema: options.schema }),
          });
      const committedRow =
        preflight === undefined ?
          await commitNewSchemaVersion(backend, graph, activeSchema.version)
        : await commitNewSchemaVersionWithPreflight(
            backend,
            graph,
            activeSchema.version,
            preflight,
          );
      await options?.onAfterMigrate?.(hookContext);
      return {
        status: "migrated",
        fromVersion: activeSchema.version,
        toVersion: committedRow.version,
        diff,
        committedRow,
      };
    }
    // Auto-migrate disabled but changes are safe
    return {
      status: "pending",
      version: activeSchema.version,
      diff,
    };
  }

  // Breaking changes detected
  const actions = getMigrationActions(diff);

  if (throwOnBreaking) {
    // The kind-removal pointer is noise on the dominant case (a property
    // change), so it appears only when the diff actually removes a kind —
    // which is exactly when `migrateSchema()` would refuse the commit.
    //
    // It must NOT point at `Store.removeKinds()`. A kind missing from the
    // *code graph* is a compile-time kind, and `removeKinds` rejects those by
    // design (`RemoveCompileTimeKindError`) — they are removed by recompiling
    // and redeploying. `removeKinds` is for runtime extension kinds, which
    // cannot be the cause of this diff.
    const removesKind = [...diff.nodes, ...diff.edges].some(
      (change) => change.type === "removed",
    );
    throw new MigrationError(
      `Schema migration required: ${diff.summary}. ` +
        `${actions.length} migration action(s) needed. ` +
        `Use getSchemaChanges() to review, then migrateSchema() to apply.` +
        (removesKind ?
          ` This diff removes a kind: migrateSchema() refuses to drop one ` +
          `that still holds rows, so export or delete those rows first and ` +
          `retry.`
        : ""),
      {
        graphId: graph.id,
        fromVersion: activeSchema.version,
        toVersion: activeSchema.version + 1,
        reason: "breaking-change",
        diff,
      },
    );
  }

  return { status: "breaking", diff, actions };
}

// ============================================================
// SELECT-only schema verification (least-privilege runtime)
// ============================================================

/**
 * SELECT-only sibling of `loadAndMergeGraphExtensionDocument` for the
 * least-privilege runtime path: reads the active schema row, folds any
 * persisted graph extension into the supplied graph, and classifies
 * whether the database is current relative to that merged graph — all
 * **without DDL, bootstrap, or writes**. Returns the merged graph
 * alongside the active row and the validation result so a caller can
 * build a `Store` on the correct graph without paying for a second
 * `getActiveSchema` round trip or re-merging.
 *
 * @throws ConfigurationError if no schema has been initialized for
 *   `graph.id` (the privileged migration step has not run, or the base
 *   tables do not exist on this connection).
 * @throws MigrationError if the persisted schema is behind the code
 *   graph — for **any** pending change, safe or breaking. The
 *   least-privilege runtime cannot migrate; "behind" means the
 *   privileged migrator has not yet caught up.
 */
export async function loadAndVerifyGraph<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
): Promise<
  Readonly<{
    graph: G;
    activeRow: SchemaVersionRow;
    result: SchemaValidationResult;
  }>
> {
  const activeRow = await readActiveSchemaPure(backend, graph.id);
  const { graph: merged, storedSchema } = mergeStoredGraphExtension(
    graph,
    activeRow,
  );

  // Hash short-circuit avoids the serialize + diff walk on the steady-
  // state warm path. A semantic no-op (hash differs but `hasChanges` is
  // false) takes the same return path.
  const storedHash = activeRow.schema_hash;
  const currentHash = await getSchemaHash(merged, activeRow.version + 1);
  if (storedHash !== currentHash) {
    const currentSchema = serializeSchema(merged, activeRow.version + 1);
    const diff = computeSchemaDiff(storedSchema, currentSchema);
    if (diff.hasChanges) {
      throw schemaBehindError(merged.id, activeRow.version, diff);
    }
  }

  await backend.assertRuntimeContributionsInitialized?.(merged.id);
  await assertVectorContributionsInitialized(backend, merged);
  return {
    graph: merged,
    activeRow,
    result: { status: "unchanged", version: activeRow.version },
  };
}

/**
 * SELECT-only verification that every embedding `(kind, field)` slot's
 * durable contribution marker is initialized — the vector counterpart of
 * `backend.assertRuntimeContributionsInitialized` (which covers fulltext).
 * Keeps `createVerifiedStore`'s "throws when runtime-contribution markers
 * are missing/stale" guarantee honest for vectors: without it the verified
 * attach would pass but the first vector op would then throw. Enumerated
 * from the merged graph (same idiom as the privileged boot materializer);
 * a no-op on backends without vector support or graphs with no embeddings.
 */
async function assertVectorContributionsInitialized(
  backend: GraphBackend,
  graph: GraphDef,
): Promise<void> {
  if (backend.capabilities.vector?.supported !== true) return;
  const slots = resolveGraphVectorSlots(graph);
  const assertVectorSlotsInitialized = backend.assertVectorSlotsInitialized;
  if (assertVectorSlotsInitialized !== undefined) {
    await assertVectorSlotsInitialized(slots);
    return;
  }
  const assertVectorSlotInitialized = backend.assertVectorSlotInitialized;
  if (assertVectorSlotInitialized === undefined) return;
  for (const slot of slots) {
    await assertVectorSlotInitialized(slot);
  }
}

function schemaBehindError(
  graphId: string,
  fromVersion: number,
  diff: SchemaDiff,
): MigrationError {
  const actions = getMigrationActions(diff);
  const qualifier =
    isBackwardsCompatible(diff) ? "safe auto-migration" : "breaking change";
  return new MigrationError(
    `Schema verification failed for graph "${graphId}": ${diff.summary} ` +
      `(${qualifier}). ${actions.length} migration action(s) needed. ` +
      `The least-privilege runtime cannot migrate — run ` +
      `createStoreWithSchema(graph, adminBackend) under a privileged role ` +
      `(after any generated migration SQL, if you manage DDL externally) ` +
      `before attaching with createStore() / createVerifiedStore().`,
    {
      graphId,
      fromVersion,
      toVersion: fromVersion + 1,
      reason: "schema-behind",
      diff,
    },
  );
}

/**
 * Verifies the database is at the same schema version as the code
 * graph, **without** running DDL, bootstrapping tables, or writing
 * markers. The runtime-side counterpart of `ensureSchema` for the
 * least-privilege deployment model documented in "Database roles &
 * least privilege": `createStoreWithSchema` (run once under a privileged
 * role, optionally after applying generated migration SQL externally) is
 * responsible for advancing the schema; runtimes assert it.
 *
 * @throws ConfigurationError if no schema has been initialized.
 * @throws MigrationError if the persisted schema is behind the code
 *   graph by any change (safe or breaking).
 * @throws StoreNotInitializedError if the schema is current but the
 *   runtime-contribution markers are missing/stale/failed (the
 *   privileged migrator has not materialized strategy-owned storage for
 *   this graph on this connection).
 */
export async function assertSchemaCurrent<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
): Promise<SchemaValidationResult> {
  const { result } = await loadAndVerifyGraph(backend, graph);
  return result;
}

/**
 * Strict SELECT-only read of the active schema row. Unlike
 * `loadActiveSchemaWithBootstrap`, this never calls `bootstrapTables` —
 * a missing-table error or an absent row both surface as
 * `ConfigurationError` so a least-privilege runtime never attempts DDL
 * it can't run. Real system faults (connection, permission, driver)
 * still propagate as themselves.
 */
async function readActiveSchemaPure(
  backend: GraphBackend,
  graphId: string,
): Promise<SchemaVersionRow> {
  let activeRow: SchemaVersionRow | undefined;
  try {
    activeRow = await backend.getActiveSchema(graphId);
  } catch (error) {
    if (isMissingTableError(error)) {
      throw schemaNotInitializedError(graphId, error);
    }
    throw error;
  }
  if (activeRow === undefined) {
    throw schemaNotInitializedError(graphId);
  }
  return activeRow;
}

function schemaNotInitializedError(
  graphId: string,
  cause?: unknown,
): ConfigurationError {
  return new ConfigurationError(
    `Cannot verify graph "${graphId}": no schema has been initialized. ` +
      `Run createStoreWithSchema(graph, adminBackend) once under a ` +
      `privileged role (which commits the schema_versions row and ` +
      `materializes contribution markers) before attaching with ` +
      `createStore() / createVerifiedStore(). Generated migration SQL ` +
      `creates the tables but does not initialize the schema row.`,
    { graphId },
    {
      cause,
      suggestion:
        "Run createStoreWithSchema(graph, adminBackend) once under a " +
        "privileged role. If you manage DDL externally with drizzle-kit / " +
        "generatePostgresMigrationSQL / generateSqliteMigrationSQL, apply " +
        "that first, then still run createStoreWithSchema to commit the " +
        "schema row and contribution markers.",
    },
  );
}

/**
 * Initializes the schema for a new graph.
 *
 * Creates version 1 of the schema and marks it as active. Goes through
 * the same `commitSchemaVersion` primitive as `migrateSchema` so the
 * initial-commit race (two processes booting against an empty database
 * simultaneously) resolves with `StaleVersionError` or idempotent
 * success rather than a raw PK violation.
 *
 * @param backend - The database backend
 * @param graph - The graph definition
 * @returns The created schema version row
 */
export async function initializeSchema<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  options?: Readonly<{
    /**
     * The effective `SqlSchema` (custom table names) the graph's Store will
     * read. The identity enablement preflight is always derived internally —
     * it is deliberately not a parameter, so no caller can commit version 1
     * of an identity-enabled graph without the fold scan, contradiction
     * validation, and closure build.
     */
    schema?: SqlSchema;
  }>,
): Promise<SchemaVersionRow> {
  // Structural gates (e.g. endpoint-incompatible implies() relations)
  // must reject before the schema is durably committed, not only when a
  // Store is later constructed against it — buildKindRegistry throws the
  // same ConfigurationError a Store construction would, just earlier.
  buildKindRegistry(graph);

  const schema = serializeSchema(graph, 1);
  const hash = await computeSchemaHash(schema);
  const commit = {
    graphId: graph.id,
    expected: { kind: "initial" } as const,
    version: 1,
    schemaHash: hash,
    schemaDoc: schema,
  };

  if (graph.identity === undefined) {
    return backend.commitSchemaVersion(commit);
  }

  // An identity-enabled graph's FIRST schema commit is an enablement: a
  // legacy database populated through an unmanaged Store can already hold
  // same-id peers and assertions, so the fold scan, contradiction
  // validation, and closure build must commit atomically with version 1 —
  // exactly like a later enablement migration. Always DERIVED here (over
  // `options.schema` when supplied, else the backend's effective table
  // names), never accepted from the caller — a substitutable preflight would
  // let a no-op callback commit a version 1 that every later hash check
  // accepts while identity reads answer from a never-built closure.
  const preflight = await prepareIdentitySchemaCommit(backend, graph, {
    enablement: true,
    ...(options?.schema === undefined ? {} : { schema: options.schema }),
  });
  const commitWithPreflight = backend.commitSchemaVersionWithPreflight;
  if (commitWithPreflight === undefined) {
    throw new ConfigurationError(
      "This backend cannot atomically commit identity data with a schema transition.",
      {
        code: "IDENTITY_REQUIRES_ATOMIC_BACKEND",
        graphId: graph.id,
      },
    );
  }
  return commitWithPreflight(commit, preflight);
}

export type MigrateSchemaOptions = Readonly<{
  /**
   * Commit even when a dropped kind still holds rows.
   *
   * **This does not preserve those rows.** They are immediately unreachable —
   * nothing references the kind any more — and they are not safe from
   * deletion either: `materializeRemovals` re-derives removals by walking
   * schema-version history, so the next reconcile finds the dropped kind and
   * hard-deletes its rows, including soft-deleted ones. The flag buys a
   * committed schema, not retained data.
   *
   * If you need the rows, copy them out **before** committing. If you want
   * them removed, prefer `Store.removeKinds()`, which queues the cleanup
   * explicitly instead of relying on history reconciliation.
   *
   * Dropping an *empty* kind needs no flag — it strands nothing, and it is
   * the last step of the documented three-deploy kind-removal flow.
   *
   * @defaultValue false
   */
  discardDroppedKindRows?: boolean;
  /**
   * The effective `SqlSchema` (custom table names) the graph's Store reads.
   * The identity closure preflight an identity-enabled migration commits is
   * derived from it and cannot be substituted by callers.
   */
  schema?: SqlSchema;
}>;

/**
 * Migrates the schema to match the current graph definition.
 *
 * Creates a new schema version and atomically activates it via the
 * `commitSchemaVersion` backend primitive — insert and activate happen
 * in a single transactional unit with optimistic compare-and-swap on
 * the currently-active version. If another writer has advanced the
 * active version since `currentVersion` was read, this throws
 * `StaleVersionError`; the caller should refetch and retry.
 *
 * Folds the persisted graph extension into `graph` first, like every other
 * commit path — kinds committed at runtime by `Store.evolve()` live in
 * `schema_doc.extension`, so committing the caller's graph verbatim would
 * erase them while leaving their rows behind. Property-level breaking
 * changes (the documented "force the contract deploy" use) are unaffected.
 *
 * @param backend - The database backend
 * @param graph - The current graph definition
 * @param currentVersion - The current active schema version
 * @param options - See {@link MigrateSchemaOptions}
 * @returns The new version number
 * @throws MigrationError with `reason: "kind-removal"` when the commit would
 *   drop a kind that still holds rows and `discardDroppedKindRows` is not set.
 */
export async function migrateSchema<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  currentVersion: number,
  options?: MigrateSchemaOptions,
): Promise<number> {
  const {
    graph: target,
    storedSchema,
    activeRow,
  } = await loadAndMergeGraphExtensionDocument(backend, graph);

  // Staleness first. The commit's CAS would catch this anyway, but only after
  // the guard below has probed row counts against a baseline the caller never
  // saw — so a stale caller dropping a populated kind would get a
  // `kind-removal` MigrationError quoting versions that were never theirs,
  // instead of the `StaleVersionError` the concurrency contract documents.
  // Diagnose the caller's actual problem, and leave the CAS to catch writers
  // that advance the version after this point.
  if (activeRow !== undefined && activeRow.version !== currentVersion) {
    throw new StaleVersionError({
      graphId: graph.id,
      expected: currentVersion,
      actual: activeRow.version,
    });
  }

  const dropped =
    storedSchema === undefined ?
      []
    : [
        ...droppedKinds(storedSchema.nodes, getNodeKinds(target), "node"),
        ...droppedKinds(storedSchema.edges, getEdgeKinds(target), "edge"),
      ];
  const guardedDrops = options?.discardDroppedKindRows === true ? [] : dropped;
  // No cleanup is queued here, deliberately, and redundancy is the whole
  // reason. `materializeRemovals` derives removals by walking schema-version
  // history (`reconcilePendingRemovals` diffs consecutive documents' kind
  // sets), so a kind dropped by this commit is discovered and reclaimed on
  // the next reconcile whether or not a `typegraph_kind_removals` row exists
  // — on every path, `discardDroppedKindRows` included. Writing one would
  // change nothing except adding a second source of truth.
  //
  // The walk is only as good as retained history: `reconcilePendingRemovals`
  // stops at the first absent prior version, so a drop below a pruned or
  // gapped range becomes undiscoverable. Callers who prune schema versions
  // should run `materializeRemovals` before pruning.

  // An identity-enabled target commits through the same data preflight
  // `createStoreWithSchema` and `Store.evolve()` use: the closure is derived
  // state, so a version that changes the identity profile — or turns identity
  // on for the first time — must not become active while the closure still
  // reflects the previous schema. Explicit `migrateSchema()` is the path the
  // MigrationError message points operators at, so it cannot be the one path
  // that skips it.
  const identityPreflight =
    activeRow === undefined || target.identity === undefined ?
      undefined
    : await prepareIdentitySchemaCommit(backend, target, {
        enablement: storedSchema?.identity === undefined,
        ...(options?.schema === undefined ? {} : { schema: options.schema }),
      });

  const committed =
    identityPreflight === undefined ?
      guardedDrops.length > 0 ?
        await commitDroppedKindsOnlyWhenEmpty(
          backend,
          target,
          currentVersion,
          guardedDrops,
        )
      : await commitNewSchemaVersion(backend, target, currentVersion)
    : await commitNewSchemaVersionWithPreflight(
        backend,
        target,
        currentVersion,
        async (transactionBackend) => {
          // The emptiness fence moves inside the commit transaction here: the
          // preflight-carrying primitive is the only one that can also run the
          // identity rebuild atomically, so the probe runs alongside it rather
          // than through `commitSchemaVersionIfKindsEmpty`.
          await assertDroppedKindsEmpty(
            transactionBackend,
            target.id,
            currentVersion,
            guardedDrops,
          );
          await identityPreflight(transactionBackend);
        },
      );
  return committed.version;
}

/**
 * Ensures identity storage exists and builds the preflight the schema commit
 * runs inside its own transaction. The DDL must happen *before* the commit
 * transaction opens — issuing it inside would re-enter the per-graph write lock
 * the commit holds.
 */
async function prepareIdentitySchemaCommit<G extends GraphDef>(
  backend: GraphBackend,
  target: G,
  options: Readonly<{ enablement: boolean; schema?: SqlSchema }>,
): Promise<(transactionBackend: TransactionBackend) => Promise<void>> {
  const schema = options.schema ?? createSqlSchema(backend.tableNames);
  await ensureIdentitySchemaStorage(backend, schema, {
    graphId: target.id,
    enablement: options.enablement,
  });
  return identitySchemaCommitPreflight(
    {
      graphId: target.id,
      registry: buildKindRegistry(target),
      schema,
      sameIdAcrossKinds: target.identity?.sameIdAcrossKinds ?? "ignore",
    },
    options,
  );
}

/**
 * Refuses a commit that would drop kinds still holding rows, from inside the
 * commit transaction. The transactional sibling of
 * {@link commitDroppedKindsOnlyWhenEmpty}'s backend-side probe.
 */
async function assertDroppedKindsEmpty(
  backend: TransactionBackend,
  graphId: string,
  currentVersion: number,
  dropped: readonly DroppedKind[],
): Promise<void> {
  const counts = await Promise.all(
    dropped.map(async (entry) => ({
      entity: entry.entity,
      kind: entry.kind,
      count:
        entry.entity === "node" ?
          await backend.countNodesByKind({ graphId, kind: entry.kind })
        : await backend.countEdgesByKind({ graphId, kind: entry.kind }),
    })),
  );
  const populated = counts.filter((entry) => entry.count > 0);
  if (populated.length === 0) return;
  throwPopulatedKindRemovalError(graphId, currentVersion, populated);
}

/**
 * Refuses a schema commit that would destroy rows.
 *
 * The invariant is not "no kind is dropped" — it is "no *populated* kind is
 * destroyed by accident". Dropping an empty kind loses nothing and is the
 * last step of the documented three-deploy removal flow (stop writing →
 * delete the rows → drop from `defineGraph`). Dropping a kind that still
 * holds rows makes them unreachable immediately, and the next
 * `materializeRemovals` — which re-derives removals from schema history —
 * deletes them. The commit is the point of no return, which is why the
 * refusal happens here rather than being left to the reconciler.
 *
 * The remedy is never `Store.removeKinds()`. The fold re-adds every
 * extension kind before this runs, so a dropped kind is always a
 * *compile-time* kind — exactly the class `removeKinds` rejects
 * (`RemoveCompileTimeKindError`). Callers export or delete the rows and
 * retry, or opt into the loss.
 *
 * Mirrors the probe `Store.evolve` already runs for tightening changes, and
 * lives in the public `migrateSchema` rather than in
 * `commitNewSchemaVersion` because `Store.removeKinds` commits through that
 * primitive and drops populated kinds *by design*, having queued their
 * cleanup rows first.
 *
 * The populated-kind probes and schema CAS run through the backend's atomic
 * `commitSchemaVersionIfKindsEmpty` primitive. PostgreSQL schema changes lock
 * the active schema row FOR UPDATE while managed Store writes lock it FOR SHARE
 * and revalidate its version; SQLite serializes both with its existing BEGIN
 * IMMEDIATE writer slot. This prevents a participating schema-managed Store
 * write from landing between the final count and schema CAS, and rejects a
 * stale Store after the schema change releases the fence. Raw Stores and direct
 * backend writes remain outside this guarantee.
 */
async function commitDroppedKindsOnlyWhenEmpty<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  currentVersion: number,
  dropped: readonly DroppedKind[],
): Promise<SchemaVersionRow> {
  const result = await commitNewSchemaVersionIfKindsEmpty(
    backend,
    graph,
    currentVersion,
    dropped,
  );
  if (result.status === "committed") return result.row;

  throwPopulatedKindRemovalError(graph.id, currentVersion, result.kinds);
}

function throwPopulatedKindRemovalError(
  graphId: string,
  currentVersion: number,
  populated: readonly PopulatedSchemaKind[],
): never {
  const named = populated
    .map((entry) => `${entry.entity} "${entry.kind}" (${String(entry.count)})`)
    .join(", ");
  throw new MigrationError(
    `Refusing to commit a schema for graph "${graphId}" that drops kinds ` +
      `still holding rows: ${named}. Committing would make those rows ` +
      `unreachable, and the next materializeRemovals() would delete them. ` +
      `Export or delete those rows, then retry. Pass ` +
      `{ discardDroppedKindRows: true } if losing them is the intent.`,
    {
      graphId,
      fromVersion: currentVersion,
      toVersion: currentVersion + 1,
      reason: "kind-removal",
      droppedKinds: {
        nodes: populated
          .filter((entry) => entry.entity === "node")
          .map((entry) => entry.kind),
        edges: populated
          .filter((entry) => entry.entity === "edge")
          .map((entry) => entry.kind),
      },
    },
  );
}

type DroppedKind = Readonly<{
  kind: string;
  entity: KindEntity;
}>;

/**
 * Kind names present in a committed schema slice but absent from the graph
 * about to be committed. Sorted so the error message and
 * `details.droppedKinds` are stable across object-key iteration order.
 */
function droppedKinds(
  committed: Readonly<Record<string, unknown>>,
  present: readonly string[],
  entity: KindEntity,
): readonly DroppedKind[] {
  const kinds = new Set(present);
  return Object.keys(committed)
    .filter((name) => !kinds.has(name))
    .toSorted()
    .map((kind) => ({ kind, entity }));
}

/**
 * Internal sibling of `migrateSchema` that surfaces the committed
 * `SchemaVersionRow` directly. The public `migrateSchema` keeps its
 * `number`-returning signature for API stability; callers that already
 * own the row (`Store.evolve`, `Store.removeKinds`) use this to skip a
 * post-commit `getActiveSchema` round-trip.
 */
export async function commitNewSchemaVersion<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  currentVersion: number,
): Promise<SchemaVersionRow> {
  const params = await buildNewSchemaVersionCommit(graph, currentVersion);
  return backend.commitSchemaVersion(params);
}

/**
 * Atomic sibling used by compatibility guards that require selected kinds to
 * remain empty through the schema CAS.
 */
export async function commitNewSchemaVersionIfKindsEmpty<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  currentVersion: number,
  probes: readonly SchemaKindEmptinessProbe[],
): Promise<CommitSchemaVersionIfKindsEmptyResult> {
  const params = await buildNewSchemaVersionCommit(graph, currentVersion);
  const commitIfKindsEmpty = backend.commitSchemaVersionIfKindsEmpty;
  if (commitIfKindsEmpty === undefined) {
    throw new ConfigurationError(
      "This backend cannot atomically fence entity writes while checking " +
        "schema kind emptiness.",
      {
        code: "SCHEMA_KIND_EMPTINESS_FENCE_UNSUPPORTED",
        graphId: graph.id,
      },
    );
  }
  return commitIfKindsEmpty(params, probes);
}

async function buildNewSchemaVersionCommit<G extends GraphDef>(
  graph: G,
  currentVersion: number,
): Promise<CommitSchemaVersionParams> {
  // See initializeSchema: reject structurally invalid graphs (e.g.
  // endpoint-incompatible implies() relations) before committing, not
  // only when a Store is later built against the committed version.
  buildKindRegistry(graph);

  const newVersion = currentVersion + 1;
  const schema = serializeSchema(graph, newVersion);
  const hash = await computeSchemaHash(schema);
  return {
    graphId: graph.id,
    expected: { kind: "active", version: currentVersion },
    version: newVersion,
    schemaHash: hash,
    schemaDoc: schema,
  };
}

/** @internal Commits a data preflight and schema CAS in one transaction. */
export async function commitNewSchemaVersionWithPreflight<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  currentVersion: number,
  preflight: (target: TransactionBackend) => Promise<void>,
): Promise<SchemaVersionRow> {
  const commitWithPreflight = backend.commitSchemaVersionWithPreflight;
  if (commitWithPreflight === undefined) {
    // Match the graph-validation ordering of the plain path: reject a
    // structurally invalid graph before probing backend capability.
    buildKindRegistry(graph);
    throw new ConfigurationError(
      "This backend cannot atomically commit identity data with a schema transition.",
      {
        code: "IDENTITY_REQUIRES_ATOMIC_BACKEND",
        graphId: graph.id,
      },
    );
  }
  return commitWithPreflight(
    await buildNewSchemaVersionCommit(graph, currentVersion),
    preflight,
  );
}

/**
 * Rolls back the active schema to a previous version.
 *
 * The target version must already exist in the version history.
 * This does not delete newer versions — it simply switches the active pointer.
 *
 * Uses the `setActiveVersion` backend primitive, which performs the flip
 * atomically with optimistic compare-and-swap on the currently-active
 * version. Concurrent rollbacks or commits surface as
 * `StaleVersionError`.
 *
 * @param backend - The database backend
 * @param graphId - The graph ID
 * @param targetVersion - The version to roll back to
 * @throws MigrationError if the target version does not exist
 * @throws StaleVersionError if another writer changed the active version concurrently
 */
export async function rollbackSchema(
  backend: GraphBackend,
  graphId: string,
  targetVersion: number,
): Promise<void> {
  const activeRow = await backend.getActiveSchema(graphId);
  if (activeRow === undefined) {
    throw new MigrationError(
      `Cannot rollback graph "${graphId}": no active schema version exists.`,
      {
        graphId,
        fromVersion: 0,
        toVersion: targetVersion,
        reason: "no-active-version",
      },
    );
  }
  await backend.setActiveVersion({
    graphId,
    expected: { kind: "active", version: activeRow.version },
    version: targetVersion,
  });
}

/**
 * Gets the current active schema for a graph — the committed document itself,
 * with the `nodes` / `edges` / `ontology` maps the database actually holds.
 *
 * This is the answer to "what kinds does this database already have?". Use
 * {@link getCommittedSchemaVersion} when only the version number is needed.
 *
 * @param backend - The database backend
 * @param graphId - The graph ID
 * @returns The active schema or undefined if not initialized
 */
export async function getActiveSchema(
  backend: GraphBackend,
  graphId: string,
): Promise<SerializedSchema | undefined> {
  const row = await backend.getActiveSchema(graphId);
  if (row === undefined) return undefined;
  return parseSerializedSchema(row.schema_doc);
}

/**
 * Checks if a graph's schema has been initialized.
 *
 * @param backend - The database backend
 * @param graphId - The graph ID
 * @returns True if the schema has been initialized
 */
export async function isSchemaInitialized(
  backend: GraphBackend,
  graphId: string,
): Promise<boolean> {
  const row = await backend.getActiveSchema(graphId);
  return row !== undefined;
}

/**
 * Gets the schema diff between the stored schema and current graph.
 *
 * @param backend - The database backend
 * @param graph - The current graph definition
 * @returns The diff, or undefined if schema not initialized
 */
export async function getSchemaChanges<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
): Promise<SchemaDiff | undefined> {
  const activeRow = await backend.getActiveSchema(graph.id);
  if (activeRow === undefined) return undefined;

  // Fold in the persisted graph-extension first — the same merge the commit
  // path performs. Without it a compile-time graph is diffed against a stored
  // schema that also contains runtime-committed kinds, so those kinds read as
  // removals and an unchanged schema looks like it needs a breaking migration.
  const { graph: merged, storedSchema } = mergeStoredGraphExtension(
    graph,
    activeRow,
  );
  const currentSchema = serializeSchema(merged, activeRow.version + 1);

  return computeSchemaDiff(storedSchema, currentSchema);
}

/**
 * Whether committing `graph` would require a schema migration — a SELECT-only
 * pre-flight with no DDL and no writes.
 *
 * Returns `true` when the schema has not been initialized yet (the privileged
 * bootstrap is required) and when the committed schema is behind `graph`.
 * This is the predicate a least-privilege runtime checks to route to the
 * privileged path *before* a write discovers the migration wall mid-request.
 *
 * For the additive-vs-incompatible distinction, use `getSchemaChanges` and
 * {@link classifySchemaChanges} instead — this collapses both to `true`.
 *
 * @param backend - The database backend
 * @param graph - The current graph definition
 * @returns Whether a privileged migration/bootstrap is required.
 */
export async function requiresMigration<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
): Promise<boolean> {
  const diff = await getSchemaChanges(backend, graph);
  if (diff === undefined) return true;
  return diff.hasChanges;
}

/**
 * Reads the committed schema version for a graph in a single round-trip — no
 * schema reconcile, no diff, no materialization-marker reads.
 *
 * This is the cross-isolate invalidation probe for a cached reconciled schema:
 * compare the returned version against the one a verified open recorded
 * (`store.reconciledSchema.version`); when it has moved, another process
 * committed a schema change and the cached reconciliation must be refreshed via
 * `createVerifiedAdapterStore`. One read replaces the three-query verified open
 * on the steady-state (unchanged) path — the round-trip that saturated the
 * connection pool under fan-out.
 *
 * It reads the active schema *row* (via `backend.getActiveSchema`), so the
 * committed `schema_doc` is transferred and normalized even though only the
 * version is used. A version-only backend query would shrink the payload
 * further; it is a backward-compatible follow-up, not required for the
 * round-trip win above.
 *
 * Returns only the version; for the document it names, see
 * {@link getActiveSchema}.
 *
 * @param backend - The database backend
 * @param graphId - The graph ID
 * @returns The active committed version, or `undefined` if the schema has not
 *   been initialized for this graph.
 */
export async function getCommittedSchemaVersion(
  backend: GraphBackend,
  graphId: string,
): Promise<number | undefined> {
  const row = await backend.getActiveSchema(graphId);
  return row?.version;
}
