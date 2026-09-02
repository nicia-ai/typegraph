import { z } from "zod";

import { assertWhereFieldDeclared } from "../constraints";
import { ConfigurationError } from "../errors/index";
import { type GraphExtension } from "../graph-extension/extension-types";
import {
  autoDeriveVectorIndexes,
  mergeVectorIndexes,
} from "../indexes/auto-derive";
import { type IndexDeclaration } from "../indexes/types";
import { type OntologyRelation } from "../ontology/types";
import { assertClaimAxisSafe } from "../store/claims/axis";
import { createDataKeyedBag, hasOwnKey } from "../utils/object";
import {
  isEdgeTargetMap,
  normalizeTargetMap,
  validateTargetMapEntries,
} from "./edge-endpoints";
import { isPortableEdgeMatchIdentityValue } from "./edge-match-identity-value";
import {
  assertGraphAnnotations,
  cloneAndFreezeGraphAnnotations,
} from "./json-value";
import {
  type AnyEdgeRegistration,
  type AnyEdgeType,
  type DeleteBehavior,
  type EdgeRegistration,
  type EdgeTargets,
  type EdgeTypeWithEndpoints,
  type GraphAnnotations,
  type GraphDefaults,
  isEdgeType,
  isEdgeTypeWithEndpoints,
  type KindEntity,
  type NodeRegistration,
  type NodeType,
  type TemporalMode,
} from "./types";

// ============================================================
// Graph Definition Brand Symbol
// ============================================================

/** Brand key for GraphDef */
const GRAPH_DEF_BRAND = "__graphDef" as const;

// ============================================================
// Edge Entry Types
// ============================================================

/**
 * An edge entry in the graph definition.
 * Can be:
 * - EdgeType directly (constrained or unconstrained)
 * - EdgeRegistration object (always works, can override/narrow defaults)
 */
type EdgeEntry = EdgeRegistration | AnyEdgeType;

/**
 * Normalized edge map type - all entries become EdgeRegistration.
 * For bare EdgeTypes, constrained endpoints are extracted from the type;
 * unconstrained edges fall back to all node types in the graph.
 */
type NormalizedEdges<
  TNodes extends Record<string, NodeRegistration>,
  TEdges extends Record<string, EdgeEntry>,
> = {
  [K in keyof TEdges]: TEdges[K] extends EdgeRegistration ? TEdges[K]
  : TEdges[K] extends AnyEdgeType ?
    EdgeRegistration<
      TEdges[K],
      TEdges[K]["from"] extends readonly (infer N extends NodeType)[] ? N
      : TNodes[keyof TNodes]["type"],
      TEdges[K]["to"] extends readonly (infer N extends NodeType)[] ? N
      : TEdges[K]["to"] extends (
        Record<string, readonly (infer N extends NodeType)[]>
      ) ?
        N
      : TNodes[keyof TNodes]["type"],
      TEdges[K]["to"] extends EdgeTargets ? TEdges[K]["to"]
      : readonly TNodes[keyof TNodes]["type"][]
    >
  : never;
};

// ============================================================
// Edge Normalization Functions
// ============================================================

/**
 * Validates that an EdgeRegistration's constraints don't widen beyond
 * the edge type's built-in domain/range constraints.
 */
