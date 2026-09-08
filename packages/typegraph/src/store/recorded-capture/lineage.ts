/**
 * Derives the backend's optional `lineage` capability
 * (`backend/capabilities/lineage.ts`) from TypeGraph's own recorded
 * relations, for a store that captures history — and the one place that
 * picks between an engine's own `lineage` and this derived one.
 *
 * ## Revision encoding
 *
 * `revision()` reports the graph's recorded-time clock (the same value
 * `store.revisionNow()` exposes) as an `EngineRevision`. This is per GRAPH,
 * not per engine — stricter than the general `LineageMembers` contract,
 * which describes a whole-database revision. It is exactly the anchor the
 * base-version token already uses, so it costs nothing new to read. Before
 * this graph has ever advanced its clock, `revision()` reports a fixed
 * genesis token instead of a real recorded instant (the clock has no row
 * yet to report); the genesis token deliberately fails the recorded-instant
 * grammar, so it can never collide with a real committed revision.
 *
 * ## The changed-since predicate
 *
 * `changesSince` reads both recorded relations for rows with
 * `recorded_from > rev` OR (`recorded_to > rev` AND `recorded_to` is not
 * the open-interval sentinel, {@link RECORDED_MAX_REVISION} — the ONE owner
 * of that value, also used by every write to these relations). Every write
 * shape a recorded relation can express is covered by one side or the
 * other:
 *
 * - a plain insert or update: the flush pipeline always inserts the new
 *   row with `recorded_from` set to the commit revision, so it matches
 *   `recorded_from > rev` directly;
 * - an update also closes the row it replaces, moving that PRIOR row's
 *   `recorded_to` to the same commit revision — matched by the second
 *   arm, and deduplicated against the first (same `(kind, id)`) by the
 *   `DISTINCT` this module's queries always apply;
 * - a soft delete inserts a tombstone row exactly like an update, so it is
 *   covered the same way;
 * - a hard delete (a single node/edge, or an entire kind) closes the open
 *   recorded row WITHOUT inserting a replacement — covered only by the
 *   second arm, which is why the sentinel exclusion cannot be dropped: a
 *   still-open row's `recorded_to` sentinel must never itself register as
 *   "changed";
 * - a resurrection (`upsertById` reviving a soft-deleted row) closes the
 *   tombstone and inserts a fresh row, so it is covered by both arms and
 *   reported exactly once via the same deduplication.
 *
 * ## What `changesSince` cannot answer
 *
 * A revision strictly newer than the graph's own clock is not something
 * this graph could have produced (a caller confusing graphs, or a
 * revision from a store this backend never wrote through) — a caller of
 * `resolveLineage` already knows to fall back to a full comparison when a
 * delta cannot be trusted, so this reports `unbounded` rather than
 * guessing.
 *
 * A revision OLDER than the earliest row either recorded relation (or the
 * recorded identity-assertion relation, folded into the same floor so a
 * graph whose earliest commits only asserted identities is not mistaken
 * for a gap) carries for this graph is the harder case: TypeGraph's
 * revision clock is shared between `revisionTracking` and `history`, so a
 * graph that ran with `revisionTracking: true` (no capture) before a later
 * store enabled `history: true` advances the clock WITHOUT ever inserting
 * a recorded row — the recorded relations then start mid-stream and cannot
 * vouch for what changed before they existed. This module detects that gap
 * from two signals: the earliest `recorded_from` this graph has (a numeric
 * gap between the requested revision and that floor means SOME tracked
 * commit landed with no recorded row to show for it), corroborated by the
 * durable per-graph revision-origin row ({@link readRevisionOrigin}). That
 * row is minted lazily by `Store.revisionOriginNow()` — graph-merge's
 * `computeBaseVersion` calls it for every revision-tracking store, so in
 * the graph-merge use case it is present almost as soon as tracking is —
 * but a store that only ever calls `revisionNow()` may never mint it, even
 * with tracking on. Its presence corroborates the gap; its absence does
 * NOT prove there is no gap, only that this heuristic cannot corroborate
 * one. When the numeric gap exists but the origin row does not (nothing
 * corroborates it), the gap is UNDETECTABLE by this heuristic; per this
 * capability's fail-open contract for an undetectable gap, `changesSince`
 * falls through to the ordinary predicate rather than claiming `unbounded`
 * on a hunch. Document this honestly rather than pretend the heuristic is
 * exact: a caller that must never miss a pre-capture change should prefer
 * `revisionTracking` and `history` together from the graph's first write.
 *
 * Beyond that gap, the delta is trustworthy only when EVERY writer to this
 * graph goes through a store that captures history. This module detects
 * ONE shape of a non-capturing writer sharing the graph — a second `Store`
 * over the same backend/graph constructed with `revisionTracking: true` but
 * no `history`, which advances the SAME shared clock without ever inserting
 * a recorded row (see `clock.ts`'s `advanceRevisionClock`: revision
 * tracking and history capture allocate from one clock by design). This
 * module's completeness evidence is the invariant every capturing commit
 * upholds on its own: it allocates a revision and touches EITHER
 * `recorded_from` (an insert, update, soft delete, or resurrection) OR
 * `recorded_to` (a hard delete, which closes the open row without
 * inserting a replacement) AT that revision — never neither — so the
 * greatest revision either column carries can never fall behind the
 * clock's current revision UNLESS some commit advanced the clock without
 * capturing. `changesSince` checks exactly that — current revision
 * strictly ahead of that greatest evidenced revision (see
 * {@link latestRecordedFrom}) — and returns `unbounded` when it holds,
 * REGARDLESS of the requested `since`: a hole anywhere in the captured
 * record means this module cannot vouch for completeness at all, not only
 * for the span after the hole.
 *
 * That check catches the non-capturing write only while it is the MOST
 * RECENT action on the clock: a later capturing commit closes the gap again
 * (the evidenced ceiling catches back up to the clock), silently erasing
 * the evidence. A non-capturing writer whose writes are always followed by a
 * capturing one is therefore still invisible — no signal at all remains to
 * catch it by (no gap in `recorded_from`, no clock/floor mismatch), and such
 * a write UNDER-REPORTS silently: it is simply absent from every `"keys"`
 * delta this module ever returns, never surfaced as `unbounded`. The same is
 * true of a raw `GraphBackend` write bypassing every `Store`, or an
 * engine-side mutation outside TypeGraph entirely. This is a materially
 * different failure mode from the corroborated pre-capture gap above, which
 * the fail-open contract handles by refusing to guess — here there is
 * sometimes no signal to refuse ON. A caller that cannot guarantee every
 * writer captures history, or that a non-capturing tracked writer's commits
 * are never immediately followed by a capturing one, must not treat a
 * `"keys"` delta from this source as exhaustive; the only fully safe
 * configuration is `history: true` on every writer touching the graph.
 *
 * ## Token identity is scoped to one store, not one `graphId`
 *
 * `revision()`'s token is the bare recorded-clock value (or the genesis
 * sentinel) — it carries NO discriminator of its own for WHICH physical
 * store's clock produced it, beyond the `graphId` refusal above. Two
 * independently created stores that happen to share a `graphId` mint
 * numerically comparable clock values (a fresh database starts counting
 * from the same low integers as any other), and the SAME store's clock
 * after `clear()` restarts numbering too (`Store.clear()` drops the
 * recorded relations and the clock row) — so a bare token from this module
 * is NEVER safe to compare across stores, or across a store's own
 * `clear()` boundary, on its own. This module's own direct callers (the
 * conformance tests) only ever compare a revision against the SAME store's
 * later clock reading with no intervening `clear()`, which is safe.
 *
 * Every caller that anchors ACROSS stores or across time — `base-version.ts`
 * is the one today — is required to pair this bare token with the store's
 * durable per-graph revision-origin nonce (`ensureRevisionOrigin`/
 * `readRevisionOrigin`, `store/recorded-capture/clock.ts`) before treating
 * two readings as comparable, and `Store.clear()` rotates that origin (see
 * `resetRevisionOrigin`) precisely so a pre-clear reading can never satisfy
 * a post-clear origin check even when the bare numbers coincide. Both
 * `base@V` anchor forms embed the origin for exactly this reason (see
 * `base-version.ts`'s module doc and `revisionOriginMatch`); a future
 * direct consumer of this module's bare token that skips that pairing would
 * reopen the same hazard.
 */
