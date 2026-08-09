/**
 * The valid-time semantics every TypeGraph read path must obey, re-derived in
 * TypeScript from the rows the backend actually persisted.
 *
 * TypeGraph spells the visibility decision in three places this suite drives —
 * the SQL compiler (`src/query/compiler/temporal.ts`), the collections
 * predicate (`src/backend/drizzle/operations/collections.ts`) and the in-memory
 * `#temporalRowMatcher` that `getById`/`getByIds` use instead of SQL filtering
 * (`src/store/store.ts`). Two of those agreeing is not evidence, so none of them
 * is checked against another: all are checked against this model, which
 * formulates visibility as INTERVAL MEMBERSHIP over epoch milliseconds rather
 * than as a column predicate over text or `timestamptz`. Model plus those three
 * is what invariant I7 calls the four-way check. The model shares no code with
 * any of them and passes unchanged on `main`, so it is an equivalence check
 * against the semantics rather than a restatement of whatever the SQL happens
 * to do.
 *
 * OUT OF SCOPE, STATED. There is a further mirror of the same decision in
 * `isValidAt` (`src/provenance/index.ts`), and this suite does NOT exercise it:
 * it is module-private and reachable only through provenance role reads, which
 * are a different store surface with their own fixtures. Binding it wants its
 * own property against this model; until one exists, nothing here should be
 * read as covering it.
 *
 * It reads the ledger — `nodes`, `edges`, and (for a history store)
 * `recorded_nodes` / `recorded_edges` — back out of the backend and derives:
 *
 * - the interval a stored row is readable over, `NULL` bound = unbounded;
 * - which rows a bitemporal coordinate must return;
 * - the lower bound a write that resolves its own start is expected to store
 *   ({@link expectedStoredLowerBound} — the ONE function the #407 contract
 *   change edits);
 * - the cells where the tree is known to violate an invariant this workstream
 *   states ({@link KNOWN_CONTRACT_GAPS}).
 *
 * IMPORT DISCIPLINE. The model's independence is a property of what it may
 * import, and that is ratcheted by `tests/temporal-oracle-imports.test.ts`
 * (exact set equality over the import specifiers, a named-import check on
 * `src/utils/date`, and an assertion that the barrel import is `import type` so
 * it cannot carry a value however the barrel grows). Adding an import here
 * without adding it there is a test failure, deliberately.
 */
import type { GraphBackend } from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { canonicalizeDatabaseTimestamp } from "../../../src/utils/date";

// ============================================================
// Ledger snapshot
// ============================================================

/** A canonical fixed-width UTC ISO 8601 instant. */
export type Instant = string;

/** The four relations invariant I1 quantifies over. */
export type LedgerRelation =
  "nodes" | "edges" | "recordedNodes" | "recordedEdges";

/**
 * One stored row, normalized off the driver's raw representation (SQLite hands
 * back `TEXT`, PostgreSQL a `Date`) so the model compares the same values on
 * every backend.
 */
export type LedgerRow = Readonly<{
  relation: LedgerRelation;
  kind: string;
  id: string;
  validFrom: Instant | undefined;
  validTo: Instant | undefined;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | undefined;
  /** `undefined` on edges, whose relation carries no `version` column. */
  version: number | undefined;
  /** Endpoints; `undefined` on the node relations. */
  fromKey: RowKey | undefined;
  toKey: RowKey | undefined;
  /** Recorded-axis bounds; `undefined` on the live relations. */
  recordedFrom: number | undefined;
  recordedTo: number | undefined;
}>;

export type TemporalLedger = Readonly<
  Record<LedgerRelation, readonly LedgerRow[]>
>;

/** A `(kind, id)` identity, flattened for set comparison. */
export type RowKey = string;

/** Separator for composite `(kind, id)` keys; no kind can contain it. */
const ROW_KEY_SEPARATOR = "\u0000";

export function rowKeyOf(row: Readonly<{ kind: string; id: string }>): RowKey {
  return `${row.kind}${ROW_KEY_SEPARATOR}${row.id}`;
}

type RawRow = Readonly<Record<string, unknown>>;

