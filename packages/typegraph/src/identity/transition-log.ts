/**
 * The identity transition log: an append-only annotation on the recorded
 * axis naming every event that changed an identity class's membership.
 *
 * This module owns the shape, the encoder, the readers, and the diffing
 * predicate that turns "before" and "after" structural-class maps into the
 * minimal exhaustive set of transition rows — the single owner every note
 * site (assert, retract, fold, detach, window-end, kind-drop,
 * schema-transition, reconcile) calls into rather than re-deriving.
 *
 * It does NOT own membership. A transition row carries no members before, no
 * members after, and no delta — see `historicalIdentityReconstructionCtes`
 * (historical-sql.ts) for the one and only owner of "who is in this class at
 * coordinate c". This module is an explanation layer over that truth, never
 * a second copy of it.
 */
import { requireTypeGraphRecordedRevision } from "../backend/capabilities/recorded-time-ownership";
import { type GraphDef } from "../core/define-graph";
import { ConfigurationError, IdentityReplayError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { getDialect } from "../query/dialect";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { storeRuntime } from "../store/runtime-port";
import { type Store } from "../store/store";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import {
  optionalIdentityTimestamp,
  toCanonicalIdentityTimestamp,
} from "./row-codec";
import { runIdentityMutation } from "./service-facade";
import { refKey } from "./service-read";
import { type IdentityServiceContext } from "./service-types";
import {
  executeIdentityStatement,
  identityChunkSize,
  type IdentityTarget,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";

/**
 * The nine exhaustive causes a materialized identity class can change under
 * (§2.3). Every writer that can move a member in or out of a class, or in or
 * out of coordinate visibility, notes through exactly one of these.
 */
export type IdentityTransitionCause =
  | "assert"
  | "retract"
  | "fold"
  | "detach"
  | "restore"
  | "window-end"
  | "kind-drop"
  | "schema-transition"
  | "reconcile";

/**
 * Decision provenance for a transition written under a governed merge apply.
 * Every field is optional and is evidence already in hand at the apply site;
 * nothing here is invented or recomputed at read time. `undefined` (the
 * default) means an ordinary API write with no governing decision.
 */
export type IdentityDecisionProvenance = Readonly<{
  policy?: string | undefined;
  branchId?: string | undefined;
  branchAncestry?: readonly string[] | undefined;
  mergePlanDigest?: string | undefined;
  reviewDigest?: string | undefined;
  sourceId?: string | undefined;
}>;

/** One buffered note, before it is assigned a transition id and flushed. */
export type IdentityTransitionNote = Readonly<{
  graphId: string;
  cause: IdentityTransitionCause;
  classRef: PlainNodeRef;
  priorClassRef?: PlainNodeRef | undefined;
  assertionIds: readonly string[];
  decision?: IdentityDecisionProvenance | undefined;
  validAt: string;
}>;

/** A note as a call site hands it to `noteTransition`: the session fills `graphId` and the ambient `decision`. */
export type IdentityTransitionDraft = Omit<
  IdentityTransitionNote,
  "graphId" | "decision"
>;

/**
 * One archived transition row as the interchange boundary hands it to
 * `importIdentityTransitionsIntoTarget` (`service-interchange-write.ts`) —
 * structurally identical to `InterchangeIdentityTransition`
 * (`interchange/types.ts`), the wire schema, exactly as `IdentityTransferAssertion`
 * mirrors `InterchangeIdentityAssertion`: two modules, two owners, one shape,
 * so a caller can pass a parsed wire row straight through with no adapter.
 */
export type IdentityTransitionTransfer = Readonly<{
  transitionId: string;
  cause: IdentityTransitionCause;
  recordedRevision: number;
  recordedAt: string;
  validAt: string;
  class: PlainNodeRef;
  priorClass?: PlainNodeRef | undefined;
  assertionIds: readonly string[];
  decision?: IdentityDecisionProvenance | undefined;
}>;

/** A persisted transition row, as read back from storage. */
export type IdentityTransitionRow = Readonly<{
  graph_id: string;
  transition_id: string;
  recorded_revision: number;
  recorded_at: string;
  valid_at: string;
  cause: IdentityTransitionCause;
  class_kind: string;
  class_id: string;
  prior_class_kind: string | undefined;
  prior_class_id: string | undefined;
  assertion_ids: readonly string[];
  decision: IdentityDecisionProvenance | undefined;
  tx_id: string | undefined;
  /** Set when an archival restore inserted this row; `undefined` for a row this graph's own live capture flush recorded. See {@link isRestoredTransitionRow}. */
  restored_at: string | undefined;
}>;

/** The class-change record `replaceAffectedClosure` / `mergeCurrentClasses` return to their caller. */
export type ClosureTransitionRecord = Readonly<{
  classRef: PlainNodeRef;
  priorClassRef?: PlainNodeRef | undefined;
}>;

function sameMemberSet(
  left: readonly PlainNodeRef[],
  right: readonly PlainNodeRef[],
): boolean {
  if (left.length !== right.length) return false;
  const rightKeys = new Set(right.map((member) => refKey(member)));
  return left.every((member) => rightKeys.has(refKey(member)));
}

/**
 * The exhaustive-diff predicate: given a member's OLD class (before a
 * structural mutation) and its NEW class (after), the one owner of "does this
 * count as a class-identity transition, and if so what does it name". retract,
 * fold, detach, kind-drop, and schema-transition all call this directly —
 * never a second inline spelling of the comparison.
 *
 * `assert`'s own site, `mergeCurrentClasses`, is §12's SANCTIONED second
 * owner, not an oversight: fusing two classes has both sides in hand
 * up front (never a snapshot-then-diff), so it derives its ONE resulting
 * record directly from `aClass[0]` / `bClass[0]` rather than calling this
 * predicate. It is a NARROWER decision than this function's general
 * before/after diff — "which one canonical survives a two-class fuse" — and
 * the two must not drift on that narrower question: this predicate's OWN
 * merge branch (`sameMemberSet` false, one canonical replacing another)
 * agrees today. A future change to either must keep them agreeing, since the
 * replay walk before/after equivalence (§9.3) depends on the record
 * `mergeCurrentClasses` emits carrying the same meaning this predicate's
 * would for the same fuse.
 *
 * A member is skipped ONLY when nothing about its class changed at all — same
 * canonical AND same member set. A canonical that survives unchanged while
 * the member SET shrank (e.g. the only other member of a two-member class was
 * hard-deleted, so nothing "became" a new label to carry the reverse hop) is
 * NOT redundant: proven by the exhaustiveness property test, which found a
 * live counterexample where skipping a same-canonical-but-shrunk member
 * dropped the only witness of a real membership change. The resulting record
 * is self-referential (`classRef === priorClassRef`) in that case — this
 * still lets a seed tracking that label discover the boundary via the
 * forward match, even with no reverse hop to lean on. A member whose old
 * class was never a real (>=2 member) closure row reports `priorClassRef:
 * undefined` ("the class did not exist").
 */
export function diffClosureTransitions(
  affected: readonly PlainNodeRef[],
  oldClassOf: ReadonlyMap<string, readonly PlainNodeRef[]>,
  newClassOf: ReadonlyMap<string, readonly PlainNodeRef[]>,
): readonly ClosureTransitionRecord[] {
  const seen = new Set<string>();
  const records: ClosureTransitionRecord[] = [];
  for (const member of affected) {
    const key = refKey(member);
    const oldClass = oldClassOf.get(key);
    if (oldClass === undefined) continue;
    const newClass = newClassOf.get(key);
    // Absent from the new state: the member no longer exists (e.g. a hard
    // delete removed it from the live population). Its own departure has no
    // "became" to name; a SURVIVING class-mate's own record (self-referential
    // when its canonical is unchanged, per the rule above) is what carries
    // this event, not a record keyed on the departed member itself.
    if (newClass === undefined) continue;
    const priorCanonical = requireDefined(oldClass[0]);
    const canonical = requireDefined(newClass[0]);
    if (
      refKey(priorCanonical) === refKey(canonical) &&
      sameMemberSet(oldClass, newClass)
    ) {
      continue;
    }
    const emittedPriorClassRef =
      oldClass.length >= 2 ? priorCanonical : undefined;
    // The dedupe key must be built from what is actually EMITTED (the
    // collapsed `priorClassRef`), not from `priorCanonical` before that
    // collapse: two members whose pre-collapse labels differ can both
    // collapse to the same `undefined` (both were singletons), and keying on
    // the raw label gave them distinct keys, emitting the same record twice.
    const dedupeKey = `${refKey(canonical)} ${
      emittedPriorClassRef === undefined ? "" : refKey(emittedPriorClassRef)
    }`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    records.push({
      classRef: canonical,
      priorClassRef: emittedPriorClassRef,
    });
  }
  return records;
}

/** Column names, in storage/INSERT/projection order — the single source both the column-list `SqlFragment` and the flush chunk-size math derive from. */
export const IDENTITY_TRANSITION_COLUMN_NAMES = [
  "graph_id",
  "transition_id",
  "recorded_revision",
  "recorded_at",
  "valid_at",
  "cause",
  "class_kind",
  "class_id",
  "prior_class_kind",
  "prior_class_id",
  "assertion_ids",
  "decision",
  "tx_id",
  "restored_at",
] as const;

/** Column list shared by the INSERT and every read projection. */
export const IDENTITY_TRANSITION_COLUMNS: SqlFragment = sql.raw(
  IDENTITY_TRANSITION_COLUMN_NAMES.join(", "),
);

function encodeJsonColumn(value: unknown): SqlFragment {
  return sql`${JSON.stringify(value)}`;
}

/** Parses a JSON column back into a value: PostgreSQL's jsonb driver hands back an already-parsed value; SQLite hands back the stored text. */
function decodeJsonColumn(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function decodeOptionalRef(
  kind: string | undefined,
  id: string | undefined,
): PlainNodeRef | undefined {
  if (kind === undefined || id === undefined) return undefined;
  return { kind, id };
}

/**
 * Builds one transition row's INSERT value tuple, in
 * {@link IDENTITY_TRANSITION_COLUMNS} order.
 *
 * `restoredAt` is `undefined` for every row the live capture flush writes
 * (`flush.ts`'s ONE call site) — a note this graph is recording about
 * itself. Archival restore (`importIdentityTransitionsIntoTarget`,
 * `service-interchange-write.ts`) is the only caller that ever passes a
 * value: every row it inserts is, by construction, foreign to this graph's
 * own timeline, regardless of what the wire payload carried.
 */
export function encodeIdentityTransitionRow(
  note: IdentityTransitionNote,
  revision: number,
  recordedAt: string,
  transitionId: string,
  restoredAt?: string,
): SqlFragment {
  return sql`
    (
        ${note.graphId},
        ${transitionId},
        ${revision},
        ${recordedAt},
        ${note.validAt},
        ${note.cause},
        ${note.classRef.kind},
        ${note.classRef.id},
        ${
          note.priorClassRef === undefined ?
            sql.raw("NULL")
          : sql`${note.priorClassRef.kind}`
        },
        ${
          note.priorClassRef === undefined ?
            sql.raw("NULL")
          : sql`${note.priorClassRef.id}`
        },
        ${encodeJsonColumn(note.assertionIds)},
        ${note.decision === undefined ? sql.raw("NULL") : encodeJsonColumn(note.decision)},
        ${sql.raw("NULL")},
        ${restoredAt === undefined ? sql.raw("NULL") : sql`${restoredAt}`}
      )
  `;
}

/**
 * Inserts pre-encoded transition-row value tuples (see
 * {@link encodeIdentityTransitionRow}) in bind-budget-sized batches through
 * the identity mutation write path.
 *
 * Archival restore's ONE writer (`importIdentityTransitionsIntoTarget`,
 * `service-interchange-write.ts`): unlike the recorded-capture flush path
 * (`flushIdentityTransitions`, `store/recorded-capture/flush.ts`, which
 * encodes fresh notes against a NEWLY allocated revision inside a
 * `TransactionBackend`), a restore carries rows whose revision, timestamp and
 * id are the SOURCE graph's own — already fully encoded — and runs through
 * `IdentityTarget`, the identity module's own write facet.
 *
 * `ON CONFLICT (graph_id, transition_id) DO NOTHING`: a restore is verbatim
 * (this function never renumbers), so a `transition_id` collision on the
 * same graph can only mean the archival document is being imported again —
 * `importGraph(..., { onConflict: "skip" })` re-run over the same archive,
 * or two archives sharing history. The colliding row is by construction the
 * same row, so silently keeping the one already there is correct; without
 * this clause the second import throws a raw driver UNIQUE-constraint error
 * that never reaches `ImportResult.errors`.
 */
export async function insertIdentityTransitionValues(
  target: IdentityTarget,
  schema: SqlSchema,
  values: readonly SqlFragment[],
): Promise<void> {
  if (values.length === 0) return;
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 0,
    maxItems: Number.MAX_SAFE_INTEGER,
    parametersPerItem: IDENTITY_TRANSITION_COLUMN_NAMES.length,
  });
  for (const valueChunk of chunk(values, chunkSize)) {
    await executeIdentityStatement(
      target,
      sql`
        INSERT INTO ${schema.identityTransitionsTable} (${IDENTITY_TRANSITION_COLUMNS})
        VALUES ${sql.join(valueChunk, sql`, `)}
        ON CONFLICT (graph_id, transition_id) DO NOTHING
      `,
    );
  }
}

type RawIdentityTransitionRow = Readonly<{
  graph_id: unknown;
  transition_id: unknown;
  recorded_revision: unknown;
  recorded_at: unknown;
  valid_at: unknown;
  cause: unknown;
  class_kind: unknown;
  class_id: unknown;
  prior_class_kind: unknown;
  prior_class_id: unknown;
  assertion_ids: unknown;
  decision: unknown;
  tx_id: unknown;
  restored_at: unknown;
}>;

function toRevisionNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new ConfigurationError(
    "Identity transition row carried a non-numeric recorded_revision.",
    { value },
  );
}