import {
  type EngineRevision,
  type EntityKey,
  type LineageDelta,
  type LineageMembers,
  type LineageSession,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import {
  asRecordedInstant,
  RECORDED_MAX_REVISION,
  recordedInstantRevision,
} from "../../core/temporal";
import { ConfigurationError } from "../../errors";
import { type SqlSchema } from "../../query/compiler/schema";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import {
  type STORE_RUNTIME,
  storeBackend,
  type StoreRuntime,
} from "../runtime-port";
import { readRecordedClock, readRevisionOrigin } from "./clock";

/**
 * The minimal store surface {@link recordedRelationsLineage} and
 * {@link resolveLineage} need: the graph this lineage answers for, whether
 * this store captures history, the schema naming the physical recorded
 * relations, and the runtime port reaching the store's own backend.
 *
 * A structural type rather than the `Store` class itself: `store/store.ts`
 * constructs the store's runtime port using exports from this same
 * `recorded-capture` family, so importing `Store` back here would cycle.
 * Every real `Store<G>` already carries these members, so a live store is
 * assignable to this type without adaptation.
 */
export type RecordedLineageStore<G extends GraphDef = GraphDef> = Readonly<{
  graphId: string;
  historyEnabled: boolean;
  revisionTrackingEnabled: boolean;
  revisionSchema: SqlSchema;
  [STORE_RUNTIME]?: StoreRuntime<G>;
}>;

/**
 * Brands a plain string as an `EngineRevision`. The one cast site this
 * module uses to mint the branded type — from the genesis sentinel below,
 * and from a real `RecordedInstant` string (a distinct brand, so crossing
 * from one to the other goes through this shared `string` step rather than
 * each call site inventing its own cross-brand assertion).
 */
function brandEngineRevision(value: string): EngineRevision {
  return value as EngineRevision;
}

/**
 * Reported by {@link recordedRelationsLineage}'s `revision()` before this
 * graph has ever advanced its recorded clock. Deliberately NOT a valid
 * `RecordedInstant` (it fails that grammar), so it can never collide with a
 * real committed revision; recognized only by this module's own
 * `changesSince`, per the opaque-token contract every `lineage` source
 * shares.
 *
 * This is a distinct constant from `base-version.ts`'s `INITIAL_REVISION`,
 * not a re-spelling of one predicate: that string lives in the `EngineRevision`
 * grammar. `store/recorded-capture` sits below `graph-merge` in the
 * dependency graph, so this module cannot import the base-token constant
 * without inverting that layering.
 */
const GENESIS_REVISION = brandEngineRevision(
  "recorded-relations-lineage:genesis",
);
const GENESIS_REVISION_NUMBER = 0;

const UNBOUNDED_DELTA: LineageDelta = Object.freeze({ kind: "unbounded" });

/**
 * Decodes a `MIN(recorded_from)`-shaped aggregate value into a JS number.
 * BIGINT columns come back as a `bigint` on some drivers and a numeric
 * string on others (PostgreSQL's default driver never parses BIGINT), so
 * both are normalized alongside the plain-number case a small SQLite value
 * already arrives as.
 */
function decodeAggregateRevision(value: bigint | number | string): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * Parses an `EngineRevision` this module minted back into the numeric
 * per-graph revision `changesSince` compares columns against, or
 * `undefined` for anything this module did not mint — a token from an
 * unrelated `lineage` source, or a corrupted value. `changesSince` treats
 * an unparseable revision the same as one newer than the clock: unknown,
 * so `unbounded`.
 */
function parseLineageRevision(revision: EngineRevision): number | undefined {
  if (revision === GENESIS_REVISION) return GENESIS_REVISION_NUMBER;
  try {
    return recordedInstantRevision(asRecordedInstant(revision));
  } catch {
    return undefined;
  }
}

/**
 * The smallest `recorded_from` any recorded relation carries for this
 * graph — nodes, edges, AND identity assertions — or `undefined` when none
 * of the three has a row yet. This is the floor `changesSince` compares a
 * requested revision against to detect a pre-capture gap (see the module
 * doc). Identity assertions are folded into the same floor deliberately: a
 * graph whose earliest tracked commits only asserted identities (no node
 * or edge row written yet) would otherwise look identical to a graph with
 * a genuine pre-capture gap, and falsely report `unbounded`.
 */
async function earliestRecordedFrom(
  session: LineageSession,
  schema: SqlSchema,
  graphId: string,
): Promise<number | undefined> {
  const rows = await session.execute<
    Readonly<{ earliest: bigint | number | string | null }>
  >(
    asCompiledRowsSql(sql`
      SELECT MIN(recorded_from) AS earliest FROM (
        SELECT recorded_from FROM ${schema.recordedNodesTable} WHERE graph_id = ${graphId}
        UNION ALL
        SELECT recorded_from FROM ${schema.recordedEdgesTable} WHERE graph_id = ${graphId}
        UNION ALL
        SELECT recorded_from FROM ${schema.recordedIdentityAssertionsTable} WHERE graph_id = ${graphId}
      ) AS lineage_earliest_recorded_from
    `),
  );
  const earliest = rows[0]?.earliest;
  return earliest === null || earliest === undefined ?
      undefined
    : decodeAggregateRevision(earliest);
}

/**
 * The largest revision any recorded relation carries EVIDENCE for, for this
 * graph — nodes, edges, AND identity assertions, the same three-relation
 * scope {@link earliestRecordedFrom} queries for the floor. This is the
 * completeness ceiling `changesSince` compares the graph's current clock
 * revision against (see the module doc's "what changesSince cannot
 * answer").
 *
 * Evidence means EITHER column, not `recorded_from` alone: an insert,
 * update, soft delete, or resurrection writes a row whose `recorded_from`
 * is the allocated revision, but a HARD delete closes the existing open row
 * — moving ONLY its `recorded_to` to the allocated revision — without
 * inserting any row at that revision (see the module doc's per-write-shape
 * breakdown). `recorded_from` alone would therefore lag the clock by one
 * commit after every hard delete even though capture is complete; folding
 * in `recorded_to` (excluding the open-interval sentinel, which marks a
 * row that has NOT closed and must never register as "activity at the
 * sentinel revision") closes that gap. `undefined` when no recorded row
 * exists yet for this graph.
 */
async function latestRecordedFrom(
  session: LineageSession,
  schema: SqlSchema,
  graphId: string,
): Promise<number | undefined> {
  const rows = await session.execute<
    Readonly<{ latest: bigint | number | string | null }>
  >(
    asCompiledRowsSql(sql`
      SELECT MAX(revision) AS latest FROM (
        SELECT recorded_from AS revision FROM ${schema.recordedNodesTable} WHERE graph_id = ${graphId}
        UNION ALL
        SELECT recorded_to AS revision FROM ${schema.recordedNodesTable} WHERE graph_id = ${graphId} AND recorded_to <> ${RECORDED_MAX_REVISION}
        UNION ALL
        SELECT recorded_from AS revision FROM ${schema.recordedEdgesTable} WHERE graph_id = ${graphId}
        UNION ALL
        SELECT recorded_to AS revision FROM ${schema.recordedEdgesTable} WHERE graph_id = ${graphId} AND recorded_to <> ${RECORDED_MAX_REVISION}
        UNION ALL
        SELECT recorded_from AS revision FROM ${schema.recordedIdentityAssertionsTable} WHERE graph_id = ${graphId}
        UNION ALL
        SELECT recorded_to AS revision FROM ${schema.recordedIdentityAssertionsTable} WHERE graph_id = ${graphId} AND recorded_to <> ${RECORDED_MAX_REVISION}
      ) AS lineage_latest_recorded_activity
    `),
  );
  const latest = rows[0]?.latest;
  return latest === null || latest === undefined ?
      undefined
    : decodeAggregateRevision(latest);
}

/**
 * Every `(kind, id)` in one recorded relation with a change strictly after
 * `sinceRevision` — the shared query behind both the node and edge halves
 * of a `"keys"` delta. See the module doc for why the two-armed predicate
 * covers every write shape and why `DISTINCT` is what keeps a row that
 * matches both arms (a resurrection) from being reported twice.
 */
async function changedEntityKeys(
  session: LineageSession,
  table: SqlFragment,
  graphId: string,
  sinceRevision: number,
): Promise<readonly EntityKey[]> {
  const rows = await session.execute<Readonly<{ kind: string; id: string }>>(
    asCompiledRowsSql(sql`
      SELECT DISTINCT kind, id
      FROM ${table}
      WHERE graph_id = ${graphId}
        AND (
          recorded_from > ${sinceRevision}
          OR (recorded_to > ${sinceRevision} AND recorded_to <> ${RECORDED_MAX_REVISION})
        )
      ORDER BY kind, id
    `),
  );
  return rows.map((row) => ({ kind: row.kind, id: row.id }));
}

/**
 * Builds a `lineage` capability sourced from `store`'s own recorded
 * relations. Callers get this indirectly through {@link resolveLineage};
 * call it directly only to consult the recorded-relations source even when
 * the backend also declares its own `lineage` (e.g. the conformance suite).
 *
 * `revision`/`changesSince` run every read on the {@link LineageSession}
 * they are given, never on a backend this function closed over — the same
 * "session facts come from the session that enforces them" contract every
 * `LineageMembers` implementation honors (see that type's own doc). Every
 * call graph-merge makes into this source (`branch()`'s fork-revision
 * capture, `staging.ts`'s pruning, `base-version.ts`'s
 * `lineageDeltaSinceAnchor`) runs at PLANNING time, strictly outside any
 * commit transaction, and passes the root backend it already holds as the
 * session — the recorded-relations source never actually reaches a
 * `transaction()` handle today, but nothing in its implementation depends
 * on that: it reads correctly on whatever session a future caller hands it,
 * transaction handle included.
 */
export function recordedRelationsLineage<G extends GraphDef>(
  store: RecordedLineageStore<G>,
): LineageMembers {
  if (!store.historyEnabled) {
    throw new ConfigurationError(
      "recordedRelationsLineage requires a store constructed with `history: true` — a non-capturing store never populates the recorded relations this lineage reads, so every changesSince would silently report an empty delta instead of the truth.",
      { code: "LINEAGE_REQUIRES_HISTORY" },
      {
        suggestion:
          "Construct the store with `history: true`, or call resolveLineage(store) instead — it already checks this and returns undefined for a non-capturing store rather than deriving a lineage that cannot see any writes.",
      },
    );
  }

  const schema = store.revisionSchema;
  const graphId = store.graphId;

  function refuseForeignGraph(requestedGraphId: string): void {
    if (requestedGraphId === graphId) return;
    throw new ConfigurationError(
      "recordedRelationsLineage's changesSince was called for a different graph than the one this lineage was derived from.",
      {
        code: "LINEAGE_GRAPH_MISMATCH",
        derivedForGraphId: graphId,
        requestedGraphId,
      },
      {
        suggestion:
          "Derive a separate lineage per graph with resolveLineage(store) — this lineage's revision() is a per-graph anchor, not comparable against another graph's rows.",
      },
    );
  }

  async function revision(session: LineageSession): Promise<EngineRevision> {
    const instant = await readRecordedClock(session, schema, graphId);
    return instant === undefined ? GENESIS_REVISION : (
        brandEngineRevision(instant)
      );
  }

  async function changesSince(
    session: LineageSession,
    since: EngineRevision,
    requestedGraphId: string,
  ): Promise<LineageDelta> {
    refuseForeignGraph(requestedGraphId);
    const requested = parseLineageRevision(since);
    if (requested === undefined) return UNBOUNDED_DELTA;

    const currentInstant = await readRecordedClock(session, schema, graphId);
    const currentRevision =
      currentInstant === undefined ?
        GENESIS_REVISION_NUMBER
      : recordedInstantRevision(currentInstant);
    if (requested > currentRevision) return UNBOUNDED_DELTA;

    // Completeness evidence (see the module doc): a capturing store's own
    // clock can never run ahead of the latest row it captured. When it
    // does, some OTHER writer sharing this graph's clock advanced it
    // without capturing — the delta this module could report is missing
    // that writer's rows entirely, so it refuses to report one at all,
    // independent of `requested`.
    const latestFrom = await latestRecordedFrom(session, schema, graphId);
    if (currentRevision > (latestFrom ?? GENESIS_REVISION_NUMBER)) {
      return UNBOUNDED_DELTA;
    }

    const earliestFrom = await earliestRecordedFrom(session, schema, graphId);
    if (earliestFrom !== undefined && requested < earliestFrom - 1) {
      // A tracked commit landed strictly between `requested` and the first
      // captured row, with no recorded row to show for it. Corroborate with
      // the durable revision-origin row before trusting the gap — see the
      // module doc's "what changesSince cannot answer" section.
      const origin = await readRevisionOrigin(session, schema, graphId);
      if (origin !== undefined) return UNBOUNDED_DELTA;
    }

    const [nodes, edges] = await Promise.all([
      changedEntityKeys(session, schema.recordedNodesTable, graphId, requested),
      changedEntityKeys(session, schema.recordedEdgesTable, graphId, requested),
    ]);
    return { kind: "keys", nodes, edges };
  }

  return Object.freeze({ revision, changesSince });
}

/**
 * Whether this store's base token is namespaced by the graph's durable
 * revision origin — true for the revision anchor (tracking on) and for the
 * engine anchor (tracking off, a backend `lineage` present), false only for
 * the content-fingerprint fallback. The one spelling `Store.clear()` uses
 * to decide whether there is an origin to rotate, so it cannot drift from
 * the anchor precedence `computeBaseVersion` applies: a store that mints an
 * origin-namespaced anchor is exactly a store whose `clear()` must rotate
 * that origin. A backend whose `lineage` is present but which cannot
 * bootstrap the origins relation mints no anchor at all (`computeBaseVersion`
 * refuses), so it has nothing to rotate either.
 */
export function mintsOriginNamespacedAnchor<G extends GraphDef>(
  store: RecordedLineageStore<G>,
  originsSupported: boolean,
): boolean {
  if (store.revisionTrackingEnabled) return true;
  return resolveLineage(store) !== undefined && originsSupported;
}

/**
 * THE one owner of lineage source selection: the backend's own `lineage`
 * when it declares one, else the store's recorded-relations lineage when
 * this store captures history, else `undefined`. Every caller that wants a
 * `lineage` — graph-merge's base-token anchor and pruned diff among
 * them — consults this function instead of re-deriving the choice.
 */
export function resolveLineage<G extends GraphDef>(
  store: RecordedLineageStore<G>,
): LineageMembers | undefined {
  const backend = storeBackend(store);
  if (backend.lineage !== undefined) return backend.lineage;
  if (store.historyEnabled) return recordedRelationsLineage(store);
  return undefined;
}
