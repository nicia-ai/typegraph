import {
  ConfigurationError,
  InvalidEdgeWeightError,
  type InvalidEdgeWeightReason,
} from "../../errors";
import { compileKindFilter } from "../../query/compiler/predicate-utils";
import { jsonPointer } from "../../query/json-pointer";
import { sql } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import type { IterativeGraphOperation } from "./iterative-graph-operation";

/**
 * Largest accepted edge weight (~9.7e288). Auditing weights to this bound
 * makes accumulated overflow impossible rather than merely unlikely: a path
 * gains one working-table row per hop, so it has at most 2^53 hops, and
 * 2^53 · MAX_EDGE_WEIGHT stays far below Number.MAX_VALUE even after
 * float-addition rounding (the 2^64 divisor leaves an ~2000x margin). The
 * same margin covers PageRank's per-node sum of out-edge weights.
 * Without the bound, PostgreSQL's float8 addition would raise a raw 22003
 * overflow mid-round while SQLite silently saturated to Infinity.
 */
const MAX_EDGE_WEIGHT = Number.MAX_VALUE / 2 ** 64;

/**
 * Smallest accepted nonzero weight magnitude: the smallest IEEE 754 double
 * (5e-324). PostgreSQL stores smaller nonzero JSON numbers exactly in jsonb
 * and raises a raw underflow when the traversal casts them to float8, so
 * the audit rejects them with the typed error instead. SQLite's JSON parser
 * has already rounded such text to 0 before SQL can observe it — an
 * engine-level difference the audit cannot detect there.
 */
const MIN_EDGE_WEIGHT = Number.MIN_VALUE;

type WeightAuditRow = Readonly<{
  edge_id: string;
  edge_kind: string;
  weight_text: unknown;
  is_number: unknown;
  is_missing: unknown;
}>;

/**
 * Validates the weight options shared by every weighted algorithm. Run it
 * only when the caller selected a weight source; `algorithm` names the
 * public operation in the refusal.
 */
export function assertWeightOptions(
  algorithm: string,
  weightProperty: string,
  defaultWeight: number | undefined,
): void {
  if (typeof weightProperty !== "string" || weightProperty.length === 0) {
    throw new ConfigurationError(
      `${algorithm} weightProperty must be a non-empty string.`,
      { weightProperty },
    );
  }
  // The same upper bound the audit applies to stored weights: a default
  // above it would reopen the accumulated-overflow gap for missing-weight
  // edges the audit deliberately lets through.
  if (
    defaultWeight !== undefined &&
    (!Number.isFinite(defaultWeight) ||
      defaultWeight < 0 ||
      defaultWeight > MAX_EDGE_WEIGHT)
  ) {
    throw new ConfigurationError(
      `${algorithm} defaultWeight must be a non-negative number no greater than ${MAX_EDGE_WEIGHT}, got ${String(defaultWeight)}.`,
      { defaultWeight, maximum: MAX_EDGE_WEIGHT },
    );
  }
}

/**
 * Fails fast on the first visible edge of the selected kinds whose weight
 * violates the weighted-algorithm contract: a non-numeric value, a negative
 * or out-of-range number, or a missing value with no configured default.
 * Runs inside the operation's snapshot before any round, so a weighted call
 * either observes a fully valid weight domain or throws — the expansion's
 * own weight cast never sees a value it could silently mangle.
 *
 * The audit deliberately covers every visible edge of the selected kinds,
 * not just edges the algorithm happens to reach or keep in scope:
 * reachability-dependent validation would make the error nondeterministic
 * in the data.
 */
