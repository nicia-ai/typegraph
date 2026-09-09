import {
  assertRecursiveTraversal,
  type RecursiveTraversalVerdict,
} from "../backend/capabilities/recursive-traversal";
import { type RecordedInstant } from "../core/temporal";
import { type TemporalMode } from "../core/types";
import { type RecursiveCyclePolicy } from "../query/ast";
import { compileKindFilter } from "../query/compiler/predicate-utils";
import {
  type RecordedReadBinding,
  recordedReadSchemaFor,
  type SqlSchema,
} from "../query/compiler/schema";
import {
  compileTemporalFilter,
  currentReadInstant,
} from "../query/compiler/temporal";
import { type DialectAdapter } from "../query/dialect/types";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { type TraversalDirection } from "./algorithms/types";
import { edgeOrderColumnName, type EdgeReadWindow } from "./neighbors";

type ReachableCteCore = Readonly<{
  graphId: string;
  maxHops: number;
  cyclePolicy: RecursiveCyclePolicy;
  includePath: boolean;
  /**
   * Temporal mode applied to both nodes and edges along the traversal.
   * Callers that want the pre-temporal behavior (soft-delete only) should
   * pass `"includeEnded"`.
   */
  temporalMode: TemporalMode;
  currentTimestamp?: SqlFragment;
  /** ISO-8601 timestamp used when `temporalMode === "asOf"`. */
  asOf?: string;
  /** Recorded/system-time timestamp for recorded-pinned reads. */
  recordedAsOf?: RecordedInstant;
  dialect: DialectAdapter;
  /**
   * The base (live-table) schema. The recorded-relation swap is derived here
   * from `recordedAsOf`, so the table source and the recorded interval predicate
   * cannot drift — callers pass their base schema and need not pre-resolve it.
   */
  schema: SqlSchema;
  recordedReadBinding?: RecordedReadBinding;
  /** Resolved verdict for the engine this CTE will run on. */
  recursiveTraversal: RecursiveTraversalVerdict;
  /** Operation label echoed in the refusal's `details.operation`. */
  operation: string;
  edgeWindows?: Readonly<Record<string, EdgeReadWindow | undefined>>;
}> &
  (
    | Readonly<{ sourceId: string; sourceIds?: never }>
    | Readonly<{ sourceId?: never; sourceIds: readonly string[] }>
  );

type BuildReachableCteOptions = ReachableCteCore &
  Readonly<{
    edgeKinds: readonly string[];
    direction: TraversalDirection;
  }>;

type PreparedReachableCte = Readonly<{
  baseCase: SqlFragment;
  recursiveColumns: readonly SqlFragment[];
  recursiveWhere: readonly SqlFragment[];
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}>;

/**
 * Everything a reachable-CTE's base case and recursive WHERE clauses need
 * that does not depend on direction: temporal filters, the recorded-schema
 * swap, path/cycle tracking, and the edge-kind filter (evaluated against
 * whatever superset of kinds the caller's shape requires). Shared by
 * {@link buildReachableCte} (one uniform direction) and
 * {@link buildDirectedReachableCte} (two edge-kind-scoped directions), so
 * the temporal/path/cycle machinery cannot drift between them.
 */
