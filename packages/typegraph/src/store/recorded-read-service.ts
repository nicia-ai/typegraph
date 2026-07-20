import { createGraphBackendProjection } from "../backend/graph-backend-projection";
import {
  createBackendOverlay,
  type EdgeRow,
  type GraphBackend,
  type NodeRow,
} from "../backend/types";
import { type ReadCoordinate } from "../core/temporal";
import {
  type AnyEdgeType,
  type EdgeId,
  type NodeId,
  type NodeType,
} from "../core/types";
import { ConfigurationError, ValidationError } from "../errors";
import { sqlValueList } from "../query/compiler/predicate-utils";
import {
  type RecordedReadBinding,
  recordedReadSqlSchema,
  requireRecordedReadBinding,
} from "../query/compiler/schema";
import {
  compileTemporalFilter,
  currentReadInstant,
} from "../query/compiler/temporal";
import { decodeCursor, encodeCursor } from "../query/cursor";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql, type CompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { requireDefined } from "../utils/presence";
import { withRecordedRelationsPrecondition } from "../utils/sql-errors";
import { recordedBindParamBudget } from "./recorded-capture/relations";
import { rowToEdge, rowToNode } from "./row-mappers";
import {
  type Edge,
  type Node,
  type RecordedScanOptions,
  type RecordedScanPage,
} from "./types";

const RECORDED_POINT_READ_FIXED_BIND_PARAMS = 8;
const RECORDED_SCAN_LIMIT = 1000;

type RecordedReadServiceParams = Readonly<{
  graphId: string;
  backend: GraphBackend;
  recordedReadBinding: RecordedReadBinding | undefined;
  mapRecordedNodeRow: (row: Record<string, unknown>) => NodeRow;
  mapRecordedEdgeRow: (row: Record<string, unknown>) => EdgeRow;
}>;

type RecordedGetByIdsParams<T extends Readonly<{ id: string }>> = Readonly<{
  entity: "node" | "edge";
  table: SqlFragment;
  alias: string;
  kind: string;
  ids: readonly string[];
  coordinate: ReadCoordinate;
  toEntity: (row: Record<string, unknown>) => T;
}>;

type RecordedScanParams<T extends Readonly<{ id: string }>> = Readonly<{
  entity: "node" | "edge";
  table: SqlFragment;
  alias: string;
  kind: string;
  coordinate: ReadCoordinate;
  options: RecordedScanOptions | undefined;
  toEntity: (row: Record<string, unknown>) => T;
}>;

export type RecordedReadService = Readonly<{
  backendForCoordinate: (
    coordinate: ReadCoordinate,
    surface: string,
  ) => GraphBackend;
  nodeGetById: <N extends NodeType>(
    kind: string,
    id: NodeId<N>,
    coordinate: ReadCoordinate,
  ) => Promise<Node<N> | undefined>;
  nodeGetByIds: <N extends NodeType>(
    kind: string,
    ids: readonly NodeId<N>[],
    coordinate: ReadCoordinate,
  ) => Promise<readonly (Node<N> | undefined)[]>;
  nodeScan: <N extends NodeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ) => Promise<RecordedScanPage<Node<N>>>;
  edgeGetById: <E extends AnyEdgeType>(
    kind: string,
    id: EdgeId<E>,
    coordinate: ReadCoordinate,
  ) => Promise<Edge<E> | undefined>;
  edgeGetByIds: <E extends AnyEdgeType>(
    kind: string,
    ids: readonly EdgeId<E>[],
    coordinate: ReadCoordinate,
  ) => Promise<readonly (Edge<E> | undefined)[]>;
  edgeScan: <E extends AnyEdgeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ) => Promise<RecordedScanPage<Edge<E>>>;
}>;

/**
 * Per-chunk id count for a recorded point read: the backend's real
 * bound-parameter ceiling less the statement's fixed binds, so Postgres point
 * reads page thousands of ids per round-trip instead of a dialect-blind 900.
 */