/** A column the schema declares NOT NULL and textual, read back off the driver. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  throw new TypeError(
    `Ledger carried a non-string identifier: ${JSON.stringify(value)}`,
  );
}

function optionalInstant(value: unknown): Instant | undefined {
  if (value === null || value === undefined) return undefined;
  const canonical = canonicalizeDatabaseTimestamp(value);
  if (canonical === undefined) {
    throw new Error(
      `Ledger carried a non-canonical instant: ${JSON.stringify(value)}`,
    );
  }
  return canonical;
}

function requiredInstant(value: unknown): Instant {
  const instant = optionalInstant(value);
  if (instant === undefined) {
    throw new Error("Ledger carried a NULL where an instant is NOT NULL");
  }
  return instant;
}

function optionalCount(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const count =
    typeof value === "bigint" ? Number(value)
    : typeof value === "string" ? Number(value)
    : value;
  if (typeof count !== "number" || !Number.isSafeInteger(count)) {
    throw new TypeError(
      `Ledger carried a non-integer count: ${JSON.stringify(value)}`,
    );
  }
  return count;
}

function optionalEndpoint(kind: unknown, id: unknown): RowKey | undefined {
  if (kind === null || kind === undefined) return undefined;
  return rowKeyOf({ kind: asText(kind), id: asText(id) });
}

function toLedgerRow(relation: LedgerRelation, raw: RawRow): LedgerRow {
  return {
    relation,
    kind: asText(raw["kind"]),
    id: asText(raw["id"]),
    validFrom: optionalInstant(raw["valid_from"]),
    validTo: optionalInstant(raw["valid_to"]),
    createdAt: requiredInstant(raw["created_at"]),
    updatedAt: requiredInstant(raw["updated_at"]),
    deletedAt: optionalInstant(raw["deleted_at"]),
    version: optionalCount(raw["version"]),
    fromKey: optionalEndpoint(raw["from_kind"], raw["from_id"]),
    toKey: optionalEndpoint(raw["to_kind"], raw["to_id"]),
    recordedFrom: optionalCount(raw["recorded_from"]),
    recordedTo: optionalCount(raw["recorded_to"]),
  };
}

/** The store handle the ledger reader needs — a backend and a graph fence. */
export type LedgerSource = Readonly<{
  backend: GraphBackend;
  graphId: string;
}>;

/**
 * Reads every stored row the valid-time contract is defined over.
 *
 * Live rows are read with a raw `SELECT` rather than through a collection read,
 * because the collection reads are among the paths under test: the model must
 * see the tombstoned, the ended and the never-visible rows too.
 */
export async function readTemporalLedger(
  source: LedgerSource,
  options: Readonly<{ includeRecorded: boolean }>,
): Promise<TemporalLedger> {
  const schema = createSqlSchema(source.backend.tableNames);
  const nodes = await source.backend.execute<RawRow>(
    asCompiledRowsSql(sql`
      SELECT kind, id, valid_from, valid_to, created_at, updated_at,
             deleted_at, version
      FROM ${schema.nodesTable}
      WHERE graph_id = ${source.graphId}
    `),
  );
  const edges = await source.backend.execute<RawRow>(
    asCompiledRowsSql(sql`
      SELECT kind, id, from_kind, from_id, to_kind, to_id,
             valid_from, valid_to, created_at, updated_at, deleted_at
      FROM ${schema.edgesTable}
      WHERE graph_id = ${source.graphId}
    `),
  );
  const recordedNodes =
    options.includeRecorded ?
      await source.backend.execute<RawRow>(
        asCompiledRowsSql(sql`
          SELECT kind, id, valid_from, valid_to, created_at, updated_at,
                 deleted_at, version, recorded_from, recorded_to
          FROM ${schema.recordedNodesTable}
          WHERE graph_id = ${source.graphId}
        `),
      )
    : [];
  const recordedEdges =
    options.includeRecorded ?
      await source.backend.execute<RawRow>(
        asCompiledRowsSql(sql`
          SELECT kind, id, valid_from, valid_to, created_at, updated_at,
                 deleted_at, recorded_from, recorded_to
          FROM ${schema.recordedEdgesTable}
          WHERE graph_id = ${source.graphId}
        `),
      )
    : [];
  return {
    nodes: nodes.map((raw) => toLedgerRow("nodes", raw)),
    edges: edges.map((raw) => toLedgerRow("edges", raw)),
    recordedNodes: recordedNodes.map((raw) =>
      toLedgerRow("recordedNodes", raw),
    ),
    recordedEdges: recordedEdges.map((raw) =>
      toLedgerRow("recordedEdges", raw),
    ),
  };
}