function validateConstraintNarrowing(
  name: string,
  edgeType: EdgeTypeWithEndpoints,
  registration: EdgeRegistration,
): void {
  const builtInFromNames = new Set(edgeType.from.map((node) => node.kind));
  for (const fromNode of registration.from) {
    if (!builtInFromNames.has(fromNode.kind)) {
      throw new ConfigurationError(
        `Edge "${name}" registration has 'from' kind "${fromNode.kind}" ` +
          `not in edge's built-in domain: [${[...builtInFromNames].join(", ")}]`,
        {
          edgeName: name,
          invalidFrom: fromNode.kind,
          allowedFrom: [...builtInFromNames],
        },
        {
          suggestion: `Edge registration can only narrow, not widen, the edge type's built-in constraints.`,
        },
      );
    }
  }

  if (!Array.isArray(registration.to)) {
    validateTargetMapEntries(name, registration.from, registration.to);
  }

  const builtInIsMap = isEdgeTargetMap(edgeType.to);
  const registrationIsMap = isEdgeTargetMap(registration.to);

  for (const fromNode of registration.from) {
    const allowedTargets =
      builtInIsMap ?
        new Set<string>(
          (edgeType.to[fromNode.kind] ?? []).map(
            (node: NodeType): string => node.kind,
          ),
        )
      : new Set<string>(
          (edgeType.to as readonly NodeType[]).map(
            (node: NodeType): string => node.kind,
          ),
        );

    const declaredTargets: readonly NodeType[] =
      registrationIsMap ?
        (registration.to[fromNode.kind] ?? [])
      : (registration.to as readonly NodeType[]);

    for (const targetNode of declaredTargets) {
      if (!allowedTargets.has(targetNode.kind)) {
        const message =
          builtInIsMap ?
            registrationIsMap ?
              `Edge "${name}" registration has target kind "${targetNode.kind}" for source "${fromNode.kind}" not in edge's built-in mapping: [${[...allowedTargets].join(", ")}]`
            : `Edge "${name}" registration has 'to' kind "${targetNode.kind}" for source "${fromNode.kind}" not in edge's built-in source-dependent targets: [${[...allowedTargets].join(", ")}]. An array-valued registration must not erase built-in endpoint correlation.`
          : `Edge "${name}" registration has 'to' kind "${targetNode.kind}" not in edge's built-in range: [${[...allowedTargets].join(", ")}]`;

        throw new ConfigurationError(
          message,
          {
            edgeName: name,
            sourceKind: fromNode.kind,
            invalidTo: targetNode.kind,
            allowedTo: [...allowedTargets],
          },
          {
            suggestion: `Edge registration can only narrow, not widen, the edge type's built-in constraints.`,
          },
        );
      }
    }
  }
}

/**
 * Normalizes a single edge entry to EdgeRegistration.
 */
function normalizeEdgeEntry(
  name: string,
  entry: EdgeEntry,
  allNodeTypes: readonly NodeType[],
): AnyEdgeRegistration {
  if (isEdgeType(entry)) {
    if (isEdgeTypeWithEndpoints(entry)) {
      // EdgeType with from/to — convert to EdgeRegistration
      return { type: entry, from: entry.from, to: entry.to };
    }
    // Unconstrained EdgeType — allow any→any
    return { type: entry, from: allNodeTypes, to: allNodeTypes };
  }

  let normalizedRegistration: AnyEdgeRegistration = entry;
  if (!Array.isArray(entry.to)) {
    validateTargetMapEntries(name, entry.from, entry.to);
    normalizedRegistration = { ...entry, to: normalizeTargetMap(entry.to) };
  }

  // Validate narrowing if edge has built-in constraints
  if (isEdgeTypeWithEndpoints(normalizedRegistration.type)) {
    validateConstraintNarrowing(
      name,
      normalizedRegistration.type,
      normalizedRegistration,
    );
  }

  return canonicalizeMatchIdentity(name, normalizedRegistration);
}

/**
 * Validates and canonicalizes the optional graph-local edge identity.
 *
 * Identity fields are persisted as a set, so declaration order is not
 * semantic. The copied registration also ensures defineGraph never mutates a
 * caller-owned registration while establishing its canonical form.
 */
