/**
 * Subgraph Extraction
 *
 * Extracts a typed subgraph from a root node by traversing a set of edge kinds.
 * Uses a recursive CTE for BFS traversal with cycle detection, then hydrates
 * the reachable nodes and connecting edges in two parallel queries.
 */
import { type SQL, sql } from "drizzle-orm";

import type { GraphBackend } from "../backend/types";
import type {
  AllNodeTypes,
  EdgeKinds,
  GraphDef,
  NodeKinds,
} from "../core/define-graph";
import type { AnyEdgeType, NodeId, NodeType } from "../core/types";
import type { RecursiveCyclePolicy } from "../query/ast";
import { compileKindFilter } from "../query/compiler/predicate-utils";
import { MAX_RECURSIVE_DEPTH } from "../query/compiler/recursive";
import { DEFAULT_SQL_SCHEMA, type SqlSchema } from "../query/compiler/schema";
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
 * PostgreSQL truncates identifiers longer than 63 bytes.
 * Column aliases must stay under this limit to avoid silent mismatches.
 */
const MAX_PG_IDENTIFIER_LENGTH = 63;

/**
 * FNV-1a hash, base-36 encoded. Deterministic and fast.
 * Used to generate short, collision-resistant column aliases.
 */
function fnv1aBase36(input: string): string {
  let hash = 0x81_1c_9d_c5;
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    hash ^= codePoint;
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return (hash >>> 0).toString(36);
}

const TEXT_ENCODER = new TextEncoder();

/**
 * Truncates a string so its UTF-8 byte length does not exceed maxBytes.
 * Avoids splitting in the middle of a multi-byte character.
 */
function truncateToBytes(value: string, maxBytes: number): string {
  const encoded = TEXT_ENCODER.encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  // Walk backwards from the limit to find a clean character boundary.
  // UTF-8 continuation bytes have the form 10xxxxxx (0x80..0xBF).
  let end = maxBytes;
  while (end > 0 && encoded[end]! >= 0x80 && encoded[end]! < 0xc0) {
    end--;
  }

  return new TextDecoder().decode(encoded.slice(0, end));
}

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
  entityPrefix: "node" | "edge",
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
  | NodeProjectionPropertyKey<N>
  | "meta";

type SubgraphEdgeProjectionField<E extends AnyEdgeType = AnyEdgeType> =
  | EdgeProjectionPropertyKey<E>
  | "meta";

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