/**
 * Every live row, nodes then edges — the scope of the read-side properties,
 * which quantify over what a live read can return. The STORAGE invariants I1
 * and I1b are stated over {@link allLedgerRows} instead: `recorded_nodes` /
 * `recorded_edges` are bound by an independent binder of the same columns
 * (`src/store/recorded-capture/relations.ts`), so leaving them out would check
 * one of the two write paths I1 quantifies over.
 */
export function liveLedgerRows(ledger: TemporalLedger): readonly LedgerRow[] {
  return [...ledger.nodes, ...ledger.edges];
}

/** Every row this library wrote, live and recorded — invariant I1's full scope. */
export function allLedgerRows(ledger: TemporalLedger): readonly LedgerRow[] {
  return [
    ...ledger.nodes,
    ...ledger.edges,
    ...ledger.recordedNodes,
    ...ledger.recordedEdges,
  ];
}

// ============================================================
// Interval algebra — visibility as membership, not as a predicate
// ============================================================

/**
 * An unbounded endpoint: the column stored `NULL`. A symbol rather than a
 * string, so `Instant | Unbounded` stays a real union — an `Instant` IS a
 * string, and any string sentinel would be absorbed by it.
 */
export const UNBOUNDED: unique symbol = Symbol("unbounded");

export type Unbounded = typeof UNBOUNDED;

export type VisibilityInterval = Readonly<{
  lower: Instant | Unbounded;
  upper: Instant | Unbounded;
}>;

function epochOf(instant: Instant): number {
  const milliseconds = new Date(instant).getTime();
  if (Number.isNaN(milliseconds)) {
    throw new TypeError(`Not an instant: ${instant}`);
  }
  return milliseconds;
}

function lowerEpoch(interval: VisibilityInterval): number {
  return interval.lower === UNBOUNDED ?
      Number.NEGATIVE_INFINITY
    : epochOf(interval.lower);
}

function upperEpoch(interval: VisibilityInterval): number {
  return interval.upper === UNBOUNDED ?
      Number.POSITIVE_INFINITY
    : epochOf(interval.upper);
}

/** The half-open interval `[valid_from, valid_to)` a stored row is readable over. */
export function intervalOf(
  row: Readonly<{
    validFrom: Instant | undefined;
    validTo: Instant | undefined;
  }>,
): VisibilityInterval {
  return {
    lower: row.validFrom ?? UNBOUNDED,
    upper: row.validTo ?? UNBOUNDED,
  };
}

/** Whether `at` falls inside the half-open interval. */
export function intervalContains(
  interval: VisibilityInterval,
  at: Instant,
): boolean {
  const instant = epochOf(at);
  return lowerEpoch(interval) <= instant && instant < upperEpoch(interval);
}

/**
 * Whether the interval is readable at NO instant — inverted OR zero width.
 * This is the model's own emptiness decision; the library's future
 * `isEmptyValidityWindow` is checked AGAINST it rather than shared with it.
 */
export function intervalIsEmpty(interval: VisibilityInterval): boolean {
  return lowerEpoch(interval) >= upperEpoch(interval);
}

/** Whether the interval is backwards — the strict refusal shape. */
export function intervalIsInverted(interval: VisibilityInterval): boolean {
  return lowerEpoch(interval) > upperEpoch(interval);
}

/**
 * Invariant I1, per row: no stored window is backwards. Stated over the
 * interval rather than over the columns so a `NULL` bound is unbounded by
 * construction rather than by a special case.
 */
export function rowSatisfiesOrderedWindow(row: LedgerRow): boolean {
  return !intervalIsInverted(intervalOf(row));
}

