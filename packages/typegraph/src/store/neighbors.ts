import type { GraphBackend, RowProps } from "../backend/types";
import type { AllNodeTypes, EdgeKinds, GraphDef } from "../core/define-graph";
import type { TemporalMode } from "../core/types";
import { ValidationError } from "../errors";
import type { ExecutableOneStatementRead } from "../query/builder/types";
import { compileKindFilter } from "../query/compiler/predicate-utils";
import type { SqlSchema } from "../query/compiler/schema";
import {
  compileTemporalFilter,
  currentReadInstant,
} from "../query/compiler/temporal";
import { compileTypedJsonExtract } from "../query/compiler/typed-json-extract";
import { getDialect } from "../query/dialect";
import { jsonPointer } from "../query/json-pointer";
import type { FieldTypeInfo } from "../query/schema-introspector";
import { createSchemaIntrospector } from "../query/schema-introspector";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import type { KindRegistry } from "../registry";
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

/** Node property names accepted by adjacent-node ordering. */
export type NeighborNodeOrderField<G extends GraphDef> = {
  [K in keyof G["nodes"] & string]: Exclude<
    keyof Node<G["nodes"][K]["type"]>,
    "id" | "kind" | "meta"
  > &
    string;
}[keyof G["nodes"] & string];

export type NeighborOrder<G extends GraphDef> =
  | Readonly<{
      by?: "edge";
      field: NeighborOrderField;
      direction?: "asc" | "desc";
    }>
  | Readonly<{
      by: "node";
      field: NeighborNodeOrderField<G>;
      direction?: "asc" | "desc";
    }>;

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
  /** Direction for this edge kind; defaults to the traversal direction. */
  direction?: "both" | "in" | "out";
  orderBy?: Readonly<{
    field: NeighborOrderField;
    direction?: "asc" | "desc";
  }>;
}>;

/** Options for reading adjacent edge-node pairs without hydrating all targets. */
type NeighborReadOptionsBoundary<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = Readonly<{
  edges?: readonly K[];
  direction?: "both" | "in" | "out";
  orderBy?: NeighborOrder<G>;
  limit?: number;
  temporalMode?: TemporalMode;
  asOf?: string;
}>;

export type NeighborReadOptions<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = NeighborReadOptionsBoundary<G, K> &
  Required<Pick<NeighborReadOptionsBoundary<G, K>, "edges">>;

/** One edge and the node it reaches from the requested source and direction. */
export type NeighborResult<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = Readonly<{
  edge: GraphEdgeForKinds<G, K>;
  node: Node<AllNodeTypes<G>>;
}>;

type NeighborRow = Readonly<Record<string, unknown>>;

function mapNeighborCountRows(rows: readonly NeighborRow[]): number {
  return Number(rows[0]?.["count"] ?? 0);
}

type NeighborContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  schema: SqlSchema;
  defaultTemporalMode: TemporalMode;
  registry: KindRegistry;
}>;

export type NeighborRead<
  G extends GraphDef,
  K extends EdgeKinds<G>,
> = ExecutableOneStatementRead<readonly NeighborResult<G, K>[]>;

export function createNeighborRead<G extends GraphDef, K extends EdgeKinds<G>>(
  ctx: NeighborContext,
  source: GraphNodeReference<G>,
  options: NeighborReadOptions<G, K>,
): NeighborRead<G, K> {
  validateOptions(ctx, options);
  const query = buildNeighborQuery(ctx, source, options, false);
  function mapRows(
    rows: readonly NeighborRow[],
  ): readonly NeighborResult<G, K>[] {
    return rows.map((row) => ({
      edge: mapEdge(row) as GraphEdgeForKinds<G, K>,
      node: mapNode(row) as Node<AllNodeTypes<G>>,
    }));
  }
  return {
    execute: async () => {
      if (options.edges.length === 0) return [];
      return mapRows(
        await ctx.backend.execute<NeighborRow>(asCompiledRowsSql(query)),
      );
    },
    compileOneStatementBatchItem: () => ({
      query: asCompiledRowsSql(query),
      outputNames: neighborOutputNames(),
      orderBy: neighborBatchOrder(options.orderBy),
      mapRows,
    }),
  };
}

export async function readNeighbors<G extends GraphDef, K extends EdgeKinds<G>>(
  ctx: NeighborContext,
  source: GraphNodeReference<G>,
  options: NeighborReadOptions<G, K>,
): Promise<readonly NeighborResult<G, K>[]> {
  return createNeighborRead(ctx, source, options).execute();
}

export async function countNeighbors<
  G extends GraphDef,
  K extends EdgeKinds<G>,
>(
  ctx: NeighborContext,
  source: GraphNodeReference<G>,
  options: Omit<NeighborReadOptions<G, K>, "limit" | "orderBy">,
): Promise<number> {
  return createNeighborCountRead(ctx, source, options).execute();
}

export function createNeighborCountRead<
  G extends GraphDef,
  K extends EdgeKinds<G>,
