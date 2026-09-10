/**
 * Subgraph Extraction
 *
 * Extracts a typed subgraph from a root node by traversing a set of edge kinds.
 * Uses a recursive CTE for BFS traversal with cycle detection, then hydrates
 * the reachable nodes and connecting edges in two parallel queries.
 */
import { resolveRecursiveTraversal } from "../backend/capabilities/recursive-traversal";
import type { GraphBackend } from "../backend/types";
import { MAX_PG_IDENTIFIER_LENGTH } from "../constants";
import type {
  AllNodeTypes,
  EdgeKinds,
  GraphDef,
  NodeKinds,
} from "../core/define-graph";
import { type RecordedInstant, resolveReadCoordinate } from "../core/temporal";
import type { KindEntity } from "../core/types";
import type {
  AnyEdgeType,
  NodeId,
  NodeType,
  TemporalMode,
} from "../core/types";
import { ConfigurationError } from "../errors";
import type { RecursiveCyclePolicy } from "../query/ast";
import { compileKindFilter } from "../query/compiler/predicate-utils";
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "../query/compiler/recursive";
import {
  DEFAULT_SQL_SCHEMA,
  type RecordedReadBinding,
  recordedReadSchemaFor,
  type SqlSchema,
} from "../query/compiler/schema";
import {
  compileTemporalFilter,
  currentReadInstant,
} from "../query/compiler/temporal";
import { compileTypedJsonExtract } from "../query/compiler/typed-json-extract";
import { quoteIdentifier } from "../query/compiler/utils";
import type { DialectAdapter } from "../query/dialect/types";
import { decodeSelectedValue } from "../query/execution/value-decoder";
import { jsonPointer } from "../query/json-pointer";
import {
  createSchemaIntrospector,
  type FieldTypeInfo,
  type SchemaIntrospector,
} from "../query/schema-introspector";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql, markForceCustomPlan } from "../query/sql-intent";
import { partitionCompositionEdgeKindsByDirection } from "../registry/composition-relation";
import type { KindRegistry } from "../registry/kind-registry";
import { fnv1aBase36 } from "../utils/hash";
import { truncateToBytes } from "../utils/identifier";
import { hasOwnKey } from "../utils/object";
import {
  buildExhaustiveDirectedReachableCte,
  buildReachableCte,
} from "./recursive-cte";
import { validateProjectionField } from "./reserved-keys";
import {
  type EdgeRow,
  type NodeRow,
  rowToEdge,
  rowToEdgeMeta,
  rowToNode,
  rowToNodeMeta,
} from "./row-mappers";
import type { Edge, EdgeMeta, Node, NodeMeta } from "./types";

// ============================================================
// Constants
// ============================================================

const DEFAULT_SUBGRAPH_MAX_DEPTH = 10;

/**
 * Generates a short, deterministic column alias safe for PostgreSQL.
 *
 * Format: `sg_{n|e}_{truncatedKind}_{hash}`
 * The hash is computed from the full `kind + field` to prevent collisions
 * when truncation would make two different identifiers identical.
 *
 * PostgreSQL truncates identifiers at 63 *bytes*, not characters.
 * The kind portion is truncated by byte length to stay under the limit
 * even with multibyte characters.
 */
function projectionAlias(
  entityPrefix: KindEntity,
  kind: string,
  field: string,
): string {
  const prefix = entityPrefix === "node" ? "sg_n" : "sg_e";
  const hash = fnv1aBase36(`${kind}\0${field}`);
  // prefix + "_" + kind_trunc + "_" + hash must fit in 63 bytes.
  // prefix and hash are ASCII, so byte length === string length.
  const fixedBytes = prefix.length + 1 + 1 + hash.length;
  const maxKindBytes = MAX_PG_IDENTIFIER_LENGTH - fixedBytes;
  const truncatedKind = truncateToBytes(kind, maxKindBytes);
  return `${prefix}_${truncatedKind}_${hash}`;
}

/**
 * Normalizes a JSON column value to a string.
 * PostgreSQL JSONB columns return parsed objects; SQLite returns strings.
 */
