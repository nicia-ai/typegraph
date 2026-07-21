import {
  optionalRecordedInstantParts,
  type ReadCoordinate,
  type RecordedInstantParts,
} from "../core/temporal";
import { type TemporalMode } from "../core/types";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { type IdentityRelation } from "./types";

export type HistoricalIdentitySqlCoordinate = Readonly<{
  validMode: TemporalMode;
  validAsOf?: string | undefined;
  recorded?: RecordedInstantParts | undefined;
  currentInstant: SqlFragment;
}>;

export function identitySqlCoordinate(
  coordinate: ReadCoordinate | undefined,
  currentInstant: string | SqlFragment,
): HistoricalIdentitySqlCoordinate {
  return {
    validMode: coordinate?.valid.mode ?? "current",
    validAsOf: coordinate?.valid.asOf,
    recorded: optionalRecordedInstantParts(
      coordinate?.recorded?.asOf,
      "recorded.asOf",
    ),
    currentInstant:
      typeof currentInstant === "string" ?
        sql`${currentInstant}`
      : currentInstant,
  };
}

function validityInstant(
  coordinate: HistoricalIdentitySqlCoordinate,
): SqlFragment {
  if (coordinate.validMode === "asOf" && coordinate.validAsOf !== undefined) {
    return sql`${coordinate.validAsOf}`;
  }
  if (coordinate.recorded !== undefined) {
    return sql`${coordinate.recorded.recordedAt}`;
  }
  return coordinate.currentInstant;
}

function qualifiedColumn(alias: string, column: string): SqlFragment {
  return sql`${sql.identifier(alias)}.${sql.identifier(column)}`;
}

/** Point-in-time node visibility shared by identity reads and traversal SQL. */
export function identityNodeVisibilitySql(
  coordinate: HistoricalIdentitySqlCoordinate,
  alias: string,
): SqlFragment {
  const deletedAt = qualifiedColumn(alias, "deleted_at");
  if (coordinate.validMode === "includeTombstones") return sql`1 = 1`;
  if (coordinate.validMode === "includeEnded") {
    return sql`${deletedAt} IS NULL`;
  }
  const validFrom = qualifiedColumn(alias, "valid_from");
  const validTo = qualifiedColumn(alias, "valid_to");
  const instant = validityInstant(coordinate);
  return sql`
    ${deletedAt} IS NULL
    AND (${validFrom} IS NULL OR ${validFrom} <= ${instant})
    AND (${validTo} IS NULL OR ${validTo} > ${instant})
  `;
}

/**
 * Lifecycle predicate for implicit same-id folds.
 *
 * A valid-time read before a later soft deletion must still see the fold that
 * existed then. Recorded reads already source a historical row image, while a
 * valid-time-only read has the live row and therefore reconstructs existence
 * from created_at/deleted_at.
 */
function structuralFoldVisibilitySql(
  coordinate: HistoricalIdentitySqlCoordinate,
  alias: string,
): SqlFragment {
  const deletedAt = qualifiedColumn(alias, "deleted_at");
  if (coordinate.recorded !== undefined) return sql`${deletedAt} IS NULL`;
  if (coordinate.validMode !== "asOf") return sql`${deletedAt} IS NULL`;
  const createdAt = qualifiedColumn(alias, "created_at");
  const instant = validityInstant(coordinate);
  return sql`${createdAt} <= ${instant} AND (${deletedAt} IS NULL OR ${deletedAt} > ${instant})`;
}

export function identityNodeSnapshotSource(
  schema: SqlSchema,
  graphId: string,
  coordinate: HistoricalIdentitySqlCoordinate,
): SqlFragment {
  const table =
    coordinate.recorded === undefined ?
      schema.nodesTable
    : schema.recordedNodesTable;
  const recordedFilter =
    coordinate.recorded === undefined ?
      sql``
    : sql`
      AND recorded_from <= ${coordinate.recorded.revision}
      AND recorded_to > ${coordinate.recorded.revision}
    `;
  return sql`
    SELECT kind, id, valid_from, valid_to, created_at, deleted_at
    FROM ${table}
    WHERE graph_id = ${graphId}
      ${recordedFilter}
  `;
}

