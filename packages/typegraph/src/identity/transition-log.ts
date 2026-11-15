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
import {
  type RecordedTimeOwnership,
  requireTypeGraphRecordedRevision,
} from "../backend/capabilities/recorded-time-ownership";
import { type GraphAllocationOwner } from "../core/allocation-owner";
import { type GraphDef } from "../core/define-graph";
import {
  parseRecordedInstant,
  type RecordedInstant,
  recordedInstantWallTime,
} from "../core/temporal";
import {
  ConfigurationError,
  IdentityReplayError,
  type IdentityTransitionLogOperation,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { getDialect } from "../query/dialect";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { readGraphAllocationOwner } from "../store/allocation-owner";
import { assertRecordedAnchorOrigin } from "../store/recorded-anchor-origin";
import { readNextRecordedRevision } from "../store/recorded-capture";
import { storeRuntime } from "../store/runtime-port";
import { type Store } from "../store/store";
import { chunk } from "../utils/array";
import { compareCodePoints } from "../utils/compare";
import { requireDefined } from "../utils/presence";
import { decodeRevisionColumn } from "../utils/revision-column";
import { withIdentityTransitionRelationsPrecondition } from "../utils/sql-errors";
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
import { type IdentityAssertionStorageRow } from "./storage-types";

/**
 * The nine exhaustive causes a materialized identity class can change under.
 * Every writer that can move a member in or out of a class, or in or
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
  /**
   * Every member the record's class holds AFTER the change — which is every
   * member of a class it was fused from, and each piece of one it was split
   * into. Not persisted: it is what decides which assertions a note of this
   * record names ({@link transitionAssertionIds}).
   */
  members: readonly PlainNodeRef[];
}>;

/** What a transition note needs of an assertion row a write created, ended or removed. */
export type TransitionAssertionRow = Pick<
  IdentityAssertionStorageRow,
  "id" | "rel" | "a_kind" | "a_id" | "b_kind" | "b_id"
>;

/**
 * THE attribution of assertions to class changes: for each record, the ids
 * of the `same` assertions with an endpoint among that record's members, in
 * the order the assertions were given.
 *
 * A write that changes many classes at once (a bulk assert, a bulk
 * retraction, a kind drop) hands every assertion it touched; a record names
 * only those that touched ITS class. Naming the whole batch on every record
 * would make each one claim assertions about unrelated nodes, and would grow
 * the log with the square of the batch. A `different` assertion shapes the
 * separation relation, never a class, so no record names one.
 *
 * Indexed by endpoint once, so the cost is linear in members plus ids.
 */
export function transitionAssertionIds(
  records: readonly ClosureTransitionRecord[],
  assertions: readonly TransitionAssertionRow[],
): readonly (readonly string[])[] {
  const positionsByEndpoint = new Map<string, number[]>();
  for (const [position, assertion] of assertions.entries()) {
    if (assertion.rel !== "same") continue;
    for (const endpoint of [
      { kind: assertion.a_kind, id: assertion.a_id },
      { kind: assertion.b_kind, id: assertion.b_id },
    ]) {
      const key = refKey(endpoint);
      const positions = positionsByEndpoint.get(key) ?? [];
      positions.push(position);
      positionsByEndpoint.set(key, positions);
    }
  }
  return records.map((record) => {
    const positions = new Set<number>();
    for (const member of record.members) {
      for (const position of positionsByEndpoint.get(refKey(member)) ?? []) {
        positions.add(position);
      }
    }
    return [...positions]
      .toSorted((left, right) => left - right)
      .map((position) => requireDefined(assertions[position]).id);
  });
}

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
 * `assert`'s own site, `mergeCurrentClasses`, is the one sanctioned second
 * owner of this decision, not an oversight: fusing two classes has both sides in hand
 * up front (never a snapshot-then-diff), so it derives its ONE resulting
 * record directly from `aClass[0]` / `bClass[0]` rather than calling this
 * predicate. It is a NARROWER decision than this function's general
 * before/after diff — "which one canonical survives a two-class fuse" — and
 * the two must not drift on that narrower question: this predicate's OWN
 * merge branch (`sameMemberSet` false, one canonical replacing another)
 * agrees today. A future change to either must keep them agreeing, since the
 * replay walk's before/after equivalence depends on the record
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
  const recordsByKey = new Map<string, ClosureTransitionRecord>();
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
    // Several members can report one record, and every member of a class
    // reports the same class: the record keeps that class once, rather than
    // folding it in per member, which would cost the square of its size.
    if (recordsByKey.has(dedupeKey)) continue;
    recordsByKey.set(dedupeKey, {
      classRef: canonical,
      priorClassRef: emittedPriorClassRef,
      members: newClass,
    });
  }
  return [...recordsByKey.values()];
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