function normalizeProps(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

// ============================================================
// Type Utilities
// ============================================================

/**
 * Discriminated union of all Node runtime types in a graph.
 *
 * Unlike `AllNodeTypes<G>` which gives the union of *type definitions*,
 * `AnyNode<G>` gives the union of *runtime node instances*.
 */
export type AnyNode<G extends GraphDef> = {
  [K in NodeKinds<G>]: Node<G["nodes"][K]["type"]>;
}[NodeKinds<G>];

/**
 * Discriminated union of all Edge runtime types in a graph.
 */
export type AnyEdge<G extends GraphDef> = {
  [K in EdgeKinds<G>]: Edge<G["edges"][K]["type"]>;
}[EdgeKinds<G>];

/**
 * Discriminated union of Node runtime types narrowed to a subset of kinds.
 */
export type SubsetNode<G extends GraphDef, K extends NodeKinds<G>> = {
  [Kind in K]: Node<G["nodes"][Kind]["type"]>;
}[K];

/**
 * Discriminated union of Edge runtime types narrowed to a subset of kinds.
 */
export type SubsetEdge<G extends GraphDef, K extends EdgeKinds<G>> = {
  [Kind in K]: Edge<G["edges"][Kind]["type"]>;
}[K];

type EmptyShape = Readonly<Record<never, never>>;

type NodeProjectionPropertyKey<N extends NodeType> = Exclude<
  keyof Node<N>,
  "id" | "kind" | "meta"
> &
  string;

type EdgeProjectionPropertyKey<E extends AnyEdgeType> = Exclude<
  keyof Edge<E>,
  "id" | "kind" | "fromKind" | "fromId" | "toKind" | "toId" | "meta"
> &
  string;

type SubgraphNodeProjectionField<N extends NodeType = NodeType> =
  NodeProjectionPropertyKey<N> | "meta";

type SubgraphEdgeProjectionField<E extends AnyEdgeType = AnyEdgeType> =
  EdgeProjectionPropertyKey<E> | "meta";

type SubgraphNodeProjectionMap<
  G extends GraphDef,
  NK extends NodeKinds<G> = NodeKinds<G>,
> = Readonly<{
  [K in NodeKinds<G>]?: K extends NK ?
    readonly SubgraphNodeProjectionField<G["nodes"][K]["type"]>[]
  : never;
}>;

type SubgraphEdgeProjectionMap<
  G extends GraphDef,
  EK extends EdgeKinds<G> = EdgeKinds<G>,
> = Readonly<{
  [K in EdgeKinds<G>]?: K extends EK ?
    readonly SubgraphEdgeProjectionField<G["edges"][K]["type"]>[]
  : never;
}>;

export type SubgraphProject<
  G extends GraphDef,
  NK extends NodeKinds<G> = NodeKinds<G>,
  EK extends EdgeKinds<G> = EdgeKinds<G>,
> = Readonly<{
  /**
   * Node fields to keep per kind.
   *
   * Projected nodes always retain `kind` and `id`.
   * Use `"meta"` to include the full metadata object; omit it to exclude metadata entirely.
   * Only kinds present in `includeKinds` (or all node kinds when omitted) are valid keys.
   */
  nodes?: SubgraphNodeProjectionMap<G, NK>;
  /**
   * Edge fields to keep per kind.
   *
   * Projected edges always retain `id`, `kind`, `fromKind`, `fromId`,
   * `toKind`, and `toId`.
   * Use `"meta"` to include the full metadata object; omit it to exclude metadata entirely.
   * Only edge kinds listed in `edges` are valid keys.
   */
  edges?: SubgraphEdgeProjectionMap<G, EK>;
}>;

/**
 * Identity function that preserves literal types for reusable projection configs.
 *
 * Without this helper, storing a projection in a typed variable widens the
 * field arrays to `string[]`, defeating compile-time narrowing on results.
 *
 * @example
 * ```ts
 * const project = defineSubgraphProject(graph)({
 *   nodes: { Task: ["title", "meta"] },
 *   edges: { uses_skill: [] },
 * });
 * const result = await store.subgraph(rootId, { edges: ["uses_skill"], project });
 * // result.nodes narrowed correctly — task.status is a type error
 * ```
 */
export function defineSubgraphProject<G extends GraphDef>(
  _graph: G,
): <const P extends SubgraphProject<G>>(project: P) => P {
  return <const P extends SubgraphProject<G>>(project: P): P => project;
}

type HasMeta<Selection extends readonly string[] | undefined> =
  Selection extends readonly string[] ?
    "meta" extends Selection[number] ?
      true
    : false
  : false;

type SelectedNodeProps<
  N extends NodeType,
  Selection extends readonly string[] | undefined,
> =
  Selection extends readonly string[] ?
    Pick<Node<N>, Extract<Selection[number], NodeProjectionPropertyKey<N>>>
  : EmptyShape;

type SelectedEdgeProps<
  E extends AnyEdgeType,
  Selection extends readonly string[] | undefined,
> =
  Selection extends readonly string[] ?
    Pick<Edge<E>, Extract<Selection[number], EdgeProjectionPropertyKey<E>>>
  : EmptyShape;

type ProjectedNodeResult<
  N extends NodeType,
  Selection extends readonly string[] | undefined,
> = Readonly<Pick<Node<N>, "id" | "kind">> &
  Readonly<SelectedNodeProps<N, Selection>> &
  (HasMeta<Selection> extends true ? Readonly<{ meta: NodeMeta }> : EmptyShape);

type ProjectedEdgeResult<
  E extends AnyEdgeType,
  Selection extends readonly string[] | undefined,
> = Readonly<
  Pick<Edge<E>, "id" | "kind" | "fromKind" | "fromId" | "toKind" | "toId">
> &
  Readonly<SelectedEdgeProps<E, Selection>> &
  (HasMeta<Selection> extends true ? Readonly<{ meta: EdgeMeta }> : EmptyShape);

type ProjectionSelection<
  P,
  Key extends "nodes" | "edges",
  Kind extends string,
> =
  // eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style -- mapped type needed for conditional inference on Key
  P extends Readonly<{ [K in Key]?: infer Map }> ?
    Map extends Readonly<Record<string, readonly string[] | undefined>> ?
      Kind extends keyof Map ?
        Map[Kind]
      : undefined
    : undefined
  : undefined;

type SubgraphNodeResultForKind<
  G extends GraphDef,
  Kind extends NodeKinds<G>,
  P,
> =
  ProjectionSelection<P, "nodes", Kind> extends readonly string[] ?
    ProjectedNodeResult<
      G["nodes"][Kind]["type"],
      ProjectionSelection<P, "nodes", Kind>
    >
  : Node<G["nodes"][Kind]["type"]>;

type SubgraphEdgeResultForKind<
  G extends GraphDef,
  Kind extends EdgeKinds<G>,
  P,
> =
  ProjectionSelection<P, "edges", Kind> extends readonly string[] ?
    ProjectedEdgeResult<
      G["edges"][Kind]["type"],
      ProjectionSelection<P, "edges", Kind>
    >
  : Edge<G["edges"][Kind]["type"]>;

// ============================================================
// Options & Result Types
// ============================================================

export type SubgraphOptions<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProjectFor<G, NK, EK, C> | undefined = undefined,
  C extends boolean | undefined = undefined,
> = Readonly<{
  /** Edge kinds to follow during traversal. Edges not listed are not traversed. */
  edges: readonly EK[];
  /**
   * Maximum traversal depth from root for the `edges` list above (default:
   * 10). It does NOT bound the `composition` closure: that returns the
   * complete owned unit at any depth — see {@link SubgraphOptions.composition}.
   */
  maxDepth?: number;
  /**
   * Node kinds to include in the result. Nodes of other kinds are still
   * traversed through but omitted from the output. When omitted, all
   * reachable node kinds are included.
   */
  includeKinds?: readonly NK[];
  /** Exclude the root node from the result (default: false). */
  excludeRoot?: boolean;
  /**
   * Edge direction policy (default: "out").
   * - "out": follow edges in their defined direction only
   * - "both": follow edges in both directions (undirected traversal)
   */
  direction?: "out" | "both";
  /** Cycle policy — reuse RecursiveCyclePolicy (default: "prevent"). */
  cyclePolicy?: RecursiveCyclePolicy;
  /**
   * Close the selected root over its declared composition parts — the
   * whole-plus-parts export unit (roadmap item E). When `true`, every
   * composition edge kind transitively under the root's actual kind
   * (`registry.compositionEdgeKindsUnder`) is added to the traversal and to
   * the hydrated edge set, in addition to whatever `edges` already lists.
   *
   * This is set-level, not per-root-kind-required: a root whose kind
   * declares no composition parts contributes nothing extra and the read
   * still runs normally (applied, not ignored — it just has no effect for
   * that root). A graph that declares no composition relation *at all*
   * cannot honor the option meaningfully and refuses with
   * `ConfigurationError` (`COMPOSITION_NO_PARTS_DECLARED`) rather than
   * silently running as if the option were absent.
   *
   * Composition edge kinds added this way are not necessarily members of
   * the compile-time `edges` list, and which ones join depends on the ROOT's
   * runtime kind — so passing `true` widens the result's edge-key type to
   * the graph's whole edge-kind union (see
   * {@link SubgraphResultEdgeKinds}). That is conservative on purpose: an
   * `adjacency` key the traversal can actually produce must be reachable
   * through the result type, and the exact set is not knowable at compile
   * time.
   *
   * The closure is COMPLETE: it is bounded by its own visited set, never by
   * `maxDepth`. A part tree deeper than the default depth still comes back
   * whole, because a whole plus a truncated prefix of its parts is not an
   * owned unit. `maxDepth` (and `cyclePolicy`) bound the explicit `edges`
   * traversal alone.
   */
  composition?: C;
  /**
   * Temporal mode applied to both nodes and edges along the traversal and in
   * the hydrated result. Defaults to `graph.defaults.temporalMode`.
   */
  temporalMode?: TemporalMode;
  /** ISO-8601 timestamp used when `temporalMode === "asOf"`. */
  asOf?: string;
  /** @internal Recorded coordinates are supplied by StoreView only. */
  recordedAsOf?: never;
  /**
   * Optional field-level projection per node/edge kind.
   *
   * Projected nodes keep `kind` and `id`; projected edges keep their structural
   * endpoint fields. Kinds omitted from `project` remain fully hydrated.
   * Projection applies to every returned entity, including the root node.
   *
   * Only kinds present in `includeKinds` (nodes) or `edges` (edges) are valid
   * projection keys. Specifying a kind outside those sets is a compile-time error.
   */
  project?: P;
}>;

/**
 * Subgraph options as seen by the internal executor: identical to the public
 * {@link SubgraphOptions} except the recorded/system-time pin is a branded
 * instant the StoreView seam supplies. The public surface keeps
 * `recordedAsOf?: never`;
 * recorded reads reach the executor only through `store.subgraphAtCoordinate`.
 */
export type InternalSubgraphOptions<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProjectFor<G, NK, EK, C> | undefined = undefined,
  C extends boolean | undefined = undefined,
> = Omit<SubgraphOptions<G, EK, NK, P, C>, "recordedAsOf"> &
  Readonly<{
    recordedAsOf?: RecordedInstant;
  }>;

/**
 * Union of all node result types in a subgraph, respecting projection.
 */
export type SubgraphNodeResult<
  G extends GraphDef,
  NK extends NodeKinds<G> = NodeKinds<G>,
  P = undefined,
> = {
  [Kind in NK]: SubgraphNodeResultForKind<G, Kind, P>;
}[NK];

/**
 * Union of all edge result types in a subgraph, respecting projection.
 */
export type SubgraphEdgeResult<
  G extends GraphDef,
  EK extends EdgeKinds<G> = EdgeKinds<G>,
  P = undefined,
> = {
  [Kind in EK]: SubgraphEdgeResultForKind<G, Kind, P>;
}[EK];

/**
 * The edge-key union a `subgraph(...)` result exposes in `adjacency` /
 * `reverseAdjacency`: the declared `edges` list, widened to the graph's
 * WHOLE edge-kind union when the call passed `composition: true`.
 *
 * `composition: true` adds `registry.compositionEdgeKindsUnder(rootKind)` to
 * the traversal — a set that depends on the root row's runtime kind, not on
 * anything the call site states — so the exact addition is not knowable at
 * compile time. Widening to every declared edge kind is the conservative
 * reading: every key the traversal can produce is in the result type, and no
 * key outside the graph's own edges ever appears. A `composition` that is
 * absent or `false` leaves the existing `edges`-list typing exactly as it
 * was. `true extends C` is the test, not `C extends true`, so an unresolved
 * `boolean` — a flag that MIGHT be `true` at runtime — widens as well.
 */
export type SubgraphResultEdgeKinds<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  C extends boolean | undefined,
> = true extends C ? EdgeKinds<G> : EK;

/**
 * The projection a `subgraph(...)` call may state, keyed by the edge kinds its
 * RESULT carries ({@link SubgraphResultEdgeKinds}) rather than by the declared
 * `edges` list. A `composition: true` call receives composition edge rows, and
 * the executor builds its edge projection plan from that same widened kind
 * list, so constraining the input by the narrow list alone would leave a
 * caller unable to shrink the payload of rows it is already being handed.
 * Without `composition: true` the two lists are identical, so a projection
 * naming a kind outside `edges` stays a compile-time error.
 */
export type SubgraphProjectFor<
  G extends GraphDef,
  NK extends NodeKinds<G>,
  EK extends EdgeKinds<G>,
  C extends boolean | undefined,
> = SubgraphProject<G, NK, SubgraphResultEdgeKinds<G, EK, C>>;

/**
 * The result of a `subgraph(...)` read. `EK` is the edge-kind union the result
 * CARRIES ({@link SubgraphResultEdgeKinds} of the call's declared `edges`), so
 * `P` is constrained by the projection over that same union — the one
 * {@link SubgraphProjectFor} admits at the call site. A fourth argument that
 * is not a projection at all is refused here rather than silently yielding
 * `undefined` selections and fully hydrated rows.
 */
export type SubgraphResult<
  G extends GraphDef,
  NK extends NodeKinds<G> = NodeKinds<G>,
  EK extends EdgeKinds<G> = EdgeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
> = Readonly<{
  /** The root node, or undefined if the root was not found or excluded. */
  root: SubgraphNodeResult<G, NK, P> | undefined;
  nodes: ReadonlyMap<string, SubgraphNodeResult<G, NK, P>>;
  /** Forward adjacency: fromId → edgeKind → edges to targets. */
  adjacency: ReadonlyMap<
    string,
    ReadonlyMap<EK, readonly SubgraphEdgeResult<G, EK, P>[]>
  >;
  /** Reverse adjacency: toId → edgeKind → edges from sources. */
  reverseAdjacency: ReadonlyMap<
    string,
    ReadonlyMap<EK, readonly SubgraphEdgeResult<G, EK, P>[]>
  >;
}>;

// ============================================================
// Execution Context
// ============================================================

type SubgraphContext = Readonly<{
  graphId: string;
  rootId: string;
  edgeKinds: readonly string[];
  maxDepth: number;
  includeKinds: readonly string[] | undefined;
  excludeRoot: boolean;
  direction: "out" | "both";
  cyclePolicy: RecursiveCyclePolicy;
  temporalMode: TemporalMode;
  asOf: string | undefined;
  recordedAsOf: RecordedInstant | undefined;
  dialect: DialectAdapter;
  schema: SqlSchema;
  recordedReadBinding: RecordedReadBinding | undefined;
  backend: GraphBackend;
}>;

type SubgraphNodeFetchRow = Readonly<
  Omit<NodeRow, "props"> & { props: unknown } & Record<string, unknown>
>;

type SubgraphEdgeFetchRow = Readonly<
  Omit<EdgeRow, "props"> & { props: unknown } & Record<string, unknown>
>;

type ProjectionPropertyFieldPlan = Readonly<{
  field: string;
  outputName: string;
  typeInfo: FieldTypeInfo | undefined;
}>;

type KindProjectionPlan = Readonly<{
  includeMeta: boolean;
  propertyFields: readonly ProjectionPropertyFieldPlan[];
}>;

type ProjectionPlan = Readonly<{
  fullKinds: readonly string[];
  projectedKinds: ReadonlyMap<string, KindProjectionPlan>;
}>;

// ============================================================
// Public API
// ============================================================

export async function executeSubgraph<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProjectFor<G, NK, EK, C> | undefined = undefined,
  C extends boolean | undefined = undefined,
>(params: {
  graph: G;
  graphId: string;
  rootId: NodeId<AllNodeTypes<G>>;
  backend: GraphBackend;
  dialect: DialectAdapter;
  schema: SqlSchema | undefined;
  recordedReadBinding: RecordedReadBinding | undefined;
  registry: KindRegistry;
  options: InternalSubgraphOptions<G, EK, NK, P, C>;
}): Promise<SubgraphResult<G, NK, SubgraphResultEdgeKinds<G, EK, C>, P>> {
  const { options } = params;
  const { valid: coordinate } = resolveReadCoordinate(
    options.temporalMode ?? params.graph.defaults.temporalMode,
    options.asOf,
  );
  const temporalMode = coordinate.mode;
  // `recordedAsOf` reaches here only via the internal `subgraphAtCoordinate`
  // seam; the public `store.subgraph` rejects it (typed `never`, runtime-guarded
  // for JS callers) before this executor is reached.
  const recordedAsOf = options.recordedAsOf;
  const baseSchema = params.schema ?? DEFAULT_SQL_SCHEMA;
  const resolvedSchema = recordedReadSchemaFor(
    baseSchema,
    recordedAsOf,
    params.recordedReadBinding,
    "recorded-subgraph",
  );

  if (
    options.composition === true &&
    params.registry.compositionEdgeKinds().length === 0
  ) {
    throw new ConfigurationError(
      `subgraph({ composition: true }) requires the graph to declare at least one partOf/hasPart relation, but "${params.graphId}" declares none.`,
      { code: "COMPOSITION_NO_PARTS_DECLARED" },
      {
        suggestion:
          "Declare a partOf/hasPart relation in the graph's ontology, or omit `composition` from the subgraph options.",
      },
    );
  }

  const compositionEdgeKinds =
    options.composition === true ?
      await fetchCompositionEdgeKindsForRoot({
        registry: params.registry,
        backend: params.backend,
        schema: resolvedSchema,
        graphId: params.graphId,
        rootId: params.rootId,
        temporalMode,
        asOf: coordinate.asOf,
        recordedAsOf,
      })
    : [];
  const edgeKinds = dedupeStrings([...options.edges, ...compositionEdgeKinds]);

  const maxDepth = Math.min(
    options.maxDepth ?? DEFAULT_SUBGRAPH_MAX_DEPTH,
    MAX_EXPLICIT_RECURSIVE_DEPTH,
  );

  const ctx: SubgraphContext = {
    graphId: params.graphId,
    rootId: params.rootId,
    edgeKinds,
    maxDepth,
    includeKinds: options.includeKinds,
    excludeRoot: options.excludeRoot ?? false,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    temporalMode,
    asOf: coordinate.asOf,
    recordedAsOf,
    dialect: params.dialect,
    schema: resolvedSchema,
    recordedReadBinding: params.recordedReadBinding,
    backend: params.backend,
  };

  const schemaIntrospector = getSubgraphSchemaIntrospector(params.graph);
  const nodeProjectionPlan = buildProjectionPlan(
    getIncludedNodeKinds(params.graph, options.includeKinds),
    options.project?.nodes,
    (kind, field) => schemaIntrospector.getFieldTypeInfo(kind, field),
    "node",
  );
  const edgeProjectionPlan = buildProjectionPlan(
    edgeKinds,
    options.project?.edges,
    (kind, field) => schemaIntrospector.getEdgeFieldTypeInfo(kind, field),
    "edge",
  );

  function buildSubgraphReachableCte(
    edgeKindsForTraversal: readonly string[],
    direction: "out" | "in" | "both",
  ): SqlFragment {
    return buildReachableCte({
      graphId: ctx.graphId,
      sourceId: ctx.rootId,
      edgeKinds: edgeKindsForTraversal,
      maxHops: ctx.maxDepth,
      direction,
      cyclePolicy: ctx.cyclePolicy,
      includePath: false,
      temporalMode: ctx.temporalMode,
      ...(ctx.asOf !== undefined && { asOf: ctx.asOf }),
      ...(ctx.recordedAsOf !== undefined && {
        recordedAsOf: ctx.recordedAsOf,
      }),
      dialect: ctx.dialect,
      // Base schema: buildReachableCte derives the recorded swap from recordedAsOf.
      schema: baseSchema,
      ...(ctx.recordedReadBinding === undefined ?
        {}
      : { recordedReadBinding: ctx.recordedReadBinding }),
      recursiveTraversal: resolveRecursiveTraversal(
        params.backend.capabilities,
      ),
      operation: "subgraph",
    });
  }

  /**
   * The composition closure's own reachable CTE: walks toward PARTS only,
   * with each realizing edge kind's direction derived through the same
   * `partitionCompositionEdgeKindsByDirection` helper `parts()`/`wholes()`
   * use, never a flat `"both"` (Ed-01). `"both"` would also climb from a
   * mid-tree root to its ancestors and re-descend into every sibling
   * subtree — R4 (one whole per part) makes the upward walk deterministic,
   * which is exactly what lets the downward re-descent pick up siblings
   * undetected.
   *
   * `composition: true` means "the COMPLETE owned unit", so this closure is
   * bounded by its VISITED SET, never by `maxDepth`: a whole plus a
   * truncated prefix of its parts is not an export unit — reloading it would
   * silently drop the tail of every deep subtree, and a required part cut
   * off from its whole cannot even be recreated. `maxDepth` continues to
   * bound the caller's own `edges` traversal (a genuine breadth choice over
   * arbitrary relationships) and nothing else. Composition depth is not a
   * caller's choice either way: it is however deep the part tree the caller
   * already wrote happens to be.
   *
   * Termination is structural rather than numeric, and there is NO hop
   * ceiling: the closure is `buildExhaustiveDirectedReachableCte`, whose
   * recursive term is `UNION` over a `(id, kind)` frontier, so it reaches a
   * fixpoint on any finite graph exactly the way item D.2's acyclicity probe
   * does. `MAX_EXPLICIT_RECURSIVE_DEPTH` — the ceiling every explicit
   * traversal is capped at, and the one caveat this closure used to carry —
   * does not apply: a part chain of any depth comes back whole, rather than
   * silently losing its tail past 1000 hops. The caller's `cyclePolicy`, like
   * `maxDepth`, governs the explicit `edges` traversal alone; this closure
   * needs neither, since a revisited node adds no new row to a set-semantics
   * recursion.
   */
  function buildSubgraphCompositionReachableCte(
    edgeKindsForTraversal: readonly string[],
  ): SqlFragment {
    const { outEdgeKinds, inEdgeKinds } =
      partitionCompositionEdgeKindsByDirection(
        params.registry,
        edgeKindsForTraversal,
        "parts",
      );
    return buildExhaustiveDirectedReachableCte({
      graphId: ctx.graphId,
      sourceId: ctx.rootId,
      outEdgeKinds,
      inEdgeKinds,
      temporalMode: ctx.temporalMode,
      ...(ctx.asOf !== undefined && { asOf: ctx.asOf }),
      ...(ctx.recordedAsOf !== undefined && {
        recordedAsOf: ctx.recordedAsOf,
      }),
      dialect: ctx.dialect,
      schema: baseSchema,
      ...(ctx.recordedReadBinding === undefined ?
        {}
      : { recordedReadBinding: ctx.recordedReadBinding }),
      recursiveTraversal: resolveRecursiveTraversal(
        params.backend.capabilities,
      ),
      operation: "subgraph",
    });
  }

  const includedIdsCte = buildIncludedIdsCte(ctx);

  // The node and edge fetches both need the traversal closure. Embedding
  // the recursive CTE in each statement runs the BFS twice; on Postgres
  // the closure ids are fetched ONCE and passed to both fetches as a
  // single text[] parameter, filtered via a hashed semi-join
  // (EXISTS over unnest — measured faster than `= ANY` on the same
  // closure). SQLite keeps the embedded form: its in-process traversal
  // is cheap, an id list would bind one parameter per id (bind-budget
  // pressure), and per-count SQL texts would churn the prepared-statement
  // cache.
  //
  // Composition is the one case that can never share this single reachable
  // CTE: `options.direction` is one scalar for the caller's own `edges`, but
  // a composition relation may mix `part -> whole` and `whole -> part`
  // (`has_*`) edges — so it is walked as its OWN closure, each realizing
  // edge kind in the direction that reaches PARTS
  // (`buildSubgraphCompositionReachableCte`, never a flat `"both"`, which
  // would also reach ancestors and siblings — Ed-01), and the two closures'
  // ids are unioned in JS. That union is computed portably (through the
  // dialect's single-parameter `inListParameter` seam, not a raw per-id `IN`
  // list — Ed-03) rather than through either dialect's normal membership
  // strategy, since Postgres's `unnest` path takes one array and SQLite's
  // inline-CTE path takes one embedded CTE — neither has a "two closures"
  // shape.
  let membership: SubgraphMembership;
  if (compositionEdgeKinds.length > 0) {
    const baseIds = await fetchIncludedIds(
      ctx,
      buildSubgraphReachableCte(options.edges, ctx.direction),
      includedIdsCte,
    );
    const compositionIds = await fetchIncludedIds(
      ctx,
      buildSubgraphCompositionReachableCte(compositionEdgeKinds),
      includedIdsCte,
    );
    membership = idListMembership(
      dedupeStrings([...baseIds, ...compositionIds]),
      ctx.dialect,
    );
  } else {
    const reachableCte = buildSubgraphReachableCte(
      options.edges,
      ctx.direction,
    );
    const membershipStrategy =
      ctx.dialect.capabilities.subgraphMembershipStrategy;
    switch (membershipStrategy) {
      case "materialized-ids": {
        const includedIds = await fetchIncludedIds(
          ctx,
          reachableCte,
          includedIdsCte,
        );
        const idsArray = textArrayParam(includedIds);
        membership = {
          prefix: sql``,
          idFilter: (column) =>
            sql`EXISTS (SELECT 1 FROM unnest(${idsArray}) AS tg_included(id) WHERE tg_included.id = ${column})`,
          parameterDependentPlan: true,
        };
        break;
      }
      case "inline-cte": {
        membership = {
          prefix: sql`${reachableCte}${includedIdsCte} `,
          // `column IN (subquery)` evaluates via a transient index — optimal
          // as-is. (The materialized-ids strategy takes the parameterized
          // array form above instead.)
          idFilter: (column) => sql`${column} IN (SELECT id FROM included_ids)`,
          parameterDependentPlan: false,
        };
        break;
      }
      default: {
        membershipStrategy satisfies never;
        throw new Error(
          `Unsupported subgraph membership strategy: ${String(membershipStrategy)}`,
        );
      }
    }
  }

  const [nodeRows, edgeRows] = await Promise.all([
    fetchSubgraphNodes(ctx, membership, nodeProjectionPlan),
    fetchSubgraphEdges(ctx, membership, edgeProjectionPlan),
  ]);

  const nodesMap = new Map<string, Node>();
  for (const row of nodeRows) {
    const node = mapSubgraphNodeRow(row, nodeProjectionPlan);
    nodesMap.set(node.id, node);
  }

  const adjacency = new Map<string, Map<string, Edge[]>>();
  const reverseAdjacency = new Map<string, Map<string, Edge[]>>();
  for (const row of edgeRows) {
    const edge = mapSubgraphEdgeRow(row, edgeProjectionPlan);
    insertAdjacencyEntry(adjacency, edge.fromId, edge.kind, edge);
    insertAdjacencyEntry(reverseAdjacency, edge.toId, edge.kind, edge);
  }

  const root = nodesMap.get(ctx.rootId);

  return {
    root,
    nodes: nodesMap,
    adjacency,
    reverseAdjacency,
  } as unknown as SubgraphResult<G, NK, SubgraphResultEdgeKinds<G, EK, C>, P>;
}

// ============================================================
// Projection Planning
// ============================================================

type FieldTypeResolver = (
  kind: string,
  field: string,
) => FieldTypeInfo | undefined;

const introspectorCache = new WeakMap<GraphDef, SchemaIntrospector>();

function getSubgraphSchemaIntrospector<G extends GraphDef>(
  graph: G,
): SchemaIntrospector {
  const cached = introspectorCache.get(graph);
  if (cached !== undefined) return cached;

  const nodeKinds = new Map(
    Object.entries(graph.nodes).map(([kind, definition]) => [
      kind,
      { schema: definition.type.schema },
    ]),
  );
  const edgeKinds = new Map(
    Object.entries(graph.edges).map(([kind, definition]) => [
      kind,
      { schema: definition.type.schema },
    ]),
  );

  const introspector = createSchemaIntrospector(nodeKinds, edgeKinds);
  introspectorCache.set(graph, introspector);
  return introspector;
}

function buildProjectionPlan(
  kinds: readonly string[],
  projectionMap:
    Readonly<Record<string, readonly string[] | undefined>> | undefined,
  resolveFieldType: FieldTypeResolver,
  entityPrefix: KindEntity,
): ProjectionPlan {
  const projectedKinds = new Map<string, KindProjectionPlan>();
  const fullKinds: string[] = [];

  for (const kind of kinds) {
    // Own-key read: `projectionMap` is the caller's `project.nodes` /
    // `project.edges` record and `kind` is a graph kind name, so a kind named
    // after an `Object.prototype` member ("toString") would otherwise read the
    // inherited function as this kind's field selection instead of "no
    // projection declared".
    const selection =
      projectionMap !== undefined && hasOwnKey(projectionMap, kind) ?
        projectionMap[kind]
      : undefined;
    if (selection === undefined) {
      fullKinds.push(kind);
      continue;
    }

    projectedKinds.set(
      kind,
      buildKindProjectionPlan(kind, selection, resolveFieldType, entityPrefix),
    );
  }

  return { fullKinds, projectedKinds };
}

function buildKindProjectionPlan(
  kind: string,
  selection: readonly string[],
  resolveFieldType: FieldTypeResolver,
  entityPrefix: KindEntity,
): KindProjectionPlan {
  const propertyFields = new Map<string, ProjectionPropertyFieldPlan>();
  let includeMeta = false;

  for (const field of selection) {
    if (field === "meta") {
      includeMeta = true;
      continue;
    }

    validateProjectionField(field, entityPrefix, kind);

    if (!propertyFields.has(field)) {
      propertyFields.set(field, {
        field,
        outputName: projectionAlias(entityPrefix, kind, field),
        typeInfo: resolveFieldType(kind, field),
      });
    }
  }

  return {
    includeMeta,
    propertyFields: [...propertyFields.values()],
  };
}

function getIncludedNodeKinds<G extends GraphDef>(
  graph: G,
  includeKinds: readonly NodeKinds<G>[] | undefined,
): readonly string[] {
  if (includeKinds === undefined || includeKinds.length === 0) {
    return Object.keys(graph.nodes);
  }

  return dedupeStrings(includeKinds);
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

// ============================================================
// SQL Generation
// ============================================================

function buildIncludedIdsCte(ctx: SubgraphContext): SqlFragment {
  const filters: SqlFragment[] = [];

  if (ctx.includeKinds !== undefined && ctx.includeKinds.length > 0) {
    filters.push(compileKindFilter(sql.raw("kind"), ctx.includeKinds));
  }

  if (ctx.excludeRoot) {
    filters.push(sql`id != ${ctx.rootId}`);
  }

  const whereClause =
    filters.length > 0 ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;

  return sql`, included_ids AS (SELECT DISTINCT id FROM reachable${whereClause})`;
}

/**
 * How the node/edge fetches restrict rows to the traversal closure:
 * either a statement prefix re-declaring the recursive CTE with an
 * `included_ids` membership subquery (SQLite), or an empty prefix with a
 * pre-fetched id-array filter (Postgres).
 */
type SubgraphMembership = Readonly<{
  prefix: SqlFragment;
  idFilter: (column: SqlFragment) => SqlFragment;
  /**
   * True in id-array mode: the fetch plans depend on the array
   * cardinality, so the statements must never fall onto a prepared
   * generic plan (see markForceCustomPlan).
   */
  parameterDependentPlan: boolean;
}>;

/**
 * Binds a string list as ONE text parameter in Postgres array-literal
 * form, cast to text[]. A single parameter keeps the statement text
 * constant across id counts, and the fetch statements semi-join against
 * `unnest` of the array. (Drizzle would otherwise serialize a JS array
 * param as JSON text.)
 */
function textArrayParam(values: readonly string[]): SqlFragment {
  const elements = values.map(
    (value) =>
      `"${value.replaceAll("\\", "\\\\").replaceAll('"', String.raw`\"`)}"`,
  );
  return sql`${`{${elements.join(",")}}`}::text[]`;
}

/**
 * A portable (dialect-agnostic) `SubgraphMembership` over an id list already
 * computed in JS — the shape the composition closure union needs, since
 * neither dialect's normal membership strategy (Postgres `unnest`, SQLite's
 * embedded CTE) has a "two closures, unioned" input.
 *
 * `idFilter` is called twice per fetch (`from_id` and `to_id` on the edge
 * fetch), so binding one parameter per id here would bind 2N parameters
 * with no bind-budget check — exactly the pressure the module's embedded-CTE
 * design otherwise avoids, and enough to exceed a Worker/D1-class backend's
 * `maxBindParameters` on an ordinary whole-plus-parts export (Ed-03). The
 * dialect's `inListParameter`/`packListValue` seam (the same one
 * `IN`-predicate compilation already uses for a parameterized list) packs
 * the whole id list into ONE bound value per call instead, so this binds a
 * constant 2 parameters regardless of how large the closure is.
 */
function idListMembership(
  ids: readonly string[],
  dialect: DialectAdapter,
): SubgraphMembership {
  if (ids.length === 0) {
    return {
      prefix: sql``,
      idFilter: () => sql`1 = 0`,
      parameterDependentPlan: true,
    };
  }
  const packedIds = dialect.packListValue(ids);
  return {
    prefix: sql``,
    idFilter: (column) =>
      dialect.inListParameter(column, sql`${packedIds}`, {
        negated: false,
        elementType: undefined,
      }),
    parameterDependentPlan: true,
  };
}

/**
 * Resolves the root's actual kind (not knowable ahead of a read: `rootId` is
 * typed `NodeId<AllNodeTypes<G>>`, a union over every node kind the graph
 * declares) and returns the composition edge kinds transitively under it —
 * empty when the root does not exist, is not visible at this coordinate, or
 * its kind declares no composition parts. `subgraph({ composition: true })`
 * is set-level (§5.2 of the composition design): a root kind with no parts
 * contributes nothing rather than failing the whole read.
 */
async function fetchCompositionEdgeKindsForRoot(input: {
  registry: KindRegistry;
  backend: GraphBackend;
  schema: SqlSchema;
  graphId: string;
  rootId: string;
  temporalMode: TemporalMode;
  asOf: string | undefined;
  recordedAsOf: RecordedInstant | undefined;
}): Promise<readonly string[]> {
  const nodeTemporalFilter = compileTemporalFilter({
    mode: input.temporalMode,
    asOf: input.asOf,
    recordedAsOf: input.recordedAsOf,
    tableAlias: "n",
    currentTimestamp: currentReadInstant(),
  });
  const query = sql`SELECT n.kind FROM ${input.schema.nodesTable} n WHERE n.graph_id = ${input.graphId} AND n.id = ${input.rootId} AND ${nodeTemporalFilter}`;
  const rows = await input.backend.execute<{ kind: string }>(
    asCompiledRowsSql(query),
  );
  const rootKind = rows[0]?.kind;
  return rootKind === undefined ?
      []
    : input.registry.compositionEdgeKindsUnder(rootKind);
}

/** Runs the traversal once and returns the closure's node ids. */
async function fetchIncludedIds(
  ctx: SubgraphContext,
  reachableCte: SqlFragment,
  includedIdsCte: SqlFragment,
): Promise<readonly string[]> {
  const rows = await ctx.backend.execute<{ id: string }>(
    asCompiledRowsSql(
      sql`${reachableCte}${includedIdsCte} SELECT id FROM included_ids`,
    ),
  );
  return rows.map((row) => row.id);
}

async function fetchSubgraphNodes(
  ctx: SubgraphContext,
  membership: SubgraphMembership,
  projectionPlan: ProjectionPlan,
): Promise<SubgraphNodeFetchRow[]> {
  const nodeTemporalFilter = compileTemporalFilter({
    mode: ctx.temporalMode,
    asOf: ctx.asOf,
    recordedAsOf: ctx.recordedAsOf,
    tableAlias: "n",
    currentTimestamp: currentReadInstant(),
    recordedReadBinding: ctx.recordedReadBinding,
  });
  const columns: SqlFragment[] = [
    sql`n.kind`,
    sql`n.id`,
    buildFullPropsColumn("n", projectionPlan),
    ...buildMetadataColumns("n", projectionPlan, [
      "version",
      "valid_from",
      "valid_to",
      "created_at",
      "updated_at",
      "deleted_at",
    ]),
    ...buildProjectedPropertyColumns("n", projectionPlan, ctx.dialect),
  ];

  const query = sql`${membership.prefix}SELECT ${sql.join(columns, sql`, `)} FROM ${ctx.schema.nodesTable} n WHERE n.graph_id = ${ctx.graphId} AND ${nodeTemporalFilter} AND ${membership.idFilter(sql.raw("n.id"))}`;
  if (membership.parameterDependentPlan) markForceCustomPlan(query);

  return ctx.backend.execute<SubgraphNodeFetchRow>(
    asCompiledRowsSql(query),
  ) as Promise<SubgraphNodeFetchRow[]>;
}

async function fetchSubgraphEdges(
  ctx: SubgraphContext,
  membership: SubgraphMembership,
  projectionPlan: ProjectionPlan,
): Promise<SubgraphEdgeFetchRow[]> {
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), ctx.edgeKinds);
  const edgeTemporalFilter = compileTemporalFilter({
    mode: ctx.temporalMode,
    asOf: ctx.asOf,
    recordedAsOf: ctx.recordedAsOf,
    tableAlias: "e",
    currentTimestamp: currentReadInstant(),
    recordedReadBinding: ctx.recordedReadBinding,
  });
  const columns: SqlFragment[] = [
    sql`e.id`,
    sql`e.kind`,
    sql`e.from_kind`,
    sql`e.from_id`,
    sql`e.to_kind`,
    sql`e.to_id`,
    buildFullPropsColumn("e", projectionPlan),
    ...buildMetadataColumns("e", projectionPlan, [
      "valid_from",
      "valid_to",
      "created_at",
      "updated_at",
      "deleted_at",
    ]),
    ...buildProjectedPropertyColumns("e", projectionPlan, ctx.dialect),
  ];

  const query = sql`${membership.prefix}SELECT ${sql.join(columns, sql`, `)} FROM ${ctx.schema.edgesTable} e WHERE e.graph_id = ${ctx.graphId} AND ${edgeKindFilter} AND ${edgeTemporalFilter} AND ${membership.idFilter(sql.raw("e.from_id"))} AND ${membership.idFilter(sql.raw("e.to_id"))}`;
  if (membership.parameterDependentPlan) markForceCustomPlan(query);

  return ctx.backend.execute<SubgraphEdgeFetchRow>(
    asCompiledRowsSql(query),
  ) as Promise<SubgraphEdgeFetchRow[]>;
}

function buildMetadataColumns(
  alias: "n" | "e",
  plan: ProjectionPlan,
  columns: readonly string[],
): readonly SqlFragment[] {
  if (plan.projectedKinds.size === 0) {
    return columns.map((col) => sql`${sql.raw(`${alias}.${col}`)}`);
  }

  const metaKinds: string[] = [...plan.fullKinds];
  for (const [kind, kindPlan] of plan.projectedKinds) {
    if (kindPlan.includeMeta) metaKinds.push(kind);
  }

  if (metaKinds.length === 0) {
    return columns.map((col) => sql`NULL AS ${sql.raw(col)}`);
  }

  // All kinds need meta — no CASE needed
  if (metaKinds.length === plan.fullKinds.length + plan.projectedKinds.size) {
    return columns.map((col) => sql`${sql.raw(`${alias}.${col}`)}`);
  }

  const filter = compileKindFilter(sql.raw(`${alias}.kind`), metaKinds);
  return columns.map(
    (col) =>
      sql`CASE WHEN ${filter} THEN ${sql.raw(`${alias}.${col}`)} ELSE NULL END AS ${sql.raw(col)}`,
  );
}

function buildFullPropsColumn(
  alias: "n" | "e",
  plan: ProjectionPlan,
): SqlFragment {
  if (plan.projectedKinds.size === 0) {
    return sql`${sql.raw(`${alias}.props`)} AS props`;
  }

  if (plan.fullKinds.length === 0) {
    return sql`NULL AS props`;
  }

  const filter = compileKindFilter(sql.raw(`${alias}.kind`), plan.fullKinds);
  return sql`CASE WHEN ${filter} THEN ${sql.raw(`${alias}.props`)} ELSE NULL END AS props`;
}

function buildProjectedPropertyColumns(
  alias: "n" | "e",
  plan: ProjectionPlan,
  dialect: DialectAdapter,
): readonly SqlFragment[] {
  const columns: SqlFragment[] = [];

  for (const [kind, kindPlan] of plan.projectedKinds.entries()) {
    for (const fieldPlan of kindPlan.propertyFields) {
      const extracted = compileTypedJsonExtract({
        column: sql.raw(`${alias}.props`),
        dialect,
        pointer: jsonPointer([fieldPlan.field]),
        valueType: fieldPlan.typeInfo?.valueType,
      });

      columns.push(
        sql`CASE WHEN ${sql.raw(alias)}.kind = ${kind} THEN ${extracted} ELSE NULL END AS ${quoteIdentifier(fieldPlan.outputName)}`,
      );
    }
  }

  return columns;
}

// ============================================================
// Adjacency Index Builder
// ============================================================

function insertAdjacencyEntry(
  index: Map<string, Map<string, Edge[]>>,
  nodeId: string,
  edgeKind: string,
  edge: Edge,
): void {
  let kindMap = index.get(nodeId);
  if (kindMap === undefined) {
    kindMap = new Map();
    index.set(nodeId, kindMap);
  }
  const edges = kindMap.get(edgeKind);
  if (edges === undefined) {
    kindMap.set(edgeKind, [edge]);
  } else {
    edges.push(edge);
  }
}

// ============================================================
// Result Mapping
// ============================================================

function applyProjectedFields(
  target: Record<string, unknown>,
  row: Readonly<Record<string, unknown>>,
  kindPlan: KindProjectionPlan,
): void {
  for (const fieldPlan of kindPlan.propertyFields) {
    target[fieldPlan.field] = decodeSelectedValue(
      row[fieldPlan.outputName],
      fieldPlan.typeInfo,
    );
  }
}

function mapSubgraphNodeRow(
  row: SubgraphNodeFetchRow,
  projectionPlan: ProjectionPlan,
): Node {
  const kindPlan = projectionPlan.projectedKinds.get(row.kind);
  if (kindPlan === undefined) {
    return rowToNode({
      ...row,
      props: normalizeProps(row.props),
    });
  }

  const projectedNode: Record<string, unknown> = {
    kind: row.kind,
    id: row.id,
  };

  if (kindPlan.includeMeta) {
    projectedNode["meta"] = rowToNodeMeta(row);
  }

  applyProjectedFields(projectedNode, row, kindPlan);
  return projectedNode as Node;
}

function mapSubgraphEdgeRow(
  row: SubgraphEdgeFetchRow,
  projectionPlan: ProjectionPlan,
): Edge {
  const kindPlan = projectionPlan.projectedKinds.get(row.kind);
  if (kindPlan === undefined) {
    return rowToEdge({
      ...row,
      props: normalizeProps(row.props),
    });
  }

  const projectedEdge: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    fromKind: row.from_kind,
    fromId: row.from_id,
    toKind: row.to_kind,
    toId: row.to_id,
  };

  if (kindPlan.includeMeta) {
    projectedEdge["meta"] = rowToEdgeMeta(row);
  }

  applyProjectedFields(projectedEdge, row, kindPlan);
  return projectedEdge as Edge;
}