function asRowString(value: unknown, column: string): string {
  if (typeof value === "string") return value;
  throw new ConfigurationError(
    `Identity transition row column "${column}" was not a string.`,
    { column, typeofValue: typeof value },
  );
}

function asOptionalRowString(
  value: unknown,
  column: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return asRowString(value, column);
}

function normalizeIdentityTransitionRow(
  row: RawIdentityTransitionRow,
): IdentityTransitionRow {
  return {
    graph_id: asRowString(row.graph_id, "graph_id"),
    transition_id: asRowString(row.transition_id, "transition_id"),
    recorded_revision: toRevisionNumber(row.recorded_revision),
    // Both columns are `timestamp(..., { withTimezone: true }).notNull()` on
    // PostgreSQL (schema/postgres.ts), which node-postgres decodes to a JS
    // `Date` — exactly the case `toCanonicalIdentityTimestamp` exists to
    // handle (row-codec.ts), and the one every other identity relation
    // already decodes through. `asRowString` would throw on that Date and,
    // on a text-returning driver, would pass a non-ISO string through
    // uncanonicalized.
    recorded_at: toCanonicalIdentityTimestamp(row.recorded_at),
    valid_at: toCanonicalIdentityTimestamp(row.valid_at),
    cause: asRowString(row.cause, "cause") as IdentityTransitionCause,
    class_kind: asRowString(row.class_kind, "class_kind"),
    class_id: asRowString(row.class_id, "class_id"),
    prior_class_kind: asOptionalRowString(
      row.prior_class_kind,
      "prior_class_kind",
    ),
    prior_class_id: asOptionalRowString(row.prior_class_id, "prior_class_id"),
    assertion_ids: decodeJsonColumn(row.assertion_ids) as readonly string[],
    decision:
      row.decision === null || row.decision === undefined ?
        undefined
      : (decodeJsonColumn(row.decision) as IdentityDecisionProvenance),
    tx_id: asOptionalRowString(row.tx_id, "tx_id"),
    // `timestamp(..., { withTimezone: true })` on PostgreSQL, same as
    // `recorded_at`/`valid_at` above — decoded through the identity module's
    // one optional-timestamp owner rather than `asOptionalRowString`, which
    // would throw on the `Date` node-postgres hands back.
    restored_at: optionalIdentityTimestamp(row.restored_at),
  };
}