/**
 * Where a statement against the transition-log relations runs: the capture
 * flush that records notes, a read (`transitionsOf`, `replay`, archival
 * export), a prune, or an archival restore.
 */
export type IdentityTransitionLogSurface =
  | "capture-flush"
  | "transition-read"
  | "transition-prune"
  | "transition-restore";

/**
 * THE detection seam for a database that lacks the transition-log relations
 * (base-schema version 9): every statement against either relation runs
 * through it, so a read, a prune and a write on such a database all refuse
 * with the same typed `IDENTITY_TRANSITION_RELATIONS_MISSING` error rather
 * than a raw driver error for whichever statement happened to run first.
 * Only those statements are wrapped, so a missing relation of any OTHER kind
 * keeps its own refusal.
 */
export function withIdentityTransitionLogRelations<T>(
  schema: SqlSchema,
  dialect: string,
  surface: IdentityTransitionLogSurface,
  promise: Promise<T>,
): Promise<T> {
  return withIdentityTransitionRelationsPrecondition(
    promise,
    [
      schema.tables.identityTransitions,
      schema.tables.identityTransitionRetention,
    ],
    { dialect, surface },
  );
}

/**
 * THE ownership check for a recorded instant addressed to the transition log
 * (`fromRecorded`, `toRecorded`, a page cursor's position, a prune's
 * `beforeRecorded`): the same {@link assertRecordedAnchorOrigin} every
 * `asOfRecorded` read runs, so an instant another graph allocated, a legacy
 * or restored (unowned) instant, and an engine-native one are refused here
 * exactly as they are there, instead of being read as a revision on this
 * graph's axis. Returns the revision the caller came for.
 */