function prepareReachableCte(
  options: ReachableCteCore,
  edgeKindsForFilter: readonly string[],
): PreparedReachableCte {
  assertRecursiveTraversal(options.recursiveTraversal, options.operation);
  const trackPath = options.cyclePolicy === "prevent" || options.includePath;
  const edgeKindFilter = compileKindFilter(
    sql.raw("e.kind"),
    edgeKindsForFilter,
  );
  const currentTimestamp = options.currentTimestamp ?? currentReadInstant();
  const nodeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    recordedAsOf: options.recordedAsOf,
    tableAlias: "n",
    currentTimestamp,
    recordedReadBinding: options.recordedReadBinding,
  });
  const edgeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    recordedAsOf: options.recordedAsOf,
    tableAlias: "e",
    currentTimestamp,
    recordedReadBinding: options.recordedReadBinding,
  });
  // Derive the read schema from the same `recordedAsOf` that drives the temporal
  // filters above: when a recorded pin is set the node/edge sources become the
  // recorded relations, matching the `recorded_from/to` interval predicate. One
  // derivation means the table source and the predicate cannot disagree.
  const schema = recordedReadSchemaFor(
    options.schema,
    options.recordedAsOf,
    options.recordedReadBinding,
    "recorded-recursive-cte",
  );
  const edgeWindows = Object.entries(options.edgeWindows ?? {}).filter(
    (entry): entry is [string, EdgeReadWindow] => entry[1] !== undefined,
  );

  const initialPath =
    trackPath ? options.dialect.initializePath(sql.raw("n.id")) : undefined;
  const pathExtension =
    trackPath ?
      options.dialect.extendPath(sql.raw("r.path"), sql.raw("n.id"))
    : undefined;
  const cycleCheck =
    options.cyclePolicy === "prevent" ?
      options.dialect.cycleCheck(sql.raw("n.id"), sql.raw("r.path"))
    : undefined;

  const baseColumns: SqlFragment[] = [sql`n.id`, sql`n.kind`, sql`0 AS depth`];
  if (initialPath !== undefined) {
    baseColumns.push(sql`${initialPath} AS path`);
  }

  if (options.sourceIds !== undefined) baseColumns.push(sql`n.id AS origin_id`);
  const sourceFilter =
    options.sourceIds === undefined ? sql`n.id = ${options.sourceId}`
    : options.sourceIds.length === 0 ? sql`1 = 0`
    : sql`n.id IN (${sql.join(
        options.sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )})`;
  const baseCase = sql`SELECT ${sql.join(baseColumns, sql`, `)} FROM ${schema.nodesTable} n WHERE n.graph_id = ${options.graphId} AND ${sourceFilter} AND ${nodeTemporalFilter}`;

  const recursiveColumns: SqlFragment[] = [
    sql`n.id`,
    sql`n.kind`,
    sql`r.depth + 1 AS depth`,
  ];
  if (pathExtension !== undefined) {
    recursiveColumns.push(sql`${pathExtension} AS path`);
  }

  if (options.sourceIds !== undefined) recursiveColumns.push(sql`r.origin_id`);

  const recursiveWhere: SqlFragment[] = [
    sql`e.graph_id = ${options.graphId}`,
    edgeKindFilter,
    edgeTemporalFilter,
    nodeTemporalFilter,
    sql`r.depth < ${options.maxHops}`,
  ];
  if (cycleCheck !== undefined) recursiveWhere.push(cycleCheck);

  return {
    baseCase,
    recursiveColumns,
    recursiveWhere,
    forceWorktableOuterJoinOrder:
      options.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder,
    schema,
  };
}

