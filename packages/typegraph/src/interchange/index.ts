/**
 * Graph Interchange Module
 *
 * Provides import/export functionality for graph data in a standardized
 * JSON format. Use this module to:
 *
 * - Export graph data for backup or transfer
 * - Exchange data between TypeGraph instances and external systems
 *
 * @example
 * ```typescript
 * import { importGraph, exportGraph, GraphDataSchema } from "@nicia-ai/typegraph/interchange";
 *
 * // Validate and import data exported from another store
 * const data = GraphDataSchema.parse(exportedJson);
 * const result = await importGraph(store, data, {
 *   onConflict: "update",
 *   onUnknownProperty: "strip",
 * });
 *
 * // Export for backup
 * const backup = await exportGraph(store, { includeMeta: true });
 * ```
 */

// ============================================================
// Types & Schemas
// ============================================================

export {
  // Inferred types
  type ConflictStrategy,
  // Zod schemas (for validation, JSON Schema generation)
  ConflictStrategySchema,
  type ExportOptions,
  type ExportOptionsInput,
  ExportOptionsSchema,
  FORMAT_VERSION,
  type GraphData,
  GraphDataSchema,
  type GraphDataSource,
  GraphDataSourceSchema,
  type ImportError,
  ImportErrorSchema,
  type ImportOptions,
  ImportOptionsSchema,
  type ImportResult,
  ImportResultSchema,
  type InterchangeEdge,
  InterchangeEdgeSchema,
  type InterchangeNode,
  InterchangeNodeSchema,
  type UnknownPropertyStrategy,
  UnknownPropertyStrategySchema,
} from "./types";

// ============================================================
// Functions
// ============================================================

export { exportGraph } from "./export";
export { importGraph } from "./import";