/**
 * Whether `row` was written by an archival restore rather than this graph's
 * own live capture flush. `identityReplay` uses this — never a comparison
 * against `recorded_revision` — to decide whether a row may be paired with a
 * membership snapshot reconstructed on THIS graph's historical reader: a
 * restored row's revision is minted by the SOURCE graph's own clock, which
 * interleaves arbitrarily with this graph's, so no numeric floor can
 * separate "restored" from "native" the way this per-row marker does.
 */
export function isRestoredTransitionRow(row: IdentityTransitionRow): boolean {
  return row.restored_at !== undefined;
}

/** `IdentityTransitionRow` decoded to its `classRef`, for the replay seed-lineage walk. */
export function transitionClassRef(row: IdentityTransitionRow): PlainNodeRef {
  return { kind: row.class_kind, id: row.class_id };
}

/** `IdentityTransitionRow` decoded to its `priorClassRef`, or `undefined` when the row names none. */
export function transitionPriorClassRef(
  row: IdentityTransitionRow,
): PlainNodeRef | undefined {
  return decodeOptionalRef(row.prior_class_kind, row.prior_class_id);
}

/**
 * Converts a stored transition row to the camelCase, plain-ref shape
 * archival interchange transfers — {@link IdentityTransitionTransfer} — built
 * from the same `transitionClassRef` / `transitionPriorClassRef` decoders
 * `replay.ts`'s `publicTransition` uses, so the two conversions can never
 * disagree about which columns name the class and prior class.
 */