function canonicalizeMatchIdentity(
  edgeName: string,
  registration: EdgeRegistration,
): EdgeRegistration {
  const identity = registration.matchIdentity;
  if (identity === undefined) return registration;

  if (typeof identity.name !== "string" || identity.name.length === 0) {
    throw new ConfigurationError(
      `Edge "${edgeName}" match identity name must be a non-empty string.`,
      { edgeName },
    );
  }
  const identityFields: unknown = identity.fields;
  if (!Array.isArray(identityFields)) {
    throw new ConfigurationError(
      `Edge "${edgeName}" match identity fields must be an array.`,
      { edgeName, identityName: identity.name },
    );
  }

  const rawShape = (registration.type.schema as { shape?: unknown }).shape;
  const shape =
    typeof rawShape === "object" && rawShape !== null ?
      (rawShape as Readonly<Record<string, unknown>>)
    : undefined;
  if (shape === undefined) {
    throw new ConfigurationError(
      `Edge "${edgeName}" match identity cannot be validated because its schema is not an object schema.`,
      { edgeName, identityName: identity.name },
    );
  }

  const fields: string[] = [];
  const seen = new Set<string>();
  for (const field of identityFields) {
    if (typeof field !== "string") {
      throw new ConfigurationError(
        `Edge "${edgeName}" match identity fields must be strings.`,
        { edgeName, identityName: identity.name },
      );
    }
    if (seen.has(field)) {
      throw new ConfigurationError(
        `Edge "${edgeName}" match identity repeats field "${field}".`,
        { edgeName, identityName: identity.name, field },
      );
    }
    seen.add(field);
    fields.push(field);
    if (!hasOwnKey(shape, field)) {
      throw new ConfigurationError(
        `Edge "${edgeName}" match identity references undeclared field "${field}".`,
        { edgeName, identityName: identity.name, field },
      );
    }
    if (!isPortableMatchIdentityFieldSchema(shape[field])) {
      throw new ConfigurationError(
        `Edge "${edgeName}" match identity field "${field}" must persist as a JSON scalar.`,
        {
          code: "EDGE_MATCH_IDENTITY_VALUE_NOT_SCALAR",
          edgeName,
          identityName: identity.name,
          field,
        },
        {
          suggestion:
            "Use a string, finite number, boolean, portable literal or enum, or an optional/nullable/readonly/default/catch/prefault wrapper or union whose output stays inside those scalar types.",
        },
      );
    }
  }

  return {
    ...registration,
    matchIdentity: {
      name: identity.name,
      fields: fields.toSorted(),
    },
  };
}

function isPortableMatchIdentityFieldSchema(fieldSchema: unknown): boolean {
  if (!(fieldSchema instanceof z.ZodType)) return false;
  if (
    fieldSchema instanceof z.ZodString ||
    fieldSchema instanceof z.ZodNumber ||
    fieldSchema instanceof z.ZodBoolean ||
    fieldSchema instanceof z.ZodNull
  )
    return true;
  if (fieldSchema instanceof z.ZodLiteral) {
    return [...fieldSchema.values].every((value) =>
      isPortableEdgeMatchIdentityValue(value),
    );
  }
  if (fieldSchema instanceof z.ZodEnum) {
    return Object.values(fieldSchema.enum).every((value) =>
      isPortableEdgeMatchIdentityValue(value),
    );
  }
  if (fieldSchema instanceof z.ZodUnion) {
    return fieldSchema.options.every((option) =>
      isPortableMatchIdentityFieldSchema(option),
    );
  }
  if (
    fieldSchema instanceof z.ZodOptional ||
    fieldSchema instanceof z.ZodNullable ||
    fieldSchema instanceof z.ZodReadonly ||
    fieldSchema instanceof z.ZodNonOptional ||
    fieldSchema instanceof z.ZodDefault ||
    fieldSchema instanceof z.ZodCatch ||
    fieldSchema instanceof z.ZodPrefault
  ) {
    return isPortableMatchIdentityFieldSchema(fieldSchema.unwrap());
  }
  return false;
}

/**
 * Normalizes all edge entries to EdgeRegistration.
 *
 * The accumulator is a {@link createDataKeyedBag}: its keys are EDGE KIND
 * NAMES, which are data. `isValidKindName` admits `__proto__` exactly as it
 * admits `toString`, and a graph literal written with a computed key
 * (`edges: { ["__proto__"]: knows }`) carries it as an own key — so
 * `result[name] = …` into a `{}` literal would reach `Object.prototype`'s
 * `__proto__` setter, reparent the accumulator, and drop the declared edge.
 * `config.nodes` needs no such treatment: it is passed through by reference,
 * never re-accumulated.
 */
