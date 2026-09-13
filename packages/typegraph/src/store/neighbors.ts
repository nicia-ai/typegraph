import type { GraphBackend, RowProps } from "../backend/types";
import type { AllNodeTypes, EdgeKinds, GraphDef } from "../core/define-graph";
import type { TemporalMode } from "../core/types";
import { ValidationError } from "../errors";
import { compileKindFilter } from "../query/compiler/predicate-utils";
import type { SqlSchema } from "../query/compiler/schema";
import {
  compileTemporalFilter,
  currentReadInstant,
} from "../query/compiler/temporal";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { rowToEdge, rowToNode } from "./row-mappers";
import type {
  Edge,
  GraphEdgeForKinds,
  GraphNodeReference,
  Node,
} from "./types";

/** Edge metadata fields accepted by bounded neighbor and subgraph reads. */
export type NeighborOrderField =
  "createdAt" | "id" | "updatedAt" | "validFrom" | "validTo";

const NEIGHBOR_ORDER_FIELDS = [
  "createdAt",
  "id",
  "updatedAt",
  "validFrom",
  "validTo",
] as const satisfies readonly NeighborOrderField[];
const NEIGHBOR_ORDER_FIELD_SET: ReadonlySet<string> = new Set(
  NEIGHBOR_ORDER_FIELDS,
);

function isNeighborOrderField(field: string): field is NeighborOrderField {
  return NEIGHBOR_ORDER_FIELD_SET.has(field);
}

/** Per-edge-kind ordering and bound applied before traversal expands an edge. */
export type EdgeReadWindow = Readonly<{
  limit: number;
  orderBy?: Readonly<{
    field: NeighborOrderField;
    direction?: "asc" | "desc";
  }>;
}>;

/** Options for reading adjacent edge-node pairs without hydrating all targets. */
export type NeighborReadOptions<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = Readonly<{
  edges: readonly K[];
  direction?: "both" | "in" | "out";
  orderBy?: Readonly<{
    field: NeighborOrderField;
    direction?: "asc" | "desc";
  }>;
  limit?: number;
  temporalMode?: TemporalMode;
  asOf?: string;
}>;

/** One edge and the node it reaches from the requested source and direction. */
export type NeighborResult<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = Readonly<{
  edge: GraphEdgeForKinds<G, K>;
  node: Node<AllNodeTypes<G>>;
}>;

type NeighborRow = Readonly<Record<string, unknown>>;

type NeighborContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  schema: SqlSchema;
  defaultTemporalMode: TemporalMode;
}>;

export async function readNeighbors<G extends GraphDef, K extends EdgeKinds<G>>(
  ctx: NeighborContext,
  source: GraphNodeReference<G>,
  options: NeighborReadOptions<G, K>,
): Promise<readonly NeighborResult<G, K>[]> {
  validateOptions(options);
  if (options.edges.length === 0) return [];
  const query = buildNeighborQuery(ctx, source, options, false);
  const rows = await ctx.backend.execute<NeighborRow>(asCompiledRowsSql(query));
  return rows.map((row) => ({
    edge: mapEdge(row) as GraphEdgeForKinds<G, K>,
    node: mapNode(row) as Node<AllNodeTypes<G>>,
  }));
}

export async function countNeighbors<
  G extends GraphDef,
  K extends EdgeKinds<G>,
>(
  ctx: NeighborContext,
  source: GraphNodeReference<G>,
  options: Omit<NeighborReadOptions<G, K>, "limit" | "orderBy">,
): Promise<number> {
  if (options.edges.length === 0) return 0;
  const rows = await ctx.backend.execute<Readonly<{ count: number | string }>>(
    asCompiledRowsSql(buildNeighborQuery(ctx, source, options, true)),
  );
  return Number(rows[0]?.count ?? 0);
}

function buildNeighborQuery<G extends GraphDef, K extends EdgeKinds<G>>(
  ctx: NeighborContext,
  source: GraphNodeReference<G>,
  options: NeighborReadOptions<G, K>,
  aggregate: boolean,
): SqlFragment {
  const direction = options.direction ?? "out";
  const instant = currentReadInstant();
  const temporalMode = options.temporalMode ?? ctx.defaultTemporalMode;
  const edgeTemporal = compileTemporalFilter({
    mode: temporalMode,
    asOf: options.asOf,
    tableAlias: "e",
    currentTimestamp: instant,
  });
  const nodeTemporal = compileTemporalFilter({
    mode: temporalMode,
    asOf: options.asOf,
    tableAlias: "n",
    currentTimestamp: instant,
  });
  const endpoint = endpointClauses(direction, source);
  const where = sql.join(
    [
      sql`e.graph_id = ${ctx.graphId}`,
      sql`n.graph_id = ${ctx.graphId}`,
      compileKindFilter(sql.raw("e.kind"), options.edges),
      edgeTemporal,
      nodeTemporal,
      endpoint.filter,
    ],
    sql` AND `,
  );
  if (aggregate) {
    return sql`SELECT COUNT(DISTINCT e.id) AS count FROM ${ctx.schema.edgesTable} e JOIN ${ctx.schema.nodesTable} n ON ${endpoint.join} WHERE ${where}`;
  }
  const order = buildOrder(options.orderBy);
  const limit =
    options.limit === undefined ? sql.empty() : sql` LIMIT ${options.limit}`;
  return sql`SELECT ${neighborColumns()} FROM ${ctx.schema.edgesTable} e JOIN ${ctx.schema.nodesTable} n ON ${endpoint.join} WHERE ${where} ORDER BY ${order}${limit}`;
}