export type SubgraphResult<
  G extends GraphDef,
  NK extends NodeKinds<G> = NodeKinds<G>,
  EK extends EdgeKinds<G> = EdgeKinds<G>,
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
> = Readonly<{
  nodes: readonly {
    [Kind in NK]: SubgraphNodeResultForKind<G, Kind, P>;
  }[NK][];
  edges: readonly {
    [Kind in EK]: SubgraphEdgeResultForKind<G, Kind, P>;
  }[EK][];
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
  dialect: DialectAdapter;
  schema: SqlSchema;
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
  P extends SubgraphProject<G, NK, EK> | undefined = undefined,
>(params: {
  graph: G;
  graphId: string;
  rootId: NodeId<AllNodeTypes<G>>;
  backend: GraphBackend;
  dialect: DialectAdapter;
  schema: SqlSchema | undefined;
  options: SubgraphOptions<G, EK, NK, P>;
}): Promise<SubgraphResult<G, NK, EK, P>> {
  const { options } = params;

  if (options.edges.length === 0) {
    return { nodes: [], edges: [] } as SubgraphResult<G, NK, EK, P>;
  }

  const maxDepth = Math.min(
    options.maxDepth ?? DEFAULT_SUBGRAPH_MAX_DEPTH,
    MAX_RECURSIVE_DEPTH,
  );

  const ctx: SubgraphContext = {
    graphId: params.graphId,
    rootId: params.rootId as string,
    edgeKinds: options.edges,
    maxDepth,
    includeKinds: options.includeKinds,
    excludeRoot: options.excludeRoot ?? false,
    direction: options.direction ?? "out",
    cyclePolicy: options.cyclePolicy ?? "prevent",
    dialect: params.dialect,
    schema: params.schema ?? DEFAULT_SQL_SCHEMA,
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
    dedupeStrings(options.edges),
    options.project?.edges,
    (kind, field) => schemaIntrospector.getEdgeFieldTypeInfo(kind, field),
    "edge",
  );

  const reachableCte = buildReachableCte(ctx);
  const includedIdsCte = buildIncludedIdsCte(ctx);

  const [nodeRows, edgeRows] = await Promise.all([
    fetchSubgraphNodes(ctx, reachableCte, includedIdsCte, nodeProjectionPlan),
    fetchSubgraphEdges(ctx, reachableCte, includedIdsCte, edgeProjectionPlan),
  ]);

  const nodes = nodeRows.map((row) =>
    mapSubgraphNodeRow(row, nodeProjectionPlan),
  );
  const edges = edgeRows.map((row) =>
    mapSubgraphEdgeRow(row, edgeProjectionPlan),
  );

  return {
    nodes: nodes as unknown as SubgraphResult<G, NK, EK, P>["nodes"],
    edges: edges as unknown as SubgraphResult<G, NK, EK, P>["edges"],
  };
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
    | Readonly<Record<string, readonly string[] | undefined>>
    | undefined,
  resolveFieldType: FieldTypeResolver,
  entityPrefix: "node" | "edge",
): ProjectionPlan {
  const projectedKinds = new Map<string, KindProjectionPlan>();
  const fullKinds: string[] = [];

  for (const kind of kinds) {
    const selection = projectionMap?.[kind];
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
  entityPrefix: "node" | "edge",
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

function buildReachableCte(ctx: SubgraphContext): SQL {
  const shouldTrackPath = ctx.cyclePolicy === "prevent";
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), ctx.edgeKinds);

  // Path operations for cycle detection
  const initialPath =
    shouldTrackPath ? ctx.dialect.initializePath(sql.raw("n.id")) : undefined;
  const pathExtension =
    shouldTrackPath ?
      ctx.dialect.extendPath(sql.raw("r.path"), sql.raw("n.id"))
    : undefined;
  const cycleCheck =
    shouldTrackPath ?
      ctx.dialect.cycleCheck(sql.raw("n.id"), sql.raw("r.path"))
    : undefined;

  // Base case: the root node
  const baseColumns: SQL[] = [sql`n.id`, sql`n.kind`, sql`0 AS depth`];
  if (initialPath !== undefined) {
    baseColumns.push(sql`${initialPath} AS path`);
  }

  const baseCase = sql`SELECT ${sql.join(baseColumns, sql`, `)} FROM ${ctx.schema.nodesTable} n WHERE n.graph_id = ${ctx.graphId} AND n.id = ${ctx.rootId} AND n.deleted_at IS NULL`;

  // Recursive case columns
  const recursiveColumns: SQL[] = [
    sql`n.id`,
    sql`n.kind`,
    sql`r.depth + 1 AS depth`,
  ];
  if (pathExtension !== undefined) {
    recursiveColumns.push(sql`${pathExtension} AS path`);
  }

  // Common WHERE clauses for recursive branches
  const recursiveWhereClauses: SQL[] = [
    sql`e.graph_id = ${ctx.graphId}`,
    edgeKindFilter,
    sql`e.deleted_at IS NULL`,
    sql`n.deleted_at IS NULL`,
    sql`r.depth < ${ctx.maxDepth}`,
  ];
  if (cycleCheck !== undefined) {
    recursiveWhereClauses.push(cycleCheck);
  }

  const forceWorktableOuterJoinOrder =
    ctx.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder;

  const recursiveCase =
    ctx.direction === "both" ?
      compileBidirectionalBranch({
        recursiveColumns,
        whereClauses: recursiveWhereClauses,
        forceWorktableOuterJoinOrder,
        schema: ctx.schema,
      })
    : compileRecursiveBranch({
        recursiveColumns,
        whereClauses: recursiveWhereClauses,
        joinField: "from_id",
        targetField: "to_id",
        targetKindField: "to_kind",
        forceWorktableOuterJoinOrder,
        schema: ctx.schema,
      });

  return sql`WITH RECURSIVE reachable AS (${baseCase} UNION ALL ${recursiveCase})`;
}

function compileRecursiveBranch(params: {
  recursiveColumns: readonly SQL[];
  whereClauses: readonly SQL[];
  joinField: "from_id" | "to_id";
  targetField: "from_id" | "to_id";
  targetKindField: "from_kind" | "to_kind";
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}): SQL {
  const columns = [...params.recursiveColumns];
  const selectClause = sql`SELECT ${sql.join(columns, sql`, `)}`;
  const nodeJoin = sql`JOIN ${params.schema.nodesTable} n ON n.graph_id = e.graph_id AND n.id = e.${sql.raw(params.targetField)} AND n.kind = e.${sql.raw(params.targetKindField)}`;

  if (params.forceWorktableOuterJoinOrder) {
    // SQLite: worktable must be outer in the join — use CROSS JOIN + WHERE
    const allWhere = [
      ...params.whereClauses,
      sql`e.${sql.raw(params.joinField)} = r.id`,
    ];
    return sql`${selectClause} FROM reachable r CROSS JOIN ${params.schema.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  // PostgreSQL: standard JOIN ON
  const where = [...params.whereClauses];
  return sql`${selectClause} FROM reachable r JOIN ${params.schema.edgesTable} e ON e.${sql.raw(params.joinField)} = r.id ${nodeJoin} WHERE ${sql.join(where, sql` AND `)}`;
}

/**
 * Combines outbound and inbound traversal into a single recursive SELECT
 * using OR on the join condition. This avoids a second UNION ALL branch,
 * which PostgreSQL rejects because it treats the left side of a multi-part
 * UNION ALL as the non-recursive term.
 */
function compileBidirectionalBranch(params: {
  recursiveColumns: readonly SQL[];
  whereClauses: readonly SQL[];
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}): SQL {
  const columns = [...params.recursiveColumns];
  const selectClause = sql`SELECT ${sql.join(columns, sql`, `)}`;

  // Match node via either direction of the edge
  const nodeJoin = sql`JOIN ${params.schema.nodesTable} n ON n.graph_id = e.graph_id AND ((e.to_id = r.id AND n.id = e.from_id AND n.kind = e.from_kind) OR (e.from_id = r.id AND n.id = e.to_id AND n.kind = e.to_kind))`;

  if (params.forceWorktableOuterJoinOrder) {
    const allWhere = [
      ...params.whereClauses,
      sql`(e.from_id = r.id OR e.to_id = r.id)`,
    ];
    return sql`${selectClause} FROM reachable r CROSS JOIN ${params.schema.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  return sql`${selectClause} FROM reachable r JOIN ${params.schema.edgesTable} e ON (e.from_id = r.id OR e.to_id = r.id) ${nodeJoin} WHERE ${sql.join([...params.whereClauses], sql` AND `)}`;
}

function buildIncludedIdsCte(ctx: SubgraphContext): SQL {
  const filters: SQL[] = [];

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

async function fetchSubgraphNodes(
  ctx: SubgraphContext,
  reachableCte: SQL,
  includedIdsCte: SQL,
  projectionPlan: ProjectionPlan,
): Promise<SubgraphNodeFetchRow[]> {
  const columns: SQL[] = [
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

  const query = sql`${reachableCte}${includedIdsCte} SELECT ${sql.join(columns, sql`, `)} FROM ${ctx.schema.nodesTable} n WHERE n.graph_id = ${ctx.graphId} AND n.id IN (SELECT id FROM included_ids)`;

  return ctx.backend.execute<SubgraphNodeFetchRow>(query) as Promise<
    SubgraphNodeFetchRow[]
  >;
}

async function fetchSubgraphEdges(
  ctx: SubgraphContext,
  reachableCte: SQL,
  includedIdsCte: SQL,
  projectionPlan: ProjectionPlan,
): Promise<SubgraphEdgeFetchRow[]> {
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), ctx.edgeKinds);
  const columns: SQL[] = [
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

  const query = sql`${reachableCte}${includedIdsCte} SELECT ${sql.join(columns, sql`, `)} FROM ${ctx.schema.edgesTable} e WHERE e.graph_id = ${ctx.graphId} AND ${edgeKindFilter} AND e.deleted_at IS NULL AND e.from_id IN (SELECT id FROM included_ids) AND e.to_id IN (SELECT id FROM included_ids)`;

  return ctx.backend.execute<SubgraphEdgeFetchRow>(query) as Promise<
    SubgraphEdgeFetchRow[]
  >;
}

function buildMetadataColumns(
  alias: "n" | "e",
  plan: ProjectionPlan,
  columns: readonly string[],
): readonly SQL[] {
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

function buildFullPropsColumn(alias: "n" | "e", plan: ProjectionPlan): SQL {
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
): readonly SQL[] {
  const columns: SQL[] = [];

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
    projectedNode.meta = rowToNodeMeta(row);
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
    projectedEdge.meta = rowToEdgeMeta(row);
  }

  applyProjectedFields(projectedEdge, row, kindPlan);
  return projectedEdge as Edge;
}
