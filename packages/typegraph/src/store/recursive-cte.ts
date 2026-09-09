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
 * The row source `buildEdgeAcyclicityProbe`'s `seed` CTE reads from, and —
 * critically — whether `ancestry` may hop THROUGH those rows on top of the
 * relation's live edges:
 *
 * - `"proposed"` — edges the calling write path has already made visible to
 *   the probing transaction (an insert earlier in the SAME transaction), OR
 *   a single row. A single row never needs a seed-hop: the question this
 *   probe answers is "does `to` already reach `from`", and a row cannot help
 *   answer that about ITSELF by being hopped through as an intermediate
 *   step. **Contract:** a caller passing more than one `"proposed"` row
 *   thereby asserts those rows are already inserted in the probing
 *   transaction — every real write path satisfies this (bulkCreate and
 *   import probe AFTER their insert; single create and resurrection propose
 *   exactly one row). `ancestry` joins `typegraph_edges` DIRECTLY for this
 *   form, no compound `candidates` CTE in between: a compound CTE whose
 *   outer query is a join cannot be flattened by SQLite's query flattener
 *   (rule 17d), which forces `MATERIALIZE candidates` — the entire relation
 *   copied into an ephemeral table on EVERY probe, turning every acyclic
 *   insert into an O(|relation|) operation instead of an index seek.
 * - `"planned"` — edges NOT YET written anywhere that the walk must hop
 *   through to see a cycle closed entirely by rows sharing no live edge.
 *   Used by exactly one caller: the graph-merge plan-time preview
 *   (`readProposedEdgeAcyclicityViolations` / `assertResolvedPlanEdgesAcyclic`
 *   in `src/graph-merge/merge.ts`), which asks "would this resolved plan's
 *   edges close a cycle" before any of them exist and so has nothing live to
 *   probe against. `ancestry` hops through a compound `candidates` CTE (live
 *   edges `UNION ALL` the `seed` rows) for this form — see
 *   {@link buildPlannedAcyclicityCandidates}'s docblock for why that pays
 *   SQLite's full-relation materialization, and why that cost is acceptable
 *   once per merge plan (never per write).
 * - `"relation"` — every live edge of the relation (the audit and
 *   schema-tightening forms). `ancestry` joins `typegraph_edges` directly,
 *   same as `"proposed"`.
 */
export type AcyclicityProbeSeed =
  | Readonly<{ kind: "proposed"; edges: readonly ProposedRelationEdge[] }>
  | Readonly<{ kind: "planned"; edges: readonly ProposedRelationEdge[] }>
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
  return sql`(CAST(${edge.edgeId} AS TEXT), CAST(${fromKind} AS TEXT), CAST(${fromId} AS TEXT), CAST(${toKind} AS TEXT), CAST(${toId} AS TEXT))`;
}

/**
 * The `seed` CTE body, oriented endpoints throughout: a `VALUES` row list
 * for the two row-list forms (`"proposed"` and `"planned"` — identical
 * shape, since both name rows the caller supplies rather than reading the
 * table), or the relation's own live edges for the `"relation"` (audit)
 * form.
 */
function buildAcyclicitySeed(
  seed: AcyclicityProbeSeed,
  members: readonly AcyclicRelationMember[],
  graphId: string,
  schema: SqlSchema,
): SqlFragment {
  if (seed.kind !== "relation") {
    // A `VALUES` row list, never `SELECT ... UNION ALL SELECT ...`: a batch
    // create can propose thousands of origins in one probe, and SQLite caps
    // a compound SELECT at `SQLITE_LIMIT_COMPOUND_SELECT` (500 terms by
    // default) — a limit `VALUES` is not subject to.
    const rows = seed.edges.map((edge) => proposedSeedRow(edge, members));
    return sql`seed(origin_key, from_kind, from_id, to_kind, to_id) AS (VALUES ${sql.join(rows, sql`, `)})`;
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

/**
 * The relation's live edges, reoriented so every row reads part->whole
 * regardless of which member direction produced it: `(from_kind, from_id,
 * to_kind, to_id)`. Used only to build the `"planned"` seed form's compound
 * `candidates` source — see {@link buildPlannedAcyclicityCandidates}. The
 * `"proposed"` and `"relation"` forms join `typegraph_edges` directly
 * instead (see {@link buildAcyclicityAncestryStepDirect}) and never call
 * this function.
 */
function buildLiveEdgeCandidates(
  members: readonly AcyclicRelationMember[],
  graphId: string,
  schema: SqlSchema,
): SqlFragment {
  const { forward, reversed, all } = kindKeys(members);
  const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), all);
  const commonWhere = [
    sql`e.graph_id = ${graphId}`,
    edgeKindFilter,
    sql`e.deleted_at IS NULL`,
  ];

  // The common case, and the only one D.2 itself ever produces: every member
  // forward. No CASE and no OR, so this shape is byte-identical to what the
  // benchmark's index-only scan assumption (§7.6) requires.
  if (reversed.length === 0) {
    return sql`SELECT e.from_kind, e.from_id, e.to_kind, e.to_id FROM ${schema.edgesTable} e WHERE ${sql.join(commonWhere, sql` AND `)}`;
  }

  // A relation composed of both part->whole and whole->part realizing edges
  // (item E). Each member still seeks its OWN natural endpoint column; the
  // CASE only chooses which pair of columns is the "part" and which is the
  // "whole" per row.
  const forwardFilter = compileKindFilter(sql.raw("e.kind"), forward);
  const fromKindColumn = sql`CASE WHEN ${forwardFilter} THEN e.from_kind ELSE e.to_kind END`;
  const fromIdColumn = sql`CASE WHEN ${forwardFilter} THEN e.from_id ELSE e.to_id END`;
  const toKindColumn = sql`CASE WHEN ${forwardFilter} THEN e.to_kind ELSE e.from_kind END`;
  const toIdColumn = sql`CASE WHEN ${forwardFilter} THEN e.to_id ELSE e.from_id END`;
  return sql`SELECT ${fromKindColumn}, ${fromIdColumn}, ${toKindColumn}, ${toIdColumn} FROM ${schema.edgesTable} e WHERE ${sql.join(commonWhere, sql` AND `)}`;
}

