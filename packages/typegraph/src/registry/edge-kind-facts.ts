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
