import {
  type InferenceType,
  META_EDGE_BRAND,
  type MetaEdge,
  type MetaEdgeProperties,
} from "../ontology/types";

// ============================================================
// Meta-Edge Factory Options
// ============================================================

/**
 * Options for creating a meta-edge.
 */
export type MetaEdgeOptions = Readonly<{
  /** Whether the relationship is transitive (A→B, B→C implies A→C) */
  transitive?: boolean;
  /** Whether the relationship is symmetric (A→B implies B→A) */
  symmetric?: boolean;
  /** Whether the relationship is reflexive (A→A is always true) */
  reflexive?: boolean;
  /** Name of the inverse meta-edge */
  inverse?: string;
  /** How this meta-edge affects queries and validation */
  inference?: InferenceType;
  /** Optional description */
  description?: string;
}>;

// ============================================================
// Meta-Edge Factory
// ============================================================

/**
 * Creates a custom meta-edge definition.
 *
 * @example
 * ```typescript
 * // Custom meta-edge for regulatory relationships
 * const regulatedBy = metaEdge("regulatedBy", {
 *   description: "Type X is regulated by authority type Y",
 *   transitive: false,
 *   symmetric: false,
 * });
 * ```
 */
export function metaEdge<K extends string>(
  name: K,
  options: MetaEdgeOptions = {},
): MetaEdge<K> {
  const properties: MetaEdgeProperties = {
    transitive: options.transitive ?? false,
    symmetric: options.symmetric ?? false,
    reflexive: options.reflexive ?? false,
    inverse: options.inverse,
    inference: options.inference ?? "none",
    description: options.description,
  };

  return Object.freeze({
    [META_EDGE_BRAND]: true as const,
    name,
    properties,
  }) as MetaEdge<K>;
}