/**
 * A bitemporal read coordinate. `revision` pins the recorded axis; the mode and
 * `asOf` pin the valid axis, exactly as `compileTemporalFilter` splits them.
 */
export type TemporalCoordinate =
  | Readonly<{ mode: "asOf"; asOf: Instant; revision?: number }>
  | Readonly<{ mode: "includeEnded"; revision?: number }>
  | Readonly<{ mode: "includeTombstones"; revision?: number }>;

/** Whether one stored row must be returned at `coordinate`. */
export function rowVisibleAt(
  row: LedgerRow,
  coordinate: TemporalCoordinate,
): boolean {
  if (coordinate.revision !== undefined) {
    const { recordedFrom, recordedTo } = row;
    if (recordedFrom === undefined || recordedTo === undefined) return false;
    if (recordedFrom > coordinate.revision) return false;
    if (coordinate.revision >= recordedTo) return false;
  }
  switch (coordinate.mode) {
    case "includeTombstones": {
      return true;
    }
    case "includeEnded": {
      return row.deletedAt === undefined;
    }
    case "asOf": {
      if (row.deletedAt !== undefined) return false;
      return intervalContains(intervalOf(row), coordinate.asOf);
    }
  }
}

/** The identities a read at `coordinate` must return, sorted for comparison. */
export function visibleAt(
  rows: readonly LedgerRow[],
  coordinate: TemporalCoordinate,
): readonly RowKey[] {
  return rows
    .filter((row) => rowVisibleAt(row, coordinate))
    .map((row) => rowKeyOf(row))
    .toSorted();
}

/**
 * The edges a one-hop traversal must return at `coordinate`: the edge visible
 * AND both endpoints visible. A compiled traversal applies the same temporal
 * filter to the edge and to both node CTEs, so the model states the conjunction
 * rather than the edge alone — which is what lets the traversal be compared
 * against the collection reads, whose filter is the edge row alone.
 */
export function traversableEdgesAt(
  ledger: TemporalLedger,
  coordinate: TemporalCoordinate,
): readonly RowKey[] {
  const visibleNodes = new Set(visibleAt(ledger.nodes, coordinate));
  return ledger.edges
    .filter(
      (edge) =>
        rowVisibleAt(edge, coordinate) &&
        edge.fromKey !== undefined &&
        edge.toKey !== undefined &&
        visibleNodes.has(edge.fromKey) &&
        visibleNodes.has(edge.toKey),
    )
    .map((edge) => rowKeyOf(edge))
    .toSorted();
}

// ============================================================
// The stored lower bound
// ============================================================

/**
 * The lower bound a write that STAMPS its own start is expected to store.
 *
 * TODAY'S CONTRACT, as `resolveValidFrom`
 * (`src/backend/drizzle/operations/shared.ts`) and its private twin in
 * `src/backend/drizzle/trusted-import.ts` implement it:
 *
 *  - a stated `null`  → no lower bound (a confirmed open-left window);
 *  - a stated string  → that bound, the caller's own assertion;
 *  - nothing stated   → the write instant, UNCONDITIONALLY.
 *
 * That last cell is issue #407: with a stated `validTo` at or before the write
 * instant it stores a window readable at no coordinate. This function is the
 * ONE place the model encodes it, so the #407 contract change is a one-function
 * edit here — and the cells it is currently wrong about are declared in
 * {@link KNOWN_CONTRACT_GAPS} rather than smoothed over.
 *
 * The write instant is a PARAMETER, never a clock read, which is what lets a
 * caller check the decision against the instant the row actually carries.
 */
export function expectedStoredLowerBound(
  statedValidFrom: Instant | null | undefined,

  // ignores the upper bound; the A2' rule this becomes consults it, and the
  // parameter is stated now so the signature does not change with the contract.
  _statedValidTo: Instant | undefined,
  writeInstant: Instant,
): Instant | undefined {
  if (statedValidFrom === null) return undefined;
  if (statedValidFrom !== undefined) return statedValidFrom;
  return writeInstant;
}

// ============================================================
// Known contract gaps
// ============================================================

/**
 * The op shapes the history generator can emit. A gap entry removes shapes from
 * this vocabulary; deleting the entry puts them back, in the same diff that
 * closes the cell.
 */
