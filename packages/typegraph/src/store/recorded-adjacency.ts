import { type GraphBackend } from "../backend/types";
import { parseRecordedInstant, type ReadCoordinate } from "../core/temporal";
import { ConfigurationError, ValidationError } from "../errors";
import {
  type RecordedReadBinding,
  recordedReadSqlSchema,
} from "../query/compiler/schema";
import { compileTemporalFilter } from "../query/compiler/temporal";
import { decodeCursor, encodeCursor } from "../query/cursor";
import { getDialect } from "../query/dialect";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { requireDefined } from "../utils/presence";
import { withRecordedRelationsPrecondition } from "../utils/sql-errors";
import {
  type Edge,
  type RecordedAdjacencyOptions,
  type RecordedAdjacencyPage,
} from "./types";

type Reference = Readonly<{ kind: string; id: string }>;
type Entry = Readonly<{ edge: Edge; neighbor: Reference }>;
type Phase = "out" | "in";
type Position = Readonly<{
  phase: Phase;
  recordedFrom: number;
  kind: string;
  id: string;
  historyId: string;
}>;
type Candidate = Readonly<{ row: Record<string, unknown>; position: Position }>;

function cursorMismatch(): ConfigurationError {
  return new ConfigurationError(
    "Recorded adjacency cursor does not match this read or its graph origin.",
    { code: "RECORDED_ADJACENCY_CURSOR_MISMATCH" },
  );
}

function decodePosition(cursor: string, scope: string): Position {
  const decoded = decodeCursor(cursor);
  const [phase, recordedFrom, kind, id, historyId] = decoded.vals;
  if (
    decoded.v !== 1 ||
    decoded.d !== "f" ||
    decoded.cols.length !== 5 ||
    decoded.cols[0] !== scope ||
    decoded.cols[1] !== "recordedFrom" ||
    decoded.cols[2] !== "kind" ||
    decoded.cols[3] !== "id" ||
    decoded.cols[4] !== "historyId" ||
    decoded.vals.length !== 5 ||
    typeof recordedFrom !== "number" ||
    !Number.isSafeInteger(recordedFrom) ||
    recordedFrom < 0 ||
    (phase !== "out" && phase !== "in") ||
    typeof kind !== "string" ||
    typeof id !== "string" ||
    typeof historyId !== "string"
  )
    throw cursorMismatch();
  try {
    return {
      phase,
      recordedFrom,
      kind: decodeURIComponent(kind),
      id: decodeURIComponent(id),
      historyId: decodeURIComponent(historyId),
    };
  } catch {
    throw cursorMismatch();
  }
}

function adjacencyDirection(value: unknown): "out" | "in" | "both" {
  if (value === "out" || value === "in" || value === "both") return value;
  throw new ValidationError("Invalid recorded adjacency direction.", {
    issues: [{ path: "direction", message: "Expected out, in, or both." }],
  });
}

/**
 * One indexed historical candidate window per direction, followed by visibility
 * checks inside the bounded window. LIMIT must stay INSIDE the derived table:
 * moving temporal/kind filtering before it makes a small page scan arbitrarily
 * many tombstones, old versions or excluded kinds. The revision-leading seek
 * also bounds the candidate set to the anchor, so future captures cannot
 * repartition pages or extend a traversal pinned to that anchor.
 */