function normalizeEdges(
  edges: Record<string, EdgeEntry>,
  allNodeTypes: readonly NodeType[],
): Record<string, AnyEdgeRegistration> {
  const result = createDataKeyedBag<AnyEdgeRegistration>();
  for (const [name, entry] of Object.entries(edges)) {
    result[name] = normalizeEdgeEntry(name, entry, allNodeTypes);
  }
  // Spread at the boundary: this becomes `graph.edges` on the returned (and
  // publicly reachable) `GraphDef`. See `createDataKeyedBag` in
  // ../utils/object.ts.
  return { ...result };
}

// ============================================================
// Graph Definition Configuration
// ============================================================

/** Durable graph-level configuration for the TypeGraph Identity Profile. */
export type GraphIdentityConfig = Readonly<{
  /** Whether equal ids in different kinds implicitly join one identity class. */
  sameIdAcrossKinds: "fold" | "ignore";
}>;

/**
 * Configuration for defineGraph.
 */
type GraphDefConfig<
  TNodes extends Record<string, NodeRegistration>,
  TEdges extends Record<string, EdgeEntry>,
  TOntology extends readonly OntologyRelation[],
  TIdentity extends GraphIdentityConfig | undefined,
> = Readonly<{
  /** Unique identifier for this graph */
  id: string;
  /** Consumer-owned JSON metadata describing the graph as a whole. */
  annotations?: GraphAnnotations;
  /** Node registrations */
  nodes: TNodes;
  /** Edge registrations or EdgeTypes with built-in domain/range */
  edges: TEdges;
  /** Ontology relations */
  ontology?: TOntology;
  /** Graph-wide defaults */
  defaults?: GraphDefaults;
  /** Enables the TypeGraph Identity Profile for this graph. */
  identity?: TIdentity;
  /**
   * Index declarations attached to this graph.
   *
   * Accepts the outputs of `defineNodeIndex` / `defineEdgeIndex` (which
   * already return `IndexDeclaration` values) or pre-built declarations
   * reconstructed from a stored schema or graph extension.
   *
   * Validated at definition time: every index must reference a `kind`
   * that exists in `nodes` / `edges`, and index `name`s must be unique
   * within the graph.
   *
   * Index DDL is **not** generated by `defineGraph`. Indexes flow into
   * `SerializedSchema.indexes` so they can later be materialized via
   * `store.materializeIndexes()` — lifting the storage concern out of
   * the schema-version commit path.
   */
  indexes?: readonly IndexDeclaration[];
}>;

// ============================================================
// Graph Definition Type
// ============================================================

/**
 * A graph definition.
 *
 * This is a compile-time artifact that describes the structure of a graph.
 * Use `createStore()` to create a runtime store from this definition.
 */
export type GraphDef<
  TNodes extends Record<string, NodeRegistration> = Record<
    string,
    NodeRegistration
  >,
  TEdges extends Record<string, EdgeRegistration> = Record<
    string,
    EdgeRegistration
  >,
  TOntology extends readonly OntologyRelation[] = readonly OntologyRelation[],
  TIdentity extends GraphIdentityConfig | undefined =
    GraphIdentityConfig | undefined,