export function toTransitionTransfer(
  row: IdentityTransitionRow,
): IdentityTransitionTransfer {
  const priorClass = transitionPriorClassRef(row);
  return {
    transitionId: row.transition_id,
    cause: row.cause,
    recordedRevision: row.recorded_revision,
    recordedAt: row.recorded_at,
    validAt: row.valid_at,
    class: transitionClassRef(row),
    ...(priorClass === undefined ? {} : { priorClass }),
    assertionIds: row.assertion_ids,
    ...(row.decision === undefined ? {} : { decision: row.decision }),
  };
}

export type IdentityTransitionReadScope = Readonly<{
  classRefs: readonly PlainNodeRef[];
  limit: number;
}>;

/**
 * Reads every transition row whose `class` OR `prior class` names one of
 * `scope.classRefs` — the forward AND reverse lineage hop the replay
 * fixed-point walk needs in one query — ordered by recorded revision then by
 * transition id, so the result is DETERMINISTIC and stable across repeated
 * reads of the same committed rows.
 *
 * NOT insertion order: `transition_id` is a random `nanoid` (`generateId()`,
 * `flush.ts`), so two notes buffered at the SAME recorded revision can sort
 * either way relative to each other here, regardless of which was written
 * first. Nothing depends on their relative order today — every note sharing
 * one boundary shares the same `before`/`after` step in replay — but a
 * future reader that does must not assume this ordering reflects buffering
 * order.
 *
 * TAKES NO RECORDED-REVISION BOUNDS, on purpose. Its one caller is replay's
 * fixed-point lineage walk, whose seed set has to reach every class name the
 * node ever carried — and the note that teaches the walk a name routinely
 * sits ABOVE the window the caller asked about, because the walk starts at
 * the node's CURRENT canonical and hops backwards through `priorClass`. A
 * bounded read cut exactly those hops. The caller's `fromRecorded` /
 * `toRecorded` are applied once, to the converged lineage, by `replay.ts`.
 *
 * `scope.classRefs` is chunked through the shared bind-budget helper (each
 * reference costs four bind parameters: kind+id in the forward match, kind+id
 * in the reverse match) exactly as every other identity OR-list is
 * (`deleteAssertionsTouchingKinds`, `loadCurrentStructuralClasses`) — a wide
 * lineage must hit a typed refusal, never the driver's own opaque
 * bind-variable-limit error. Each chunk is read with the full `scope.limit`
 * and the merged, deduplicated rows are re-sorted and re-truncated to that
 * same limit, so chunking never changes the result a single unchunked query
 * would have returned.
 */
