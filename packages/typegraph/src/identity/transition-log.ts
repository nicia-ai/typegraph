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
import { type GraphDef } from "../core/define-graph";
import { parseRecordedInstant } from "../core/temporal";
import { ConfigurationError, IdentityReplayError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { asCompiledRowsSql, asCompiledStatementSql } from "../query/sql-intent";
import { storeRuntime } from "../store/runtime-port";
import { type Store } from "../store/store";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { runIdentityMutation } from "./service-facade";
import { refKey } from "./service-read";
import { type IdentityServiceContext } from "./service-types";
import { type IdentityTarget, type PlainNodeRef } from "./sql-target";

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
}>;

/** The class-change record `replaceAffectedClosure` / `mergeCurrentClasses` return to their caller. */
export type ClosureTransitionRecord = Readonly<{
  classRef: PlainNodeRef;
  priorClassRef?: PlainNodeRef | undefined;
}>;

/**
 * The exhaustive-diff predicate: given a member's OLD class (before a
 * structural mutation) and its NEW class (after), the one owner of "does this
 * count as a class-identity transition, and if so what does it name". Every
 * structural cause site (assert, retract, fold, detach, kind-drop,
 * schema-transition) calls this — never a second inline spelling of the
 * comparison.
 *
 * A member whose canonical is unchanged never needs its own record: if its
 * old class genuinely lost members, at least one OTHER member of that old
 * class ends up under a different canonical, and THAT member's record already
 * carries `priorClassRef` equal to the old canonical — sufficient for a seed
 * tracking the old canonical to discover this boundary by the reverse
 * lineage hop. A member whose old class was never a real (>=2 member) closure
 * row reports `priorClassRef: undefined` ("the class did not exist").
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
    // delete removed it from the live population). Its departure is reported
    // through whichever surviving member's record carries the old canonical
    // as `priorClassRef`; there is nothing to name it "became" here.
    if (newClass === undefined) continue;
    const priorCanonical = requireDefined(oldClass[0]);
    const canonical = requireDefined(newClass[0]);
    if (refKey(priorCanonical) === refKey(canonical)) continue;
    const dedupeKey = `${refKey(canonical)} ${refKey(priorCanonical)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    records.push({
      classRef: canonical,
      priorClassRef: oldClass.length >= 2 ? priorCanonical : undefined,
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

/** Builds one transition row's INSERT value tuple, in {@link IDENTITY_TRANSITION_COLUMNS} order. */
export function encodeIdentityTransitionRow(
  note: IdentityTransitionNote,
  revision: number,
  recordedAt: string,
  transitionId: string,
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
        ${sql.raw("NULL")}
      )
  `;
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
    recorded_at: asRowString(row.recorded_at, "recorded_at"),
    valid_at: asRowString(row.valid_at, "valid_at"),
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
  };
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

export type IdentityTransitionReadScope = Readonly<{
  classRefs: readonly PlainNodeRef[];
  fromRevision?: number | undefined;
  toRevision?: number | undefined;
  limit: number;
}>;

/**
 * Reads every transition row whose `class` OR `prior class` names one of
 * `scope.classRefs` — the forward AND reverse lineage hop the replay
 * fixed-point walk needs in one query — ordered by recorded revision then by
 * transition id, so several notes sharing a boundary come back in the
 * deterministic insertion order they were written.
 */
export async function readIdentityTransitions(
  target: IdentityTarget,
  schema: SqlSchema,
  graphId: string,
  scope: IdentityTransitionReadScope,
): Promise<readonly IdentityTransitionRow[]> {
  if (scope.classRefs.length === 0) return [];
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
  const fromFilter =
    scope.fromRevision === undefined ?
      sql``
    : sql`AND recorded_revision >= ${scope.fromRevision}`;
  const toFilter =
    scope.toRevision === undefined ?
      sql``
    : sql`AND recorded_revision <= ${scope.toRevision}`;
  const rows = await target.execute<RawIdentityTransitionRow>(
    asCompiledRowsSql(sql`
      SELECT ${IDENTITY_TRANSITION_COLUMNS}
      FROM ${schema.identityTransitionsTable}
      WHERE graph_id = ${graphId}
        AND (${classMatches} OR ${priorMatches})
        ${fromFilter}
        ${toFilter}
      ORDER BY recorded_revision ASC, transition_id ASC
      LIMIT ${scope.limit}
    `),
  );
  return rows.map((row) => normalizeIdentityTransitionRow(row));
}

/** Reads a graph's transition-retention watermark; `0` when nothing has been pruned. */
export async function readTransitionRetention(
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
    prunedAt: asRowString(row.pruned_at, "pruned_at"),
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
  const target = parseRecordedInstant(options.beforeRecorded, "beforeRecorded");
  return runIdentityMutation(ctx, async (rawTarget) => {
    const existingWatermark = await readTransitionRetention(
      rawTarget,
      ctx.schema,
      ctx.graphId,
    );
    const resolvedWatermark = Math.max(existingWatermark, target.revision);
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
    await requireDefined(
      rawTarget.executeStatement,
      "pruneIdentityTransitions requires a statement-capable transaction target.",
    )(
      asCompiledStatementSql(sql`
        INSERT INTO ${ctx.schema.identityTransitionRetentionTable} (
          graph_id, pruned_before_revision, pruned_at
        ) VALUES (${ctx.graphId}, ${resolvedWatermark}, ${nowIso()})
        ON CONFLICT (graph_id) DO UPDATE
        SET pruned_before_revision = excluded.pruned_before_revision,
            pruned_at = excluded.pruned_at
        WHERE ${ctx.schema.identityTransitionRetentionTable}.pruned_before_revision < excluded.pruned_before_revision
      `),
    );
    return { pruned: deleted.length, prunedBeforeRevision: resolvedWatermark };
  });
}

/**
 * Prunes a graph's retained identity transitions.
 *
 * INTERNAL for PR-1: not exported from `src/index.ts`. The public surface
 * (`store.identity.replay` / `transitionsOf`, and this function's export from
 * the package barrel) lands with PR-3's release slice.
 */
export async function pruneIdentityTransitions<G extends GraphDef>(
  store: Store<G>,
  options: Readonly<{ beforeRecorded: string }>,
): Promise<Readonly<{ pruned: number; prunedBeforeRevision: number }>> {
  const ctx = storeRuntime(store).identityContext();
  return pruneIdentityTransitionsForContext(ctx, options);
}