/**
 * The `"planned"` seed form's `candidates` source: the relation's live
 * edges, `UNION ALL` the writer's own not-yet-written rows via `seed`.
 *
 * A cycle formed ENTIRELY from rows in one planned set (three branch edges
 * a->b, b->c, c->a with nothing live) has no live edge to walk, so
 * `ancestry` must also be able to reach through `seed` directly. That
 * cannot be a second `UNION`-ed recursive term next to the live-edge hop:
 * both PostgreSQL and SQLite refuse a recursive term that references the
 * recursive relation (`ancestry`) more than once (verified empirically —
 * PostgreSQL: `recursive reference to query "ancestry" must not appear more
 * than once`), so the two hops cannot be two arms of a `UNION` each
 * self-joining `ancestry`. They must instead be two arms of the table
 * `ancestry` joins against ONCE — the same device `buildBidirectionalBranch`
 * uses for two traversal directions in one recursive term. This also lets a
 * single path interleave live and planned edges (an existing edge, then a
 * planned one, then another existing edge), which two separate recursive
 * terms could not express without an explicit second round of interleaving.
 *
 * `UNION ALL`, not `UNION`: `candidates` is a source `ancestry` joins
 * against, not itself part of the `(origin_key, node_kind, node_id)`
 * accumulator that needs deduplicating — a duplicate candidate row costs an
 * extra join, never a wrong answer.
 *
 * This is a compound CTE whose outer query (`ancestry`'s recursive term) is
 * a join — SQLite's query flattener cannot flatten that (rule 17d), so this
 * form materializes the ENTIRE relation into an ephemeral table on every
 * call. Acceptable ONLY because this seed form runs once per merge plan,
 * never per write — see {@link AcyclicityProbeSeed}'s docblock. The
 * `"proposed"` and `"relation"` forms never pay this cost: their `ancestry`
 * step joins `typegraph_edges` directly (see
 * {@link buildAcyclicityAncestryStepDirect}) and calls neither this function
 * nor {@link buildLiveEdgeCandidates}.
 */
function buildPlannedAcyclicityCandidates(
  members: readonly AcyclicRelationMember[],
  graphId: string,
  schema: SqlSchema,
): SqlFragment {
  const liveEdges = buildLiveEdgeCandidates(members, graphId, schema);
  return sql`${liveEdges} UNION ALL SELECT from_kind, from_id, to_kind, to_id FROM seed`;
}

/**
 * The `ancestry` recursive term for the `"planned"` seed form: one hop
 * through the compound `candidates` CTE, the ONLY reference to the
 * recursive relation this term may make (see
 * {@link buildPlannedAcyclicityCandidates}'s docblock for why the live-edge
 * and seed hops are folded into one join rather than two recursive terms).
 */
function buildAcyclicityAncestryStepViaCandidates(
  forceWorktableOuterJoinOrder: boolean,
): SqlFragment {
  const joinPredicate = sql`c.from_kind = a.node_kind AND c.from_id = a.node_id`;
  if (forceWorktableOuterJoinOrder) {
    return sql`SELECT a.origin_key, c.to_kind, c.to_id FROM ancestry a CROSS JOIN candidates c WHERE ${joinPredicate}`;
  }
  return sql`SELECT a.origin_key, c.to_kind, c.to_id FROM ancestry a JOIN candidates c ON ${joinPredicate}`;
}