>(
  ctx: NeighborContext,
  source: GraphNodeReference<G>,
  options: Omit<NeighborReadOptions<G, K>, "limit" | "orderBy">,
): ExecutableOneStatementRead<number> {
  validateEdgeReadBounds(options, "countNeighbors");
  const query = buildNeighborQuery(ctx, source, options, true);
  return {
    execute: async () => {
      if (options.edges.length === 0) return 0;
      return mapNeighborCountRows(
        await ctx.backend.execute<NeighborRow>(asCompiledRowsSql(query)),
      );
    },
    compileOneStatementBatchItem: () => ({
      query: asCompiledRowsSql(query),
      outputNames: ["count"],
      orderBy: [],
      mapRows: mapNeighborCountRows,
    }),
  };
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
  const orderValue = buildOrderValue(ctx, options.orderBy);
  const order = buildOrder(options.orderBy, orderValue);
  const limit =
    options.limit === undefined ? sql.empty() : sql` LIMIT ${options.limit}`;
  return sql`SELECT ${neighborColumns()}, ${orderValue} AS typegraph_neighbor_order FROM ${ctx.schema.edgesTable} e JOIN ${ctx.schema.nodesTable} n ON ${endpoint.join} WHERE ${where} ORDER BY ${order}${limit}`;
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

function buildOrderValue(
  ctx: NeighborContext,
  orderBy: NeighborReadOptions<GraphDef, string>["orderBy"],
): SqlFragment {
  if (orderBy?.by !== "node") {
    return sql`e.${sql.raw(edgeOrderColumnName(orderBy?.field ?? "id"))}`;
  }
  return compileTypedJsonExtract({
    column: sql.raw("n.props"),
    dialect: getDialect(ctx.backend.dialect),
    fallback: "text",
    pointer: jsonPointer([orderBy.field]),
    valueType: resolveNodeOrderFieldType(ctx, orderBy.field)?.valueType,
  });
}

function buildOrder(
  orderBy: NeighborReadOptions<GraphDef, string>["orderBy"],
  value: SqlFragment,
): SqlFragment {
  const direction = orderBy?.direction ?? "asc";
  return sql`CASE WHEN ${value} IS NULL THEN 1 ELSE 0 END ASC, ${value} ${sql.raw(direction.toUpperCase())}, e.id ASC`;
}

function neighborBatchOrder(
  orderBy: NeighborReadOptions<GraphDef, string>["orderBy"],
): readonly Readonly<{
  column: string;
  direction: "asc" | "desc";
  nulls: "last";
}>[] {
  return [
    {
      column: "typegraph_neighbor_order",
      direction: orderBy?.direction ?? "asc",
      nulls: "last",
    },
    { column: "edge_id", direction: "asc", nulls: "last" },
  ];
}

function validateOptions(
  ctx: NeighborContext,
  options: NeighborReadOptions<GraphDef, string>,
): void {
  validateEdgeReadBounds(options, "neighbors");
  if (options.orderBy?.by !== "node") return;
  resolveNodeOrderFieldType(ctx, options.orderBy.field);
}

function resolveNodeOrderFieldType(
  ctx: NeighborContext,
  field: string,
): FieldTypeInfo | undefined {
  const nodeKinds = [...ctx.registry.nodeKinds.keys()];
  const introspector = createSchemaIntrospector(ctx.registry.nodeKinds);
  const declaringKinds = nodeKinds.filter(
    (kind) => introspector.getFieldTypeInfo(kind, field) !== undefined,
  );
  if (declaringKinds.length === 0) {
    throw new ValidationError("Unknown adjacent-node ordering field", {
      issues: [{ path: "neighbors.orderBy.field", message: "Invalid field" }],
    });
  }
  return introspector.getSharedFieldTypeInfo(declaringKinds, field);
}

export function validateEdgeReadBounds(
  options: Readonly<{
    limit?: number;
    direction?: string;
    orderBy?: Readonly<{ by?: string; field: string; direction?: string }>;
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
  if (
    options.direction !== undefined &&
    options.direction !== "both" &&
    options.direction !== "in" &&
    options.direction !== "out"
  ) {
    throw new ValidationError("Unknown edge traversal direction", {
      issues: [{ path: `${path}.direction`, message: "Invalid direction" }],
    });
  }
  const field = options.orderBy?.field;
  if (
    field !== undefined &&
    options.orderBy?.by !== "node" &&
    !isNeighborOrderField(field)
  ) {
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

function neighborOutputNames(): readonly string[] {
  return [
    "edge_graph_id",
    "edge_id",
    "edge_kind",
    "edge_from_kind",
    "edge_from_id",
    "edge_to_kind",
    "edge_to_id",
    "edge_props",
    "edge_valid_from",
    "edge_valid_to",
    "edge_created_at",
    "edge_updated_at",
    "edge_deleted_at",
    "node_graph_id",
    "node_id",
    "node_kind",
    "node_props",
    "node_version",
    "node_valid_from",
    "node_valid_to",
    "node_created_at",
    "node_updated_at",
    "node_deleted_at",
  ];
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
