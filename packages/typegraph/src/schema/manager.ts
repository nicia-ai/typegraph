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
import { MigrationError } from "../errors";
import {
  computeSchemaDiff,
  getMigrationActions,
  isBackwardsCompatible,
  type SchemaDiff,
} from "./migration";
import { computeSchemaHash, serializeSchema } from "./serializer";
import { type SerializedSchema } from "./types";

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
  options?: SchemaManagerOptions,
): Promise<SchemaValidationResult> {
  const autoMigrate = options?.autoMigrate ?? true;
  const throwOnBreaking = options?.throwOnBreaking ?? true;

  // Get the active schema from the database
  const activeSchema = await backend.getActiveSchema(graph.id);

  if (!activeSchema) {
    // No schema exists - initialize with version 1
    const result = await initializeSchema(backend, graph);
    return { status: "initialized", version: result.version };
  }

  // Parse the stored schema
  const storedSchema = JSON.parse(activeSchema.schema_doc) as SerializedSchema;

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
 * Creates version 1 of the schema and marks it as active.
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

  return backend.insertSchema({
    graphId: graph.id,
    version: 1,
    schemaHash: hash,
    schemaDoc: schema,
    isActive: true,
  });
}

/**
 * Migrates the schema to match the current graph definition.
 *
 * This creates a new schema version and marks it as active.
 * The old version is preserved for history/rollback.
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

  // Insert new version (not active yet)
  await backend.insertSchema({
    graphId: graph.id,
    version: newVersion,
    schemaHash: hash,
    schemaDoc: schema,
    isActive: false,
  });

  // Atomically switch to the new version
  await backend.setActiveSchema(graph.id, newVersion);

  return newVersion;
}

/**
 * Rolls back the active schema to a previous version.
 *
 * The target version must already exist in the version history.
 * This does not delete newer versions — it simply switches the active pointer.
 *
 * @param backend - The database backend
 * @param graphId - The graph ID
 * @param targetVersion - The version to roll back to
 * @throws MigrationError if the target version does not exist
 */
export async function rollbackSchema(
  backend: GraphBackend,
  graphId: string,
  targetVersion: number,
): Promise<void> {
  const row = await backend.getSchemaVersion(graphId, targetVersion);
  if (!row) {
    throw new MigrationError(
      `Cannot rollback to version ${targetVersion}: version does not exist.`,
      { graphId, fromVersion: targetVersion, toVersion: targetVersion },
    );
  }
  await backend.setActiveSchema(graphId, targetVersion);
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
  return JSON.parse(row.schema_doc) as SerializedSchema;
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

  const storedSchema = JSON.parse(activeSchema.schema_doc) as SerializedSchema;
  const currentSchema = serializeSchema(graph, activeSchema.version + 1);

  return computeSchemaDiff(storedSchema, currentSchema);
}
