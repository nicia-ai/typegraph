/**
 * Shared `CompileQueryOptions` construction for the executable query,
 * aggregate query, and unionable query builders. Keeps one source of
 * truth for which config fields are propagated to the compiler.
 */
import { resolveEmbeddingFields } from "../../core/embedding";
import { type KindRegistry } from "../../registry/kind-registry";
import { type CompileQueryOptions } from "../compiler/index";
import {
  type VectorSlotDescriptor,
  vectorSlotKey,
  type VectorSlotMap,
} from "../compiler/schema";
import { getQueryBuilderInternalContext } from "./internal-context";
import { type QueryBuilderConfig } from "./types";

export function buildCompileOptions(
  config: QueryBuilderConfig,
): CompileQueryOptions {
  const fulltextStrategy = config.backend?.fulltextStrategy;
  const vectorStrategy = config.backend?.vectorStrategy;
  const { recordedReadBinding } = getQueryBuilderInternalContext(config);
  return {
    dialect: config.dialect ?? "sqlite",
    schema: config.schema,
    windowFunctions: config.backend?.capabilities.windowFunctions ?? true,
    ...(fulltextStrategy === undefined ? {} : { fulltextStrategy }),
    ...(vectorStrategy === undefined ?
      {}
    : { vectorStrategy, vectorSlots: buildVectorSlots(config.registry) }),
    ...(recordedReadBinding === undefined ? {} : { recordedReadBinding }),
  };
}

/**
 * Memoizes the {@link VectorSlotMap} per registry. A registry is immutable
 * for its lifetime, and `buildCompileOptions` runs on every query compile, so
 * caching avoids re-walking every node kind's schema (and re-allocating the
 * map) on each query — including the majority that contain no `similarTo()`.
 */
const vectorSlotsCache = new WeakMap<KindRegistry, VectorSlotMap>();

/**
 * Builds the compiler's {@link VectorSlotMap} from every registered node
 * kind's embedding fields. Used only when a vector strategy is present —
 * it tells the `field.similarTo(...)` CTE which `(kind, fieldPath)` pairs
 * back a per-field table, so the UNION ALL only scans kinds that declare
 * the field. Memoized per (immutable) registry.
 */
function buildVectorSlots(registry: KindRegistry): VectorSlotMap {
  const cached = vectorSlotsCache.get(registry);
  if (cached !== undefined) return cached;

  const slots = new Map<string, VectorSlotDescriptor>();
  for (const [nodeKind, nodeType] of registry.nodeKinds) {
    for (const field of resolveEmbeddingFields(nodeType.schema)) {
      slots.set(vectorSlotKey(nodeKind, field.fieldPath), {
        dimensions: field.dimensions,
        metric: field.metric,
        indexType: field.indexType,
      });
    }
  }
  vectorSlotsCache.set(registry, slots);
  return slots;
}