> = Readonly<{
  [GRAPH_DEF_BRAND]: true;
  id: string;
  /** Consumer-owned JSON metadata describing the graph as a whole. */
  annotations: GraphAnnotations | undefined;
  nodes: TNodes;
  edges: TEdges;
  ontology: TOntology;
  /** Durable graph-level opt-in to the TypeGraph Identity Profile. */
  identity: TIdentity;
  defaults: Readonly<{
    onNodeDelete: DeleteBehavior;
    temporalMode: TemporalMode;
  }>;
  /**
   * Index declarations attached to this graph. Preserves whatever the
   * caller passed to `defineGraph` (including an explicit empty array)
   * for introspection purposes.
   *
   * The serialized canonical form is order-canonicalized (sorted by
   * `name`) and treats `undefined` and `[]` as the same "no slice" form
   * — an empty array does not bump the schema hash, since indexes are
   * an unordered set keyed by name and `[]` carries no semantic meaning
   * that an absent slice doesn't.
   */
  indexes: readonly IndexDeclaration[] | undefined;
  /**
   * Graph extension this graph was merged with, if any. Set by
   * `mergeGraphExtension`; never set by `defineGraph` directly.
   * Exists solely so re-serialization is stable — the rest of the
   * system reads the merged kinds through `nodes` / `edges` /
   * `ontology` and never inspects this field. Absent on graphs that
   * have never been extended; legacy graphs hash byte-identically.
   */
  extension: GraphExtension | undefined;
  /**
   * Soft-deprecated kind names attached to this graph. Set by the
   * loader from the persisted schema and by `store.deprecateKinds(...)`
   * / `store.undeprecateKinds(...)`. A purely informational signal
   * surfaced for introspection — does not gate reads, writes, or
   * queries. Defaults to the empty set on freshly-defined graphs.
   */
  deprecatedKinds: ReadonlySet<string>;
}>;

// ============================================================
// Type Helpers
// ============================================================

/**
 * Extract node kind names from a GraphDef.
 */
export type NodeKinds<G extends GraphDef> = keyof G["nodes"] & string;

/**
 * Extract edge kind names from a GraphDef.
 */
export type EdgeKinds<G extends GraphDef> = keyof G["edges"] & string;

/**
 * Get a NodeType from a GraphDef by kind name.
 */
export type GetNodeType<
  G extends GraphDef,
  K extends NodeKinds<G>,
> = G["nodes"][K]["type"];

/**
 * Get an EdgeType from a GraphDef by kind name.
 */
export type GetEdgeType<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = G["edges"][K]["type"];

/**
 * Get all NodeTypes from a GraphDef.
 */
export type AllNodeTypes<G extends GraphDef> = {
  [K in NodeKinds<G>]: G["nodes"][K]["type"];
}[NodeKinds<G>];

/**
 * Get all EdgeTypes from a GraphDef.
 */
export type AllEdgeTypes<G extends GraphDef> = {
  [K in EdgeKinds<G>]: G["edges"][K]["type"];
}[EdgeKinds<G>];

// ============================================================
// Define Graph Function
// ============================================================

/**
 * Creates a graph definition.
 *
 * @example
 * ```typescript
 * const graph = defineGraph({
 *   id: "my_graph",
 *   nodes: {
 *     Person: { type: Person },
 *     Company: { type: Company },
 *   },
 *   edges: {
 *     // Traditional EdgeRegistration syntax
 *     worksAt: {
 *       type: worksAt,
 *       from: [Person],
 *       to: [Company],
 *       cardinality: "many",
 *     },
 *     // Or use EdgeType directly if it has from/to defined
 *     knows,  // EdgeType with built-in domain/range
 *   },
 *   ontology: [
 *     subClassOf(Company, Organization),
 *     disjointWith(Person, Organization),
 *   ],
 *   defaults: {
 *     onNodeDelete: "restrict",
 *     temporalMode: "current",
 *   },
 * });
 * ```
 */
export function defineGraph<
  const TNodes extends Record<string, NodeRegistration<NodeType>>,
  const TEdges extends Record<string, EdgeEntry>,
  const TOntology extends readonly OntologyRelation[],
  const TIdentity extends GraphIdentityConfig | undefined = undefined,
>(
  config: GraphDefConfig<TNodes, TEdges, TOntology, TIdentity>,
): GraphDef<TNodes, NormalizedEdges<TNodes, TEdges>, TOntology, TIdentity> {
  return defineGraphUnchecked(config);
}