export function requireOwnedTransitionLogRevision(
  instant: string,
  surface: string,
  owner: GraphAllocationOwner | undefined,
  graphId: string,
): number {
  const revision = requireTypeGraphRecordedRevision(instant, surface);
  assertRecordedAnchorOrigin(
    parseRecordedInstant(instant, surface),
    owner,
    graphId,
  );
  return revision;
}

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
 * (this function never renumbers), so a `transition_id` collision with a row
 * already on the graph means the archival document is being imported again —
 * `importGraph(..., { onConflict: "skip" })` re-run over the same archive,
 * or two archives sharing history — and keeping the row already there makes
 * that re-import idempotent; without this clause the second import throws a
 * raw driver UNIQUE-constraint error that never reaches
 * `ImportResult.errors`. A collision WITHIN one restore is a malformed
 * archive, refused before any write by
 * `assertIdentityTransitionsWellOrdered` (`service-interchange-write.ts`),
 * so it never reaches this clause to be silently dropped.
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
    await withIdentityTransitionLogRelations(
      schema,
      target.dialect,
      "transition-restore",
      executeIdentityStatement(
        target,
        sql`
          INSERT INTO ${schema.identityTransitionsTable} (${IDENTITY_TRANSITION_COLUMNS})
          VALUES ${sql.join(valueChunk, sql`, `)}
          ON CONFLICT (graph_id, transition_id) DO NOTHING
        `,
      ),
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
  const revision = decodeRevisionColumn(value);
  if (typeof revision === "number") return revision;
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
export function isRestoredTransitionRow(
  row: IdentityTransitionRow,
): row is IdentityTransitionRow & Readonly<{ restored_at: string }> {
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

/** A (recorded revision, transition id) keyset cursor, ordering ties by the transition id. */
export type IdentityTransitionCursor = Readonly<{
  recordedRevision: number;
  transitionId: string;
}>;

/**
 * One owner for the `(recorded_revision, transition_id)` keyset predicate
 * both transition-log readers page by: `readIdentityTransitions` (replay's
 * fixed-point walk) and `readIdentityTransitionPageForInterchange` (archival
 * export). `transitionIdKey` is the tie-break column wrapped in the same
 * `binaryText` collation-safety seam both callers' `ORDER BY` uses — left
 * bare, `>`/`ORDER BY` on that column would compare under the column's
 * collation, which is locale-dependent on PostgreSQL and could disagree with
 * each other on some inputs. `cursorFilter` is the empty fragment when
 * `after` is `undefined`.
 */
function identityTransitionCursorSeam(
  target: IdentityTarget,
  after: IdentityTransitionCursor | undefined,
): Readonly<{ transitionIdKey: SqlFragment; cursorFilter: SqlFragment }> {
  const transitionIdKey = getDialect(target.dialect).binaryText(
    sql`transition_id`,
  );
  const cursorFilter =
    after === undefined ?
      sql``
    : sql`
      AND (
        recorded_revision > ${after.recordedRevision}
        OR (
          recorded_revision = ${after.recordedRevision}
          AND ${transitionIdKey} > ${after.transitionId}
        )
      )
    `;
  return { transitionIdKey, cursorFilter };
}

export type IdentityTransitionReadScope = Readonly<{
  classRefs: readonly PlainNodeRef[];
  limit: number;
  /**
   * Keyset-pages the read strictly past this cursor, ordered the same way
   * the result is (`recorded_revision` then `transition_id`) — pass the
   * cursor built from the previous page's LAST row to read the next `limit`
   * rows. `undefined` (the default) reads from the start. This is how
   * `walkClassLineage`'s fixed-point walk (replay.ts) reads one round to
   * exhaustion without a fixed per-round ceiling: it keeps requesting pages
   * until a page comes back shorter than `limit`.
   */
  after?: IdentityTransitionCursor | undefined;
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
 * (past `scope.after`, when given) and the merged, deduplicated rows are
 * re-sorted and re-truncated to that same limit, so chunking never changes
 * the result a single unchunked query would have returned.
 *
 * `scope.after` keyset-pages the result past a prior page's last row: the
 * caller (`walkClassLineage`, replay.ts) reads one fixed-point round to
 * exhaustion by re-issuing this call with `after` set to the previous page's
 * last row until a page comes back shorter than `scope.limit`, rather than
 * capping the round at a fixed row ceiling. Keyset-pages and orders through
 * {@link identityTransitionCursorSeam}.
 */
export async function readIdentityTransitions(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  scope: IdentityTransitionReadScope,
): Promise<readonly IdentityTransitionRow[]> {
  if (scope.classRefs.length === 0) return [];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: scope.after === undefined ? 4 : 6,
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
  const { transitionIdKey, cursorFilter } = identityTransitionCursorSeam(
    target,
    scope.after,
  );
  const rows = await withIdentityTransitionLogRelations(
    schema,
    target.dialect,
    "transition-read",
    target.execute<RawIdentityTransitionRow>(
      asCompiledRowsSql(sql`
        SELECT ${IDENTITY_TRANSITION_COLUMNS}
        FROM ${schema.identityTransitionsTable}
        WHERE graph_id = ${graphId}
          AND (${classMatches} OR ${priorMatches})
          ${cursorFilter}
        ORDER BY recorded_revision ASC, ${transitionIdKey} ASC
        LIMIT ${scope.limit}
      `),
    ),
  );
  return rows.map((row) => normalizeIdentityTransitionRow(row));
}

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
 * retention watermark"). Keyset-pages and orders through
 * {@link identityTransitionCursorSeam}.
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
  const { transitionIdKey, cursorFilter } = identityTransitionCursorSeam(
    target,
    options.after,
  );
  const rows = await withIdentityTransitionLogRelations(
    schema,
    target.dialect,
    "transition-read",
    target.execute<RawIdentityTransitionRow>(
      asCompiledRowsSql(sql`
        SELECT ${IDENTITY_TRANSITION_COLUMNS}
        FROM ${schema.identityTransitionsTable}
        WHERE graph_id = ${graphId}
          ${cursorFilter}
        ORDER BY recorded_revision ASC, ${transitionIdKey} ASC
        LIMIT ${options.limit}
      `),
    ),
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

type RawRestoredTransitionCountRow = Readonly<{ restored: unknown }>;

/** How many of `graphId`'s retained transition rows an archival restore inserted. */
export async function countRestoredIdentityTransitions(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<number> {
  const rows = await withIdentityTransitionLogRelations(
    schema,
    target.dialect,
    "transition-read",
    target.execute<RawRestoredTransitionCountRow>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS restored
        FROM ${schema.identityTransitionsTable}
        WHERE graph_id = ${graphId} AND restored_at IS NOT NULL
      `),
    ),
  );
  return Number(requireDefined(rows[0]).restored);
}

/**
 * One retention cut: every transition row below `revision` is gone.
 * `recordedAt` is the wall time of the recorded instant the cut was made at,
 * so `revision` and `recordedAt` together re-form that instant — a coordinate
 * a caller can hand back (as `fromRecorded`, or to `store.asOfRecorded` for a
 * native cut), never a wall clock no commit carried.
 */
export type IdentityTransitionCut = Readonly<{
  revision: number;
  recordedAt: string;
}>;

/**
 * What a graph's transition log no longer holds, as two separate facts on
 * two separate axes:
 *
 * - `pruned`: this graph's own retention watermark, which
 *   `pruneIdentityTransitions` advances. Its revision is on this graph's
 *   recorded axis.
 * - `restoredPruned`: the highest cut an archival restore carried in — the
 *   source graph's own retention at export time — or that a local prune
 *   reached among restored rows above this graph's clock. Its revision is on
 *   the raw revision numbers restored rows keep, which is the SOURCE graph's
 *   axis, never this one's.
 *
 * Either is `undefined` when nothing on its axis was cut.
 */
export type IdentityTransitionRetention = Readonly<{
  pruned?: IdentityTransitionCut | undefined;
  restoredPruned?: IdentityTransitionCut | undefined;
}>;

/** Which of {@link IdentityTransitionRetention}'s two cuts a write advances. */
type IdentityTransitionCutAxis = "pruned" | "restored-pruned";

const IDENTITY_TRANSITION_CUT_COLUMNS = {
  pruned: {
    revision: "pruned_before_revision",
    recordedAt: "pruned_before_recorded_at",
  },
  "restored-pruned": {
    revision: "restored_pruned_before_revision",
    recordedAt: "restored_pruned_before_recorded_at",
  },
} as const satisfies Readonly<
  Record<IdentityTransitionCutAxis, Readonly<Record<string, string>>>
>;

type RawRetentionRow = Readonly<{
  pruned_before_revision: unknown;
  pruned_before_recorded_at: unknown;
  restored_pruned_before_revision: unknown;
  restored_pruned_before_recorded_at: unknown;
}>;

/**
 * Decodes one cut's column pair. The revision column is `0` (native) or
 * `NULL` (restored) when nothing was cut on that axis; a revision without its
 * recorded time is a row no writer produces.
 *
 * Both time columns are `timestamp(..., { withTimezone: true })` on
 * PostgreSQL, which node-postgres decodes to a JS `Date` and a text-returning
 * driver hands back as non-ISO text, so they decode through the identity
 * module's one timestamp owner, as `normalizeIdentityTransitionRow` does.
 */
function decodeIdentityTransitionCut(
  revisionValue: unknown,
  recordedAtValue: unknown,
  axis: IdentityTransitionCutAxis,
): IdentityTransitionCut | undefined {
  if (revisionValue === null || revisionValue === undefined) return undefined;
  const revision = toRevisionNumber(revisionValue);
  if (revision === 0) return undefined;
  if (recordedAtValue === null || recordedAtValue === undefined) {
    throw new ConfigurationError(
      "Identity transition retention row carries a cut revision without its recorded time.",
      { axis, revision },
    );
  }
  return {
    revision,
    recordedAt: toCanonicalIdentityTimestamp(recordedAtValue),
  };
}

/** Reads a graph's {@link IdentityTransitionRetention}; both cuts `undefined` when nothing has been cut. */
export async function readIdentityTransitionRetention(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  surface: IdentityTransitionLogSurface = "transition-read",
): Promise<IdentityTransitionRetention> {
  const rows = await withIdentityTransitionLogRelations(
    schema,
    target.dialect,
    surface,
    target.execute<RawRetentionRow>(
      asCompiledRowsSql(sql`
        SELECT pruned_before_revision, pruned_before_recorded_at,
               restored_pruned_before_revision, restored_pruned_before_recorded_at
        FROM ${schema.identityTransitionRetentionTable}
        WHERE graph_id = ${graphId}
      `),
    ),
  );
  const row = rows[0];
  if (row === undefined) return {};
  return {
    pruned: decodeIdentityTransitionCut(
      row.pruned_before_revision,
      row.pruned_before_recorded_at,
      "pruned",
    ),
    restoredPruned: decodeIdentityTransitionCut(
      row.restored_pruned_before_revision,
      row.restored_pruned_before_recorded_at,
      "restored-pruned",
    ),
  };
}

/**
 * The cut an archival export carries: the higher of the two. On the graph
 * the archive is restored into, every row it carries is a restored row read
 * by its raw revision, native and restored alike, so "rows below this raw
 * revision may be missing" is the one claim that stays true of the whole
 * section.
 */
export function archivalRetentionCut(
  retention: IdentityTransitionRetention,
): IdentityTransitionCut | undefined {
  const { pruned, restoredPruned } = retention;
  if (pruned === undefined || restoredPruned === undefined)
    return pruned ?? restoredPruned;
  return restoredPruned.revision > pruned.revision ? restoredPruned : pruned;
}

/**
 * Advances one of a graph's two retention cuts — the ONE owner of the
 * retention relation's writes, shared by `pruneIdentityTransitionsForContext`
 * (both axes) and archival restore (`importIdentityTransitionsIntoTarget`,
 * `service-interchange-write.ts`, the restored axis only). The `WHERE` guard
 * makes the write itself monotonic per axis: a cut at or below the one
 * already stored is a no-op that keeps the stored cut and its recorded time,
 * and a write to one axis never touches the other.
 */
export async function advanceIdentityTransitionCut(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  axis: IdentityTransitionCutAxis,
  cut: IdentityTransitionCut,
  surface: IdentityTransitionLogSurface,
): Promise<void> {
  const table = schema.identityTransitionRetentionTable;
  const columns = IDENTITY_TRANSITION_CUT_COLUMNS[axis];
  const revisionColumn = sql.raw(columns.revision);
  const recordedAtColumn = sql.raw(columns.recordedAt);
  // A row first created by a restore records that nothing was pruned locally.
  const insert =
    axis === "pruned" ?
      {
        columns: sql`graph_id, ${revisionColumn}, ${recordedAtColumn}`,
        values: sql`${graphId}, ${cut.revision}, ${cut.recordedAt}`,
      }
    : {
        columns: sql`graph_id, pruned_before_revision, ${revisionColumn}, ${recordedAtColumn}`,
        values: sql`${graphId}, ${0}, ${cut.revision}, ${cut.recordedAt}`,
      };
  await withIdentityTransitionLogRelations(
    schema,
    target.dialect,
    surface,
    executeIdentityStatement(
      target,
      sql`
        INSERT INTO ${table} (${insert.columns}) VALUES (${insert.values})
        ON CONFLICT (graph_id) DO UPDATE
        SET ${revisionColumn} = excluded.${revisionColumn},
            ${recordedAtColumn} = excluded.${recordedAtColumn}
        WHERE COALESCE(${table}.${revisionColumn}, 0) < excluded.${revisionColumn}
      `,
    ),
  );
}

/**
 * The `IdentityReplayError` every transition-log operation raises when the
 * store keeps no TypeGraph transition log. Two states reach it: a store opened
 * without `history: true`, and a backend that owns recorded time itself
 * (engine-native), where TypeGraph performs no recorded capture — and so
 * writes no transitions — whatever `history` says. The latter names its own
 * code, since `history: true` is not the remedy there.
 */
export function identityTransitionLogUnavailableError(
  graphId: string,
  recordedTimeOwnership: RecordedTimeOwnership,
  operation: IdentityTransitionLogOperation,
): IdentityReplayError {
  if (recordedTimeOwnership === "engine-native") {
    return new IdentityReplayError(
      `${operation} is not supported under engine-native recorded time.`,
      { code: "IDENTITY_REPLAY_ENGINE_NATIVE_UNSUPPORTED", graphId, operation },
      {
        suggestion:
          "This backend declares recordedTime, so it owns recorded history itself and TypeGraph keeps no identity transition log for it, with or without history: true. The transition log needs a backend whose recorded time TypeGraph captures in its own relations.",
      },
    );
  }
  return new IdentityReplayError(
    `${operation} requires the store to be opened with history: true.`,
    { code: "IDENTITY_REPLAY_REQUIRES_HISTORY", graphId, operation },
    {
      suggestion:
        "Open the store with createStore(graph, backend, { history: true }); the transition log annotates the recorded axis and has nothing to annotate without it.",
    },
  );
}

/** Refuses a transition-log operation on a context whose store keeps no TypeGraph transition log — see {@link identityTransitionLogUnavailableError}. */
export function requireIdentityTransitionLog(
  ctx: Pick<
    IdentityServiceContext<GraphDef>,
    "graphId" | "historyEnabled" | "recordedTimeOwnership"
  >,
  operation: IdentityTransitionLogOperation,
): void {
  if (!ctx.historyEnabled) {
    throw identityTransitionLogUnavailableError(
      ctx.graphId,
      ctx.recordedTimeOwnership,
      operation,
    );
  }
}

async function readHighestRetainedTransitionRevision(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
): Promise<number | undefined> {
  const rows = await withIdentityTransitionLogRelations(
    schema,
    target.dialect,
    "transition-prune",
    target.execute<Readonly<{ highest: unknown }>>(
      asCompiledRowsSql(sql`
        SELECT MAX(recorded_revision) AS highest
        FROM ${schema.identityTransitionsTable}
        WHERE graph_id = ${graphId}
      `),
    ),
  );
  const highest = rows[0]?.highest;
  return highest === null || highest === undefined ?
      undefined
    : toRevisionNumber(highest);
}

/** What `pruneIdentityTransitions` reports. */
export type IdentityTransitionPruneResult = Readonly<{
  pruned: number;
  prunedBeforeRevision: number;
}>;

/**
 * Prunes retained explanation: deletes every transition row strictly below
 * the requested revision and advances the retention watermark monotonically.
 * A prune at an earlier revision than the current watermark never lowers it.
 * A prune beyond every revision the graph holds — the next commit's revision,
 * or one past the highest retained row when archival restore carried higher
 * revisions in from another graph — is refused: it would claim history the
 * graph has yet to record as already pruned. The watermark itself is clamped to
 * the next commit's revision, because restored revisions are not on this
 * graph's axis; when the prune deleted restored rows above that clamp, the
 * restored cut records how far it reached among them.
 *
 * `beforeRecorded` must be an instant this graph allocated: it is checked by
 * the same ownership rule every `asOfRecorded` read applies
 * ({@link requireOwnedTransitionLogRevision}), inside the prune's own
 * mutation and before it reads or deletes anything, so another graph's
 * instant, a legacy or restored instant, and an engine-native one delete
 * nothing and leave the watermark where it was. The watermark keeps that
 * instant's recorded time, so the `retention-truncated` cut a read reports
 * is the instant the caller pruned at.
 *
 * Explicit operator action only — no automatic retention policy exists.
 * Deliberately, a prune does NOT advance the content revision (the
 * same non-advancing contract `rebuildIdentityClosure` follows): it destroys
 * retained explanation, never truth, so branch staleness must track truth,
 * not explanation.
 */
export async function pruneIdentityTransitionsForContext<G extends GraphDef>(
  ctx: IdentityServiceContext<G>,
  options: Readonly<{ beforeRecorded: RecordedInstant }>,
): Promise<IdentityTransitionPruneResult> {
  requireIdentityTransitionLog(ctx, "pruneIdentityTransitions");
  // Form first: a malformed or engine-native instant is refused before the
  // mutation opens.
  requireTypeGraphRecordedRevision(options.beforeRecorded, "beforeRecorded");
  return runIdentityMutation(ctx, async (rawTarget) => {
    const targetRevision = requireOwnedTransitionLogRevision(
      options.beforeRecorded,
      "beforeRecorded",
      await readGraphAllocationOwner(rawTarget, ctx.schema, ctx.graphId),
      ctx.graphId,
    );
    const retention = await readIdentityTransitionRetention(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      "transition-prune",
    );
    const existingWatermark = retention.pruned?.revision ?? 0;
    const nextRevision = await readNextRecordedRevision(
      rawTarget,
      ctx.schema,
      ctx.graphId,
    );
    const highestRetained = await readHighestRetainedTransitionRevision(
      rawTarget,
      ctx.schema,
      ctx.graphId,
    );
    const highestPrunableRevision = Math.max(
      nextRevision,
      highestRetained === undefined ? nextRevision : highestRetained + 1,
    );
    if (targetRevision > highestPrunableRevision) {
      throw new IdentityReplayError(
        `Cannot prune identity transitions before ${options.beforeRecorded}: the graph holds no transition at or above revision ${String(highestPrunableRevision)}, so a prune beyond it would claim history that does not exist yet as already pruned.`,
        {
          code: "IDENTITY_PRUNE_BEYOND_RECORDED_CLOCK",
          requestedBefore: options.beforeRecorded,
          requestedRevision: targetRevision,
          highestPrunableRevision,
        },
        {
          suggestion:
            "Pass a recorded instant this graph has reached, such as store.recordedNow(), as beforeRecorded.",
        },
      );
    }
    // Restored rows keep the revision their source graph minted, so they can
    // sit above this graph's clock: the rows are deleted by the requested
    // revision, while the watermark — a claim about this graph's own axis —
    // never rises above the revision its next commit takes.
    const resolvedWatermark = Math.max(
      existingWatermark,
      Math.min(targetRevision, nextRevision),
    );
    const deleted = await withIdentityTransitionLogRelations(
      ctx.schema,
      rawTarget.dialect,
      "transition-prune",
      rawTarget.execute<
        Readonly<{ recorded_revision: unknown; restored_at: unknown }>
      >(
        asCompiledRowsSql(sql`
          DELETE FROM ${ctx.schema.identityTransitionsTable}
          WHERE graph_id = ${ctx.graphId}
            AND recorded_revision < ${targetRevision}
          RETURNING recorded_revision, restored_at
        `),
      ),
    );
    const cutRecordedAt = recordedInstantWallTime(options.beforeRecorded);
    await advanceIdentityTransitionCut(
      rawTarget,
      ctx.schema,
      ctx.graphId,
      "pruned",
      { revision: resolvedWatermark, recordedAt: cutRecordedAt },
      "transition-prune",
    );
    // A deleted restored row the native watermark does not cover (one at or
    // above it) is history the restored cut must now report.
    const deletedRestoredAboveWatermark = deleted.some(
      (row) =>
        row.restored_at !== null &&
        row.restored_at !== undefined &&
        toRevisionNumber(row.recorded_revision) >= resolvedWatermark,
    );
    if (deletedRestoredAboveWatermark) {
      await advanceIdentityTransitionCut(
        rawTarget,
        ctx.schema,
        ctx.graphId,
        "restored-pruned",
        { revision: targetRevision, recordedAt: cutRecordedAt },
        "transition-prune",
      );
    }
    return { pruned: deleted.length, prunedBeforeRevision: resolvedWatermark };
  });
}

/**
 * Prunes a graph's retained identity transitions.
 *
 * An explicit operator action with no automatic retention policy — see
 * "Retention" in the identity documentation. Requires the store to be opened
 * with `history: true`, and a `beforeRecorded` this graph allocated.
 */
export async function pruneIdentityTransitions<G extends GraphDef>(
  store: Store<G>,
  options: Readonly<{ beforeRecorded: RecordedInstant }>,
): Promise<IdentityTransitionPruneResult> {
  const ctx = storeRuntime(store).identityContext();
  return pruneIdentityTransitionsForContext(ctx, options);
}
