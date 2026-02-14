/**
 * Schema Management Module
 *
 * Provides serialization, deserialization, migration, and versioning
 * for TypeGraph schemas.
 *
 * @example
 * ```typescript
 * import { initializeSchema, ensureSchema, migrateSchema } from "@nicia-ai/typegraph/schema";
 *
 * // Initialize schema versioning for a store
 * await initializeSchema(store);
 *
 * // Ensure schema matches the graph definition
 * const result = await ensureSchema(store);
 *
 * // Compute diff between schema versions
 * const diff = computeSchemaDiff(oldSchema, newSchema);
 * ```
 */

// ============================================================
// Serialization
// ============================================================

export { type DeserializedSchema, deserializeSchema } from "./deserializer";
export {
  computeSchemaHash,
  deserializeWherePredicate,
  serializeSchema,
} from "./serializer";

// ============================================================
// Schema Manager
// ============================================================

export {
  ensureSchema,
  getActiveSchema,
  getSchemaChanges,
  initializeSchema,
  isSchemaInitialized,
  migrateSchema,
  type MigrationHookContext,
  rollbackSchema,
  type SchemaManagerOptions,
  type SchemaValidationResult,
} from "./manager";

// ============================================================
// Migration
// ============================================================

export {
  type ChangeSeverity,
  type ChangeType,
  computeSchemaDiff,
  type EdgeChange,
  getMigrationActions,
  isBackwardsCompatible,
  type NodeChange,
  type OntologyChange,
  type SchemaDiff,
} from "./migration";

// ============================================================
// Validation Utilities
// ============================================================

export type { ValidationContext } from "../errors/validation";
export {
  createValidationError,
  validateEdgeProps,
  validateNodeProps,
  validateProps,
  wrapZodError,
} from "../errors/validation";

// ============================================================
// Types
// ============================================================

export type {
  JsonSchema,
  SchemaHash,
  SerializedClosures,
  SerializedEdgeDef,
  SerializedMetaEdge,
  SerializedNodeDef,
  SerializedOntology,
  SerializedOntologyRelation,
  SerializedSchema,
  SerializedUniqueConstraint,
} from "./types";
