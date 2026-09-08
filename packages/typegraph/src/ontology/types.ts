import { type AnyEdgeType, type NodeProps, type NodeType } from "../core/types";
import { type CompositionPartSide } from "../registry/composition-relation";

// ============================================================
// Brand Key
// ============================================================

/** Brand key for MetaEdge */
export const META_EDGE_BRAND = "__metaEdge" as const;

// ============================================================
// Inference Types
// ============================================================

/**
 * How a meta-edge affects queries and validation.
 */
export type InferenceType =
  | "subsumption" // Query for X includes instances of subclasses
  | "hierarchy" // Enables broader/narrower traversal
  | "substitution" // Can substitute equivalent types
  | "constraint" // Validation rules
  | "composition" // Part-whole navigation
  | "association" // Discovery/recommendation
  | "none"; // No automatic inference

// ============================================================
// Meta-Edge Properties
// ============================================================

/**
 * Properties of a meta-edge.
 */
export type MetaEdgeProperties = Readonly<{
  transitive: boolean; // A→B, B→C implies A→C
  symmetric: boolean; // A→B implies B→A
  reflexive: boolean; // A→A is always true
  inverse: string | undefined; // Name of inverse meta-edge
  inference: InferenceType; // How this affects queries
  description: string | undefined;
}>;

// ============================================================
// Meta-Edge Type
// ============================================================

/**
 * A meta-edge definition.
 *
 * Meta-edges represent type-level relationships (between kinds),
 * not instance-level relationships (between nodes).
 */
export type MetaEdge<K extends string = string> = Readonly<{
  [META_EDGE_BRAND]: true;
  name: K;
  properties: MetaEdgeProperties;
}>;

// ============================================================
// Ontology Relation
// ============================================================

/**
 * A relation in the ontology (instance of meta-edge between types).
 *
 * @example
 * ```typescript
 * // Podcast subClassOf Media
 * subClassOf(Podcast, Media)
 *
 * // Person equivalentTo schema:Person
 * equivalentTo(Person, "https://schema.org/Person")
 * ```
 */
export type OntologyRelation = Readonly<{
  metaEdge: MetaEdge;
  from: NodeType | AnyEdgeType | string; // string for external IRIs
  to: NodeType | AnyEdgeType | string;
  /** The realizing edge kind name. Required for `partOf`/`hasPart`, absent otherwise. */
  via?: string;
  /** R5's orientation. Meaningful only alongside `via`. */
  partSide?: CompositionPartSide;
}>;

// ============================================================
// Type Guards
// ============================================================

/**
 * Checks if a value is a MetaEdge.
 */
export function isMetaEdge(value: unknown): value is MetaEdge {
  return (
    typeof value === "object" &&
    value !== null &&
    META_EDGE_BRAND in value &&
    (value as Record<string, unknown>)[META_EDGE_BRAND] === true
  );
}

/**
 * Gets the type name from a NodeType, EdgeType, or IRI string.
 */
export function getTypeName(
  typeOrIri: NodeType | AnyEdgeType | string,
): string {
  if (typeof typeOrIri === "string") {
    return typeOrIri;
  }
  return typeOrIri.kind;
}

// ============================================================
// Typed Subsumption (C.1)
// ============================================================

/**
 * A structurally validated ontology relation. Assignable to
 * {@link OntologyRelation} unchanged (so it slots into a
 * `defineGraph({ ontology: [...] })` array with no cast), but retains the
 * `From`/`To` kind literals so `G["ontology"]` — and therefore the
 * polymorphic-alias computation in `src/query/builder/types.ts` — can see
 * which node kinds a relation actually connects.
 */
export type TypedOntologyRelation<
  M extends string,
  From extends NodeType | AnyEdgeType | string,
  To extends NodeType | AnyEdgeType | string,
> = Readonly<{ metaEdge: MetaEdge<M>; from: From; to: To }>;

/**
 * Every key `Parent`'s schema declares that `Child`'s schema has no
 * compatible replacement for: a property `Child` is missing while `Parent`
 * requires it, or a property both declare whose `Child` type does not fit
 * `Parent`'s.
 *
 * Compares PER PROPERTY (`Child[K] extends Parent[K]`), never by building a
 * `Pick<Parent, K>` object type and checking `Child extends` it as a whole —
 * TypeScript's "weak type" detection (TS2559, "has no properties in
 * common") refuses that comparison whenever `Parent` is a schema whose
 * fields are ALL optional and `Child` shares none of their names, which is
 * exactly the width-subtyping case this predicate must accept (a `subClassOf`
 * parent with a single optional field and a child that adds unrelated
 * required fields). Comparing `Child[K]` against `Parent[K]` directly for
 * one key at a time never constructs a weak object type, so it is immune to
 * that detector. Each side of the property comparison is tuple-wrapped
 * (`[Child[K]] extends [Parent[K]]`) to compare a union type as a whole
 * rather than distributing the conditional over its members.
 */