function defineGraphUnchecked<
  const TNodes extends Record<string, NodeRegistration<NodeType>>,
  const TEdges extends Record<string, EdgeEntry>,
  const TOntology extends readonly OntologyRelation[],
  const TIdentity extends GraphIdentityConfig | undefined = undefined,
>(
  config: GraphDefConfig<TNodes, TEdges, TOntology, TIdentity>,
): GraphDef<TNodes, NormalizedEdges<TNodes, TEdges>, TOntology, TIdentity> {
  const defaults = {
    onNodeDelete: config.defaults?.onNodeDelete ?? "restrict",
    temporalMode: config.defaults?.temporalMode ?? "current",
  } as const;

  if (config.annotations !== undefined) {
    assertGraphAnnotations(config.annotations, `Graph "${config.id}"`);
  }
  const annotations =
    config.annotations === undefined ?
      undefined
    : cloneAndFreezeGraphAnnotations(config.annotations);

  const allNodeTypes = Object.values(config.nodes).map((reg) => reg.type);
  const normalizedEdges = normalizeEdges(config.edges, allNodeTypes);
  assertClaimNamesAreSafe(config.nodes);
  assertUniqueConstraintsAreDeclared(config.nodes);
  // Vector indexes are auto-derived from `embedding()` brands on node
  // schemas (see `autoDeriveVectorIndexes`). Explicit declarations
  // passed via `defineGraph({ indexes })` win on (kind, fieldPath)
  // collisions so consumers can override defaults — see
  // `mergeVectorIndexes`. The merged list flows through
  // `normalizeIndexes` for the standard kind-registered + unique-name
  // checks.
  //
  // Preservation rule: if the consumer never passed `indexes` at all
  // AND no embedding brands exist, leave `graph.indexes` undefined to
  // keep the introspection surface stable for legacy graphs. If the
  // consumer passed an explicit `[]`, surface it as `[]` (not
  // `undefined`) to match the contract pinned by the
  // "preserves an explicit empty indexes array" test.
  const autoVectorIndexes = autoDeriveVectorIndexes(config.nodes);
  const explicitProvided = config.indexes !== undefined;
  const mergedIndexes = mergeVectorIndexes(
    config.indexes ?? [],
    autoVectorIndexes,
  );
  const indexes =
    !explicitProvided && mergedIndexes.length === 0 ?
      undefined
    : normalizeIndexes(mergedIndexes, config.nodes, normalizedEdges);

  return Object.freeze({
    [GRAPH_DEF_BRAND]: true as const,
    id: config.id,
    annotations,
    nodes: config.nodes,
    edges: normalizedEdges,
    ontology: config.ontology ?? ([] as unknown as TOntology),
    identity: config.identity as TIdentity,
    defaults,
    indexes,
    extension: undefined,
    deprecatedKinds: EMPTY_DEPRECATED_KINDS,
  }) as GraphDef<TNodes, NormalizedEdges<TNodes, TEdges>, TOntology, TIdentity>;
}

/**
 * @internal Marks a graph definition as framework-owned rather than
 * application-authored.
 *
 * It builds exactly what {@link defineGraph} builds — the name records the
 * caller, it does not reserve anything. There is NO reserved id namespace and
 * no id validation anywhere: an application may define a graph at any id a
 * framework-owned graph uses, the merge-provenance sidecar's
 * `<target>::merge-provenance` convention included. That convention is
 * protected at RUNTIME instead, by the ownership checks in the single gateway
 * that opens a sidecar (`openProvenanceStore`), which refuses an id occupied by
 * anything it cannot prove it owns.
 */
export function defineInternalGraph<
  const TNodes extends Record<string, NodeRegistration<NodeType>>,
  const TEdges extends Record<string, EdgeEntry>,
  const TOntology extends readonly OntologyRelation[],
  const TIdentity extends GraphIdentityConfig | undefined = undefined,