/**
 * The `ancestry` recursive term for the `"proposed"` and `"relation"` seed
 * forms: one hop DIRECTLY against `typegraph_edges`, with no `candidates`
 * CTE in between. This is what keeps every real write's probe an index
 * seek — see {@link AcyclicityProbeSeed}'s docblock for the flattener
 * defect this restores the pre-D-4 shape to avoid.
 *
 * The common case (no `reversed` member — the only shape D.2 itself ever
 * produces) is a plain equality join on `from_kind`/`from_id`, seekable by
 * `typegraph_edges_from_idx`. `forceWorktableOuterJoinOrder` moves the join
 * field predicate into the `WHERE` clause behind a `CROSS JOIN`, mirroring
 * `buildDirectionalBranch` above — every other predicate (`graph_id`, the
 * edge-kind filter, `deleted_at`) always lives in `WHERE` regardless.
 *
 * A relation with a `reversed` member (item E's mixed orientation — D.2
 * itself never produces one, but the type and this code path are exercised
 * by the mixed-orientation fixture) is still ONE join, never a compound: an
 * OR of two index-seekable arms, one per orientation —
 * `(e.kind IN (forward) AND e.from_kind = a.node_kind AND e.from_id =
 * a.node_id) OR (e.kind IN (reversed) AND e.to_kind = a.node_kind AND
 * e.to_id = a.node_id)` — with the "next node" projected by a `CASE` on
 * which arm matched. This is what lets SQLite's OR-optimization and
 * PostgreSQL's `BitmapOr` seek both `typegraph_edges_from_idx` and
 * `typegraph_edges_to_idx` in the same step, mirroring
 * `buildBidirectionalBranch`'s two-direction device above.
 */
function buildAcyclicityAncestryStepDirect(
  members: readonly AcyclicRelationMember[],
  graphId: string,
  schema: SqlSchema,
  forceWorktableOuterJoinOrder: boolean,
): SqlFragment {
  const { forward, reversed, all } = kindKeys(members);
  const commonWhere = [sql`e.graph_id = ${graphId}`, sql`e.deleted_at IS NULL`];

  if (reversed.length === 0) {
    const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), all);
    const joinPredicate = sql`e.from_kind = a.node_kind AND e.from_id = a.node_id`;
    const whereClauses = [...commonWhere, edgeKindFilter];
    if (forceWorktableOuterJoinOrder) {
      return sql`SELECT a.origin_key, e.to_kind, e.to_id FROM ancestry a CROSS JOIN ${schema.edgesTable} e WHERE ${sql.join([...whereClauses, joinPredicate], sql` AND `)}`;
    }
    return sql`SELECT a.origin_key, e.to_kind, e.to_id FROM ancestry a JOIN ${schema.edgesTable} e ON ${joinPredicate} WHERE ${sql.join(whereClauses, sql` AND `)}`;
  }

  const forwardFilter = compileKindFilter(sql.raw("e.kind"), forward);
  const reversedFilter = compileKindFilter(sql.raw("e.kind"), reversed);
  const forwardArm = sql`(${forwardFilter} AND e.from_kind = a.node_kind AND e.from_id = a.node_id)`;
  const reversedArm = sql`(${reversedFilter} AND e.to_kind = a.node_kind AND e.to_id = a.node_id)`;
  const joinPredicate = sql`(${forwardArm} OR ${reversedArm})`;
  const toKindColumn = sql`CASE WHEN ${forwardFilter} THEN e.to_kind ELSE e.from_kind END`;
  const toIdColumn = sql`CASE WHEN ${forwardFilter} THEN e.to_id ELSE e.from_id END`;

  if (forceWorktableOuterJoinOrder) {
    return sql`SELECT a.origin_key, ${toKindColumn}, ${toIdColumn} FROM ancestry a CROSS JOIN ${schema.edgesTable} e WHERE ${sql.join([...commonWhere, joinPredicate], sql` AND `)}`;
  }
  return sql`SELECT a.origin_key, ${toKindColumn}, ${toIdColumn} FROM ancestry a JOIN ${schema.edgesTable} e ON ${joinPredicate} WHERE ${sql.join(commonWhere, sql` AND `)}`;
}

/** Everything {@link buildProbeBodyPlanned} and {@link buildProbeBodyDirect} need beyond their own seed form. */
type AcyclicityProbeBodyOptions = Readonly<{
  members: readonly AcyclicRelationMember[];
  graphId: string;
  schema: SqlSchema;
  forceWorktableOuterJoinOrder: boolean;
  seedCte: SqlFragment;
  anchor: SqlFragment;
  closingSelect: SqlFragment;
}>;