export async function readIdentityTransitions(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  scope: IdentityTransitionReadScope,
): Promise<readonly IdentityTransitionRow[]> {
  if (scope.classRefs.length === 0) return [];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 4,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 4,
  });
  if (scope.classRefs.length > chunkSize) {
    const matched = new Map<string, IdentityTransitionRow>();
    for (const refChunk of chunk(scope.classRefs, chunkSize)) {
      const rows = await readIdentityTransitions(target, schema, graphId, {
        ...scope,
        classRefs: refChunk,
      });
      for (const row of rows) matched.set(row.transition_id, row);
    }
    return [...matched.values()]
      .toSorted((left, right) =>
        left.recorded_revision === right.recorded_revision ?
          compareCodePoints(left.transition_id, right.transition_id)
        : left.recorded_revision - right.recorded_revision,
      )
      .slice(0, scope.limit);
  }
  // Exact-pair OR lists rather than two independent IN-lists: an IN-list per
  // column would match the cross product of unrelated kind/id pairs.
  const classMatches = sql.join(
    scope.classRefs.map(
      (ref) => sql`(class_kind = ${ref.kind} AND class_id = ${ref.id})`,
    ),
    sql` OR `,
  );
  const priorMatches = sql.join(
    scope.classRefs.map(
      (ref) =>
        sql`(prior_class_kind = ${ref.kind} AND prior_class_id = ${ref.id})`,
    ),
    sql` OR `,
  );
  const rows = await target.execute<RawIdentityTransitionRow>(
    asCompiledRowsSql(sql`
      SELECT ${IDENTITY_TRANSITION_COLUMNS}
      FROM ${schema.identityTransitionsTable}
      WHERE graph_id = ${graphId}
        AND (${classMatches} OR ${priorMatches})
      ORDER BY recorded_revision ASC, transition_id ASC
      LIMIT ${scope.limit}
    `),
  );
  return rows.map((row) => normalizeIdentityTransitionRow(row));
}