export function identityAssertionSnapshotSource(
  schema: SqlSchema,
  graphId: string,
  coordinate: HistoricalIdentitySqlCoordinate,
  relation: IdentityRelation | undefined,
): SqlFragment {
  const table =
    coordinate.recorded === undefined ?
      schema.identityAssertionsTable
    : schema.recordedIdentityAssertionsTable;
  const recordedFilter =
    coordinate.recorded === undefined ?
      sql``
    : sql`
      AND recorded_from <= ${coordinate.recorded.revision}
      AND recorded_to > ${coordinate.recorded.revision}
    `;
  const relationFilter =
    relation === undefined ? sql`` : sql`AND rel = ${relation}`;
  const instant = validityInstant(coordinate);
  return sql`
    SELECT graph_id, id, rel, a_kind, a_id, b_kind, b_id,
           valid_from, valid_to, created_at, updated_at, deleted_at
    FROM ${table}
    WHERE graph_id = ${graphId}
      ${recordedFilter}
      AND deleted_at IS NULL
      ${relationFilter}
      AND valid_from <= ${instant}
      AND (valid_to IS NULL OR valid_to > ${instant})
  `;
}

/**
 * Builds the shared recursive CTE body used to reconstruct an identity class.
 * `seedSource` must select `(seed_kind, seed_id)` columns.
 */
export function historicalIdentityReconstructionCtes(
  input: Readonly<{
    schema: SqlSchema;
    graphId: string;
    coordinate: HistoricalIdentitySqlCoordinate;
    seedSource: SqlFragment;
    sameIdAcrossKinds: "fold" | "ignore";
  }>,
): SqlFragment {
  const nodes = identityNodeSnapshotSource(
    input.schema,
    input.graphId,
    input.coordinate,
  );
  const assertions = identityAssertionSnapshotSource(
    input.schema,
    input.graphId,
    input.coordinate,
    "same",
  );
  const sameIdEdges =
    input.sameIdAcrossKinds === "fold" ?
      sql`
        UNION ALL
        SELECT left_node.kind, left_node.id, right_node.kind, right_node.id
        FROM node_snapshot left_node
        JOIN node_snapshot right_node
          ON right_node.id = left_node.id
         AND right_node.kind <> left_node.kind
        WHERE ${structuralFoldVisibilitySql(input.coordinate, "left_node")}
          AND ${structuralFoldVisibilitySql(input.coordinate, "right_node")}
      `
    : sql``;
  return sql`
    seeds(seed_kind, seed_id) AS (
      ${input.seedSource}
    ),
    node_snapshot(kind, id, valid_from, valid_to, created_at, deleted_at) AS (
      ${nodes}
    ),
    same_assertions(a_kind, a_id, b_kind, b_id) AS (
      SELECT a_kind, a_id, b_kind, b_id FROM (${assertions}) identity_assertions
    ),
    identity_edges(a_kind, a_id, b_kind, b_id) AS (
      SELECT a_kind, a_id, b_kind, b_id FROM same_assertions
      UNION ALL
      SELECT b_kind, b_id, a_kind, a_id FROM same_assertions
      ${sameIdEdges}
    ),
    identity_members(seed_kind, seed_id, kind, id) AS (
      SELECT seeds.seed_kind, seeds.seed_id, seeds.seed_kind, seeds.seed_id
      FROM seeds
      JOIN node_snapshot n
        ON n.kind = seeds.seed_kind AND n.id = seeds.seed_id
      WHERE ${identityNodeVisibilitySql(input.coordinate, "n")}
      UNION
      SELECT member.seed_kind, member.seed_id, edge.b_kind, edge.b_id
      FROM identity_members member
      JOIN identity_edges edge
        ON edge.a_kind = member.kind
       AND edge.a_id = member.id
    )
  `;
}