export async function readRecordedAdjacency(
  params: Readonly<{
    graphId: string;
    backend: GraphBackend;
    binding: RecordedReadBinding | undefined;
    origin: () => Promise<string>;
    root: Reference;
    coordinate: ReadCoordinate;
    edgeKinds: readonly string[];
    options: RecordedAdjacencyOptions | undefined;
    toEdge: (row: Record<string, unknown>) => Edge;
  }>,
): Promise<RecordedAdjacencyPage<Entry>> {
  const { graphId, backend, binding, root, coordinate, options, toEdge } =
    params;
  if (binding?.kind !== "typegraph-capture" || !binding.carriesInterval) {
    throw new ConfigurationError(
      "Recorded adjacency requires TypeGraph-captured recorded relations and a durable revision origin.",
      { code: "RECORDED_ADJACENCY_UNSUPPORTED_SOURCE" },
    );
  }
  const limit = options?.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new ValidationError(
      "Recorded adjacency limit must be an integer between 1 and 1000.",
      {
        issues: [
          { path: "limit", message: "Must be an integer between 1 and 1000." },
        ],
      },
    );
  const direction = adjacencyDirection(options?.direction ?? "both");
  const revision = parseRecordedInstant(
    requireDefined(coordinate.recorded).asOf,
  );
  const schema = recordedReadSqlSchema(binding, revision);
  if (revision.kind !== "typegraph")
    throw new ConfigurationError(
      "Recorded adjacency requires a TypeGraph revision.",
      { code: "RECORDED_ADJACENCY_UNSUPPORTED_SOURCE" },
    );
  const kinds = [...new Set(params.edgeKinds)].toSorted();
  const origin = await params.origin();
  const scope = encodeURIComponent(
    JSON.stringify([
      "recorded-adjacency-v1",
      graphId,
      origin,
      root.kind,
      root.id,
      kinds,
      direction,
      coordinate.valid.mode,
      coordinate.valid.asOf,
      coordinate.recorded?.asOf,
    ]),
  );
  const after =
    options?.after === undefined ?
      undefined
    : decodePosition(options.after, scope);
  if (after !== undefined && direction !== "both" && after.phase !== direction)
    throw cursorMismatch();
  const phases: readonly Phase[] =
    direction === "both" ?
      after?.phase === "in" ?
        ["in"]
      : ["out", "in"]
    : [direction];
  const candidates: Candidate[] = [];
  const binaryText = getDialect(backend.dialect).binaryText;
  const temporal = (alias: string) =>
    compileTemporalFilter({
      mode: coordinate.valid.mode,
      asOf: coordinate.valid.asOf,
      recordedAsOf: coordinate.recorded?.asOf,
      tableAlias: alias,
      recordedReadBinding: binding,
    });
  function endpointVisible(alias: string, endpoint: "from" | "to") {
    const name = sql.raw(alias);
    const prefix = sql.raw(endpoint);
    return sql`
      EXISTS (
            SELECT 1 FROM (
              SELECT * FROM ${schema.nodesTable}
              WHERE graph_id = ${graphId} AND kind = e.${prefix}_kind AND id = e.${prefix}_id
                AND recorded_from <= ${revision.revision}
              ORDER BY recorded_from DESC
              LIMIT 1
            ) ${name} WHERE ${temporal(alias)}
          )
    `;
  }
  for (const phase of phases) {
    const endpoint = phase === "out" ? sql.raw("from") : sql.raw("to");
    const key = after?.phase === phase ? after : undefined;
    const remaining = limit + 1 - candidates.length;
    const rows = await withRecordedRelationsPrecondition(
      backend.execute<Record<string, unknown>>(
        asCompiledRowsSql(sql`
          SELECT e.*,
            CASE WHEN ${temporal("e")}
              ${direction === "both" && phase === "in" ? sql`AND NOT (e.from_kind = ${root.kind} AND e.from_id = ${root.id})` : sql.raw("")}
              AND ${endpointVisible("n", "from")}
              AND ${endpointVisible("m", "to")}
            THEN 1 ELSE 0 END AS adjacency_visible
          FROM (
            SELECT * FROM ${schema.edgesTable}
            WHERE graph_id = ${graphId} AND ${endpoint}_kind = ${root.kind} AND ${endpoint}_id = ${root.id}
          AND recorded_from <= ${revision.revision}
              ${key === undefined ? sql.raw("") : sql`AND (recorded_from, ${binaryText(sql`kind`)}, ${binaryText(sql`id`)}, ${binaryText(sql`history_id`)}) > (${key.recordedFrom}, ${key.kind}, ${key.id}, ${key.historyId})`}
            ORDER BY recorded_from ASC, ${binaryText(sql`kind`)} ASC, ${binaryText(sql`id`)} ASC, ${binaryText(sql`history_id`)} ASC
            LIMIT ${remaining}
          ) e
          ORDER BY e.recorded_from ASC, ${binaryText(sql`e.kind`)} ASC, ${binaryText(sql`e.id`)} ASC, ${binaryText(sql`e.history_id`)} ASC
        `),
      ),
      { graphId, surface: "recorded-adjacency" },
    );
    for (const row of rows) {
      const recordedFrom = Number(row["recorded_from"]);
      if (
        !Number.isSafeInteger(recordedFrom) ||
        recordedFrom < 0 ||
        typeof row["kind"] !== "string" ||
        typeof row["id"] !== "string" ||
        typeof row["history_id"] !== "string"
      )
        throw new ConfigurationError(
          "Invalid recorded adjacency candidate key.",
          { code: "RECORDED_RELATION_INVARIANT_VIOLATION" },
        );
      candidates.push({
        row,
        position: {
          phase,
          recordedFrom,
          kind: row["kind"],
          id: row["id"],
          historyId: row["history_id"],
        },
      });
    }
    if (candidates.length > limit) break;
  }
  // Detect origin rotation during the read as well as between pages.
  if ((await params.origin()) !== origin) throw cursorMismatch();
  const hasNextPage = candidates.length > limit;
  const window = candidates.slice(0, limit);
  const data: Entry[] = [];
  for (const candidate of window) {
    if (
      !kinds.includes(candidate.position.kind) ||
      Number(candidate.row["adjacency_visible"]) !== 1
    )
      continue;
    const edge = toEdge(candidate.row);
    data.push({
      edge,
      neighbor:
        candidate.position.phase === "out" ?
          { kind: edge.toKind, id: edge.toId }
        : { kind: edge.fromKind, id: edge.fromId },
    });
  }
  const last = window.at(-1)?.position;
  return {
    data,
    hasNextPage,
    nextCursor:
      hasNextPage && last !== undefined ?
        encodeCursor({
          v: 1,
          d: "f",
          cols: [scope, "recordedFrom", "kind", "id", "historyId"],
          vals: [
            last.phase,
            last.recordedFrom,
            encodeURIComponent(last.kind),
            encodeURIComponent(last.id),
            encodeURIComponent(last.historyId),
          ],
        })
      : undefined,
  };
}