function recordedPointReadIdChunk(backend: GraphBackend): number {
  const budget = recordedBindParamBudget(backend);
  return Math.max(1, budget - RECORDED_POINT_READ_FIXED_BIND_PARAMS);
}

function recordedRelationErrorDetails(
  backend: Pick<GraphBackend, "dialect">,
  surface: string,
): Readonly<{ dialect: GraphBackend["dialect"]; surface: string }> {
  return { dialect: backend.dialect, surface };
}

function withRelationsPrecondition<T>(
  backend: Pick<GraphBackend, "dialect">,
  promise: Promise<T>,
  surface: string,
): Promise<T> {
  return withRecordedRelationsPrecondition(
    promise,
    recordedRelationErrorDetails(backend, surface),
  );
}

function createRecordedReadBackend(
  backend: GraphBackend,
  surface: string,
): GraphBackend {
  // A public AdapterStore backend is frozen. Decorate a fresh allowlist
  // projection so Proxy invariants do not prevent the execute guards from
  // replacing non-configurable function properties.
  const projectedBackend = createGraphBackendProjection(backend);
  return createBackendOverlay(projectedBackend, {
    execute: <T>(query: CompiledRowsSql): Promise<readonly T[]> =>
      withRelationsPrecondition(backend, backend.execute<T>(query), surface),
    ...(backend.executeRaw === undefined ?
      {}
    : {
        executeRaw: <T>(
          sqlText: string,
          params: readonly unknown[],
        ): Promise<readonly T[]> =>
          withRelationsPrecondition(
            backend,
            requireDefined(backend.executeRaw)<T>(sqlText, params),
            surface,
          ),
      }),
  });
}

function recordedTemporalFilter(
  backend: GraphBackend,
  coordinate: ReadCoordinate,
  tableAlias: string,
): SqlFragment {
  const recordedAsOf = coordinate.recorded?.asOf;
  if (recordedAsOf === undefined) {
    throw new ConfigurationError(
      "Recorded point reads require a recorded-time coordinate.",
      { code: "RECORDED_POINT_READ_MISSING_COORDINATE" },
    );
  }
  return compileTemporalFilter({
    mode: coordinate.valid.mode,
    asOf: coordinate.valid.asOf,
    recordedAsOf,
    tableAlias,
    currentTimestamp: currentReadInstant(),
  });
}

function recordedRelationInvariantError(
  params: Readonly<{
    graphId: string;
    entity: "node" | "edge";
    kind: string;
    id: string;
    coordinate: ReadCoordinate;
  }>,
): ConfigurationError {
  return new ConfigurationError(
    "Recorded relation invariant violation: more than one recorded row matched the requested read.",
    {
      code: "RECORDED_RELATION_INVARIANT_VIOLATION",
      graphId: params.graphId,
      entity: params.entity,
      kind: params.kind,
      id: params.id,
      validMode: params.coordinate.valid.mode,
      validAsOf: params.coordinate.valid.asOf,
      recordedAsOf: params.coordinate.recorded?.asOf,
    },
    {
      suggestion:
        "Repair overlapping recorded_from/recorded_to intervals for this entity before using recorded-time reads.",
    },
  );
}

function validateRecordedScanLimit(limit: number | undefined): number {
  if (limit === undefined) return RECORDED_SCAN_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0 || limit > RECORDED_SCAN_LIMIT) {
    throw new ValidationError(
      `Recorded scan limit must be an integer between 1 and ${RECORDED_SCAN_LIMIT}, got: ${String(limit)}`,
      {
        issues: [
          {
            path: "limit",
            message: `Must be an integer between 1 and ${RECORDED_SCAN_LIMIT}.`,
          },
        ],
      },
    );
  }
  return limit;
}

function recordedScanCursorScope(
  graphId: string,
  entity: "node" | "edge",
  kind: string,
  coordinate: ReadCoordinate,
): string {
  return JSON.stringify([
    "recorded-scan",
    graphId,
    entity,
    kind,
    coordinate.valid.mode,
    coordinate.valid.asOf,
    coordinate.recorded?.asOf,
  ]);
}

