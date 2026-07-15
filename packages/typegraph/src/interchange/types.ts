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

import { isCanonicalIsoDate } from "../utils/date";

// ============================================================
// Format Version
// ============================================================

/**
 * Current interchange format version — the value every export writes.
 *
 * Read-side compatibility policy: the format is versioned separately from what
 * it *accepts*. A 1.0 document is a structurally valid 2.0 document — the only
 * 2.0 addition is the optional `identity` section — so import and
 * {@link GraphDataSchema} accept both `"1.0"` and `"2.0"` (see
 * {@link AcceptedFormatVersionSchema}), while exports keep writing this
 * constant. Bump this only when exports must emit a new version; add the old
 * value to the accepted set rather than dropping read compatibility.
 */
export const FORMAT_VERSION = "2.0" as const;

/**
 * Format versions accepted on the read side (import + `GraphDataSchema.parse`).
 * A pre-existing 1.0 export is a valid 2.0 document (the 2.0 change is the
 * additive optional `identity` section), so both validate; exports always write
 * {@link FORMAT_VERSION}.
 */
const AcceptedFormatVersionSchema = z.enum(["1.0", "2.0"]);

/**
 * A stored validity-window timestamp (`validFrom` / `validTo`). Must be a
 * canonical fixed-width UTC ISO-8601 string (`YYYY-MM-DDTHH:mm:ss.sssZ`) — the
 * same contract `create` / `update` enforce — because temporal filters compare
 * it as text against the `asOf` read coordinate, and a variable-width value
 * (date-only, offset, missing/variable milliseconds) would mis-sort and
 * silently include or exclude the wrong rows. Convert non-canonical inputs with
 * `new Date(value).toISOString()`.
 */
const ValidityTimestampSchema = z.iso
  .datetime()
  .refine((value) => isCanonicalIsoDate(value), {
    message:
      "Expected canonical UTC ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ); convert with new Date(value).toISOString().",
  });

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
  /**
   * `undefined` (key absent): not requested (`includeTemporal: false`) —
   * import defaults it to the import's own creation timestamp. `null`:
   * requested and confirmed the row has no lower bound (e.g. a legacy row
   * predating the "omitted validFrom defaults to creation time" fix) —
   * import preserves that open-left validity instead of re-stamping it.
   */
  validFrom: ValidityTimestampSchema.nullable().optional(),
  validTo: ValidityTimestampSchema.optional(),
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
  /** See {@link InterchangeNodeSchema}'s `validFrom` for the null/undefined contract. */
  validFrom: ValidityTimestampSchema.nullable().optional(),
  validTo: ValidityTimestampSchema.optional(),
  meta: z
    .object({
      createdAt: z.iso.datetime().optional(),
      updatedAt: z.iso.datetime().optional(),
    })
    .optional(),
});

export type InterchangeEdge = z.infer<typeof InterchangeEdgeSchema>;

// ============================================================
// Operational Identity Interchange
// ============================================================

export const IdentityInterchangeModeSchema = z.enum(["state", "archival"]);
export type IdentityInterchangeMode = z.infer<
  typeof IdentityInterchangeModeSchema
>;

export const InterchangeIdentityAssertionSchema = z.object({
  id: z.string().min(1),
  relation: z.enum(["same", "different"]),
  a: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
  b: z.object({ kind: z.string().min(1), id: z.string().min(1) }),
  validFrom: ValidityTimestampSchema,
  validTo: ValidityTimestampSchema.optional(),
});
export type InterchangeIdentityAssertion = z.infer<
  typeof InterchangeIdentityAssertionSchema
>;

export const InterchangeIdentitySchema = z.object({
  profile: z.literal("typegraph-identity-v1"),
  mode: IdentityInterchangeModeSchema,
  assertions: z.array(InterchangeIdentityAssertionSchema),
});
export type InterchangeIdentity = z.infer<typeof InterchangeIdentitySchema>;

