import { type SQL, sql } from "drizzle-orm";

import { type TemporalMode } from "../core/types";
import { type RecursiveCyclePolicy } from "../query/ast";
import { compileKindFilter } from "../query/compiler/predicate-utils";
import { type SqlSchema } from "../query/compiler/schema";
import { compileTemporalFilter } from "../query/compiler/temporal";
import { type DialectAdapter } from "../query/dialect/types";
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
  dialect: DialectAdapter;
  schema: SqlSchema;
}>;

export function buildReachableCte(options: BuildReachableCteOptions): SQL {
  const trackPath = options.cyclePolicy === "prevent" || options.includePath;
  const edgeKindFilter = compileKindFilter(
    sql.raw("e.kind"),
    options.edgeKinds,
  );
  const currentTimestamp = options.dialect.currentTimestamp();
  const nodeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    tableAlias: "n",
    currentTimestamp,
  });
  const edgeTemporalFilter = compileTemporalFilter({
    mode: options.temporalMode,
    asOf: options.asOf,
    tableAlias: "e",
    currentTimestamp,
  });

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

  const baseCase = sql`SELECT ${sql.join(baseColumns, sql`, `)} FROM ${options.schema.nodesTable} n WHERE n.graph_id = ${options.graphId} AND n.id = ${options.sourceId} AND ${nodeTemporalFilter}`;

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