export function buildReachableCte(
  options: BuildReachableCteOptions,
): SqlFragment {
  assertRecursiveTraversal(options.recursiveTraversal, options.operation);
  const trackPath = options.cyclePolicy === "prevent" || options.includePath;
  const edgeKindFilter = compileKindFilter(
    sql.raw("e.kind"),
    options.edgeKinds,
  );
  const currentTimestamp = options.currentTimestamp ?? currentReadInstant();
  const nodeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    recordedAsOf: options.recordedAsOf,
    tableAlias: "n",
    currentTimestamp,
    recordedReadBinding: options.recordedReadBinding,
  });
  const edgeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    recordedAsOf: options.recordedAsOf,
    tableAlias: "e",
    currentTimestamp,
    recordedReadBinding: options.recordedReadBinding,
  });
  // Derive the read schema from the same `recordedAsOf` that drives the temporal
  // filters above: when a recorded pin is set the node/edge sources become the
  // recorded relations, matching the `recorded_from/to` interval predicate. One
  // derivation means the table source and the predicate cannot disagree.
  const schema = recordedReadSchemaFor(
    options.schema,
    options.recordedAsOf,
    options.recordedReadBinding,
    "recorded-recursive-cte",
  );
  const edgeWindows = Object.entries(options.edgeWindows ?? {}).filter(
    (entry): entry is [string, EdgeReadWindow] => entry[1] !== undefined,
  );

  const initialPath =
    trackPath ? options.dialect.initializePath(sql.raw("n.id")) : undefined;
  const pathExtension =
    trackPath ?
      options.dialect.extendPath(sql.raw("r.path"), sql.raw("n.id"))
    : undefined;
  const cycleCheck =
    options.cyclePolicy === "prevent" ?
      options.dialect.cycleCheck(sql.raw("n.id"), sql.raw("r.path"))
    : undefined;

  const baseColumns: SqlFragment[] = [sql`n.id`, sql`n.kind`, sql`0 AS depth`];
  if (initialPath !== undefined) {
    baseColumns.push(sql`${initialPath} AS path`);
  }

  if (options.sourceIds !== undefined) baseColumns.push(sql`n.id AS origin_id`);
  const sourceFilter =
    options.sourceIds === undefined ? sql`n.id = ${options.sourceId}`
    : options.sourceIds.length === 0 ? sql`1 = 0`
    : sql`n.id IN (${sql.join(
        options.sourceIds.map((id) => sql`${id}`),
        sql`, `,
      )})`;
  const baseCase = sql`SELECT ${sql.join(baseColumns, sql`, `)} FROM ${schema.nodesTable} n WHERE n.graph_id = ${options.graphId} AND ${sourceFilter} AND ${nodeTemporalFilter}`;

  const recursiveColumns: SqlFragment[] = [
    sql`n.id`,
    sql`n.kind`,
    sql`r.depth + 1 AS depth`,
  ];
  if (pathExtension !== undefined) {
    recursiveColumns.push(sql`${pathExtension} AS path`);
  }

  if (options.sourceIds !== undefined) recursiveColumns.push(sql`r.origin_id`);

  const recursiveWhere: SqlFragment[] = [
    sql`e.graph_id = ${options.graphId}`,
    edgeKindFilter,
    edgeTemporalFilter,
    nodeTemporalFilter,
    sql`r.depth < ${options.maxHops}`,
  ];
  if (cycleCheck !== undefined) recursiveWhere.push(cycleCheck);

  const forceWorktableOuterJoinOrder =
    options.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder;

  const usesOrientedEdges = edgeWindows.length > 0;
  const recursiveCase = compileRecursiveBranch({
    recursiveColumns,
    whereClauses: recursiveWhere,
    direction: usesOrientedEdges ? "out" : options.direction,
    forceWorktableOuterJoinOrder,
    schema,
    edgesTable:
      usesOrientedEdges ?
        sql.identifier("typegraph_windowed_edges")
      : schema.edgesTable,
    ...(usesOrientedEdges && {
      joinField: "typegraph_source_id",
      targetField: "typegraph_target_id",
      targetKindField: "typegraph_target_kind",
    }),
  });

  const windowedEdges =
    usesOrientedEdges ?
      buildWindowedEdgesCte(
        schema.edgesTable,
        options.direction,
        options.edgeKinds.map((kind) => [kind, options.edgeWindows?.[kind]]),
        sql.join(
          [
            sql`e.graph_id = ${options.graphId}`,
            edgeKindFilter,
            edgeTemporalFilter,
          ],
          sql` AND `,
        ),
      )
    : undefined;
  return windowedEdges === undefined ?
      sql`WITH RECURSIVE reachable AS (${baseCase} UNION ALL ${recursiveCase})`
    : sql`WITH RECURSIVE typegraph_windowed_edges AS (${windowedEdges}), reachable AS (${baseCase} UNION ALL ${recursiveCase})`;
}


type BuildDirectedReachableCteOptions = ReachableCteCore &
  Readonly<{
    /** Edge kinds walked in the "out" direction (`e.from_id = r.id`). */
    outEdgeKinds: readonly string[];
    /** Edge kinds walked in the "in" direction (`e.to_id = r.id`). */
    inEdgeKinds: readonly string[];
  }>;

/**
 * A reachable CTE whose recursive term walks two edge-kind groups in two
 * different, fixed directions — every hop tries both groups against the
 * current frontier row, unioned within the SAME recursive term via an OR on
 * the join condition, never as two separate recursive terms (PostgreSQL
 * refuses more than one self-reference in a recursive CTE, even split
 * across `UNION ALL` branches).
 *
 * This is what lets a composition closure cross a relation that mixes
 * `part -> whole` and `whole -> part` (`has_*`) realizing edges across
 * levels of the same tree, without walking `direction: "both"` — which
 * would also climb from a mid-tree root to its ancestors and re-descend
 * into siblings (Ed-01). A uniform `edgeKinds`+`direction` traversal
 * ({@link buildReachableCte}) cannot express "these kinds forward, those
 * kinds reversed" in one term; this function is the composition-specific
 * generalization of `buildReachableCte`'s `"both"` case, scoped to two
 * caller-chosen edge-kind groups instead of one edge-kind set walked both
 * ways.
 */
export function buildDirectedReachableCte(
  options: BuildDirectedReachableCteOptions,
): SqlFragment {
  const prepared = prepareReachableCte(options, [
    ...options.outEdgeKinds,
    ...options.inEdgeKinds,
  ]);

  const recursiveCase = buildDirectedGroupsBranch({
    recursiveColumns: prepared.recursiveColumns,
    whereClauses: prepared.recursiveWhere,
    outEdgeKinds: options.outEdgeKinds,
    inEdgeKinds: options.inEdgeKinds,
    forceWorktableOuterJoinOrder: prepared.forceWorktableOuterJoinOrder,
    schema: prepared.schema,
  });

  return sql`WITH RECURSIVE reachable AS (${prepared.baseCase} UNION ALL ${recursiveCase})`;
}