>(
  config: GraphDefConfig<TNodes, TEdges, TOntology, TIdentity>,
): GraphDef<TNodes, NormalizedEdges<TNodes, TEdges>, TOntology, TIdentity> {
  return defineGraphUnchecked(config);
}

// Sharing one frozen empty Set keeps the canonical-form hash stable
// across graphs that never deprecate any kinds.
const EMPTY_DEPRECATED_KINDS: ReadonlySet<string> = Object.freeze(
  new Set<string>(),
);

// ============================================================
// Unique Constraint Validation
// ============================================================

/**
 * Refuses any kind name or constraint name that could spell a reserved claim
 * axis.
 *
 * A node kind and a unique constraint name are both written verbatim into the
 * claim rows a write of that kind reserves, and the axes that are NOT kinds —
 * the disjoint pair axis, and the reserved constraint name its rows carry — are
 * built from a code point neither may contain. `defineGraph` is where that is
 * enforced for the whole graph: `defineNode` already refuses it for kinds it
 * builds, but the graph-extension compiler builds registrations without going
 * through it, and constraint names never pass `defineNode` at all.
 */
function assertClaimNamesAreSafe(
  nodes: Record<string, NodeRegistration>,
): void {
  for (const registration of Object.values(nodes)) {
    assertClaimAxisSafe(registration.type.kind, "Node kind");
    for (const constraint of registration.unique ?? []) {
      assertClaimAxisSafe(constraint.name, "Unique constraint");
    }
  }
}

/**
 * Refuses any uniqueness constraint whose `where` clause names a field its kind
 * does not declare.
 *
 * `defineGraph` is the one gate every constraint passes before a write can
 * evaluate it — the store reads constraints off `registration.unique`, and the
 * only other way a registration is built is `mergeGraphExtension`, whose
 * documents `validateGraphExtension` already refuses on the same grounds
 * (`UNKNOWN_UNIQUE_WHERE_FIELD`). Validating here therefore covers every write
 * path at once, instead of at each `checkWherePredicate` call site.
 *
 * Typed callers are already guarded by `UniqueConstraintPredicateBuilder`,
 * which declares exactly the schema's fields; this is the runtime half, for
 * untyped callers whose typo would otherwise produce a constraint that quietly
 * never applies.
 */
function assertUniqueConstraintsAreDeclared(
  nodes: Record<string, NodeRegistration>,
): void {
  for (const registration of Object.values(nodes)) {
    const constraints = registration.unique;
    if (constraints === undefined || constraints.length === 0) continue;

    const rawShape = (registration.type.schema as { shape?: unknown }).shape;
    const shape =
      typeof rawShape === "object" && rawShape !== null ?
        (rawShape as Readonly<Record<string, unknown>>)
      : undefined;

    for (const constraint of constraints) {
      // A schema exposing no `.shape` is not an object schema, so there is no
      // declared-field set to check the clause against. Skipping the check
      // silently would disable this guard for exactly the callers it was
      // written for — untyped ones, who are also the only callers who can put
      // a non-`ZodObject` here (`defineNode` / `defineEdge` and the
      // graph-extension compiler all produce `z.object(...)`). So the clause is
      // REFUSED rather than left unvalidated.
      //
      // Narrowly: only a constraint that actually carries a `where` is refused.
      // A plain `unique: [{ fields }]` needs no shape to be meaningful — it
      // names props by key and evaluates fine against a non-object schema — and
      // refusing it would break a working, if unusual, untyped graph for no
      // safety gain.
      if (shape === undefined) {
        if (constraint.where === undefined) continue;
        throw new ConfigurationError(
          `Unique constraint "${constraint.name}" on node kind "${registration.type.kind}" has a \`where\` clause, but the kind's schema is not an object schema, so its declared fields cannot be checked.`,
          {
            kind: registration.type.kind,
            constraintName: constraint.name,
          },
          {
            suggestion: `Declare the kind with an object schema (\`z.object({ ... })\`) so the \`where\` clause can be validated, or drop the \`where\` clause.`,
          },
        );
      }

      assertWhereFieldDeclared(registration.type.kind, constraint, shape);
    }
  }
}

