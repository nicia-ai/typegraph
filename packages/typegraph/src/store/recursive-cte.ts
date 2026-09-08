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
import {
  type AcyclicRelationMember,
  type ProposedRelationEdge,
} from "./acyclicity";
import { type TraversalDirection } from "./algorithms/types";

type BuildReachableCteOptions = Readonly<{
  graphId: string;
  sourceId: string;
  edgeKinds: readonly string[];
  maxHops: number;
  direction: TraversalDirection;
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

export function buildReachableCte(
  options: BuildReachableCteOptions,
): SqlFragment {
  assertRecursiveTraversal(options.recursiveTraversal, options.operation);
  const trackPath = options.cyclePolicy === "prevent" || options.includePath;
  const edgeKindFilter = compileKindFilter(
    sql.raw("e.kind"),
    options.edgeKinds,
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

  const forceWorktableOuterJoinOrder =
    options.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder;

  const recursiveCase = compileRecursiveBranch({
    recursiveColumns,
    whereClauses: recursiveWhere,
    direction: options.direction,
    forceWorktableOuterJoinOrder,
    schema,
  });

  return sql`WITH RECURSIVE reachable AS (${baseCase} UNION ALL ${recursiveCase})`;
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

// ============================================================
// Edge-acyclicity probe (item D.2)
// ============================================================

/**
 * The row source `buildEdgeAcyclicityProbe`'s `seed` CTE reads from: either
 * the rows a writer proposes (`originKey` is the edge id the verdict answers
 * for), or every live edge of the relation — the audit and tightening form.
 * The two seeds differ only in this row source; everything downstream is
 * identical, which is what lets the write-path probe and the audit agree by
 * construction.
 */
export type AcyclicityProbeSeed =
  | Readonly<{ kind: "proposed"; edges: readonly ProposedRelationEdge[] }>
  | Readonly<{ kind: "relation" }>;

function kindKeys(members: readonly AcyclicRelationMember[]): {
  forward: readonly string[];
  reversed: readonly string[];
  all: readonly string[];
} {
  const forward = members
    .filter((member) => !member.reversed)
    .map((member) => member.edgeKind);
  const reversed = members
    .filter((member) => member.reversed)
    .map((member) => member.edgeKind);
  return { forward, reversed, all: [...forward, ...reversed] };
}

function reversedForEdgeKind(
  members: readonly AcyclicRelationMember[],
  edgeKind: string,
): boolean {
  return members.some(
    (member) => member.edgeKind === edgeKind && member.reversed,
  );
}

/** One literal `seed` row for the `"proposed"` form, oriented part->whole. */
function proposedSeedRow(
  edge: ProposedRelationEdge,
  members: readonly AcyclicRelationMember[],
): SqlFragment {
  const reversed = reversedForEdgeKind(members, edge.edgeKind);
  const fromKind = reversed ? edge.toKind : edge.fromKind;
  const fromId = reversed ? edge.toId : edge.fromId;
  const toKind = reversed ? edge.fromKind : edge.toKind;
  const toId = reversed ? edge.fromId : edge.toId;
  return sql`SELECT CAST(${edge.edgeId} AS TEXT), CAST(${fromKind} AS TEXT), CAST(${fromId} AS TEXT), CAST(${toKind} AS TEXT), CAST(${toId} AS TEXT)`;
}

/** The `seed` CTE body for both forms, oriented endpoints throughout. */
function buildAcyclicitySeed(
  seed: AcyclicityProbeSeed,
  members: readonly AcyclicRelationMember[],
  graphId: string,
  schema: SqlSchema,
): SqlFragment {
  if (seed.kind === "proposed") {
    const rows = seed.edges.map((edge) => proposedSeedRow(edge, members));
    return sql`seed(origin_key, from_kind, from_id, to_kind, to_id) AS (${sql.join(rows, sql` UNION ALL `)})`;
  }
  const { forward, all } = kindKeys(members);
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), all);
  const isForwardRow =
    forward.length === all.length ?
      undefined
    : compileKindFilter(sql.raw("e.kind"), forward);
  const fromKindColumn =
    isForwardRow === undefined ?
      sql`e.from_kind`
    : sql`CASE WHEN ${isForwardRow} THEN e.from_kind ELSE e.to_kind END`;
  const fromIdColumn =
    isForwardRow === undefined ?
      sql`e.from_id`
    : sql`CASE WHEN ${isForwardRow} THEN e.from_id ELSE e.to_id END`;
  const toKindColumn =
    isForwardRow === undefined ?
      sql`e.to_kind`
    : sql`CASE WHEN ${isForwardRow} THEN e.to_kind ELSE e.from_kind END`;
  const toIdColumn =
    isForwardRow === undefined ?
      sql`e.to_id`
    : sql`CASE WHEN ${isForwardRow} THEN e.to_id ELSE e.from_id END`;
  return sql`seed(origin_key, from_kind, from_id, to_kind, to_id) AS (SELECT e.id, ${fromKindColumn}, ${fromIdColumn}, ${toKindColumn}, ${toIdColumn} FROM ${schema.edgesTable} e WHERE e.graph_id = ${graphId} AND ${edgeKindFilter} AND e.deleted_at IS NULL)`;
}

/** The `ancestry` recursive term, oriented so every member walks part->whole. */
function buildAcyclicityRecursiveTerm(
  members: readonly AcyclicRelationMember[],
  graphId: string,
  schema: SqlSchema,
  forceWorktableOuterJoinOrder: boolean,
): SqlFragment {
  const { forward, reversed, all } = kindKeys(members);
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), all);
  const commonWhere = [
    sql`e.graph_id = ${graphId}`,
    edgeKindFilter,
    sql`e.deleted_at IS NULL`,
  ];

  // The common case, and the only one D.2 itself ever produces: every member
  // forward. One equality-only join on `(from_kind, from_id)` — covered by
  // `typegraph_edges_from_idx` in that leading order — with no CASE and no
  // OR, so this shape is byte-identical to what the benchmark's index-only
  // scan assumption (§7.6) requires.
  if (reversed.length === 0) {
    const joinPredicate = sql`e.from_kind = a.node_kind AND e.from_id = a.node_id`;
    if (forceWorktableOuterJoinOrder) {
      return sql`SELECT a.origin_key, e.to_kind, e.to_id FROM ancestry a CROSS JOIN ${schema.edgesTable} e WHERE ${sql.join([...commonWhere, joinPredicate], sql` AND `)}`;
    }
    return sql`SELECT a.origin_key, e.to_kind, e.to_id FROM ancestry a JOIN ${schema.edgesTable} e ON ${joinPredicate} WHERE ${sql.join(commonWhere, sql` AND `)}`;
  }

  // A relation composed of both part->whole and whole->part realizing edges
  // (item E). Each member still seeks its OWN natural endpoint column; the
  // OR only chooses which equality applies per row, the same device
  // `buildBidirectionalBranch` already uses for two traversal directions in
  // one recursive term.
  const forwardFilter = compileKindFilter(sql.raw("e.kind"), forward);
  const reversedFilter = compileKindFilter(sql.raw("e.kind"), reversed);
  const joinPredicate = sql`((${forwardFilter} AND e.from_kind = a.node_kind AND e.from_id = a.node_id) OR (${reversedFilter} AND e.to_kind = a.node_kind AND e.to_id = a.node_id))`;
  const projectedKind = sql`CASE WHEN ${forwardFilter} THEN e.to_kind ELSE e.from_kind END`;
  const projectedId = sql`CASE WHEN ${forwardFilter} THEN e.to_id ELSE e.from_id END`;
  if (forceWorktableOuterJoinOrder) {
    return sql`SELECT a.origin_key, ${projectedKind}, ${projectedId} FROM ancestry a CROSS JOIN ${schema.edgesTable} e WHERE ${sql.join([...commonWhere, joinPredicate], sql` AND `)}`;
  }
  return sql`SELECT a.origin_key, ${projectedKind}, ${projectedId} FROM ancestry a JOIN ${schema.edgesTable} e ON ${joinPredicate} WHERE ${sql.join(commonWhere, sql` AND `)}`;
}

