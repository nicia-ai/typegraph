/**
 * Auto-derive vector index declarations from `embedding()` brands on
 * node schemas.
 *
 * Walks each node's top-level Zod shape, finds fields wrapped in
 * `embedding(dimensions, opts)` (including `.optional()` /
 * `.nullable()` wrappers), and emits one `VectorIndexDeclaration` per
 * (kind, field) pair. The declaration carries the resolved index
 * configuration from the embedding brand — metric, indexType, HNSW /
 * IVFFlat params — so the materializer doesn't need to reach back into
 * the Zod schema.
 *
 * Auto-derivation is intentionally limited to TOP-LEVEL embedding
 * fields. Embeddings nested inside object properties are out of scope
 * for v1 — pgvector's column-based indexes don't address sub-paths
 * cleanly, and the storage layer's `typegraph_node_embeddings` table
 * uses a flat `field_path` keyed at the kind level.
 *
 * Explicit `defineVectorIndex(node, fieldPath, opts)` declarations
 * passed via `defineGraph({ indexes })` take precedence — when an
 * explicit declaration matches the same (kind, fieldPath) as an
 * auto-derived one, the explicit version wins. This lets consumers
 * override defaults without losing auto-derivation for other fields.
 */

import { type z } from "zod";

import {
  EMBEDDING_INDEX_KEY,
  getEmbeddingIndex,
  isEmbeddingSchema,
  type ResolvedEmbeddingIndex,
} from "../core/embedding";
import { type NodeRegistration } from "../core/types";
import { type IndexDeclaration, type VectorIndexDeclaration } from "./types";

/**
 * Auto-derive vector index declarations from embedding brands on a
 * map of node registrations. Returns one declaration per
 * (kind, top-level field) pair. Empty array when no embeddings found.
 *
 * Cross-graph status-table disambiguation does NOT happen here — the
 * declaration name stays clean (`tg_vec_{kind}_{field}_{metric}`) so
 * `pg_indexes` and result-entry inspection are readable. The
 * materializer composes a graph-scoped key (`${graphId}::${name}`)
 * for status-table identity, applied uniformly to both auto-derived
 * and explicit `VectorIndexDeclaration` entries — see
 * `vectorStatusKey` in `store/materialize-indexes.ts`. This keeps
 * the disambiguation rule in one place that BOTH paths go through,
 * rather than depending on the auto-derive caller to produce a
 * graph-scoped name.
 */
export function autoDeriveVectorIndexes(
  nodes: Record<string, NodeRegistration>,
): readonly VectorIndexDeclaration[] {
  const out: VectorIndexDeclaration[] = [];
  for (const registration of Object.values(nodes)) {
    const node = registration.type;
    const shape = readObjectShape(node.schema);
    if (shape === undefined) continue;
    for (const [fieldName, fieldSchema] of Object.entries(shape)) {
      const config = readEmbeddingIndex(fieldSchema);
      if (config === undefined) continue;
      const dimensions = readEmbeddingDimensions(fieldSchema);
      if (dimensions === undefined) continue;
      out.push(buildAutoDerived(node.kind, fieldName, dimensions, config));
    }
  }
  return out;
}

/**
 * Merge auto-derived declarations with explicit ones, preferring
 * explicit on (kind, fieldPath) collisions. Returns a flat list of all
 * indexes; non-vector entries from `explicit` pass through unchanged.
 */
export function mergeVectorIndexes(
  explicit: readonly IndexDeclaration[],
  autoDerived: readonly VectorIndexDeclaration[],
): readonly IndexDeclaration[] {
  if (autoDerived.length === 0) return explicit;
  const explicitVectorKeys = new Set<string>();
  for (const declaration of explicit) {
    if (declaration.entity === "vector") {
      explicitVectorKeys.add(`${declaration.kind}|${declaration.fieldPath}`);
    }
  }
  const filteredAuto = autoDerived.filter(
    (entry) => !explicitVectorKeys.has(`${entry.kind}|${entry.fieldPath}`),
  );
  return [...explicit, ...filteredAuto];
}

/**
 * Generate the deterministic vector index name. The visible prefix
 * `tg_vec_<kind>_<field>_<metric>` keeps it scannable in result-entry
 * inspection and the `typegraph_index_materializations` table.
 *
 * Cross-graph disambiguation is handled separately at the
 * materialization boundary (see `vectorStatusKey`) so the declaration
 * name doesn't need to carry `graphId` — the same auto-derived name
 * is reusable across graphs and the materializer composes a
 * graph-scoped status key for both auto-derived and explicit entries
 * uniformly.
 */
function buildAutoDerived(
  kind: string,
  fieldName: string,
  dimensions: number,
  config: ResolvedEmbeddingIndex,
): VectorIndexDeclaration {
  const fieldPath = fieldName;
  return Object.freeze({
    entity: "vector" as const,
    name: `tg_vec_${sanitize(kind)}_${sanitize(fieldName)}_${config.metric}`,
    kind,
    fieldPath,
    dimensions,
    metric: config.metric,
    indexType: config.indexType,
    indexParams: Object.freeze({
      m: config.m,
      efConstruction: config.efConstruction,
      lists: config.lists,
    }),
  });
}

function sanitize(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

function readObjectShape(
  schema: z.ZodType,
): Record<string, z.ZodType> | undefined {
  if ((schema as { type?: string }).type !== "object") return undefined;
  const shape = (schema.def as { shape?: Record<string, z.ZodType> }).shape;
  return shape;
}

function readEmbeddingIndex(
  schema: z.ZodType,
): ResolvedEmbeddingIndex | undefined {
  for (const candidate of unwrapChain(schema)) {
    const config = getEmbeddingIndex(candidate);
    if (config !== undefined) return config;
  }
  return undefined;
}

function readEmbeddingDimensions(schema: z.ZodType): number | undefined {
  for (const candidate of unwrapChain(schema)) {
    if (isEmbeddingSchema(candidate)) {
      return (candidate as unknown as Record<string, number>)
        ._embeddingDimensions;
    }
  }
  return undefined;
}

/**
 * Yield the schema and every reachable inner schema by repeatedly
 * applying `.unwrap()` (Zod 4 optional/nullable/default) and
 * `.def.innerType` (some wrappers). Cycle-guarded by depth and
 * reference identity. Generators stop at the first non-unwrappable
 * schema OR after 8 levels — deeper wrapping is pathological and not
 * worth supporting.
 */
function* unwrapChain(schema: z.ZodType): Generator<z.ZodType, void, void> {
  const seen = new Set<z.ZodType>();
  let current: z.ZodType | undefined = schema;
  let depth = 0;
  while (current !== undefined && !seen.has(current) && depth < 8) {
    seen.add(current);
    yield current;
    current = unwrapOnce(current);
    depth++;
  }
}

function unwrapOnce(schema: z.ZodType): z.ZodType | undefined {
  // Zod 4 wrappers expose `.unwrap()` on optional/nullable/default.
  const candidate = schema as unknown as { unwrap?: () => z.ZodType };
  if (typeof candidate.unwrap === "function") return candidate.unwrap();
  // Some wrappers expose the inner schema via `.def.innerType`.
  return (schema as unknown as { def?: { innerType?: z.ZodType } }).def
    ?.innerType;
}

// Suppress "unused" lint if EMBEDDING_INDEX_KEY isn't directly referenced
// after the helpers above; it's part of the brand contract this module
// reads through `getEmbeddingIndex`.
void EMBEDDING_INDEX_KEY;