export type IncompatibleKeys<Child, Parent> = {
  [K in keyof Parent]-?: K extends keyof Child ?
    [Child[K]] extends [Parent[K]] ?
      never
    : K
  : undefined extends Parent[K] ? never
  : K;
}[keyof Parent] &
  string;

/**
 * Type-level refusal carrier for `subClassOf` / `equivalentTo` / `sameAs`:
 * printed in place of the parent/partner parameter when the child's schema
 * does not structurally extend it. A named object, not a branded `never`,
 * so the compiler error names the offending properties instead of printing
 * "not assignable to type 'never'" — the same idiom `UniqueAlias`
 * (`src/query/builder/types.ts`) already uses for a type-level refusal.
 */
export type StructuralSubtypeMismatch<
  ChildKind extends string,
  ParentKind extends string,
  Fields extends string,
> = Readonly<{
  __typegraphSubClassOfError: `subClassOf(${ChildKind}, ${ParentKind}): the child's schema must extend the parent's`;
  missingOrIncompatibleProperties: Fields;
  fix: "Give the child these properties with compatible types, or declare broader(child, parent) instead.";
}>;

/**
 * Resolves to `P` when `C`'s schema output structurally extends `P`'s, or to
 * a {@link StructuralSubtypeMismatch} naming the incompatible fields
 * otherwise. `NodeProps` is the Zod OUTPUT type, so this sees exactly what
 * `isStructuralSubtype` (`src/schema/structural-subtype.ts`) sees when
 * applied to the same pair's projected JSON Schema, modulo the refinements,
 * transforms, and value-level constraints that projection cannot represent
 * — `tests/property/typed-subsumption-agreement.test.ts` pins the one
 * direction that must agree between the two.
 */
export type SubClassOfParent<C extends NodeType, P extends NodeType> =
  [IncompatibleKeys<NodeProps<C>, NodeProps<P>>] extends [never] ? P
  : StructuralSubtypeMismatch<
      C["kind"],
      P["kind"],
      IncompatibleKeys<NodeProps<C>, NodeProps<P>>
    >;

/**
 * Resolves to `B` when `A` and `B`'s schemas are mutually structurally
 * subtyping (the D1 "mutual subsumption" reading of `equivalentTo` between
 * two registered kinds), or to a {@link StructuralSubtypeMismatch} naming
 * the direction that fails and its incompatible fields.
 */
export type EquivalentToPartner<A extends NodeType, B extends NodeType> =
  [IncompatibleKeys<NodeProps<A>, NodeProps<B>>] extends [never] ?
    [IncompatibleKeys<NodeProps<B>, NodeProps<A>>] extends [never] ?
      B
    : StructuralSubtypeMismatch<
        B["kind"],
        A["kind"],
        IncompatibleKeys<NodeProps<B>, NodeProps<A>>
      >
  : StructuralSubtypeMismatch<
      A["kind"],
      B["kind"],
      IncompatibleKeys<NodeProps<A>, NodeProps<B>>
    >;

/**
 * `N`, with the runtime-variable facts widened. C.1/C.2 guarantee that a
 * subtype row satisfies the parent's PROPERTIES; they say nothing about
 * which concrete kind produced the row, so `Node<PolymorphicNodeType<N>>`
 * keeps every property fully typed while widening the `kind` discriminant
 * to `string` and the `NodeId` brand to one an exact `NodeId<N>` is
 * assignable TO but not FROM — the safe direction. See `AliasNodeType`
 * (`src/query/builder/types.ts`) for where this is applied selectively,
 * only to aliases the ontology can actually affect.
 *
 * An intersection (`Omit<N, "kind"> & { kind: string }`), not a fresh
 * `NodeType<string, N["schema"]>` — the fresh construction drops every
 * property `N` carries beyond `schema`, including a brand a runtime-kind
 * marker type layers on TOP of `NodeType` (`DynamicNodeType`'s
 * `DYNAMIC_NODE_BRAND`, `src/query/builder/dynamic.ts`). Losing that brand
 * silently switched `fromDynamic`/`toDynamic` aliases from the dynamic
 * `.field()` accessor to the typed one. The intersection widens ONLY `kind`,
 * preserving every other property — brands included — unchanged.
 */
export type PolymorphicNodeType<N extends NodeType> = Omit<N, "kind"> &
  Readonly<{ kind: string }>;
