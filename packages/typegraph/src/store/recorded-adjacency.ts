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
import { compareCodePoints } from "../utils/compare";
import { sha256Hex } from "../utils/hash";
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

function cursorMismatch(): ValidationError {
  return new ValidationError(
    "Recorded adjacency cursor does not match this read or its graph origin.",
    {
      issues: [
        {
          path: "after",
          message:
            "Use a cursor from the same recorded adjacency read and graph origin.",
        },
      ],
    },
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
 * One indexed historical candidate window per selected kind and direction, followed by visibility
 * checks inside the bounded window. LIMIT must stay INSIDE the derived table:
 * moving temporal filtering before it makes a small page scan arbitrarily
 * many tombstones or old versions. Kind equality precedes the revision seek, which
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
  const candidateLimit = options?.candidateLimit ?? 100;
  if (
    !Number.isInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > 1000
  )
    throw new ValidationError(
      "Recorded adjacency candidateLimit must be an integer between 1 and 1000.",
      {
        issues: [
          {
            path: "candidateLimit",
            message: "Must be an integer between 1 and 1000.",
          },
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
  const kinds = [...new Set(params.edgeKinds)].toSorted((left, right) =>
    compareCodePoints(left, right),
  );
  const origin = await params.origin();
  const scope = await sha256Hex(
    JSON.stringify([
      "recorded-adjacency-v2",
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
    32,
  );
  const after =
    options?.after === undefined ?
      undefined
    : decodePosition(options.after, scope);
  if (
    after !== undefined &&
    (!kinds.includes(after.kind) ||
      (direction !== "both" && after.phase !== direction))
  )
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
  function nodeVisible(
    kind: ReturnType<typeof sql>,
    id: ReturnType<typeof sql>,
  ) {
    return sql`
      EXISTS (
            SELECT 1 FROM (
              SELECT * FROM ${schema.nodesTable}
              WHERE graph_id = ${graphId} AND kind = ${kind} AND id = ${id}
                AND recorded_from <= ${revision.revision}
              ORDER BY recorded_from DESC LIMIT 1
            ) n WHERE ${temporal("n")}
          )
    `;
  }
  async function finishOriginCheck() {
    if ((await params.origin()) !== origin)
      throw new ConfigurationError(
        "Graph origin changed during recorded adjacency read.",
        {
          code: "RECORDED_ADJACENCY_ORIGIN_CHANGED",
        },
      );
  }
  const empty = {
    data: [],
    hasNextPage: false,
    nextCursor: undefined,
  } as const;
  if (kinds.length === 0) {
    await finishOriginCheck();
    return empty;
  }
  const roots = await withRecordedRelationsPrecondition(
    backend.execute(
      asCompiledRowsSql(
        sql`SELECT 1 WHERE ${nodeVisible(sql`${root.kind}`, sql`${root.id}`)}`,
      ),
    ),
    { graphId, surface: "recorded-adjacency" },
  );
  if (roots.length === 0) {
    await finishOriginCheck();
    return empty;
  }
  windows: for (const phase of phases) {
    for (const kind of kinds) {
      if (after?.phase === phase && compareCodePoints(kind, after.kind) < 0)
        continue;
      const endpoint = phase === "out" ? sql.raw("from") : sql.raw("to");
      const key =
        after?.phase === phase && after.kind === kind ? after : undefined;
      const remaining = candidateLimit + 1 - candidates.length;
      const rows = await withRecordedRelationsPrecondition(
        backend.execute<Record<string, unknown>>(
          asCompiledRowsSql(sql`
            SELECT e.*,
              CASE WHEN ${temporal("e")}
                ${direction === "both" && phase === "in" ? sql`AND NOT (e.from_kind = ${root.kind} AND e.from_id = ${root.id})` : sql.raw("")}
                AND ${phase === "out" ? nodeVisible(sql`e.to_kind`, sql`e.to_id`) : nodeVisible(sql`e.from_kind`, sql`e.from_id`)}
              THEN 1 ELSE 0 END AS adjacency_visible
            FROM (
              SELECT * FROM ${schema.edgesTable}
              WHERE graph_id = ${graphId} AND ${endpoint}_kind = ${root.kind} AND ${endpoint}_id = ${root.id}
            AND ${binaryText(sql`kind`)} = ${kind}
            AND recorded_from <= ${revision.revision}
                ${key === undefined ? sql.raw("") : sql`AND (recorded_from, ${binaryText(sql`id`)}, ${binaryText(sql`history_id`)}) > (${key.recordedFrom}, ${key.id}, ${key.historyId})`}
              ORDER BY recorded_from ASC, ${binaryText(sql`id`)} ASC, ${binaryText(sql`history_id`)} ASC
              LIMIT ${remaining}
            ) e
            ORDER BY e.recorded_from ASC, ${binaryText(sql`e.id`)} ASC, ${binaryText(sql`e.history_id`)} ASC
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
      if (candidates.length > candidateLimit) break windows;
    }
  }
  // Detect origin rotation during the read as well as between pages.
  await finishOriginCheck();
  const hasNextPage = candidates.length > candidateLimit;
  const window = candidates.slice(0, candidateLimit);
  const data: Entry[] = [];
  for (const candidate of window) {
    if (Number(candidate.row["adjacency_visible"]) !== 1) continue;
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