type CompileRecursiveBranchOptions = Readonly<{
  recursiveColumns: readonly SqlFragment[];
  whereClauses: readonly SqlFragment[];
  direction: TraversalDirection;
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
  edgesTable: SqlFragment;
  joinField?: "from_id" | "to_id" | "typegraph_source_id";
  targetField?: "from_id" | "to_id" | "typegraph_target_id";
  targetKindField?: "from_kind" | "to_kind" | "typegraph_target_kind";
}>;

function compileRecursiveBranch(
  options: CompileRecursiveBranchOptions,
): SqlFragment {
  const selectClause = sql`SELECT ${sql.join([...options.recursiveColumns], sql`, `)}`;

  switch (options.direction) {
    case "out": {
      return buildDirectionalBranch({
        selectClause,
        whereClauses: options.whereClauses,
        joinField: options.joinField ?? "from_id",
        targetField: options.targetField ?? "to_id",
        targetKindField: options.targetKindField ?? "to_kind",
        forceWorktableOuterJoinOrder: options.forceWorktableOuterJoinOrder,
        schema: options.schema,
        edgesTable: options.edgesTable,
      });
    }
    case "in": {
      return buildDirectionalBranch({
        selectClause,
        whereClauses: options.whereClauses,
        joinField: "to_id",
        targetField: "from_id",
        targetKindField: "from_kind",
        forceWorktableOuterJoinOrder: options.forceWorktableOuterJoinOrder,
        schema: options.schema,
        edgesTable: options.edgesTable,
      });
    }
    case "both": {
      return buildBidirectionalBranch({
        selectClause,
        whereClauses: options.whereClauses,
        forceWorktableOuterJoinOrder: options.forceWorktableOuterJoinOrder,
        schema: options.schema,
        edgesTable: options.edgesTable,
      });
    }
  }
}

type DirectionalBranchOptions = Readonly<{
  selectClause: SqlFragment;
  whereClauses: readonly SqlFragment[];
  joinField: "from_id" | "to_id" | "typegraph_source_id";
  targetField: "from_id" | "to_id" | "typegraph_target_id";
  targetKindField: "from_kind" | "to_kind" | "typegraph_target_kind";
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
  edgesTable: SqlFragment;
}>;