/** A (recorded revision, transition id) keyset cursor, ordering ties by the transition id. */
export type IdentityTransitionCursor = Readonly<{
  recordedRevision: number;
  transitionId: string;
}>;

export type IdentityTransitionPage = Readonly<{
  transitions: readonly IdentityTransitionRow[];
  nextAfter?: IdentityTransitionCursor | undefined;
  done: boolean;
}>;

/**
 * Pages every RETAINED transition row for `graphId`, ordered by
 * `(recorded_revision, transition_id)` ascending — the archival interchange
 * export's sole reader.
 *
 * Unlike {@link readIdentityTransitions} (scoped by class-key lineage, for
 * replay's fixed-point walk), this reader takes no `classRefs` scope AND no
 * `nodeKinds` scope: it always walks the whole graph's log, in export order.
 * `readIdentityAssertionPageAtTarget` (`interchange-read.ts`) is similarly
 * unscoped by class-key lineage, but — unlike this reader — DOES honor a
 * `nodeKinds`-filtered archival export; a `nodeKinds`-filtered archival
 * export therefore still carries transitions naming excluded kinds (see
 * `export.ts`'s call site and identity.md's "Archival transitions and the
 * retention watermark"). `transition_id` is a random nanoid, so the tie-break
 * goes through the same `binaryText` collation-safety seam that reader uses
 * for assertion ids: left bare, `ORDER BY transition_id` sorts under the
 * column's collation, which is locale-dependent on PostgreSQL and would page
 * mixed-case ids differently than SQLite's code-point order.
 */
