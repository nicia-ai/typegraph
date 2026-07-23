/**
 * Schema manager for TypeGraph.
 *
 * Provides schema lifecycle management:
 * - Initialization on first store creation
 * - Validation on store open
 * - Auto-migration for safe changes
 * - Error reporting for breaking changes
 */
import { type GraphBackend, type SchemaVersionRow } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import {
  ConfigurationError,
  DatabaseOperationError,
  MigrationError,
} from "../errors";
import { mergeGraphExtension } from "../graph-extension/merge";
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
 */
function mergeStoredGraphExtension<G extends GraphDef>(
  graph: G,
  activeRow: SchemaVersionRow,
): Readonly<{ graph: G; storedSchema: SerializedSchema }> {
  const storedSchema = parseSerializedSchema(activeRow.schema_doc);
  const merged =
    storedSchema.extension === undefined ?
      graph
    : mergeGraphExtension(graph, storedSchema.extension);
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
    // No schema exists - initialize with version 1
    const result = await initializeSchema(backend, graph);
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
      const committedRow = await commitNewSchemaVersion(
        backend,
        graph,
        activeSchema.version,
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
    throw new MigrationError(
      `Schema migration required: ${diff.summary}. ` +
        `${actions.length} migration action(s) needed. ` +
        `Use getSchemaChanges() to review, then migrateSchema() to apply.`,
      {
        graphId: graph.id,
        fromVersion: activeSchema.version,
        toVersion: activeSchema.version + 1,
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
): Promise<SchemaVersionRow> {
  // Structural gates (e.g. endpoint-incompatible implies() relations)
  // must reject before the schema is durably committed, not only when a
  // Store is later constructed against it — buildKindRegistry throws the
  // same ConfigurationError a Store construction would, just earlier.
  buildKindRegistry(graph);

  const schema = serializeSchema(graph, 1);
  const hash = await computeSchemaHash(schema);

  return backend.commitSchemaVersion({
    graphId: graph.id,
    expected: { kind: "initial" },
    version: 1,
    schemaHash: hash,
    schemaDoc: schema,
  });
}

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
 * @param backend - The database backend
 * @param graph - The current graph definition
 * @param currentVersion - The current active schema version
 * @returns The new version number
 */
export async function migrateSchema<G extends GraphDef>(
  backend: GraphBackend,
  graph: G,
  currentVersion: number,
): Promise<number> {
  const committed = await commitNewSchemaVersion(
    backend,
    graph,
    currentVersion,
  );
  return committed.version;
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
  // See initializeSchema: reject structurally invalid graphs (e.g.
  // endpoint-incompatible implies() relations) before committing, not
  // only when a Store is later built against the committed version.
  buildKindRegistry(graph);

  const newVersion = currentVersion + 1;
  const schema = serializeSchema(graph, newVersion);
  const hash = await computeSchemaHash(schema);

  return backend.commitSchemaVersion({
    graphId: graph.id,
    expected: { kind: "active", version: currentVersion },
    version: newVersion,
    schemaHash: hash,
    schemaDoc: schema,
  });
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
      { graphId, fromVersion: 0, toVersion: targetVersion },
    );
  }
  await backend.setActiveVersion({
    graphId,
    expected: { kind: "active", version: activeRow.version },
    version: targetVersion,
  });
}

/**
 * Gets the current active schema for a graph.
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
  const activeSchema = await backend.getActiveSchema(graph.id);
  if (activeSchema === undefined) return undefined;

  const storedSchema = parseSerializedSchema(activeSchema.schema_doc);
  const currentSchema = serializeSchema(graph, activeSchema.version + 1);

  return computeSchemaDiff(storedSchema, currentSchema);
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
