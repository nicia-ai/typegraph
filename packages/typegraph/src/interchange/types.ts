/**
 * Graph interchange format types.
 *
 * Defines Zod schemas for importing and exporting graph data.
 * The format is designed to be:
 * - JSON-serializable for API transport
 * - Validated via Zod at runtime
 * - Exportable as JSON Schema for LLM/API documentation
 */
import { z } from "zod";

// ============================================================
// Format Version
// ============================================================

/**
 * Current interchange format version.
 * Increment for breaking changes to the format.
 */
export const FORMAT_VERSION = "1.0" as const;

// ============================================================
// Node Interchange
// ============================================================

/**
 * Interchange format for a node.
 *
 * Properties are stored as a record to allow schema-agnostic transport.
 * Validation against the actual schema happens during import.
 */
export const InterchangeNodeSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
  meta: z
    .object({
      version: z.number().int().positive().optional(),
      createdAt: z.iso.datetime().optional(),
      updatedAt: z.iso.datetime().optional(),
    })
    .optional(),
});

export type InterchangeNode = z.infer<typeof InterchangeNodeSchema>;

// ============================================================
// Edge Interchange
// ============================================================

/**
 * Interchange format for an edge.
 *
 * Endpoint references are objects with kind and id, rather than
 * composite strings, for clarity and type safety.
 */
export const InterchangeEdgeSchema = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  from: z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
  }),
  to: z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
  }),
  properties: z.record(z.string(), z.unknown()).default({}),
  validFrom: z.iso.datetime().optional(),
  validTo: z.iso.datetime().optional(),
  meta: z
    .object({
      createdAt: z.iso.datetime().optional(),
      updatedAt: z.iso.datetime().optional(),
    })
    .optional(),
});

export type InterchangeEdge = z.infer<typeof InterchangeEdgeSchema>;

// ============================================================
// Import Configuration
// ============================================================

/**
 * Strategy for handling conflicts when a node/edge ID already exists.
 *
 * - `skip`: Keep existing, ignore incoming
 * - `update`: Merge incoming properties into existing
 * - `error`: Throw an error on conflict
 */
export const ConflictStrategySchema = z.enum(["skip", "update", "error"]);
export type ConflictStrategy = z.infer<typeof ConflictStrategySchema>;

/**
 * Strategy for handling properties not defined in the schema.
 *
 * - `error`: Throw a validation error
 * - `strip`: Remove unknown properties silently
 * - `allow`: Pass through to storage (relies on backend behavior)
 */
export const UnknownPropertyStrategySchema = z.enum([
  "error",
  "strip",
  "allow",
]);
export type UnknownPropertyStrategy = z.infer<
  typeof UnknownPropertyStrategySchema
>;

/**
 * Options for importing graph data.
 */
export const ImportOptionsSchema = z.object({
  /** How to handle existing nodes/edges with the same ID */
  onConflict: ConflictStrategySchema,
  /** How to handle properties not in the schema */
  onUnknownProperty: UnknownPropertyStrategySchema.default("error"),
  /** Whether to validate that edge endpoints exist */
  validateReferences: z.boolean().default(true),
  /** Number of items to process in each batch */
  batchSize: z.number().int().positive().default(100),
});

export type ImportOptions = z.infer<typeof ImportOptionsSchema>;

// ============================================================
// Graph Data Source
// ============================================================

/**
 * Source metadata for graph data.
 *
 * Uses discriminated union to capture different origin types:
 * - `typegraph-cloud`: Extracted by TypeGraph Cloud
 * - `typegraph-export`: Exported from a TypeGraph store
 * - `external`: From a third-party system
 */
export const GraphDataSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("typegraph-cloud"),
    extractionId: z.string(),
    schemaId: z.string(),
    schemaVersion: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("typegraph-export"),
    graphId: z.string(),
    schemaVersion: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("external"),
    description: z.string().optional(),
  }),
]);

export type GraphDataSource = z.infer<typeof GraphDataSourceSchema>;

// ============================================================
// Graph Data Envelope
// ============================================================

/**
 * Complete graph data interchange format.
 *
 * The envelope contains metadata about the data source and format version,
 * plus arrays of nodes and edges to import.
 */
export const GraphDataSchema = z.object({
  formatVersion: z.literal(FORMAT_VERSION),
  exportedAt: z.iso.datetime(),
  source: GraphDataSourceSchema,
  nodes: z.array(InterchangeNodeSchema),
  edges: z.array(InterchangeEdgeSchema),
});

export type GraphData = z.infer<typeof GraphDataSchema>;

// ============================================================
// Import Result
// ============================================================

/**
 * An error that occurred during import.
 */
export const ImportErrorSchema = z.object({
  entityType: z.enum(["node", "edge"]),
  kind: z.string(),
  id: z.string(),
  error: z.string(),
});

export type ImportError = z.infer<typeof ImportErrorSchema>;

/**
 * Result of an import operation.
 *
 * Contains counts of created/updated/skipped entities and any errors.
 */
export const ImportResultSchema = z.object({
  success: z.boolean(),
  nodes: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  edges: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  errors: z.array(ImportErrorSchema),
});

export type ImportResult = z.infer<typeof ImportResultSchema>;

// ============================================================
// Export Options
// ============================================================

/**
 * Options for exporting graph data.
 */
export const ExportOptionsSchema = z.object({
  /** Filter to specific node kinds (undefined = all) */
  nodeKinds: z.array(z.string()).optional(),
  /** Filter to specific edge kinds (undefined = all) */
  edgeKinds: z.array(z.string()).optional(),
  /** Include temporal fields (validFrom, validTo) */
  includeTemporal: z.boolean().default(false),
  /** Include metadata (version, timestamps) */
  includeMeta: z.boolean().default(false),
  /** Include soft-deleted records */
  includeDeleted: z.boolean().default(false),
});

/** Export options with defaults applied (output type) */
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

/** Export options as accepted by exportGraph (input type with optional defaults) */
export type ExportOptionsInput = z.input<typeof ExportOptionsSchema>;