export async function readIdentityTransitionPageForInterchange(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  options: Readonly<{
    after?: IdentityTransitionCursor | undefined;
    limit: number;
  }>,
): Promise<IdentityTransitionPage> {
  const transitionIdKey = getDialect(target.dialect).binaryText(
    sql`transition_id`,
  );
  const cursorFilter =
    options.after === undefined ?
      sql``
    : sql`
      AND (
        recorded_revision > ${options.after.recordedRevision}
        OR (
          recorded_revision = ${options.after.recordedRevision}
          AND ${transitionIdKey} > ${options.after.transitionId}
        )
      )
    `;
  const rows = await target.execute<RawIdentityTransitionRow>(
    asCompiledRowsSql(sql`
      SELECT ${IDENTITY_TRANSITION_COLUMNS}
      FROM ${schema.identityTransitionsTable}
      WHERE graph_id = ${graphId}
        ${cursorFilter}
      ORDER BY recorded_revision ASC, ${transitionIdKey} ASC
      LIMIT ${options.limit}
    `),
  );
  const transitions = rows.map((row) => normalizeIdentityTransitionRow(row));
  const last = transitions.at(-1);
  return {
    transitions,
    ...(last === undefined ?
      {}
    : {
        nextAfter: {
          recordedRevision: last.recorded_revision,
          transitionId: last.transition_id,
        },
      }),
    done: rows.length < options.limit,
  };
}

type RawNativeTransitionExistsRow = Readonly<{ transition_id: unknown }>;

/**
 * Whether `graphId` already has at least one NATIVE (non-restored) identity
 * transition row — one this graph itself recorded through the live capture
 * flush, as opposed to one an archival restore inserted verbatim.
 *
 * Archival restore (`importIdentityTransitionsIntoTarget`,
 * `service-interchange-write.ts`) consults this BEFORE deciding whether to
 * advance the retention watermark: a graph that already has its own retained
 * history has honest boundaries the restore never touched, and stamping a
 * restore-derived floor over them would misreport `truncatedBefore` (or the
 * `IDENTITY_REPLAY_HISTORY_TRUNCATED` refusal) for classes the restore had
 * nothing to do with. A graph with no native rows yet — fresh, or one whose
 * only transitions so far are themselves restored — has nothing of its own
 * for a floor to misclassify, so the restore is free to set one.
 */
