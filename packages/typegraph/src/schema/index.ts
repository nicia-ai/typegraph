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

export type {
  ContributionDiagnostic,
  ContributionDiagnosticState,
  ContributionRepairEntry,
  ContributionRepairResult,
} from "../backend/types";

// ============================================================
// Serialization
// ============================================================

export { type DeserializedSchema, deserializeSchema } from "./deserializer";
export type {
  GraphTemplate,
  InstantiateGraphTemplateResult,
} from "./graph-templates";
export {
  instantiateGraph,
  instantiateGraphTemplate,
  registerGraphTemplate,
} from "./graph-templates";
export {
  computeSchemaHash,
  deserializeWherePredicate,
  serializeSchema,
} from "./serializer";

// ============================================================
// Schema Manager
// ============================================================

export {
  applyDeprecatedKinds,
  assertSchemaCurrent,
  ensureSchema,
  getActiveSchema,
  getCommittedSchemaVersion,
  getSchemaChanges,
  initializeSchema,
  isSchemaInitialized,
  loadActiveSchemaWithBootstrap,
  loadAndMergeGraphExtensionDocument,
  migrateSchema,
  type MigrateSchemaOptions,
  type MigrationHookContext,
  parseSerializedSchema,
  requiresMigration,
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
  classifySchemaChanges,
  computeSchemaDiff,
  type DeprecatedKindsChange,
  type EdgeChange,
  type ExtensionChange,
  getMigrationActions,
  type IdentityChange,
  type IndexChange,
  isBackwardsCompatible,
  type NodeChange,
  type OntologyChange,
  type SchemaChangeClassification,
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

export type { GraphIdentityConfig } from "../core/define-graph";
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
