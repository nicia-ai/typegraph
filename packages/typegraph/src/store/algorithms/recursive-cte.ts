/**
 * Shared recursive-CTE builder used by `reachable`, `shortestPath`,
 * `neighbors`, and `canReach`.
 *
 * Produces a `reachable(id, kind, depth [, path])` CTE whose rows are every
 * node discovered from `sourceId` in at most `maxHops` hops, following the
 * configured edge kinds in the requested direction. Cycle prevention is
 * delegated to the dialect's existing path-tracking primitives so the
 * algorithms reuse the same semantics as subgraph extraction and the
 * recursive query builder.
 */
import { type SQL, sql } from "drizzle-orm";

import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { type SqlSchema } from "../../query/compiler/schema";
import { type DialectAdapter } from "../../query/dialect/types";
import { type AlgorithmCyclePolicy, type TraversalDirection } from "./types";

export type BuildReachableCteOptions = Readonly<{
  graphId: string;
  sourceId: string;
  edgeKinds: readonly string[];
  maxHops: number;
  direction: TraversalDirection;
  cyclePolicy: AlgorithmCyclePolicy;
  /**
   * When `true`, the CTE selects a dialect-specific `path` column used for
   * later decoding into an ordered list of node IDs.
   */
  includePath: boolean;
  dialect: DialectAdapter;
  schema: SqlSchema;
}>;

/**
 * Compiles a `WITH RECURSIVE reachable(...) AS (...)` CTE.
 *
 * The caller concatenates this SQL fragment with a subsequent SELECT from
 * the `reachable` CTE to project whatever columns they need.
 */
export function buildReachableCte(options: BuildReachableCteOptions): SQL {
  const trackPath = options.cyclePolicy === "prevent" || options.includePath;
  const edgeKindFilter = compileKindFilter(
    sql.raw("e.kind"),
    options.edgeKinds,
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

  const baseColumns: SQL[] = [sql`n.id`, sql`n.kind`, sql`0 AS depth`];
  if (initialPath !== undefined) {
    baseColumns.push(sql`${initialPath} AS path`);
  }

  const baseCase = sql`SELECT ${sql.join(baseColumns, sql`, `)} FROM ${options.schema.nodesTable} n WHERE n.graph_id = ${options.graphId} AND n.id = ${options.sourceId} AND n.deleted_at IS NULL`;

  const recursiveColumns: SQL[] = [
    sql`n.id`,
    sql`n.kind`,
    sql`r.depth + 1 AS depth`,
  ];
  if (pathExtension !== undefined) {
    recursiveColumns.push(sql`${pathExtension} AS path`);
  }

  const recursiveWhere: SQL[] = [
    sql`e.graph_id = ${options.graphId}`,
    edgeKindFilter,
    sql`e.deleted_at IS NULL`,
    sql`n.deleted_at IS NULL`,
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
    schema: options.schema,
  });

  return sql`WITH RECURSIVE reachable AS (${baseCase} UNION ALL ${recursiveCase})`;
}

type CompileRecursiveBranchOptions = Readonly<{
  recursiveColumns: readonly SQL[];
  whereClauses: readonly SQL[];
  direction: TraversalDirection;
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}>;

function compileRecursiveBranch(options: CompileRecursiveBranchOptions): SQL {
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
  selectClause: SQL;
  whereClauses: readonly SQL[];
  joinField: "from_id" | "to_id";
  targetField: "from_id" | "to_id";
  targetKindField: "from_kind" | "to_kind";
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}>;

function buildDirectionalBranch(options: DirectionalBranchOptions): SQL {
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
  selectClause: SQL;
  whereClauses: readonly SQL[];
  forceWorktableOuterJoinOrder: boolean;
  schema: SqlSchema;
}>;

function buildBidirectionalBranch(options: BidirectionalBranchOptions): SQL {
  // Match the node via either direction of the edge in a single UNION ALL
  // branch, mirroring the approach used by subgraph extraction so PostgreSQL
  // accepts the recursive CTE (it rejects multiple non-recursive terms).
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

/**
 * Decodes a dialect-specific `path` column value into an ordered list of
 * node IDs.
 *
 * PostgreSQL returns `text[]` arrays (already JavaScript arrays); SQLite
 * returns a `'|id1|id2|...|id_n|'` delimited string. Empty or unknown values
 * fall back to an empty list.
 */
export function decodePathColumn(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }

  if (typeof value === "string") {
    if (value.length === 0) return [];
    const trimmed = value.startsWith("|") ? value.slice(1) : value;
    const withoutTail = trimmed.endsWith("|") ? trimmed.slice(0, -1) : trimmed;
    if (withoutTail.length === 0) return [];
    return withoutTail.split("|");
  }

  return [];
}