export async function assertValidEdgeWeights(
  operation: IterativeGraphOperation,
  weightProperty: string,
  defaultWeight: number | undefined,
): Promise<void> {
  const { dialect } = operation.ctx;
  const pointer = jsonPointer([weightProperty]);
  const propsColumn = sql.raw("e.props");
  // The inner projection extracts the JSON path once per edge; the outer
  // violation predicate then works over plain projected columns. Composing
  // the checks directly over `e.props` would re-parse the JSON payload for
  // every predicate branch on the audit's full edge scan.
  //
  // Both type predicates are never-NULL by contract, so the multi-branch
  // violation predicate below stays two-valued.
  const isNumber = dialect.jsonPathIsNumber(propsColumn, pointer);
  const isMissing = dialect.jsonPathIsNull(propsColumn, pointer);
  const weightText = dialect.jsonExtractText(propsColumn, pointer);
  // CASE keeps the numeric extraction unreachable for non-numeric values:
  // PostgreSQL does not short-circuit OR/AND, and casting arbitrary text
  // would error before the audit could produce its typed report. The
  // extraction is jsonExtractNumber (PostgreSQL `numeric`), NOT the double
  // extraction the traversal uses: a JSON number beyond the float8 range
  // must reach the range check below instead of overflowing the cast.
  const weightNumber = sql`CASE WHEN ${isNumber} THEN ${dialect.jsonExtractNumber(propsColumn, pointer)} END`;
  const missingViolation =
    defaultWeight === undefined ?
      sql`audited.is_missing = 1`
    : dialect.booleanLiteral(false);
  const negativeViolation = sql`audited.is_number = 1 AND audited.weight_number < 0`;
  // CAST the bounds to NUMERIC so PostgreSQL compares in the arbitrary-
  // precision domain — a numeric-vs-float8 comparison would coerce the
  // out-of-range value to float8 and overflow before comparing. The lower
  // arm rejects sub-denormal magnitudes (float8 cast underflow on
  // PostgreSQL); on SQLite they parsed to exactly 0 and the arm cannot
  // fire, which is the declared engine caveat on MIN_EDGE_WEIGHT.
  const outOfRangeViolation = sql`audited.is_number = 1 AND (ABS(audited.weight_number) > CAST(${MAX_EDGE_WEIGHT} AS NUMERIC) OR (audited.weight_number <> 0 AND ABS(audited.weight_number) < CAST(${MIN_EDGE_WEIGHT} AS NUMERIC)))`;

  for (const edgeKinds of operation.edgeKindChunks) {
    const edgeKindFilter = compileKindFilter(sql.raw("e.kind"), edgeKinds);
    const rows = await operation.backend.execute<WeightAuditRow>(
      asCompiledRowsSql(sql`
        SELECT audited.edge_id, audited.edge_kind, audited.weight_text,
          audited.is_number, audited.is_missing
        FROM (
          SELECT e.id AS edge_id, e.kind AS edge_kind,
            ${weightText} AS weight_text,
            ${weightNumber} AS weight_number,
            CASE WHEN ${isNumber} THEN 1 ELSE 0 END AS is_number,
            CASE WHEN ${isMissing} THEN 1 ELSE 0 END AS is_missing
          FROM ${operation.schema.edgesTable} e
          WHERE e.graph_id = ${operation.ctx.graphId}
            AND ${edgeKindFilter}
            AND ${operation.edgeTemporalFilter}
        ) audited
        WHERE (${missingViolation})
          OR (audited.is_missing = 0 AND audited.is_number = 0)
          OR (${negativeViolation})
          OR (${outOfRangeViolation})
        ORDER BY ${dialect.binaryText(sql`audited.edge_id`)}
        LIMIT 1
      `),
    );
    const row = rows[0];
    if (row !== undefined) {
      throw createInvalidEdgeWeightError(row, weightProperty);
    }
  }
}

function createInvalidEdgeWeightError(
  row: WeightAuditRow,
  weightProperty: string,
): InvalidEdgeWeightError {
  const reason = resolveInvalidWeightReason(row);
  const value =
    reason === "missing" || row.weight_text === null ?
      undefined
    : formatWeightValue(row.weight_text);
  return new InvalidEdgeWeightError({
    edgeId: row.edge_id,
    edgeKind: row.edge_kind,
    property: weightProperty,
    reason,
    ...(value === undefined ? {} : { value }),
  });
}

function resolveInvalidWeightReason(
  row: WeightAuditRow,
): InvalidEdgeWeightReason {
  if (flagIsSet(row.is_missing)) return "missing";
  if (!flagIsSet(row.is_number)) return "non_numeric";
  // A numeric violation is either negative or outside the accepted
  // magnitude range; the sign distinguishes them (Number() of an oversized
  // magnitude yields ±Infinity, whose sign still holds).
  return Number(row.weight_text) < 0 ? "negative" : "out_of_range";
}

/** Coerces a driver-shaped 0/1 flag (number, bigint, or boolean) to boolean. */
function flagIsSet(value: unknown): boolean {
  return Number(value) !== 0;
}

/** Renders an extracted weight value for the error message. */
function formatWeightValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}