const InterchangeIdentityHeaderSchema = InterchangeIdentitySchema.omit({
  assertions: true,
});

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
  /**
   * Number of items to process in each batch. Each batch pays fixed
   * per-round-trip costs (existence probe, unique check, one multi-row
   * insert), so undersized batches dominate import time on client/server
   * engines: measured on PostgreSQL, 20k nodes + 5k edges import in
   * 1,515ms at 100 vs 781ms at 1,000. Above ~1,000 the multi-row insert
   * itself dominates and larger batches stop paying; SQLite is
   * insensitive to the value (in-process, no round trips). The backend
   * further splits inserts by its bind-parameter budget, so a large
   * batch never overruns driver limits.
   */
  batchSize: z.number().int().positive().default(1000),
  /**
   * Refresh planner statistics (ANALYZE) after an import that created or
   * updated rows. Bulk loads otherwise run against stale statistics until
   * the engine catches up on its own. Default: true.
   */
  refreshStatistics: z.boolean().optional(),
  /**
   * How a streamed import reacts when one chunk reports entity-level errors.
   * `abort` is the safe default: earlier chunks are already committed, so
   * callers must not mistake a partial stream for a successful retryable load.
   * `continue` is reserved for explicit best-effort ingestion.
   */
  onStreamChunkError: z.enum(["abort", "continue"]).default("abort"),
});

/**
 * Caller-facing options: fields with schema defaults are optional.
 * `importGraph` parses these once at its boundary; internal stages
 * consume {@link ResolvedImportOptions} with every default applied.
 */
export type ImportOptions = z.input<typeof ImportOptionsSchema>;

/** {@link ImportOptions} after schema parsing — all defaults resolved. */
export type ResolvedImportOptions = z.infer<typeof ImportOptionsSchema>;

// ============================================================
// Graph Data Source
// ============================================================

/**
 * Source metadata for graph data.
 *
 * Uses discriminated union to capture different origin types:
 * - `typegraph-export`: Exported from a TypeGraph store
 * - `external`: From a third-party system
 */
export const GraphDataSourceSchema = z.discriminatedUnion("type", [
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
  formatVersion: AcceptedFormatVersionSchema,
  exportedAt: z.iso.datetime(),
  source: GraphDataSourceSchema,
  nodes: z.array(InterchangeNodeSchema),
  edges: z.array(InterchangeEdgeSchema),
  identity: InterchangeIdentitySchema.optional(),
});

export type GraphData = z.infer<typeof GraphDataSchema>;

/** The metadata envelope emitted before streamed graph entities. */
export const GraphDataHeaderSchema = GraphDataSchema.omit({
  nodes: true,
  edges: true,
  identity: true,
}).extend({
  identity: InterchangeIdentityHeaderSchema.optional(),
});

export type GraphDataHeader = z.infer<typeof GraphDataHeaderSchema>;

/**
 * One bounded unit in the streamed interchange protocol. Nodes always precede
 * edges, so an importer can validate endpoints from rows already written to its
 * target without retaining all prior nodes in memory.
 */
export const GraphInterchangeChunkSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("header"), header: GraphDataHeaderSchema }),
  z.object({ type: z.literal("nodes"), nodes: z.array(InterchangeNodeSchema) }),
  z.object({ type: z.literal("edges"), edges: z.array(InterchangeEdgeSchema) }),
  z.object({
    type: z.literal("identity"),
    assertions: z.array(InterchangeIdentityAssertionSchema),
  }),
]);

export type GraphInterchangeChunk = z.infer<typeof GraphInterchangeChunkSchema>;

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
  identity: z.object({
    created: z.number().int().nonnegative(),
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
  /** Operational Identity export mode. Defaults to current state only. */
  identityMode: IdentityInterchangeModeSchema.default("state"),
});

/** Export options with defaults applied (output type) */
export type ExportOptions = z.infer<typeof ExportOptionsSchema>;

/** Export options as accepted by exportGraph (input type with optional defaults) */
export type ExportOptionsInput = z.input<typeof ExportOptionsSchema>;

/**
 * Export options for {@link exportGraphStream}. `batchSize` bounds the number
 * of node or edge entities retained for one yielded chunk.
 */
export const ExportStreamOptionsSchema = ExportOptionsSchema.extend({
  batchSize: z.number().int().positive().default(1000),
});

export type ExportStreamOptions = z.infer<typeof ExportStreamOptionsSchema>;
export type ExportStreamOptionsInput = z.input<
  typeof ExportStreamOptionsSchema
>;