function endpointClauses(
  direction: "both" | "in" | "out",
  source: Readonly<{ kind: string; id: string }>,
): Readonly<{ join: SqlFragment; filter: SqlFragment }> {
  const outgoingFilter = sql`e.from_kind = ${source.kind} AND e.from_id = ${source.id}`;
  const incomingFilter = sql`e.to_kind = ${source.kind} AND e.to_id = ${source.id}`;
  switch (direction) {
    case "out": {
      return {
        filter: outgoingFilter,
        join: sql`n.kind = e.to_kind AND n.id = e.to_id`,
      };
    }
    case "in": {
      return {
        filter: incomingFilter,
        join: sql`n.kind = e.from_kind AND n.id = e.from_id`,
      };
    }
    case "both": {
      return {
        filter: sql`((${outgoingFilter}) OR (${incomingFilter}))`,
        join: sql`((e.from_kind = ${source.kind} AND e.from_id = ${source.id} AND n.kind = e.to_kind AND n.id = e.to_id) OR (e.to_kind = ${source.kind} AND e.to_id = ${source.id} AND n.kind = e.from_kind AND n.id = e.from_id))`,
      };
    }
  }
}

export function edgeOrderColumnName(field: NeighborOrderField): string {
  switch (field) {
    case "id": {
      return "id";
    }
    case "createdAt": {
      return "created_at";
    }
    case "updatedAt": {
      return "updated_at";
    }
    case "validFrom": {
      return "valid_from";
    }
    case "validTo": {
      return "valid_to";
    }
  }
}

function buildOrder(
  orderBy: NeighborReadOptions<GraphDef, string>["orderBy"],
): SqlFragment {
  const direction = orderBy?.direction ?? "asc";
  const column = edgeOrderColumnName(orderBy?.field ?? "id");
  return sql`CASE WHEN e.${sql.raw(column)} IS NULL THEN 1 ELSE 0 END ASC, e.${sql.raw(column)} ${sql.raw(direction.toUpperCase())}, e.id ASC`;
}

function validateOptions(options: Readonly<{ limit?: number }>): void {
  validateEdgeReadBounds(options, "neighbors");
}

export function validateEdgeReadBounds(
  options: Readonly<{
    limit?: number;
    orderBy?: Readonly<{ field: string; direction?: string }>;
  }>,
  path: string,
): void {
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit <= 0)
  ) {
    throw new ValidationError(
      "Neighbor limit must be a positive safe integer",
      {
        issues: [{ path: `${path}.limit`, message: "Invalid edge-read limit" }],
      },
    );
  }
  const field = options.orderBy?.field;
  if (field !== undefined && !isNeighborOrderField(field)) {
    throw new ValidationError("Unknown edge ordering field", {
      issues: [{ path: `${path}.orderBy.field`, message: "Invalid field" }],
    });
  }
  const direction = options.orderBy?.direction;
  if (direction !== undefined && direction !== "asc" && direction !== "desc") {
    throw new ValidationError("Unknown edge ordering direction", {
      issues: [
        { path: `${path}.orderBy.direction`, message: "Invalid direction" },
      ],
    });
  }
}

function neighborColumns(): SqlFragment {
  const edgeColumns = [
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
  ];
  const nodeColumns = [
    "graph_id",
    "id",
    "kind",
    "props",
    "version",
    "valid_from",
    "valid_to",
    "created_at",
    "updated_at",
    "deleted_at",
  ];
  return sql.join(
    [
      ...edgeColumns.map(
        (column) =>
          sql`e.${sql.raw(column)} AS ${sql.identifier(`edge_${column}`)}`,
      ),
      ...nodeColumns.map(
        (column) =>
          sql`n.${sql.raw(column)} AS ${sql.identifier(`node_${column}`)}`,
      ),
    ],
    sql`, `,
  );
}

function mapEdge(row: NeighborRow): Edge {
  return rowToEdge({
    id: String(row["edge_id"]),
    kind: String(row["edge_kind"]),
    from_kind: String(row["edge_from_kind"]),
    from_id: String(row["edge_from_id"]),
    to_kind: String(row["edge_to_kind"]),
    to_id: String(row["edge_to_id"]),
    props: row["edge_props"] as RowProps,
    valid_from: row["edge_valid_from"] as string | undefined,
    valid_to: row["edge_valid_to"] as string | undefined,
    created_at: String(row["edge_created_at"]),
    updated_at: String(row["edge_updated_at"]),
    deleted_at: row["edge_deleted_at"] as string | undefined,
  });
}

function mapNode(row: NeighborRow): Node {
  return rowToNode({
    id: String(row["node_id"]),
    kind: String(row["node_kind"]),
    props: row["node_props"] as RowProps,
    version: Number(row["node_version"]),
    valid_from: row["node_valid_from"] as string | undefined,
    valid_to: row["node_valid_to"] as string | undefined,
    created_at: String(row["node_created_at"]),
    updated_at: String(row["node_updated_at"]),
    deleted_at: row["node_deleted_at"] as string | undefined,
  });
}
