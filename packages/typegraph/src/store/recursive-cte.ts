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

type ReachableCteCore = Readonly<{
  graphId: string;
  sourceId: string;
  maxHops: number;
  cyclePolicy: RecursiveCyclePolicy;
  includePath: boolean;
  /**
   * Temporal mode applied to both nodes and edges along the traversal.
   * Callers that want the pre-temporal behavior (soft-delete only) should
   * pass `"includeEnded"`.
   */
  temporalMode: TemporalMode;
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
}>;

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
  const currentTimestamp = currentReadInstant();
  const nodeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    recordedAsOf: options.recordedAsOf,
    tableAlias: "n",
    currentTimestamp,
  });
  const edgeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    recordedAsOf: options.recordedAsOf,
    tableAlias: "e",
    currentTimestamp,
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

  const baseCase = sql`SELECT ${sql.join(baseColumns, sql`, `)} FROM ${schema.nodesTable} n WHERE n.graph_id = ${options.graphId} AND n.id = ${options.sourceId} AND ${nodeTemporalFilter}`;

  const recursiveColumns: SqlFragment[] = [
    sql`n.id`,
    sql`n.kind`,
    sql`r.depth + 1 AS depth`,
  ];
  if (pathExtension !== undefined) {
    recursiveColumns.push(sql`${pathExtension} AS path`);
  }

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
  const prepared = prepareReachableCte(options, options.edgeKinds);

  const recursiveCase = compileRecursiveBranch({
    recursiveColumns: prepared.recursiveColumns,
    whereClauses: prepared.recursiveWhere,
    direction: options.direction,
    forceWorktableOuterJoinOrder: prepared.forceWorktableOuterJoinOrder,
    schema: prepared.schema,
  });

  return sql`WITH RECURSIVE reachable AS (${prepared.baseCase} UNION ALL ${recursiveCase})`;
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
        joinField: "from_id",
        targetField: "to_id",
        targetKindField: "to_kind",
        forceWorktableOuterJoinOrder: options.forceWorktableOuterJoinOrder,
        schema: options.schema,
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
      });
    }
    case "both": {
      return buildBidirectionalBranch({
        selectClause,
        whereClauses: options.whereClauses,
        forceWorktableOuterJoinOrder: options.forceWorktableOuterJoinOrder,
        schema: options.schema,
      });
    }
  }
}

type DirectionalBranchOptions = Readonly<{
  selectClause: SqlFragment;
  whereClauses: readonly SqlFragment[];
  joinField: "from_id" | "to_id";
  targetField: "from_id" | "to_id";
  targetKindField: "from_kind" | "to_kind";
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
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
    return sql`${options.selectClause} FROM reachable r CROSS JOIN ${options.schema.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  return sql`${options.selectClause} FROM reachable r JOIN ${options.schema.edgesTable} e ON e.${sql.raw(options.joinField)} = r.id ${nodeJoin} WHERE ${sql.join([...options.whereClauses], sql` AND `)}`;
}

type BidirectionalBranchOptions = Readonly<{
  selectClause: SqlFragment;
  whereClauses: readonly SqlFragment[];
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
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
    return sql`${options.selectClause} FROM reachable r CROSS JOIN ${options.schema.edgesTable} e ${nodeJoin} WHERE ${sql.join(allWhere, sql` AND `)}`;
  }

  return sql`${options.selectClause} FROM reachable r JOIN ${options.schema.edgesTable} e ON (e.from_id = r.id OR e.to_id = r.id) ${nodeJoin} WHERE ${sql.join([...options.whereClauses], sql` AND `)}`;
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
