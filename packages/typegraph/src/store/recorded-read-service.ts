import { type SQL, sql } from "drizzle-orm";

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
import { ConfigurationError } from "../errors";
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
import { asCompiledRowsSql, type CompiledRowsSql } from "../query/sql-intent";
import { chunk } from "../utils/array";
import { withRecordedRelationsPrecondition } from "../utils/sql-errors";
import { recordedBindParamBudget } from "./recorded-capture/relations";
import { rowToEdge, rowToNode } from "./row-mappers";
import { type Edge, type Node } from "./types";

const RECORDED_POINT_READ_FIXED_BIND_PARAMS = 8;

type RecordedReadServiceParams = Readonly<{
  graphId: string;
  backend: GraphBackend;
  recordedReadBinding: RecordedReadBinding | undefined;
  mapRecordedNodeRow: (row: Record<string, unknown>) => NodeRow;
  mapRecordedEdgeRow: (row: Record<string, unknown>) => EdgeRow;
}>;

type RecordedGetByIdsParams<T extends Readonly<{ id: string }>> = Readonly<{
  entity: "node" | "edge";
  table: SQL;
  alias: string;
  kind: string;
  ids: readonly string[];
  coordinate: ReadCoordinate;
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
  return createBackendOverlay(backend, {
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
            backend.executeRaw!<T>(sqlText, params),
            surface,
          ),
      }),
  });
}

function recordedTemporalFilter(
  backend: GraphBackend,
  coordinate: ReadCoordinate,
  tableAlias: string,
): SQL {
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
    "Recorded relation invariant violation: more than one recorded row matched the requested point read.",
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

  function nodeGetByIds<N extends NodeType>(
    kind: string,
    ids: readonly NodeId<N>[],
    coordinate: ReadCoordinate,
  ): Promise<readonly (Node<N> | undefined)[]> {
    const schema =
      recordedSchema ??
      recordedReadSqlSchema(
        requireRecordedReadBinding(recordedReadBinding, "recorded-point-read"),
      );
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
    const schema =
      recordedSchema ??
      recordedReadSqlSchema(
        requireRecordedReadBinding(recordedReadBinding, "recorded-point-read"),
      );
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

    async edgeGetById<E extends AnyEdgeType>(
      kind: string,
      id: EdgeId<E>,
      coordinate: ReadCoordinate,
    ): Promise<Edge<E> | undefined> {
      const results = await edgeGetByIds(kind, [id], coordinate);
      return results[0];
    },

    edgeGetByIds,
  };
}