export async function hasNativeIdentityTransitions(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<boolean> {
  const rows = await target.execute<RawNativeTransitionExistsRow>(
    asCompiledRowsSql(sql`
      SELECT transition_id
      FROM ${schema.identityTransitionsTable}
      WHERE graph_id = ${graphId} AND restored_at IS NULL
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/** Reads a graph's transition-retention watermark; `0` when nothing has been pruned. */
async function readTransitionRetention(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<number> {
  const details = await readTransitionRetentionDetails(target, schema, graphId);
  return details.prunedBeforeRevision;
}

type RawRetentionDetailsRow = Readonly<{
  pruned_before_revision: unknown;
  pruned_at: unknown;
}>;

/**
 * The retention watermark AND the wall time the prune that set it ran at —
 * the latter is the prune operation's own instant, not the original commit
 * time of the pruned revision (which pruning destroys), but is the only
 * wall-time evidence retained once that history is gone. Used only to name a
 * `truncatedBefore` / `IDENTITY_REPLAY_HISTORY_TRUNCATED` boundary.
 */
export async function readTransitionRetentionDetails(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<Readonly<{ prunedBeforeRevision: number; prunedAt: string }>> {
  const rows = await target.execute<RawRetentionDetailsRow>(
    asCompiledRowsSql(sql`
      SELECT pruned_before_revision, pruned_at
      FROM ${schema.identityTransitionRetentionTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const row = rows[0];
  if (row === undefined) return { prunedBeforeRevision: 0, prunedAt: nowIso() };
  return {
    prunedBeforeRevision: toRevisionNumber(row.pruned_before_revision),
    // `pruned_at` is `timestamp(..., { withTimezone: true }).notNull()` on
    // PostgreSQL (schema/postgres.ts), the exact column shape
    // `normalizeIdentityTransitionRow` above decodes `recorded_at`/`valid_at`
    // through `toCanonicalIdentityTimestamp` for — node-postgres returns a JS
    // `Date`, and a text-returning driver returns a non-ISO string that must
    // still be canonicalized. `asRowString` would throw on the former and
    // pass the latter through uncanonicalized.
    prunedAt: toCanonicalIdentityTimestamp(row.pruned_at),
  };
}

/** The `IdentityReplayError` a store without `history: true` raises for every replay-family operation. */
export function identityReplayRequiresHistoryError(
  graphId: string,
): IdentityReplayError {
  return new IdentityReplayError(
    "Identity replay requires the store to be opened with history: true.",
    { code: "IDENTITY_REPLAY_REQUIRES_HISTORY", graphId },
    {
      suggestion:
        "Open the store with createStore(graph, backend, { history: true }); the transition log annotates the recorded axis and has nothing to annotate without it.",
    },
  );
}

/**
 * Writes a graph's transition-retention watermark — the ONE owner of this
 * INSERT ... ON CONFLICT, shared by `pruneIdentityTransitionsForContext`
 * (which pairs it with deleting the rows it now covers) and archival restore
 * (`importIdentityTransitionsIntoTarget`, `service-interchange-write.ts`,
 * which sets it to the highest restored revision + 1 without deleting
 * anything — a restore into a fresh graph has nothing there to delete). The
 * `WHERE` guard makes the write itself monotonic: a `resolvedWatermark` at or
 * below what is already stored is a no-op, so neither caller needs its own
 * read-compare-write race guard beyond the one each already has for its own
 * return value (prune's `pruned` count, restore's `truncatedBefore` honesty).
 */
export async function writeIdentityTransitionRetentionWatermark(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  resolvedWatermark: number,
  at: string,
): Promise<void> {
  await executeIdentityStatement(
    target,
    sql`
      INSERT INTO ${schema.identityTransitionRetentionTable} (
        graph_id, pruned_before_revision, pruned_at
      ) VALUES (${graphId}, ${resolvedWatermark}, ${at})
      ON CONFLICT (graph_id) DO UPDATE
      SET pruned_before_revision = excluded.pruned_before_revision,
          pruned_at = excluded.pruned_at
      WHERE ${schema.identityTransitionRetentionTable}.pruned_before_revision < excluded.pruned_before_revision
    `,
  );
}

/**
 * Prunes retained explanation: deletes every transition row strictly below
 * the resolved revision and advances the retention watermark monotonically.
 * A prune at an earlier revision than the current watermark is a successful
 * no-op, never a rollback.
 *
 * Explicit operator action only — no automatic retention policy exists. Per
 * the ratified ruling, a prune does NOT advance the content revision (the
 * same non-advancing contract `rebuildIdentityClosure` follows): it destroys
 * retained explanation, never truth, so branch staleness must track truth,
 * not explanation.
 */
export async function pruneIdentityTransitionsForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  options: Readonly<{ beforeRecorded: string }>,
): Promise<Readonly<{ pruned: number; prunedBeforeRevision: number }>> {
  if (!ctx.historyEnabled) {
    throw identityReplayRequiresHistoryError(ctx.graphId);
  }
  const targetRevision = requireTypeGraphRecordedRevision(
    options.beforeRecorded,
    "beforeRecorded",
  );
  return runIdentityMutation(ctx, async (rawTarget) => {
    const existingWatermark = await readTransitionRetention(
      rawTarget,
      ctx.schema,
      ctx.graphId,
    );
    const resolvedWatermark = Math.max(existingWatermark, targetRevision);
    if (resolvedWatermark === existingWatermark) {
      return { pruned: 0, prunedBeforeRevision: existingWatermark };
    }
    const deleted = await rawTarget.execute<
      Readonly<{ transition_id: unknown }>
    >(
      asCompiledRowsSql(sql`
        DELETE FROM ${ctx.schema.identityTransitionsTable}
        WHERE graph_id = ${ctx.graphId}
          AND recorded_revision < ${resolvedWatermark}
        RETURNING transition_id
      `),
    );
    await writeIdentityTransitionRetentionWatermark(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      resolvedWatermark,
      nowIso(),
    );
    return { pruned: deleted.length, prunedBeforeRevision: resolvedWatermark };
  });
}

/**
 * Prunes a graph's retained identity transitions.
 *
 * An explicit operator action with no automatic retention policy — see
 * "Retention" in the identity documentation. Requires the store to be opened
 * with `history: true`.
 */
export async function pruneIdentityTransitions<G extends GraphDef>(
  store: Store<G>,
  options: Readonly<{ beforeRecorded: string }>,
): Promise<Readonly<{ pruned: number; prunedBeforeRevision: number }>> {
  const ctx = storeRuntime(store).identityContext();
  return pruneIdentityTransitionsForContext(ctx, options);
}
