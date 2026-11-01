/**
 * `EdgeKindFacts` — one entry type carrying an edge kind's declared
 * endpoints AND its cardinalities.
 *
 * Composition validation (`src/registry/composition-relation.ts`) needs the
 * realizing edge's cardinality alongside its endpoints. A sibling map built
 * at a second site could disagree with this one about which edge kinds
 * exist or what their endpoints are, so the fact lives on this one entry
 * instead — built once per input shape (a live `GraphDef` or a persisted
 * schema) and read everywhere else.
 */
import { type Cardinality, type TargetCardinality } from "../core/types";
import { type SerializedEdgeDef } from "../schema/types";

/**
 * An edge kind's declared domain (`from`) and range (`to`) kind names, its
 * allowed endpoint pairs, and its declared cardinalities.
 */
export type EdgeKindFacts = Readonly<{
  from: readonly string[];
  to: readonly string[];
  /**
   * The `(from, to)` pairs the declaration admits, already resolved from a
   * source-dependent target map or a plain Cartesian product by whichever
   * builder read the declaration — so no consumer re-derives a second,
   * driftable spelling of the same value.
   */
  pairs: readonly Readonly<{ from: string; to: string }>[];
  cardinality: Cardinality;
  targetCardinality: TargetCardinality;
}>;

/**
 * Maps each edge kind's serialized definition to its domain/range kind
 * names and cardinalities, for `validateImpliesEndpointCompatibility`, for
 * `expandEdgeEndpointAllowance` (`src/registry/edge-endpoint-allowance.ts`),
 * and for `buildCompositionRelation`
 * (`src/registry/composition-relation.ts`). A `Map` (rather than the plain
 * `schema.edges` object) so a lookup for an edge kind literally named
 * "toString" or another `Object.prototype` member can't resolve to an
 * inherited member instead of `undefined`.
 */
export function buildSerializedEdgeKindFacts(
  edges: Record<string, SerializedEdgeDef>,
): ReadonlyMap<string, EdgeKindFacts> {
  const result = new Map<string, EdgeKindFacts>();
  for (const [kind, def] of Object.entries(edges)) {
    const pairs: { from: string; to: string }[] = [];
    if (def.targetKindsBySource === undefined) {
      for (const fromKind of def.fromKinds) {
        for (const toKind of def.toKinds) {
          pairs.push({ from: fromKind, to: toKind });
        }
      }
    } else {
      for (const [sourceKind, targetKinds] of Object.entries(
        def.targetKindsBySource,
      )) {
        for (const targetKind of targetKinds) {
          pairs.push({ from: sourceKind, to: targetKind });
        }
      }
    }
    result.set(kind, {
      from: def.fromKinds,
      to: def.toKinds,
      pairs,
      cardinality: def.cardinality,
      // Absent in documents stored before the option existed (the serializer
      // omits the default so untouched graphs keep their hash).
      targetCardinality: def.targetCardinality ?? "many",
    });
  }
  return result;
}
