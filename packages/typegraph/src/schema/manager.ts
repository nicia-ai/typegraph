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
import { DatabaseOperationError, MigrationError } from "../errors";
import { mergeRuntimeExtension } from "../runtime/merge";
import {
  computeSchemaDiff,
  getMigrationActions,
  isBackwardsCompatible,
  type SchemaDiff,
} from "./migration";
import { computeSchemaHash, serializeSchema } from "./serializer";
import { type SerializedSchema, serializedSchemaZod } from "./types";

/**
 * Parses and validates a serialized schema document from the database.
 *
 * Uses the Zod schema to validate the full nested structure, catching
 * corruption, incompatible schema versions, or truncated JSON at the
 * parse boundary rather than letting invalid data propagate silently.
 */
export function parseSerializedSchema(json: string): SerializedSchema {
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
  return result.data as SerializedSchema;
}

// ============================================================
// Helpers
// ============================================================

const MISSING_TABLE_PATTERNS = [
  "no such table", // SQLite
  "does not exist", // PostgreSQL ("relation ... does not exist")
  "SQLITE_ERROR", // D1 / Durable Objects error code
];

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_TABLE_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Reads the active schema row, bootstrapping the base tables on the
 * first call against an empty database.
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
 * Reads the active schema, parses it, and folds any persisted runtime
 * extension document into the supplied compile-time graph. Returns the
 * merged graph alongside the prefetched row + parsed schema so the
 * caller can pass them through to `ensureSchema` without paying for a
 * second `getActiveSchema` round trip or a second
 * `serializedSchemaZod` walk.
 *
 * Throws `ConfigurationError` if the persisted runtime document
 * references a compile-time kind that no longer exists (the
 * startup-conflict case).
 */
export async function loadAndMergeRuntimeDocument<G extends GraphDef>(
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
  const storedSchema = parseSerializedSchema(activeRow.schema_doc);
  if (storedSchema.runtimeDocument === undefined) {
    return { graph, activeRow, storedSchema };
  }
  return {
    graph: mergeRuntimeExtension(graph, storedSchema.runtimeDocument),
    activeRow,
    storedSchema,
  };
}

// ============================================================
// Types
// ============================================================

/**
 * Result of schema validation.
 */
export type SchemaValidationResult =
  | { status: "initialized"; version: number }
  | { status: "unchanged"; version: number }
  | {
      status: "migrated";
      fromVersion: number;
      toVersion: number;
      diff: SchemaDiff;
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
     * and `parseSerializedSchema` to peek at `runtimeDocument`, it
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
  // would then diff a runtime-extended persisted schema against the
  // unmerged graph and throw a misleading MigrationError. With the
  // sentinel check the race surfaces as a clean `StaleVersionError`
  // from `commitSchemaVersion` inside `initializeSchema` instead.
  const preloaded = options?.preloaded;
  const activeSchema =
    preloaded === undefined ?
      await loadActiveSchemaWithBootstrap(backend, graph.id)
    : preloaded.activeRow;

  if (!activeSchema) {
    // No schema exists - initialize with version 1
    const result = await initializeSchema(backend, graph);
    return { status: "initialized", version: result.version };
  }

  // Reuse the loader's parsed schema when supplied; otherwise parse now.
  const storedSchema =
    preloaded?.storedSchema ?? parseSerializedSchema(activeSchema.schema_doc);

  // Serialize the current graph for comparison
  const currentSchema = serializeSchema(graph, activeSchema.version + 1);

  // Quick hash check - if hashes match, schemas are identical
  const storedHash = activeSchema.schema_hash;
  const currentHash = await computeSchemaHash(currentSchema);

  if (storedHash === currentHash) {
    return { status: "unchanged", version: activeSchema.version };
  }

  // Hashes differ - compute the diff
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
      const newVersion = await migrateSchema(
        backend,
        graph,
        activeSchema.version,
      );
      await options?.onAfterMigrate?.(hookContext);
      return {
        status: "migrated",
        fromVersion: activeSchema.version,
        toVersion: newVersion,
        diff,
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
  const newVersion = currentVersion + 1;
  const schema = serializeSchema(graph, newVersion);
  const hash = await computeSchemaHash(schema);

  await backend.commitSchemaVersion({
    graphId: graph.id,
    expected: { kind: "active", version: currentVersion },
    version: newVersion,
    schemaHash: hash,
    schemaDoc: schema,
  });

  return newVersion;
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
  if (!activeRow) {
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
  if (!row) return undefined;
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
  if (!activeSchema) return undefined;

  const storedSchema = parseSerializedSchema(activeSchema.schema_doc);
  const currentSchema = serializeSchema(graph, activeSchema.version + 1);

  return computeSchemaDiff(storedSchema, currentSchema);
}