function invalidRecordedScanCursor(): ValidationError {
  return new ValidationError(
    "Recorded scan cursor does not match this graph, collection, or temporal coordinate.",
    {
      issues: [
        {
          path: "after",
          message:
            "Use a cursor returned by the same recorded collection scan.",
        },
      ],
    },
  );
}

function decodeRecordedScanCursor(
  cursor: string,
  expectedScope: string,
): string {
  const decoded = decodeCursor(cursor);
  if (
    decoded.d !== "f" ||
    decoded.cols.length !== 1 ||
    decoded.cols[0] !== expectedScope ||
    decoded.vals.length !== 1 ||
    typeof decoded.vals[0] !== "string"
  ) {
    throw invalidRecordedScanCursor();
  }
  return decoded.vals[0];
}

function encodeRecordedScanCursor(id: string, scope: string): string {
  return encodeCursor({ v: 1, d: "f", vals: [id], cols: [scope] });
}

export function createRecordedReadService(
  params: RecordedReadServiceParams,
): RecordedReadService {
  const {
    graphId,
    backend,
    recordedReadBinding,
    mapRecordedNodeRow,
    mapRecordedEdgeRow,
  } = params;
  const recordedSchema =
    recordedReadBinding === undefined ? undefined : (
      recordedReadSqlSchema(recordedReadBinding)
    );

  function schemaForRecordedRead(surface: string) {
    return (
      recordedSchema ??
      recordedReadSqlSchema(
        requireRecordedReadBinding(recordedReadBinding, surface),
      )
    );
  }

  async function recordedGetByIds<T extends Readonly<{ id: string }>>(
    read: RecordedGetByIdsParams<T>,
  ): Promise<readonly (T | undefined)[]> {
    const { table, alias, kind, ids, coordinate, toEntity, entity } = read;
    if (ids.length === 0) return [];

    const uniqueIds = [...new Set(ids)];
    const aliasSql = sql.raw(alias);
    const temporalFilter = recordedTemporalFilter(backend, coordinate, alias);
    const chunkResults = await withRelationsPrecondition(
      backend,
      Promise.all(
        chunk(uniqueIds, recordedPointReadIdChunk(backend)).map((idChunk) =>
          backend.execute<Record<string, unknown>>(
            asCompiledRowsSql(sql`
              SELECT * FROM ${table} ${aliasSql}
              WHERE ${aliasSql}.graph_id = ${graphId}
                AND ${aliasSql}.kind = ${kind}
                AND ${aliasSql}.id IN (${sqlValueList(idChunk)})
                AND ${temporalFilter}
              ORDER BY ${aliasSql}.recorded_from
            `),
          ),
        ),
      ),
      "recorded-point-read",
    );

    const byId = new Map<string, T>();
    for (const rows of chunkResults) {
      for (const row of rows) {
        const entityRow = toEntity(row);
        if (byId.has(entityRow.id)) {
          throw recordedRelationInvariantError({
            graphId,
            entity,
            kind,
            id: entityRow.id,
            coordinate,
          });
        }
        byId.set(entityRow.id, entityRow);
      }
    }
    return ids.map((id) => byId.get(id));
  }

  async function recordedScan<T extends Readonly<{ id: string }>>(
    scan: RecordedScanParams<T>,
  ): Promise<RecordedScanPage<T>> {
    const { table, alias, kind, coordinate, options, toEntity, entity } = scan;
    const limit = validateRecordedScanLimit(options?.limit);
    const scope = recordedScanCursorScope(graphId, entity, kind, coordinate);
    const after =
      options?.after === undefined ?
        undefined
      : decodeRecordedScanCursor(options.after, scope);
    const aliasSql = sql.raw(alias);
    const temporalFilter = recordedTemporalFilter(backend, coordinate, alias);
    const rows = await withRelationsPrecondition(
      backend,
      backend.execute<Record<string, unknown>>(
        asCompiledRowsSql(sql`
          SELECT * FROM ${table} ${aliasSql}
          WHERE ${aliasSql}.graph_id = ${graphId}
            AND ${aliasSql}.kind = ${kind}
            ${after === undefined ? sql.raw("") : sql`AND ${aliasSql}.id > ${after}`}
            AND ${temporalFilter}
          ORDER BY ${aliasSql}.id ASC, ${aliasSql}.recorded_from ASC
          LIMIT ${limit + 1}
        `),
      ),
      "recorded-scan",
    );
    const entities = rows.map((row) => toEntity(row));
    for (let index = 1; index < entities.length; index += 1) {
      const previous = requireDefined(entities[index - 1]);
      const current = requireDefined(entities[index]);
      if (previous.id !== current.id) continue;
      throw recordedRelationInvariantError({
        graphId,
        entity,
        kind,
        id: current.id,
        coordinate,
      });
    }

    const hasNextPage = entities.length > limit;
    const data = hasNextPage ? entities.slice(0, limit) : entities;
    return {
      data,
      nextCursor:
        hasNextPage ?
          encodeRecordedScanCursor(requireDefined(data.at(-1)).id, scope)
        : undefined,
      hasNextPage,
    };
  }

  function nodeGetByIds<N extends NodeType>(
    kind: string,
    ids: readonly NodeId<N>[],
    coordinate: ReadCoordinate,
  ): Promise<readonly (Node<N> | undefined)[]> {
    const schema = schemaForRecordedRead("recorded-point-read");
    return recordedGetByIds({
      entity: "node",
      table: schema.nodesTable,
      alias: "n",
      kind,
      ids,
      coordinate,
      toEntity: (row) => rowToNode(mapRecordedNodeRow(row)) as Node<N>,
    });
  }

  function edgeGetByIds<E extends AnyEdgeType>(
    kind: string,
    ids: readonly EdgeId<E>[],
    coordinate: ReadCoordinate,
  ): Promise<readonly (Edge<E> | undefined)[]> {
    const schema = schemaForRecordedRead("recorded-point-read");
    return recordedGetByIds({
      entity: "edge",
      table: schema.edgesTable,
      alias: "e",
      kind,
      ids,
      coordinate,
      toEntity: (row) => rowToEdge(mapRecordedEdgeRow(row)) as Edge<E>,
    });
  }

  function nodeScan<N extends NodeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ): Promise<RecordedScanPage<Node<N>>> {
    const schema = schemaForRecordedRead("recorded-scan");
    return recordedScan({
      entity: "node",
      table: schema.nodesTable,
      alias: "n",
      kind,
      coordinate,
      options,
      toEntity: (row) => rowToNode(mapRecordedNodeRow(row)) as Node<N>,
    });
  }

  function edgeScan<E extends AnyEdgeType>(
    kind: string,
    coordinate: ReadCoordinate,
    options?: RecordedScanOptions,
  ): Promise<RecordedScanPage<Edge<E>>> {
    const schema = schemaForRecordedRead("recorded-scan");
    return recordedScan({
      entity: "edge",
      table: schema.edgesTable,
      alias: "e",
      kind,
      coordinate,
      options,
      toEntity: (row) => rowToEdge(mapRecordedEdgeRow(row)) as Edge<E>,
    });
  }

  return {
    backendForCoordinate(
      coordinate: ReadCoordinate,
      surface: string,
    ): GraphBackend {
      if (coordinate.recorded === undefined) return backend;
      requireRecordedReadBinding(recordedReadBinding, surface);
      return createRecordedReadBackend(backend, surface);
    },

    async nodeGetById<N extends NodeType>(
      kind: string,
      id: NodeId<N>,
      coordinate: ReadCoordinate,
    ): Promise<Node<N> | undefined> {
      const results = await nodeGetByIds(kind, [id], coordinate);
      return results[0];
    },

    nodeGetByIds,
    nodeScan,

    async edgeGetById<E extends AnyEdgeType>(
      kind: string,
      id: EdgeId<E>,
      coordinate: ReadCoordinate,
    ): Promise<Edge<E> | undefined> {
      const results = await edgeGetByIds(kind, [id], coordinate);
      return results[0];
    },

    edgeGetByIds,
    edgeScan,
  };
}