/**
 * Builds the exhaustive, set-semantics reachability probe item D.2's
 * acyclicity check runs: "does `from` lie in the reflexive-transitive
 * closure of `to`" over one acyclic relation's live edges.
 *
 * Deliberately a sibling export in this file rather than a new emitter: the
 * two seed forms are the ONLY difference between the write-path probe and
 * the audit reader, so both are built by this one function and cannot
 * answer the question differently.
 *
 * `UNION`, never `UNION ALL`, on the `ancestry` term: set semantics on
 * `(origin_key, node_kind, node_id)` is what makes an unbounded recursion
 * terminate on a finite graph with no path tracking and no depth bound —
 * `MAX_EXPLICIT_RECURSIVE_DEPTH` does not apply to this probe.
 *
 * Every literal seed column is `CAST(... AS TEXT)`: PostgreSQL cannot infer
 * the type of a bare bound parameter in a `SELECT` list with no surrounding
 * column context.
 */
export function buildEdgeAcyclicityProbe(
  options: Readonly<{
    graphId: string;
    members: readonly AcyclicRelationMember[];
    seed: AcyclicityProbeSeed;
    dialect: DialectAdapter;
    schema: SqlSchema;
    recursiveTraversal: RecursiveTraversalVerdict;
    operation: string;
  }>,
): SqlFragment {
  assertRecursiveTraversal(options.recursiveTraversal, options.operation);

  const seedCte = buildAcyclicitySeed(
    options.seed,
    options.members,
    options.graphId,
    options.schema,
  );
  const recursiveTerm = buildAcyclicityRecursiveTerm(
    options.members,
    options.graphId,
    options.schema,
    options.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder,
  );

  const anchor = sql`SELECT s.origin_key, s.to_kind, s.to_id FROM seed s`;
  const ancestry = sql`ancestry(origin_key, node_kind, node_id) AS (${anchor} UNION ${recursiveTerm})`;

  const closingSelect = sql`SELECT DISTINCT a.origin_key FROM ancestry a JOIN seed s ON s.origin_key = a.origin_key AND s.from_kind = a.node_kind AND s.from_id = a.node_id`;
  // A single-edge proposed seed stops at the first witness: both engines
  // pipeline a recursive CTE, so a `LIMIT 1` short-circuits the walk instead
  // of running to fixpoint. Several origins must return every offending one
  // so a refusal can name the edge, so no LIMIT is added there.
  const limited =
    options.seed.kind === "proposed" && options.seed.edges.length === 1 ?
      sql`${closingSelect} LIMIT 1`
    : closingSelect;

  return sql`WITH RECURSIVE ${seedCte}, ${ancestry} ${limited}`;
}
