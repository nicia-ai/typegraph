/**
 * Subgraph Extraction
 *
 * Extracts a typed subgraph from a root node by traversing a set of edge kinds.
 * Both public read forms share one validation and projection plan. The direct
 * read uses the backend's tuned hydration strategy; the composable read emits
 * one statement so it can participate in batchOnce().
 */
import { resolveRecursiveTraversal } from "../backend/capabilities/recursive-traversal";
import { backendDerivationRoot } from "../backend/derive-backend";
import {
  normalizeRequiredRowTimestamp,
  normalizeRowTimestamp,
} from "../backend/row-mappers";
import type { GraphBackend } from "../backend/types";
import { MAX_PG_IDENTIFIER_LENGTH } from "../constants";
import type { EdgeKinds, GraphDef, NodeKinds } from "../core/define-graph";
import { type RecordedInstant, resolveReadCoordinate } from "../core/temporal";
import type { KindEntity } from "../core/types";
import type { AnyEdgeType, NodeType, TemporalMode } from "../core/types";
import {
  ConfigurationError,
  KindNotFoundError,
  ValidationError,
} from "../errors";
import type { RecursiveCyclePolicy } from "../query/ast";
import {
  type OneStatementBatchItem,
  registerOneStatementSharing,
} from "../query/builder/one-statement-sharing";
import type { ExecutableOneStatementRead } from "../query/builder/types";
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
import { compareCodePoints } from "../utils/compare";
import { fnv1aBase36 } from "../utils/hash";
import { truncateToBytes } from "../utils/identifier";
import { hasOwnKey } from "../utils/object";
import { requireDefined } from "../utils/presence";
import { type EdgeReadWindow, validateEdgeReadBounds } from "./neighbors";
import {
  buildReachableCte,
  buildWindowedEdgesCte,
  type ReachableSeed,
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
import type {
  Edge,
  EdgeMeta,
  GraphNodeReference,
  Node,
  NodeMeta,
} from "./types";

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
 * const result = await store.subgraph(task, { edges: ["uses_skill"], project });
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
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
> = Readonly<{
  /** Edge kinds to follow during traversal. Edges not listed are not traversed. */
  edges: readonly EK[];
  /** Maximum traversal depth from root (default: 10). */
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
  /**
   * Per-edge-kind windows applied while traversing and hydrating. Each limit
   * is partitioned by the current endpoint, so append-only edge histories can
   * contribute only their newest N targets at every hop.
   */
  edgeWindows?: Readonly<Partial<Record<EK, EdgeReadWindow>>>;
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
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
> = Omit<SubgraphOptions<G, EK, NK, P>, "recordedAsOf"> &
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
 * A node's identity inside a subgraph result. Node rows are keyed by
 * (kind, id), so two nodes of different kinds may share an id; every lookup
 * takes both. A node, a `GraphNodeReference`, or an edge's endpoint
 * (`{ kind: edge.toKind, id: edge.toId }`) all fit.
 */
export type SubgraphNodeKey<K extends string = string> = Readonly<{
  kind: K;
  id: string;
}>;

/** The structural fields of a returned edge that {@link indexSubgraph} reads. */
export type SubgraphEdgeKey = Readonly<{
  id: string;
  kind: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
}>;

export type SubgraphResult<
  G extends GraphDef,
  NK extends NodeKinds<G> = NodeKinds<G>,
  EK extends EdgeKinds<G> = EdgeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
> = Readonly<{
  /** The root node, or undefined if the root was not found or excluded. */
  root: SubgraphNodeResult<G, NK, P> | undefined;
  /** Every returned node once, ordered by kind then id (code points). */
  nodes: readonly SubgraphNodeResult<G, NK, P>[];
  /**
   * Every returned edge once, ordered by id (code points). Both endpoints are
   * in `nodes`. Use {@link indexSubgraph} for (kind, id) lookups.
   */
  edges: readonly SubgraphEdgeResult<G, EK, P>[];
}>;

/**
 * Looks up a returned node by kind and id. A literal kind narrows the result
 * to that kind and must be a kind the result can hold; a `string` kind (such
 * as an edge's `toKind`) returns any returned kind.
 */
export type SubgraphNodeLookup<N extends SubgraphNodeKey> = <
  const K extends string,
>(
  node: SubgraphNodeKey<string extends K ? K : K & N["kind"]>,
) => (string extends K ? N : Extract<N, Readonly<{ kind: K }>>) | undefined;

/**
 * Lists the returned edges leaving (`outgoing`) or entering (`incoming`) a
 * node, optionally of one edge kind, in edge-id order.
 */
export interface SubgraphEdgeLookup<E extends SubgraphEdgeKey> {
  <const K extends E["kind"]>(
    node: SubgraphNodeKey,
    edgeKind: K,
  ): readonly Extract<E, Readonly<{ kind: K }>>[];
  (node: SubgraphNodeKey, edgeKind?: E["kind"]): readonly E[];
}

/** (kind, id) lookups over a subgraph result, built by {@link indexSubgraph}. */
export type SubgraphIndex<
  N extends SubgraphNodeKey,
  E extends SubgraphEdgeKey,
> = Readonly<{
  /** The returned node with this kind and id, if any. */
  node: SubgraphNodeLookup<N>;
  /** Returned edges whose source is this node. */
  outgoing: SubgraphEdgeLookup<E>;
  /** Returned edges whose target is this node. */
  incoming: SubgraphEdgeLookup<E>;
}>;

// ============================================================
// Execution Context
// ============================================================

type SubgraphContext = Readonly<{
  graphId: string;
  root: ReachableSeed;
  edgeKinds: readonly string[];
  maxDepth: number;
  includeKinds: readonly string[] | undefined;
  excludeRoot: boolean;
  direction: "out" | "both";
  cyclePolicy: RecursiveCyclePolicy;
  temporalMode: TemporalMode;
  currentTimestamp: SqlFragment;
  asOf: string | undefined;
  recordedAsOf: RecordedInstant | undefined;
  dialect: DialectAdapter;
  schema: SqlSchema;
  recordedReadBinding: RecordedReadBinding | undefined;
  backend: GraphBackend;
  edgeWindows: Readonly<Record<string, EdgeReadWindow | undefined>> | undefined;
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

type SubgraphExecutionParams<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined,
> = Readonly<{
  graph: G;
  graphId: string;
  root: GraphNodeReference<G>;
  backend: GraphBackend;
  dialect: DialectAdapter;
  schema: SqlSchema | undefined;
  recordedReadBinding: RecordedReadBinding | undefined;
  options: InternalSubgraphOptions<G, EK, NK, P>;
}>;

type SubgraphPlan = Readonly<{
  baseSchema: SqlSchema;
  ctx: SubgraphContext;
  reachableCte: SqlFragment;
  includedIdsCte: SqlFragment;
  nodeProjectionPlan: ProjectionPlan;
  edgeProjectionPlan: ProjectionPlan;
}>;

type SubgraphSurface = "subgraph" | "batchOnce.subgraph";

function buildSubgraphPlan<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined,
>(
  params: SubgraphExecutionParams<G, EK, NK, P>,
  surface: SubgraphSurface,
): SubgraphPlan {
  const { options } = params;
  validateSubgraphTraversalOptions(options);
  const { valid: coordinate } = resolveReadCoordinate(
    options.temporalMode ?? params.graph.defaults.temporalMode,
    options.asOf,
  );
  validateEdgeWindows(options.edgeWindows, options.edges);
  const baseSchema = params.schema ?? DEFAULT_SQL_SCHEMA;
  const ctx: SubgraphContext = {
    graphId: params.graphId,
    root: resolveSubgraphRoot(params.graph, params.graphId, params.root),
    edgeKinds: [...options.edges],
    maxDepth: options.maxDepth ?? DEFAULT_SUBGRAPH_MAX_DEPTH,
    includeKinds:
      options.includeKinds === undefined ?
        undefined
      : [...options.includeKinds],
    excludeRoot: options.excludeRoot ?? false,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    temporalMode: coordinate.mode,
    currentTimestamp: currentReadInstant(),
    asOf: coordinate.asOf,
    // Recorded coordinates reach here only through the StoreView seam. The
    // public API rejects them before either execution strategy is selected.
    recordedAsOf: options.recordedAsOf,
    dialect: params.dialect,
    schema: recordedReadSchemaFor(
      baseSchema,
      options.recordedAsOf,
      params.recordedReadBinding,
      surface === "subgraph" ? "recorded-subgraph" : "recorded-subgraph-query",
    ),
    recordedReadBinding: params.recordedReadBinding,
    backend: params.backend,
    edgeWindows:
      options.edgeWindows === undefined ?
        undefined
      : structuredClone(options.edgeWindows),
  };
  const introspector = getSubgraphSchemaIntrospector(params.graph);
  const nodeProjectionPlan = buildProjectionPlan(
    getIncludedNodeKinds(params.graph, options.includeKinds),
    options.project?.nodes,
    (kind, field) => introspector.getFieldTypeInfo(kind, field),
    "node",
  );
  const edgeProjectionPlan = buildProjectionPlan(
    dedupeStrings(options.edges),
    options.project?.edges,
    (kind, field) => introspector.getEdgeFieldTypeInfo(kind, field),
    "edge",
  );
  const reachableCte = buildSubgraphReachableCte(ctx, baseSchema, surface);

  return {
    baseSchema,
    ctx,
    reachableCte,
    includedIdsCte: buildIncludedIdsCte(ctx),
    nodeProjectionPlan,
    edgeProjectionPlan,
  };
}

/**
 * Validates the caller's root reference. The walk starts from exactly the node
 * it names, so an unregistered kind is refused rather than read as empty.
 */
function resolveSubgraphRoot(
  graph: GraphDef,
  graphId: string,
  root: unknown,
): ReachableSeed {
  if (
    typeof root === "object" &&
    root !== null &&
    "kind" in root &&
    "id" in root &&
    typeof root.kind === "string" &&
    typeof root.id === "string"
  ) {
    if (!Object.hasOwn(graph.nodes, root.kind)) {
      throw new KindNotFoundError(root.kind, "node", { graphId });
    }
    return { kind: root.kind, id: root.id };
  }
  throw new ValidationError(
    "Subgraph root must be a { kind, id } node reference",
    {
      issues: [
        {
          path: "root",
          message: "Received an unsupported root",
          code: "invalid_type",
        },
      ],
    },
  );
}

function buildSubgraphReachableCte(
  ctx: SubgraphContext,
  baseSchema: SqlSchema,
  surface: SubgraphSurface,
  sources?: readonly ReachableSeed[],
): SqlFragment {
  return buildReachableCte({
    graphId: ctx.graphId,
    ...(sources === undefined ? { source: ctx.root } : { sources }),
    edgeKinds: ctx.edgeKinds,
    maxHops: ctx.maxDepth,
    direction: ctx.direction,
    cyclePolicy: ctx.cyclePolicy,
    includePath: false,
    temporalMode: ctx.temporalMode,
    currentTimestamp: ctx.currentTimestamp,
    ...(ctx.asOf !== undefined && { asOf: ctx.asOf }),
    ...(ctx.recordedAsOf !== undefined && { recordedAsOf: ctx.recordedAsOf }),
    dialect: ctx.dialect,
    // The recursive compiler derives the recorded relation from the pin.
    schema: baseSchema,
    ...(ctx.recordedReadBinding === undefined ?
      {}
    : { recordedReadBinding: ctx.recordedReadBinding }),
    recursiveTraversal: resolveRecursiveTraversal(ctx.backend.capabilities),
    operation: surface,
    ...(ctx.edgeWindows === undefined ? {} : { edgeWindows: ctx.edgeWindows }),
  });
}

// ============================================================
// Public API
// ============================================================

export async function executeSubgraph<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
>(
  params: SubgraphExecutionParams<G, EK, NK, P>,
): Promise<SubgraphResult<G, NK, EK, P>> {
  const {
    ctx,
    reachableCte,
    includedIdsCte,
    nodeProjectionPlan,
    edgeProjectionPlan,
  } = buildSubgraphPlan(params, "subgraph");

  // The node and edge fetches both need the traversal closure. Embedding
  // the recursive CTE in each statement runs the BFS twice; on Postgres
  // the closure is fetched ONCE and passed to both fetches as a pair of
  // text[] parameters (kinds and ids), filtered via a hashed semi-join
  // (EXISTS over unnest — measured faster than `= ANY` on the same
  // closure). SQLite keeps the embedded form: its in-process traversal
  // is cheap, an id list would bind one parameter per id (bind-budget
  // pressure), and per-count SQL texts would churn the prepared-statement
  // cache.
  let membership: SubgraphMembership;
  const membershipStrategy =
    ctx.dialect.capabilities.subgraphMembershipStrategy;
  switch (membershipStrategy) {
    case "materialized-ids": {
      const members = await fetchIncludedNodes(
        ctx,
        reachableCte,
        includedIdsCte,
      );
      const kindsArray = textArrayParam(members.map((member) => member.kind));
      const idsArray = textArrayParam(members.map((member) => member.id));
      membership = {
        prefix: sql``,
        memberFilter: (kindColumn, idColumn) =>
          sql`EXISTS (SELECT 1 FROM unnest(${kindsArray}, ${idsArray}) AS tg_included(kind, id) WHERE tg_included.kind = ${kindColumn} AND tg_included.id = ${idColumn})`,
        parameterDependentPlan: true,
      };
      break;
    }
    case "inline-cte": {
      membership = {
        prefix: sql`${reachableCte}${includedIdsCte} `,
        // `row IN (subquery)` evaluates via a transient index — optimal
        // as-is. (The materialized-ids strategy takes the parameterized
        // array form above instead.)
        memberFilter: (kindColumn, idColumn) =>
          sql`(${kindColumn}, ${idColumn}) IN (SELECT kind, id FROM included_ids)`,
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

  const [nodeRows, edgeRows] = await Promise.all([
    fetchSubgraphNodes(ctx, membership, nodeProjectionPlan),
    fetchSubgraphEdges(ctx, membership, edgeProjectionPlan),
  ]);

  return assembleSubgraphResult<G, NK, EK, P>(
    ctx.root,
    nodeRows.map((row) => mapSubgraphNodeRow(row, nodeProjectionPlan)),
    edgeRows.map((row) => mapSubgraphEdgeRow(row, edgeProjectionPlan)),
  );
}

/** A subgraph read that can execute alone or in `store.batchOnce()`. */
export type SubgraphRead<
  G extends GraphDef,
  NK extends NodeKinds<G>,
  EK extends EdgeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
> = ExecutableOneStatementRead<SubgraphResult<G, NK, EK, P>>;

/** Builds the one-statement form used by composable set-oriented reads. */
export function createSubgraphRead<
  G extends GraphDef,
  EK extends EdgeKinds<G>,
  NK extends NodeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
>(params: SubgraphExecutionParams<G, EK, NK, P>): SubgraphRead<G, NK, EK, P> {
  const plan = buildSubgraphPlan(params, "batchOnce.subgraph");
  const {
    ctx,
    reachableCte,
    includedIdsCte,
    nodeProjectionPlan: nodePlan,
    edgeProjectionPlan: edgePlan,
  } = plan;
  const query = buildOneStatementSubgraphQuery(
    ctx,
    reachableCte,
    includedIdsCte,
    nodePlan,
    edgePlan,
  );
  function mapRows(
    rows: readonly Record<string, unknown>[],
  ): SubgraphResult<G, NK, EK, P> {
    return mapOneStatementSubgraphRows(
      ctx.root,
      rows as readonly OneStatementSubgraphRow[],
      nodePlan,
      edgePlan,
    );
  }
  return {
    execute: async () =>
      mapRows(
        await params.backend.execute<OneStatementSubgraphRow>(
          asCompiledRowsSql(query),
        ),
      ),
    compileOneStatementBatchItem: () => {
      const item: OneStatementBatchItem<SubgraphResult<G, NK, EK, P>> = {
        query: asCompiledRowsSql(query),
        provenance: {
          graphId: params.graphId,
          executionTarget: backendDerivationRoot(params.backend),
        },
        outputNames: oneStatementSubgraphOutputNames(nodePlan, edgePlan),
        orderBy: [],
        mapRows,
      };
      sharedSubgraphPlans.set(item, plan);
      registerOneStatementSharing(item, {
        owner: params.graph,
        key: subgraphSharingKey(plan),
        combine: combineSubgraphBatchItems,
      });
      return item;
    },
  };
}

const sharedSubgraphPlans = new WeakMap<OneStatementBatchItem, SubgraphPlan>();
const SHARED_MEMBERSHIPS_COLUMN = "typegraph_shared_memberships";

function projectionSharingKey(plan: ProjectionPlan): unknown {
  return {
    fullKinds: plan.fullKinds,
    projectedKinds: [...plan.projectedKinds],
  };
}

function subgraphSharingKey(plan: SubgraphPlan): string {
  const { ctx } = plan;
  return JSON.stringify({
    graphId: ctx.graphId,
    schema: ctx.schema,
    edgeKinds: ctx.edgeKinds,
    includeKinds: ctx.includeKinds,
    excludeRoot: ctx.excludeRoot,
    maxDepth: ctx.maxDepth,
    direction: ctx.direction,
    cyclePolicy: ctx.cyclePolicy,
    temporalMode: ctx.temporalMode,
    asOf: ctx.asOf,
    recordedAsOf: ctx.recordedAsOf,
    currentTimestamp: ctx.currentTimestamp.chunks,
    edgeWindows: ctx.edgeWindows,
    nodes: projectionSharingKey(plan.nodeProjectionPlan),
    edges: projectionSharingKey(plan.edgeProjectionPlan),
  });
}

function sharedEntityKey(row: Readonly<Record<string, unknown>>): string {
  return JSON.stringify([row["typegraph_entity"], row["kind"], row["id"]]);
}

function combineSubgraphBatchItems(
  items: readonly OneStatementBatchItem[],
): OneStatementBatchItem<readonly unknown[]> {
  const first = requireDefined(items[0]);
  const plans = items.map((item) =>
    requireDefined(sharedSubgraphPlans.get(item)),
  );
  const {
    ctx,
    baseSchema,
    nodeProjectionPlan: nodePlan,
    edgeProjectionPlan: edgePlan,
  } = requireDefined(plans[0]);
  const roots = plans.map((plan) => plan.ctx.root);
  const reachable = buildSubgraphReachableCte(
    ctx,
    baseSchema,
    "batchOnce.subgraph",
    dedupeSeeds(roots),
  );
  const filters: SqlFragment[] = [];
  if (ctx.includeKinds !== undefined && ctx.includeKinds.length > 0)
    filters.push(compileKindFilter(sql.raw("kind"), ctx.includeKinds));
  if (ctx.excludeRoot)
    filters.push(sql`NOT (kind = origin_kind AND id = origin_id)`);
  const included = sql`, included_ids AS (SELECT DISTINCT origin_kind, origin_id, kind, id FROM reachable ${filters.length === 0 ? sql.empty() : sql`WHERE ${sql.join(filters, sql` AND `)}`})`;
  const requests = roots.map(
    (root, index) => sql`(${index}, ${root.kind}, ${root.id})`,
  );
  function requestMatches(kindColumn: string, idColumn: string): SqlFragment {
    return sql`requests.root_kind = ${sql.raw(kindColumn)} AND requests.root_id = ${sql.raw(idColumn)}`;
  }
  const hydration = buildOneStatementSubgraphQuery(
    ctx,
    sql.empty(),
    sql.empty(),
    nodePlan,
    edgePlan,
    true,
  );
  const columns = first.outputNames;
  const membershipPayload = ctx.dialect.orderedRowsJsonArray(
    "typegraph_shared_ordered_membership",
    ["request_id", "typegraph_entity", "kind", "id"],
    "typegraph_shared_ordinal",
  );
  const hydratedColumns = columns.map(
    (column) => sql`h.${sql.identifier(column)}`,
  );
  const membershipColumns = columns.map((column) =>
    column === "typegraph_entity" ? sql`'membership'` : sql`NULL`,
  );
  const query = asCompiledRowsSql(sql`
    ${reachable}${included},
        typegraph_shared_requests(request_id, root_kind, root_id) AS (VALUES ${sql.join(requests, sql`, `)}),
        typegraph_shared_hydrated AS (${hydration}),
        typegraph_shared_membership AS (
          SELECT requests.request_id, h.typegraph_entity, h.kind, h.id
          FROM typegraph_shared_hydrated h
          JOIN included_ids included ON h.kind = included.kind AND h.id = included.id
          JOIN typegraph_shared_requests requests ON ${requestMatches("included.origin_kind", "included.origin_id")}
          WHERE h.typegraph_entity = 'node'
          UNION ALL
          SELECT requests.request_id, h.typegraph_entity, h.kind, h.id
          FROM typegraph_shared_hydrated h
          JOIN included_ids source_membership ON h.from_kind = source_membership.kind AND h.from_id = source_membership.id
          JOIN included_ids target_membership ON h.to_kind = target_membership.kind AND h.to_id = target_membership.id AND source_membership.origin_kind = target_membership.origin_kind AND source_membership.origin_id = target_membership.origin_id
          JOIN typegraph_shared_requests requests ON ${requestMatches("source_membership.origin_kind", "source_membership.origin_id")}
          WHERE h.typegraph_entity = 'edge'
        ),
        typegraph_shared_ordered_membership AS (
          SELECT membership.*, request_id AS typegraph_shared_ordinal
          FROM typegraph_shared_membership membership
        )
        SELECT ${sql.join(hydratedColumns, sql`, `)}, NULL AS ${sql.identifier(SHARED_MEMBERSHIPS_COLUMN)}
        FROM typegraph_shared_hydrated h
        UNION ALL
        SELECT ${sql.join(membershipColumns, sql`, `)}, ${membershipPayload}
  `);
  return {
    query,
    provenance: first.provenance,
    outputNames: [...columns, SHARED_MEMBERSHIPS_COLUMN],
    orderBy: [],
    mapRows: (rows) => mapSharedSubgraphRows(items, rows),
  };
}

function mapSharedSubgraphRows(
  items: readonly OneStatementBatchItem[],
  rows: readonly Record<string, unknown>[],
): readonly unknown[] {
  const entities = new Map<string, Record<string, unknown>>();
  const requestRows: Record<string, unknown>[][] = items.map(() => []);
  const membershipRows = rows.filter(
    (row) => row["typegraph_entity"] === "membership",
  );
  for (const row of rows)
    if (row["typegraph_entity"] !== "membership")
      entities.set(sharedEntityKey(row), row);
  if (membershipRows.length !== 1)
    throw new ConfigurationError(
      "Shared subgraph query returned an invalid membership envelope.",
    );
  const encoded = requireDefined(membershipRows[0])[SHARED_MEMBERSHIPS_COLUMN];
  const memberships: unknown =
    typeof encoded === "string" ? JSON.parse(encoded) : encoded;
  if (!Array.isArray(memberships))
    throw new ConfigurationError(
      "Shared subgraph query returned invalid membership rows.",
    );
  for (const membership of memberships) {
    if (typeof membership !== "object" || membership === null)
      throw new ConfigurationError(
        "Shared subgraph membership must be an object.",
      );
    const row = membership as Record<string, unknown>;
    const index = Number(row["request_id"]);
    if (!Number.isInteger(index) || index < 0 || index >= items.length)
      throw new ConfigurationError(
        "Shared subgraph membership has an invalid request index.",
      );
    const entity = requireDefined(
      entities.get(sharedEntityKey(row)),
      "Shared subgraph membership refers to a missing entity.",
    );
    requireDefined(requestRows[index]).push(entity);
  }
  // The envelope reuses hydrated rows; each public result must own nested props.
  return items.map((item, index) =>
    item.mapRows(structuredClone(requireDefined(requestRows[index]))),
  );
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

function dedupeSeeds(
  seeds: readonly ReachableSeed[],
): readonly ReachableSeed[] {
  return [
    ...new Map(
      seeds.map((seed) => [JSON.stringify([seed.kind, seed.id]), seed]),
    ).values(),
  ];
}

// ============================================================
// SQL Generation
// ============================================================

/** Declares `included_ids`: the (kind, id) pairs the read returns. */
function buildIncludedIdsCte(ctx: SubgraphContext): SqlFragment {
  const filters: SqlFragment[] = [];

  if (ctx.includeKinds !== undefined && ctx.includeKinds.length > 0) {
    filters.push(compileKindFilter(sql.raw("kind"), ctx.includeKinds));
  }

  if (ctx.excludeRoot) {
    filters.push(sql`NOT (kind = ${ctx.root.kind} AND id = ${ctx.root.id})`);
  }

  const whereClause =
    filters.length > 0 ? sql` WHERE ${sql.join(filters, sql` AND `)}` : sql``;

  return sql`, included_ids AS (SELECT DISTINCT kind, id FROM reachable${whereClause})`;
}

function buildSubgraphEdgeSource(
  ctx: SubgraphContext,
  edgeTemporalFilter: SqlFragment,
): SqlFragment {
  const windows = Object.entries(ctx.edgeWindows ?? {}).filter(
    (entry): entry is [string, EdgeReadWindow] => entry[1] !== undefined,
  );
  if (windows.length === 0) return ctx.schema.edgesTable;

  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), ctx.edgeKinds);
  const windowedEdges = buildWindowedEdgesCte(
    ctx.schema.edgesTable,
    ctx.direction,
    ctx.edgeKinds.map((kind) => [kind, ctx.edgeWindows?.[kind]]),
    sql.join(
      [sql`e.graph_id = ${ctx.graphId}`, edgeKindFilter, edgeTemporalFilter],
      sql` AND `,
    ),
  );
  const physicalColumns = [
    "graph_id",
    "id",
    "kind",
    "from_kind",
    "from_id",
    "to_kind",
    "to_id",
    "props",
    "valid_from",
    "valid_to",
    "created_at",
    "updated_at",
    "deleted_at",
  ].map((column) => sql.raw(`windowed_edge.${column}`));

  // Bidirectional windows can surface one physical edge through both
  // orientations. Deduplicate the typed source rows before projection so
  // UNION placeholder NULLs retain the opposite arm's database type.
  return sql`(SELECT DISTINCT ${sql.join(physicalColumns, sql`, `)} FROM (${windowedEdges}) windowed_edge)`;
}

/**
 * How the node/edge fetches restrict rows to the traversal closure:
 * either a statement prefix re-declaring the recursive CTE with an
 * `included_ids` membership subquery (SQLite), or an empty prefix with a
 * pre-fetched (kind, id) array filter (Postgres).
 */
type SubgraphMembership = Readonly<{
  prefix: SqlFragment;
  memberFilter: (kindColumn: SqlFragment, idColumn: SqlFragment) => SqlFragment;
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

/** Runs the traversal once and returns the (kind, id) pairs the read returns. */
async function fetchIncludedNodes(
  ctx: SubgraphContext,
  reachableCte: SqlFragment,
  includedIdsCte: SqlFragment,
): Promise<readonly SubgraphNodeKey[]> {
  return ctx.backend.execute<SubgraphNodeKey>(
    asCompiledRowsSql(
      sql`${reachableCte}${includedIdsCte} SELECT kind, id FROM included_ids`,
    ),
  );
}

type OneStatementSubgraphRow = SubgraphNodeFetchRow &
  SubgraphEdgeFetchRow &
  Readonly<{ typegraph_entity: "edge" | "node" }>;

function projectionOutputNames(plan: ProjectionPlan): readonly string[] {
  return [...plan.projectedKinds.values()].flatMap((kindPlan) =>
    kindPlan.propertyFields.map((field) => field.outputName),
  );
}

function oneStatementSubgraphOutputNames(
  nodePlan: ProjectionPlan,
  edgePlan: ProjectionPlan,
): readonly string[] {
  return [
    "typegraph_entity",
    "id",
    "kind",
    "from_kind",
    "from_id",
    "to_kind",
    "to_id",
    "props",
    "version",
    "valid_from",
    "valid_to",
    "created_at",
    "updated_at",
    "deleted_at",
    ...projectionOutputNames(nodePlan),
    ...projectionOutputNames(edgePlan),
  ];
}

function nullProjectionColumns(plan: ProjectionPlan): readonly SqlFragment[] {
  return projectionOutputNames(plan).map(
    (outputName) => sql`NULL AS ${quoteIdentifier(outputName)}`,
  );
}

function buildOneStatementSubgraphQuery(
  ctx: SubgraphContext,
  reachable: SqlFragment,
  includedIds: SqlFragment,
  nodePlan: ProjectionPlan,
  edgePlan: ProjectionPlan,
  sharedOrigins = false,
): SqlFragment {
  const instant = ctx.currentTimestamp;
  const nodeTemporal = compileTemporalFilter({
    mode: ctx.temporalMode,
    asOf: ctx.asOf,
    recordedAsOf: ctx.recordedAsOf,
    tableAlias: "n",
    currentTimestamp: instant,
    recordedReadBinding: ctx.recordedReadBinding,
  });
  const edgeTemporal = compileTemporalFilter({
    mode: ctx.temporalMode,
    asOf: ctx.asOf,
    recordedAsOf: ctx.recordedAsOf,
    tableAlias: "e",
    currentTimestamp: instant,
    recordedReadBinding: ctx.recordedReadBinding,
  });
  const nodeColumns: SqlFragment[] = [
    sql`'node' AS typegraph_entity`,
    sql`n.id`,
    sql`n.kind`,
    sql`NULL AS from_kind`,
    sql`NULL AS from_id`,
    sql`NULL AS to_kind`,
    sql`NULL AS to_id`,
    buildFullPropsColumn("n", nodePlan),
    ...buildMetadataColumns("n", nodePlan, [
      "version",
      "valid_from",
      "valid_to",
      "created_at",
      "updated_at",
      "deleted_at",
    ]),
    ...buildProjectedPropertyColumns("n", nodePlan, ctx.dialect),
    ...nullProjectionColumns(edgePlan),
  ];
  const edgeColumns: SqlFragment[] = [
    sql`'edge' AS typegraph_entity`,
    sql`e.id`,
    sql`e.kind`,
    sql`e.from_kind`,
    sql`e.from_id`,
    sql`e.to_kind`,
    sql`e.to_id`,
    buildFullPropsColumn("e", edgePlan),
    sql`NULL AS version`,
    ...buildMetadataColumns("e", edgePlan, [
      "valid_from",
      "valid_to",
      "created_at",
      "updated_at",
      "deleted_at",
    ]),
    ...nullProjectionColumns(nodePlan),
    ...buildProjectedPropertyColumns("e", edgePlan, ctx.dialect),
  ];
  const edgeSource = buildSubgraphEdgeSource(ctx, edgeTemporal);
  const edgeMembership =
    sharedOrigins ?
      sql`EXISTS (SELECT 1 FROM included_ids source_membership JOIN included_ids target_membership ON source_membership.origin_kind = target_membership.origin_kind AND source_membership.origin_id = target_membership.origin_id WHERE source_membership.kind = e.from_kind AND source_membership.id = e.from_id AND target_membership.kind = e.to_kind AND target_membership.id = e.to_id)`
    : sql`(e.from_kind, e.from_id) IN (SELECT kind, id FROM included_ids) AND (e.to_kind, e.to_id) IN (SELECT kind, id FROM included_ids)`;
  return sql`${reachable}${includedIds} SELECT ${sql.join(nodeColumns, sql`, `)} FROM ${ctx.schema.nodesTable} n WHERE n.graph_id = ${ctx.graphId} AND ${nodeTemporal} AND (n.kind, n.id) IN (SELECT kind, id FROM included_ids) UNION ALL SELECT ${sql.join(edgeColumns, sql`, `)} FROM ${edgeSource} e WHERE e.graph_id = ${ctx.graphId} AND ${compileKindFilter(sql.raw("e.kind"), ctx.edgeKinds)} AND ${edgeTemporal} AND ${edgeMembership}`;
}

function mapOneStatementSubgraphRows<
  G extends GraphDef,
  NK extends NodeKinds<G>,
  EK extends EdgeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined,
>(
  root: SubgraphNodeKey,
  rows: readonly OneStatementSubgraphRow[],
  nodePlan: ProjectionPlan,
  edgePlan: ProjectionPlan,
): SubgraphResult<G, NK, EK, P> {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const row of rows) {
    if (row.typegraph_entity === "node") {
      nodes.push(mapSubgraphNodeRow(row, nodePlan));
      continue;
    }
    edges.push(mapSubgraphEdgeRow(row, edgePlan));
  }
  return assembleSubgraphResult<G, NK, EK, P>(root, nodes, edges);
}

/** Values keyed by node kind, then node id: (kind, id) without an encoded key. */
type NodeKeyedIndex<T> = Map<string, Map<string, T>>;

function nodeKeyedSlot<T>(
  index: NodeKeyedIndex<T>,
  kind: string,
): Map<string, T> {
  const existing = index.get(kind);
  if (existing !== undefined) return existing;
  const created = new Map<string, T>();
  index.set(kind, created);
  return created;
}

/** One endpoint's edges: all of them, and by edge kind, each in id order. */
type EndpointEdges<E> = Readonly<{
  all: readonly E[];
  byKind: ReadonlyMap<string, readonly E[]>;
}>;

function indexEdgesByEndpoint<E extends SubgraphEdgeKey>(
  edges: readonly E[],
  endpoint: "source" | "target",
): NodeKeyedIndex<EndpointEdges<E>> {
  const grouped: NodeKeyedIndex<E[]> = new Map();
  for (const edge of edges) {
    const kind = endpoint === "source" ? edge.fromKind : edge.toKind;
    const id = endpoint === "source" ? edge.fromId : edge.toId;
    const slot = nodeKeyedSlot(grouped, kind);
    const list = slot.get(id);
    if (list === undefined) slot.set(id, [edge]);
    else list.push(edge);
  }
  const index: NodeKeyedIndex<EndpointEdges<E>> = new Map();
  for (const [kind, byId] of grouped) {
    const slot = nodeKeyedSlot(index, kind);
    for (const [id, list] of byId) {
      const byKind = new Map<string, E[]>();
      for (const edge of list) {
        const kindList = byKind.get(edge.kind);
        if (kindList === undefined) byKind.set(edge.kind, [edge]);
        else kindList.push(edge);
      }
      slot.set(id, {
        all: Object.freeze(list),
        byKind: new Map(
          [...byKind].map(([edgeKind, kindList]) => [
            edgeKind,
            Object.freeze(kindList),
          ]),
        ),
      });
    }
  }
  return index;
}

const NO_EDGES: readonly never[] = Object.freeze([]);

function createEdgeLookup<E extends SubgraphEdgeKey>(
  index: NodeKeyedIndex<EndpointEdges<E>>,
): (node: SubgraphNodeKey, edgeKind?: string) => readonly E[] {
  return (node, edgeKind) => {
    const endpoint = index.get(node.kind)?.get(node.id);
    if (endpoint === undefined) return NO_EDGES;
    if (edgeKind === undefined) return endpoint.all;
    return endpoint.byKind.get(edgeKind) ?? NO_EDGES;
  };
}

/**
 * Builds (kind, id) lookups over a subgraph result. The result itself stays
 * plain data (it survives `structuredClone`, `postMessage`, and serialization);
 * index it once where lookups are needed.
 *
 * @example
 * ```ts
 * const sg = await store.subgraph(run, { edges: ["has_task"] });
 * const { node, outgoing } = indexSubgraph(sg);
 * const tasks = outgoing(run, "has_task").map((edge) =>
 *   node({ kind: edge.toKind, id: edge.toId }),
 * );
 * ```
 */
export function indexSubgraph<
  N extends SubgraphNodeKey,
  E extends SubgraphEdgeKey,
>(
  subgraph: Readonly<{ nodes: readonly N[]; edges: readonly E[] }>,
): SubgraphIndex<N, E> {
  const nodeIndex: NodeKeyedIndex<N> = new Map();
  for (const node of subgraph.nodes) {
    nodeKeyedSlot(nodeIndex, node.kind).set(node.id, node);
  }
  function lookupNode(key: SubgraphNodeKey): N | undefined {
    return nodeIndex.get(key.kind)?.get(key.id);
  }
  return {
    node: lookupNode as SubgraphNodeLookup<N>,
    outgoing: createEdgeLookup(
      indexEdgesByEndpoint(subgraph.edges, "source"),
    ) as SubgraphEdgeLookup<E>,
    incoming: createEdgeLookup(
      indexEdgesByEndpoint(subgraph.edges, "target"),
    ) as SubgraphEdgeLookup<E>,
  };
}

function compareNodeKeys(left: SubgraphNodeKey, right: SubgraphNodeKey) {
  return (
    compareCodePoints(left.kind, right.kind) ||
    compareCodePoints(left.id, right.id)
  );
}

function assembleSubgraphResult<
  G extends GraphDef,
  NK extends NodeKinds<G>,
  EK extends EdgeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined,
>(
  root: SubgraphNodeKey,
  nodeValues: readonly Node[],
  edgeValues: readonly Edge[],
): SubgraphResult<G, NK, EK, P> {
  const nodes = nodeValues.toSorted((left, right) =>
    compareNodeKeys(left, right),
  );
  const edges = edgeValues.toSorted((left, right) =>
    compareCodePoints(left.id, right.id),
  );
  const rootNode = nodes.find(
    (node) => node.kind === root.kind && node.id === root.id,
  );
  return {
    root: rootNode,
    nodes,
    edges,
  } as unknown as SubgraphResult<G, NK, EK, P>;
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
    currentTimestamp: ctx.currentTimestamp,
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

  const query = sql`${membership.prefix}SELECT ${sql.join(columns, sql`, `)} FROM ${ctx.schema.nodesTable} n WHERE n.graph_id = ${ctx.graphId} AND ${nodeTemporalFilter} AND ${membership.memberFilter(sql.raw("n.kind"), sql.raw("n.id"))}`;
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
    currentTimestamp: ctx.currentTimestamp,
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

  const edgesSource = buildSubgraphEdgeSource(ctx, edgeTemporalFilter);
  const query = sql`${membership.prefix}SELECT ${sql.join(columns, sql`, `)} FROM ${edgesSource} e WHERE e.graph_id = ${ctx.graphId} AND ${edgeKindFilter} AND ${edgeTemporalFilter} AND ${membership.memberFilter(sql.raw("e.from_kind"), sql.raw("e.from_id"))} AND ${membership.memberFilter(sql.raw("e.to_kind"), sql.raw("e.to_id"))}`;
  if (membership.parameterDependentPlan) markForceCustomPlan(query);

  return ctx.backend.execute<SubgraphEdgeFetchRow>(
    asCompiledRowsSql(query),
  ) as Promise<SubgraphEdgeFetchRow[]>;
}

function validateEdgeWindows(
  windows: Readonly<Record<string, EdgeReadWindow | undefined>> | undefined,
  selectedEdgeKinds: readonly string[],
): void {
  for (const [kind, window] of Object.entries(windows ?? {})) {
    if (!selectedEdgeKinds.includes(kind)) {
      throw new ValidationError(
        "Subgraph edge windows must name a traversed edge kind",
        {
          issues: [
            {
              path: `edgeWindows.${kind}`,
              message: "Edge kind is not present in options.edges",
            },
          ],
        },
      );
    }
    if (window !== undefined) {
      validateEdgeReadBounds(window, `edgeWindows.${kind}`);
    }
  }
}

function validateSubgraphTraversalOptions(
  options: Readonly<{
    maxDepth?: number;
    direction?: unknown;
    cyclePolicy?: unknown;
  }>,
): void {
  const maxDepth = options.maxDepth;
  if (
    maxDepth !== undefined &&
    (!Number.isFinite(maxDepth) ||
      !Number.isInteger(maxDepth) ||
      maxDepth < 0 ||
      maxDepth > MAX_EXPLICIT_RECURSIVE_DEPTH)
  ) {
    throw new ValidationError(
      `Subgraph maxDepth must be an integer from 0 through ${MAX_EXPLICIT_RECURSIVE_DEPTH}`,
      {
        issues: [
          {
            path: "maxDepth",
            message: `Received ${String(maxDepth)}`,
            code: "invalid_value",
          },
        ],
      },
    );
  }
  if (
    options.direction !== undefined &&
    options.direction !== "out" &&
    options.direction !== "both"
  ) {
    throw new ValidationError('Subgraph direction must be "out" or "both"', {
      issues: [
        {
          path: "direction",
          message: "Received an unsupported direction",
          code: "invalid_value",
        },
      ],
    });
  }
  if (
    options.cyclePolicy !== undefined &&
    options.cyclePolicy !== "prevent" &&
    options.cyclePolicy !== "allow"
  ) {
    throw new ValidationError(
      'Subgraph cyclePolicy must be "prevent" or "allow"',
      {
        issues: [
          {
            path: "cyclePolicy",
            message: "Received an unsupported cycle policy",
            code: "invalid_value",
          },
        ],
      },
    );
  }
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

function normalizeSubgraphRowTimestamps<
  T extends Readonly<{
    valid_from: unknown;
    valid_to: unknown;
    created_at: unknown;
    updated_at: unknown;
    deleted_at: unknown;
  }>,
>(row: T) {
  return {
    ...row,
    valid_from: normalizeRowTimestamp(row.valid_from, "valid_from"),
    valid_to: normalizeRowTimestamp(row.valid_to, "valid_to"),
    created_at: normalizeRequiredRowTimestamp(row.created_at, "created_at"),
    updated_at: normalizeRequiredRowTimestamp(row.updated_at, "updated_at"),
    deleted_at: normalizeRowTimestamp(row.deleted_at, "deleted_at"),
  };
}

function mapSubgraphNodeRow(
  row: SubgraphNodeFetchRow,
  projectionPlan: ProjectionPlan,
): Node {
  const kindPlan = projectionPlan.projectedKinds.get(row.kind);
  if (kindPlan === undefined) {
    const normalizedRow = normalizeSubgraphRowTimestamps(row);
    return rowToNode({
      ...normalizedRow,
      props: normalizeProps(normalizedRow.props),
    });
  }

  const projectedNode: Record<string, unknown> = {
    kind: row.kind,
    id: row.id,
  };

  if (kindPlan.includeMeta) {
    projectedNode["meta"] = rowToNodeMeta(normalizeSubgraphRowTimestamps(row));
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
    const normalizedRow = normalizeSubgraphRowTimestamps(row);
    return rowToEdge({
      ...normalizedRow,
      props: normalizeProps(normalizedRow.props),
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
    projectedEdge["meta"] = rowToEdgeMeta(normalizeSubgraphRowTimestamps(row));
  }

  applyProjectedFields(projectedEdge, row, kindPlan);
  return projectedEdge as Edge;
}