function buildDirectionalBranch(
  options: DirectionalBranchOptions,
): SqlFragment {
  const nodeJoin = sql`JOIN ${options.schema.nodesTable} n ON n.graph_id = e.graph_id AND n.id = e.${sql.raw(options.targetField)} AND n.kind = e.${sql.raw(options.targetKindField)}`;

  if (options.forceWorktableOuterJoinOrder) {
    const allWhere = [
      ...options.whereClauses,
      sql`e.${sql.raw(options.joinField)} = r.id`,
    ];
    return sql`${options.selectClause} FROM reachable r CROSS JOIN ${options.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  return sql`${options.selectClause} FROM reachable r JOIN ${options.edgesTable} e ON e.${sql.raw(options.joinField)} = r.id ${nodeJoin} WHERE ${sql.join([...options.whereClauses], sql` AND `)}`;
}

type BidirectionalBranchOptions = Readonly<{
  selectClause: SqlFragment;
  whereClauses: readonly SqlFragment[];
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
  edgesTable: SqlFragment;
}>;

function buildBidirectionalBranch(
  options: BidirectionalBranchOptions,
): SqlFragment {
  // PostgreSQL rejects multiple non-recursive terms, so both directions are
  // folded into a single UNION ALL branch via an OR on the join condition.
  const nodeJoin = sql`JOIN ${options.schema.nodesTable} n ON n.graph_id = e.graph_id AND ((e.to_id = r.id AND n.id = e.from_id AND n.kind = e.from_kind) OR (e.from_id = r.id AND n.id = e.to_id AND n.kind = e.to_kind))`;

  if (options.forceWorktableOuterJoinOrder) {
    const allWhere = [
      ...options.whereClauses,
      sql`(e.from_id = r.id OR e.to_id = r.id)`,
    ];
    return sql`${options.selectClause} FROM reachable r CROSS JOIN ${options.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  return sql`${options.selectClause} FROM reachable r JOIN ${options.edgesTable} e ON (e.from_id = r.id OR e.to_id = r.id) ${nodeJoin} WHERE ${sql.join([...options.whereClauses], sql` AND `)}`;
}

export function buildWindowedEdgesCte(
  edgesTable: SqlFragment,
  defaultDirection: TraversalDirection,
  edgeKinds: readonly [string, EdgeReadWindow | undefined][],
  where: SqlFragment,
): SqlFragment {
  const branches = edgeKinds.flatMap(([kind, window]) => {
    const direction = window?.direction ?? defaultDirection;
    const directions: readonly Exclude<TraversalDirection, "both">[] =
      direction === "both" ? ["out", "in"] : [direction];
    return directions.map((orientedDirection) => {
      const sourceKind = orientedDirection === "out" ? "from_kind" : "to_kind";
      const sourceId = orientedDirection === "out" ? "from_id" : "to_id";
      const targetKind = orientedDirection === "out" ? "to_kind" : "from_kind";
      const targetId = orientedDirection === "out" ? "to_id" : "from_id";
      const column = edgeOrderColumnName(window?.orderBy?.field ?? "id");
      const orderDirection = window?.orderBy?.direction ?? "asc";
      const omitReverseSelfLoop =
        direction === "both" && orientedDirection === "in" ?
          sql` AND NOT (e.from_kind = e.to_kind AND e.from_id = e.to_id)`
        : sql.empty();
      const oriented = sql`SELECT e.*, e.${sql.raw(sourceKind)} AS typegraph_source_kind, e.${sql.raw(sourceId)} AS typegraph_source_id, e.${sql.raw(targetKind)} AS typegraph_target_kind, e.${sql.raw(targetId)} AS typegraph_target_id`;
      if (window === undefined) {
        return sql`${oriented}, 1 AS typegraphedgerank FROM ${edgesTable} e WHERE ${where} AND e.kind = ${kind}${omitReverseSelfLoop}`;
      }
      const rank = sql`ROW_NUMBER() OVER (PARTITION BY e.kind, e.${sql.raw(sourceKind)}, e.${sql.raw(sourceId)} ORDER BY CASE WHEN e.${sql.raw(column)} IS NULL THEN 1 ELSE 0 END ASC, e.${sql.raw(column)} ${sql.raw(orderDirection.toUpperCase())}, e.id ASC)`;
      const ranked = sql`${oriented}, ${rank} AS typegraphedgerank FROM ${edgesTable} e WHERE ${where} AND e.kind = ${kind}${omitReverseSelfLoop}`;
      return sql`SELECT * FROM (${ranked}) ranked WHERE ranked.typegraphedgerank <= ${window.limit}`;
    });
  });
  return sql.join(branches, sql` UNION ALL `);
}

type DirectedGroupsBranchOptions = Readonly<{
  recursiveColumns: readonly SqlFragment[];
  whereClauses: readonly SqlFragment[];
  outEdgeKinds: readonly string[];
  inEdgeKinds: readonly string[];
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}>;

/**
 * The directed-groups counterpart of {@link buildBidirectionalBranch}: an
 * edge row matches this frontier row either by starting from it (`e.from_id
 * = r.id`), restricted to `outEdgeKinds`, or by ending at it (`e.to_id =
 * r.id`), restricted to `inEdgeKinds` — never both regardless of kind, which
 * is what `buildBidirectionalBranch` does instead. An edge kind present in
 * neither group can never match (`compileKindFilter([])` compiles to
 * `1 = 0`), so a caller may pass one empty group for a uniform-orientation
 * relation and get exactly the single-direction shape.
 */
function buildDirectedGroupsBranch(
  options: DirectedGroupsBranchOptions,
): SqlFragment {
  const selectClause = sql`SELECT ${sql.join([...options.recursiveColumns], sql`, `)}`;
  const outKindFilter = compileKindFilter(
    sql.raw("e.kind"),
    options.outEdgeKinds,
  );
  const inKindFilter = compileKindFilter(
    sql.raw("e.kind"),
    options.inEdgeKinds,
  );
  const joinCondition = sql`((e.from_id = r.id AND (${outKindFilter})) OR (e.to_id = r.id AND (${inKindFilter})))`;
  const nodeJoin = sql`JOIN ${options.schema.nodesTable} n ON n.graph_id = e.graph_id AND ((e.from_id = r.id AND (${outKindFilter}) AND n.id = e.to_id AND n.kind = e.to_kind) OR (e.to_id = r.id AND (${inKindFilter}) AND n.id = e.from_id AND n.kind = e.from_kind))`;

  if (options.forceWorktableOuterJoinOrder) {
    const allWhere = [...options.whereClauses, joinCondition];
    return sql`${selectClause} FROM reachable r CROSS JOIN ${options.schema.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  return sql`${selectClause} FROM reachable r JOIN ${options.schema.edgesTable} e ON ${joinCondition} ${nodeJoin} WHERE ${sql.join([...options.whereClauses], sql` AND `)}`;
}