/** The `"planned"` form's probe body: `seed`, a compound `candidates`, `ancestry` hopping through it. */
function buildProbeBodyPlanned(
  options: AcyclicityProbeBodyOptions,
): SqlFragment {
  const candidatesCte = buildPlannedAcyclicityCandidates(
    options.members,
    options.graphId,
    options.schema,
  );
  const ancestryStep = buildAcyclicityAncestryStepViaCandidates(
    options.forceWorktableOuterJoinOrder,
  );
  const ancestry = sql`ancestry(origin_key, node_kind, node_id) AS (${options.anchor} UNION ${ancestryStep})`;
  return sql`${options.seedCte}, candidates(from_kind, from_id, to_kind, to_id) AS (${candidatesCte}), ${ancestry} ${options.closingSelect}`;
}

/** The `"proposed"`/`"relation"` forms' probe body: `seed`, `ancestry` joining `typegraph_edges` directly. */
function buildProbeBodyDirect(
  options: AcyclicityProbeBodyOptions,
): SqlFragment {
  const ancestryStep = buildAcyclicityAncestryStepDirect(
    options.members,
    options.graphId,
    options.schema,
    options.forceWorktableOuterJoinOrder,
  );
  const ancestry = sql`ancestry(origin_key, node_kind, node_id) AS (${options.anchor} UNION ${ancestryStep})`;
  return sql`${options.seedCte}, ${ancestry} ${options.closingSelect}`;
}

/**
 * Builds the exhaustive, set-semantics reachability probe item D.2's
 * acyclicity check runs: "does `from` lie in the reflexive-transitive
 * closure of `to`" over one acyclic relation's live edges.
 *
 * Deliberately a sibling export in this file rather than a new emitter: the
 * three seed forms are the ONLY difference between the write-path probe,
 * the audit reader, and the merge plan-time preview, so all three are built
 * by this one function and cannot answer the question differently.
 *
 * `UNION`, never `UNION ALL`, on the `ancestry` term: set semantics on
 * `(origin_key, node_kind, node_id)` is what makes an unbounded recursion
 * terminate on a finite graph with no path tracking and no depth bound —
 * `MAX_EXPLICIT_RECURSIVE_DEPTH` does not apply to this probe.
 *
 * Exactly ONE literal `WITH RECURSIVE` occurs in this function (the
 * `WITH RECURSIVE ${body}` return below) regardless of which seed form
 * runs: `body` is assembled by {@link buildPlannedAcyclicityCandidates} /
 * {@link buildAcyclicityAncestryStepDirect} beforehand, both of which are
 * plain fragments with no `WITH RECURSIVE` of their own, so
 * `tests/recursive-traversal-inventory.test.ts`'s emission-site inventory
 * still counts exactly one site here.
 *
 * For the `"planned"` seed form, `ancestry` hops through TWO sources folded
 * into one `candidates` CTE — the relation's live edges AND the writer's
 * not-yet-written rows (D-4) — so a cycle closed entirely by rows in that
 * set is found even though none of them exist yet. See
 * {@link buildPlannedAcyclicityCandidates}'s docblock for why this is one
 * joined source rather than a second recursive term, and why it is the only
 * form that pays for it. The `"proposed"` and `"relation"` forms join
 * `typegraph_edges` directly instead — see
 * {@link buildAcyclicityAncestryStepDirect}.
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
  const forceWorktableOuterJoinOrder =
    options.dialect.capabilities.forceRecursiveWorktableOuterJoinOrder;
  const anchor = sql`SELECT s.origin_key, s.to_kind, s.to_id FROM seed s`;

  const closingSelect = sql`SELECT DISTINCT a.origin_key FROM ancestry a JOIN seed s ON s.origin_key = a.origin_key AND s.from_kind = a.node_kind AND s.from_id = a.node_id`;
  // A single-edge proposed seed stops at the first witness: both engines
  // pipeline a recursive CTE, so a `LIMIT 1` short-circuits the walk instead
  // of running to fixpoint. Several origins must return every offending one
  // so a refusal can name the edge, so no LIMIT is added there.
  const limited =
    options.seed.kind === "proposed" && options.seed.edges.length === 1 ?
      sql`${closingSelect} LIMIT 1`
    : closingSelect;

  const bodyOptions: AcyclicityProbeBodyOptions = {
    members: options.members,
    graphId: options.graphId,
    schema: options.schema,
    forceWorktableOuterJoinOrder,
    seedCte,
    anchor,
    closingSelect: limited,
  };
  const body =
    options.seed.kind === "planned" ?
      buildProbeBodyPlanned(bodyOptions)
    : buildProbeBodyDirect(bodyOptions);

  return sql`WITH RECURSIVE ${body}`;
}