export const TEMPORAL_OP_SHAPES = [
  "create-open",
  "create-stated-window",
  "create-scheduled-end",
  "create-born-ended",
  "create-on-tombstone",
  "create-on-tombstone-born-ended",
  "update-props",
  "update-scheduled-end",
  "soft-delete",
  "upsert-resurrect",
  "upsert-resurrect-born-ended",
  "upsert-unchanged",
  "bulk-create",
  "bulk-upsert-repeated-id",
  "edge-create-open",
  "edge-create-stated-window",
  "edge-create-scheduled-end",
  "edge-create-born-ended",
  "edge-soft-delete",
] as const;

export type TemporalOpShape = (typeof TEMPORAL_OP_SHAPES)[number];

/**
 * One cell where the tree is known to violate an invariant this workstream
 * states. Each entry does three things: it NAMES the invariant it excuses, it
 * REMOVES the op shapes that reach the cell from the generator so the script
 * cannot hit it, and it carries a STILL-REPRODUCES test.
 *
 * Each entry is deleted by the diff that measurably closes it — never later —
 * and `closedBy` records which diff that is.
 */
export type KnownContractGap = Readonly<{
  id: string;
  /** The invariants this cell violates, so the table names the whole excuse. */
  invariants: readonly string[];
  closedBy: "batch-2" | "batch-3";
  /**
   * The op shapes withheld from the generator while this gap stands. Stated
   * over what the script SAYS, never over what it observes, so the restriction
   * is deterministic rather than outcome-dependent.
   */
  restrictedOpShapes: readonly TemporalOpShape[];
  /** The title of the deterministic example test that still reproduces it. */
  reproducedBy: string;
}>;

/**
 * Restriction R-A removes the born-ended CREATE on a fresh id, R-B the same
 * shape on a tombstoned id, R-C the resurrecting `upsertById` that names a lone
 * non-future `validTo`. R-A and R-B are stated for NODES AND EDGES alike: the
 * same insert builders stamp both relations, so leaving the edge shape emittable
 * would make P1 red for a cell the table claims to excuse.
 *
 * Because every exclusion is over an op SHAPE, the `validTo == write instant`
 * cell (which stores a zero-width window today — satisfying I1, violating I1b)
 * cannot be emitted either: a `validTo` drawn from the run's own write instants
 * is part of the same withheld shape. That is why two entries suffice for the
 * born-ended cell and no fake-timer machinery is needed inside the property.
 */
export const KNOWN_CONTRACT_GAPS = [
  {
    id: "born-ended-insert",
    invariants: ["I1", "I1b"],
    closedBy: "batch-2",
    restrictedOpShapes: ["create-born-ended", "edge-create-born-ended"],
    reproducedBy:
      "still reproduces: a born-ended create on a fresh id stores a window readable at no coordinate",
  },
  {
    id: "born-ended-on-tombstone",
    invariants: ["I1", "I1b"],
    closedBy: "batch-2",
    restrictedOpShapes: ["create-on-tombstone-born-ended"],
    reproducedBy:
      "still reproduces: a born-ended create on a tombstoned id stores a window readable at no coordinate",
  },
  {
    id: "resurrection-refusal-gap",
    invariants: ["I12"],
    closedBy: "batch-3",
    restrictedOpShapes: ["upsert-resurrect-born-ended"],
    reproducedBy:
      "still reproduces: one stated window, two outcomes — create succeeds on a tombstone where upsertById refuses",
  },
] as const satisfies readonly KnownContractGap[];

export type KnownContractGapId = (typeof KNOWN_CONTRACT_GAPS)[number]["id"];

/** Every op shape some standing gap withholds from the generator. */
export function restrictedOpShapes(): ReadonlySet<TemporalOpShape> {
  return new Set(
    KNOWN_CONTRACT_GAPS.flatMap((gap) => [...gap.restrictedOpShapes]),
  );
}

/** The op shapes the generator may emit against this tree. */
export function emittableOpShapes(): readonly TemporalOpShape[] {
  const withheld = restrictedOpShapes();
  return TEMPORAL_OP_SHAPES.filter((shape) => !withheld.has(shape));
}