// ============================================================
// Index Normalization
// ============================================================

/**
 * Validates the `indexes` config slice:
 *
 * - Every index references a kind that exists in the graph's `nodes`
 *   (for node indexes) or `edges` (for edge indexes).
 * - Index `name`s are unique within the graph.
 */
function normalizeIndexes(
  inputs: readonly IndexDeclaration[],
  nodes: Record<string, NodeRegistration>,
  edges: Record<string, EdgeRegistration>,
): readonly IndexDeclaration[] {
  if (inputs.length === 0) {
    return [];
  }

  const nodeKinds = collectKinds(nodes);
  const edgeKinds = collectKinds(edges);
  const seenNames = new Set<string>();

  for (const declaration of inputs) {
    if (declaration.entity === "node" || declaration.entity === "vector") {
      // Vector indexes attach to node kinds (the embedding lives on a
      // node field). Validation reuses the node-kind check.
      assertKindRegistered(declaration, nodeKinds, "node");
    } else {
      assertKindRegistered(declaration, edgeKinds, "edge");
    }

    if (seenNames.has(declaration.name)) {
      throw new ConfigurationError(
        `Duplicate index name "${declaration.name}" in defineGraph({ indexes }). ` +
          `Index names must be unique within a graph.`,
        { indexName: declaration.name },
        {
          suggestion: `Pass an explicit { name: "..." } to disambiguate.`,
        },
      );
    }
    seenNames.add(declaration.name);
  }

  return inputs;
}

function collectKinds(
  registrations: Record<string, { type: { kind: string } }>,
): ReadonlySet<string> {
  const kinds = new Set<string>();
  for (const registration of Object.values(registrations)) {
    kinds.add(registration.type.kind);
  }
  return kinds;
}

function assertKindRegistered(
  declaration: IndexDeclaration,
  registeredKinds: ReadonlySet<string>,
  entity: KindEntity,
): void {
  if (registeredKinds.has(declaration.kind)) return;

  const slot = entity === "node" ? "nodes" : "edges";
  const suggestion =
    entity === "node" ?
      `Add { ${declaration.kind}: { type: ${declaration.kind} } } to defineGraph({ nodes }) ` +
      `or remove the index from "indexes".`
    : `Register the edge in defineGraph({ edges }) or remove the index from "indexes".`;

  throw new ConfigurationError(
    `Index "${declaration.name}" references ${entity} kind "${declaration.kind}" ` +
      `which is not registered in this graph's "${slot}".`,
    {
      indexName: declaration.name,
      referencedKind: declaration.kind,
      availableKinds: [...registeredKinds],
    },
    { suggestion },
  );
}

// ============================================================
// Graph Definition Utilities
// ============================================================

/**
 * Checks if a value is a GraphDef.
 */
export function isGraphDef(value: unknown): value is GraphDef {
  return (
    typeof value === "object" &&
    value !== null &&
    GRAPH_DEF_BRAND in value &&
    (value as Record<string, unknown>)[GRAPH_DEF_BRAND] === true
  );
}

/**
 * Gets all node kind names from a GraphDef.
 */
export function getNodeKinds<G extends GraphDef>(
  graph: G,
): readonly (keyof G["nodes"] & string)[] {
  return Object.keys(graph.nodes);
}

/**
 * Gets all edge kind names from a GraphDef.
 */
export function getEdgeKinds<G extends GraphDef>(
  graph: G,
): readonly (keyof G["edges"] & string)[] {
  return Object.keys(graph.edges);
}

/**
 * Returns true when `name` is registered as either a node or edge kind
 * on the given graph.
 */
export function isKnownKind(graph: GraphDef, name: string): boolean {
  return Object.hasOwn(graph.nodes, name) || Object.hasOwn(graph.edges, name);
}
