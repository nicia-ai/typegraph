/**
 * Derives the backend's optional `lineage` capability
 * (`backend/capabilities/lineage.ts`) from TypeGraph's own recorded
 * relations, for a store that captures history — and the one place that
 * picks between an engine's own `lineage` and this derived one.
 *
 * ## Revision encoding
 *
 * `revision()` reports `<origin>:<clock>` as an `EngineRevision`: the
 * graph's durable, random revision-origin nonce ({@link readRevisionOrigin},
 * minted on demand through `store.allocationOwner()` — the SAME
 * `typegraph_revision_origins` row `base-version.ts`'s revision and engine
 * anchors bind to), joined to the graph's recorded-time clock (the same
 * value `store.revisionNow()` exposes, or the fixed genesis token before
 * this graph has ever advanced its clock). The clock half is per GRAPH, not
 * per engine — stricter than the general `LineageMembers` contract, which
 * describes a whole-database revision — and is exactly the anchor the
 * base-version token already uses, so it costs nothing new to read.
 *
 * The origin half is what makes the token safe to compare across a
 * `Store.clear()` boundary or a numerically coincidental clock from a
 * different physical store sharing this `graphId` (see "Token identity"
 * below): `changesSince` parses it back out of `since` and treats a
 * mismatch against the graph's LIVE origin exactly like an unparseable
 * revision — `unbounded`, never a guess. `revision()` resolves the origin
 * entirely through `store.allocationOwner()` rather than reading
 * {@link readRevisionOrigin} on `session` itself first: minting a
 * never-before-seen origin is a WRITE (schema DDL plus an insert), and for a
 * capture-enabled store `session` is often the recorded-capture wrapper,
 * which refuses raw `executeStatement` regardless of which table it
 * targets — but even a plain READ of the origins relation cannot safely run
 * on `session` ahead of that DDL: a backend whose `ensureRevisionOriginsTable`
 * provisions the relation lazily (see `Store.clear()`'s own comment on this)
 * has no such table at all until something ensures it, and `session` (a
 * `LineageSession`) carries no `ensureRevisionOriginsTable` member of its
 * own to do that with. `Store.allocationOwner()` already knows both how to
 * ensure the relation and how to route the read/mint around the
 * recorded-capture wrapper onto the store's raw backend (see its own doc
 * comment), so this module defers to it completely rather than re-deriving
 * either half.
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
 * guessing. The same is true of a token this module never minted at all
 * (a garbage string, or one from a different `lineage` source): it fails
 * {@link parseLineageRevision}'s grammar and is treated identically.
 *
 * ## Completeness evidence
 *
 * The delta is trustworthy only when EVERY commit that touched this graph
 * between `since` and the current clock left recorded-relation evidence —
 * TypeGraph's revision clock is shared between `revisionTracking` and
 * `history` (see `clock.ts`'s `advanceRevisionClock`), so a second `Store`
 * over the same backend/graph constructed with `revisionTracking: true` but
 * no `history` advances the SAME clock without ever inserting a recorded
 * row, and a graph that ran that way before `history: true` was ever
 * enabled has an identical gap at its start. Both are the same shape: a
 * revision this graph's clock reached with no row in any recorded relation
 * to show for it.
 *
 * `changesSince` proves completeness directly rather than inferring it from
 * a ceiling: {@link evidencedRevisionCount} counts the DISTINCT revisions in
 * `(since, current]` that have direct evidence — a `recorded_from` or a
 * non-sentinel `recorded_to` — in ANY of the three recorded relations
 * (nodes, edges, identity assertions; folding identity assertions in keeps a
 * graph whose earliest commits only asserted identities from looking like a
 * gap). Every capturing commit allocates exactly one revision and touches
 * EITHER `recorded_from` (an insert, update, soft delete, or resurrection)
 * OR `recorded_to` (a hard delete, which closes the open row without
 * inserting a replacement) AT that revision — never neither — so a
 * genuinely complete span has EXACTLY `current - since` evidenced revisions,
 * one per commit. Fewer than that means some revision in the span has no
 * evidence at all: a hole, wherever in the span it falls. Unlike a
 * ceiling-only check, this catches a non-capturing write REGARDLESS of
 * whether a later capturing commit follows it — there is no way for a
 * subsequent commit to "close" a hole that already happened, because the
 * missing revision itself never gets evidence no matter what comes after.
 *
 * Two commit shapes can legitimately allocate a revision and leave ZERO
 * evidence behind. A kind-level hard delete (`closeRecordedHardDeletedKind`
 * in `flush.ts`, run when a schema migration removes a node or edge kind)
 * over a kind that currently has no live rows: the
 * `UPDATE ... WHERE recorded_to = sentinel` it issues matches nothing, so
 * neither column moves at that revision. And a forced revision
 * (`forceRecordedGraphRevision`, which every `applyMergePlan` requests so an
 * applied plan always advances the target's anchor, honored by `flush()`'s
 * forced-revision branch with an empty entity list) when the plan carried no
 * writes at all. When such a commit is the ONLY thing that happened at that
 * revision, the evidence count comes up one short of a span that in truth
 * changed nothing for this graph, and `changesSince` reports `unbounded`
 * even though the honest answer would have been an empty `"keys"` delta. This is the capability's fail-open contract working
 * as designed: a false `unbounded` costs a caller an avoidable full
 * comparison, never a missed change, so it is accepted rather than special-cased.
 *
 * A raw `GraphBackend` write bypassing every `Store` entirely, or an
 * engine-side mutation outside TypeGraph, is a DIFFERENT shape than the gap
 * above and this evidence count cannot catch it: such a write never
 * allocates a revision on this graph's clock at all, so `currentRevision`
 * does not move to account for it, the evidence count still comes out
 * exactly equal to `currentRevision - since`, and the row it touched is
 * simply absent from the `"keys"` delta with no signal anywhere that
 * anything was missed. Routing every writer through a capturing `Store` is
 * the only way to keep this source's delta exhaustive; nothing in
 * `changesSince` can detect a writer that never touched the clock it reads.
 * The only writer this module RULES OUT rather than merely fails to catch is
 * one that advances a DIFFERENT graph's clock or touches a different
 * database — `refuseForeignGraph` and the origin check below reject those
 * before this check ever runs.
 *
 * ## Token identity is scoped to one graph, not one physical store
 *
 * Two independently created stores that happen to share a `graphId` mint
 * numerically comparable clock values (a fresh database starts counting
 * from the same low integers as any other), and the SAME store's clock
 * after `clear()` restarts numbering too (`Store.clear()` drops the
 * recorded relations and the clock row, and rotates the origin — see
 * `resetRevisionOrigin`). The origin half of the token is what makes
 * this safe: `changesSince` reads the graph's LIVE origin and refuses
 * (`unbounded`) whenever it differs from the one embedded in `since`, so a
 * revision minted before a `clear()`, or by a different physical store that
 * happens to share this `graphId`, can never satisfy a post-clear or
 * cross-store comparison even when the numeric clock values coincide. Every
 * caller that anchors ACROSS stores or across time —
 * `base-version.ts`'s revision-anchor branch, `branch()`'s `forkRevision`
 * capture, and `staging.ts`'s pruning are the ones today — gets this check
 * for free by going through `revision()`/`changesSince()` rather than
 * comparing a bare clock value itself. `base-version.ts`'s OWN `base@V`
 * token grammar carries a separate, independently-checked origin pairing
 * for its own revision anchor (see that module's doc and
 * `revisionOriginMatch`) — the two origin checks protect different tokens
 * and neither substitutes for the other, though both draw on the same
 * durable `typegraph_revision_origins` row.
 */
import { isFirstPartyFactory } from "../../backend/capabilities/write-fence";
import { assertRevisionChangesJournalReady } from "../../backend/revision-journal";
import {
  type EngineRevision,
  type EntityKey,
  type LineageDelta,
  type LineageMembers,
  type LineageSession,
} from "../../backend/types";
import { type GraphAllocationOwner } from "../../core/allocation-owner";
import { type GraphDef } from "../../core/define-graph";
import {
  asRecordedInstant,
  RECORDED_MAX_REVISION,
  recordedInstantRevision,
} from "../../core/temporal";
import {
  ConfigurationError,
  type ReadSetChangedKey,
  type ReadSetEdgeDirection,
  type ReadSetScopeChange,
  type ReadSetScopeDescriptor,
} from "../../errors";
import {
  resolveRevisionChangesTableName,
  type SqlSchema,
} from "../../query/compiler/schema";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import { asCompiledRowsSql } from "../../query/sql-intent";
import { type ReadSetDelta } from "../read-set";
import {
  type STORE_RUNTIME,
  storeBackend,
  storeCaptureEnabled,
  type StoreRuntime,
} from "../runtime-port";
import { readRecordedClock, readRevisionOrigin } from "./clock";

/**
 * The minimal store surface {@link recordedRelationsLineage} and
 * {@link resolveLineage} need: the graph this lineage answers for, the
 * schema naming the physical recorded relations, and the runtime port
 * reaching the store's own backend and its `storeCaptureEnabled` flag —
 * whether this store captures history through TypeGraph's own recorded
 * relations, not merely whether `history: true` was requested (an
 * engine-native store answers that too, without ever populating them; see
 * `storeCaptureEnabled`'s own doc comment).
 *
 * A structural type rather than the `Store` class itself: `store/store.ts`
 * constructs the store's runtime port using exports from this same
 * `recorded-capture` family, so importing `Store` back here would cycle.
 * Every real `Store<G>` already carries these members, so a live store is
 * assignable to this type without adaptation.
 */
export type RecordedLineageStore<G extends GraphDef = GraphDef> = Readonly<{
  graphId: string;
  revisionTrackingEnabled: boolean;
  revisionJournalEnabled?: boolean;
  revisionSchema: SqlSchema;
  /**
   * Mints (or returns) this graph's durable revision-origin nonce, always
   * through the store's OWN raw backend regardless of which session called
   * it — see `Store.allocationOwner()`'s own doc for why it deliberately
   * bypasses the recorded-capture wrapper. `revision()` defers to this
   * rather than re-deriving the mint here: a capture-enabled store's
   * wrapped backend refuses raw `executeStatement` outright (it exists to
   * catch a graph write bypassing capture), so minting through anything
   * `resolveLineage`'s callers might pass as a `LineageSession` — which,
   * for a history-enabled store, is that very wrapper — would refuse for a
   * reason that has nothing to do with this row.
   */
  allocationOwner: () => Promise<GraphAllocationOwner>;
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
 * The `since`-half of {@link recordedRelationsLineage}'s revision grammar
 * when this graph has never advanced its recorded clock: `revision()`
 * reports `<origin>${LINEAGE_REVISION_SEPARATOR}${GENESIS_REVISION_TOKEN}`
 * rather than a real `RecordedInstant`. Deliberately NOT a valid
 * `RecordedInstant` (it fails that grammar), so it can never collide with a
 * real committed revision; recognized only by this module's own
 * `parseLineageRevision`, per the opaque-token contract every `lineage`
 * source shares.
 *
 * This is a distinct constant from `base-version.ts`'s `INITIAL_REVISION`,
 * not a re-spelling of one predicate: that string lives in the `EngineRevision`
 * grammar. `store/recorded-capture` sits below `graph-merge` in the
 * dependency graph, so this module cannot import the base-token constant
 * without inverting that layering.
 */
const GENESIS_REVISION_TOKEN = "recorded-relations-lineage:genesis";
const GENESIS_REVISION_NUMBER = 0;

/**
 * Separates the durable per-graph origin from the clock half of a bundled
 * `EngineRevision` (see the module doc's "Revision encoding" and "Token
 * identity" sections). `generateId()` origins never contain this character
 * (URL-safe nanoid alphabet), so splitting at the FIRST occurrence
 * unambiguously recovers the origin even though the clock half — a
 * `RecordedInstant`, itself colon-delimited — contains more of them.
 */
const LINEAGE_REVISION_SEPARATOR = ":";

const UNBOUNDED_DELTA: LineageDelta = Object.freeze({ kind: "unbounded" });
const UNBOUNDED_READ_SET_DELTA: ReadSetDelta = Object.freeze({
  kind: "unbounded",
});

/**
 * THE one owner of the bundled `EngineRevision` grammar: `<origin>` then
 * {@link LINEAGE_REVISION_SEPARATOR} then either a real `RecordedInstant` or
 * {@link GENESIS_REVISION_TOKEN} (`instant` omitted). Used by `revision()`
 * to mint the token, and by `base-version.ts`'s `lineageDeltaSinceAnchor` to
 * rebuild the equivalent token from a `base@V` revision anchor's own
 * (already-verified) origin and revision components — so neither producer
 * hand-spells the separator.
 */
export function encodeRecordedLineageRevision(
  origin: string,
  instant: string | undefined,
): EngineRevision {
  return brandEngineRevision(
    `${origin}${LINEAGE_REVISION_SEPARATOR}${instant ?? GENESIS_REVISION_TOKEN}`,
  );
}

/**
 * Decodes a `COUNT`/`MIN`/`MAX`-shaped aggregate value into a JS number.
 * BIGINT columns come back as a `bigint` on some drivers and a numeric
 * string on others (PostgreSQL's default driver never parses BIGINT), so
 * both are normalized alongside the plain-number case a small SQLite value
 * already arrives as.
 */
function decodeAggregateRevision(value: bigint | number | string): number {
  return typeof value === "number" ? value : Number(value);
}

/**
 * Parses an `EngineRevision` this module minted back into the durable
 * origin and the numeric per-graph revision `changesSince` compares columns
 * against, or `undefined` for anything that does not fit the grammar — a
 * token from an unrelated `lineage` source, or a corrupted value.
 * `changesSince` treats an unparseable revision the same as a live-origin
 * mismatch or one newer than the clock: unknown, so `unbounded`.
 */
function parseLineageRevision(
  revision: EngineRevision,
): Readonly<{ origin: string; revision: number }> | undefined {
  const separatorIndex = revision.indexOf(LINEAGE_REVISION_SEPARATOR);
  if (separatorIndex <= 0) return undefined;
  const origin = revision.slice(0, separatorIndex);
  const remainder = revision.slice(separatorIndex + 1);
  if (remainder === GENESIS_REVISION_TOKEN) {
    return { origin, revision: GENESIS_REVISION_NUMBER };
  }
  try {
    return {
      origin,
      revision: recordedInstantRevision(asRecordedInstant(remainder)),
    };
  } catch {
    return undefined;
  }
}

/**
 * The number of DISTINCT revisions in `(sinceRevision, currentRevision]`
 * with direct completeness evidence — a `recorded_from` or a non-sentinel
 * `recorded_to` — in ANY of the three recorded relations for this graph
 * (nodes, edges, identity assertions). This is the whole completeness
 * check `changesSince` runs (see the module doc's "Completeness evidence"):
 * a genuinely complete span has exactly `currentRevision - sinceRevision`
 * evidenced revisions, one per capturing commit; fewer means a hole
 * somewhere in the span, regardless of where.
 *
 * Evidence means EITHER column, not `recorded_from` alone: an insert,
 * update, soft delete, or resurrection writes a row whose `recorded_from`
 * is the allocated revision, but a HARD delete closes the existing open row
 * — moving ONLY its `recorded_to` to the allocated revision — without
 * inserting any row at that revision (see the module doc's per-write-shape
 * breakdown). Excluding the open-interval sentinel from the `recorded_to`
 * arm is required for the same reason `changedEntityKeys` excludes it: a
 * still-open row's sentinel must never itself register as activity at the
 * sentinel revision.
 */
async function evidencedRevisionCount(
  session: LineageSession,
  schema: SqlSchema,
  graphId: string,
  sinceRevision: number,
  currentRevision: number,
): Promise<number> {
  const rows = await session.execute<
    Readonly<{ evidenced: bigint | number | string | null }>
  >(
    asCompiledRowsSql(sql`
      SELECT COUNT(DISTINCT rev) AS evidenced FROM (
        SELECT recorded_from AS rev FROM ${schema.recordedNodesTable}
          WHERE graph_id = ${graphId} AND recorded_from > ${sinceRevision} AND recorded_from <= ${currentRevision}
        UNION ALL
        SELECT recorded_to AS rev FROM ${schema.recordedNodesTable}
          WHERE graph_id = ${graphId} AND recorded_to <> ${RECORDED_MAX_REVISION} AND recorded_to > ${sinceRevision} AND recorded_to <= ${currentRevision}
        UNION ALL
        SELECT recorded_from AS rev FROM ${schema.recordedEdgesTable}
          WHERE graph_id = ${graphId} AND recorded_from > ${sinceRevision} AND recorded_from <= ${currentRevision}
        UNION ALL
        SELECT recorded_to AS rev FROM ${schema.recordedEdgesTable}
          WHERE graph_id = ${graphId} AND recorded_to <> ${RECORDED_MAX_REVISION} AND recorded_to > ${sinceRevision} AND recorded_to <= ${currentRevision}
        UNION ALL
        SELECT recorded_from AS rev FROM ${schema.recordedIdentityAssertionsTable}
          WHERE graph_id = ${graphId} AND recorded_from > ${sinceRevision} AND recorded_from <= ${currentRevision}
        UNION ALL
        SELECT recorded_to AS rev FROM ${schema.recordedIdentityAssertionsTable}
          WHERE graph_id = ${graphId} AND recorded_to <> ${RECORDED_MAX_REVISION} AND recorded_to > ${sinceRevision} AND recorded_to <= ${currentRevision}
      ) AS lineage_evidenced_revisions
    `),
  );
  const evidenced = rows[0]?.evidenced;
  return evidenced === null || evidenced === undefined ?
      0
    : decodeAggregateRevision(evidenced);
}

/**
 * THE two-armed "changed strictly after `sinceRevision`" predicate over one
 * recorded relation's rows: a version opened after it, or a version closed
 * after it. See the module doc for why the two arms cover every write shape.
 */
function changedAfterRevision(sinceRevision: number): SqlFragment {
  return sql`
    (
              recorded_from > ${sinceRevision}
              OR (recorded_to > ${sinceRevision} AND recorded_to <> ${RECORDED_MAX_REVISION})
            )
  `;
}

/**
 * The distinct `(kind, id)` keys of one recorded relation's rows of
 * `graphId` that changed strictly after `sinceRevision`, narrowed by
 * `filter` when given. The changed-since predicate is
 * {@link changedAfterRevision}, never re-spelled.
 */
function changedKeysSelect(
  table: SqlFragment,
  graphId: string,
  sinceRevision: number,
  filter?: SqlFragment,
): SqlFragment {
  return sql`
    SELECT DISTINCT kind, id
    FROM ${table}
    WHERE graph_id = ${graphId}
      ${filter === undefined ? sql.empty() : sql`AND ${filter}`}
      AND ${changedAfterRevision(sinceRevision)}
  `;
}

/**
 * Every `(kind, id)` in one recorded relation with a change strictly after
 * `sinceRevision` — the shared query behind both the node and edge halves
 * of a `"keys"` delta. See the module doc for why the two-armed predicate
 * covers every write shape and why `DISTINCT` is what keeps a row that
 * matches both arms (a resurrection) from being reported twice.
 */
function changedEntityKeys(
  session: LineageSession,
  table: SqlFragment,
  graphId: string,
  sinceRevision: number,
): Promise<readonly EntityKey[]> {
  return changedEntityKeysWhere(session, table, graphId, sinceRevision, [
    undefined,
  ]);
}

/**
 * {@link changedEntityKeys} narrowed to the rows one or more `filters`
 * select, as the distinct union of every filter's keys. Each filter is a
 * conjunction over the relation's own columns that one of its indexes
 * answers (`entity_idx` for `kind, id`, `from_idx` / `to_idx` for an edge
 * endpoint); `undefined` selects the whole graph.
 */
async function changedEntityKeysWhere(
  session: LineageSession,
  table: SqlFragment,
  graphId: string,
  sinceRevision: number,
  filters: readonly (SqlFragment | undefined)[],
): Promise<readonly EntityKey[]> {
  const selects = filters.map((filter) =>
    changedKeysSelect(table, graphId, sinceRevision, filter),
  );
  const rows = await session.execute<Readonly<{ kind: string; id: string }>>(
    asCompiledRowsSql(sql`
      ${sql.join(selects, sql` UNION `)}
      ORDER BY kind, id
    `),
  );
  return rows.map((row) => ({ kind: row.kind, id: row.id }));
}

/**
 * Whether any identity assertion of `graphId` changed strictly after `since` —
 * the same two-armed predicate {@link changedEntityKeys} applies to nodes and
 * edges, asked of the recorded identity-assertions relation.
 *
 * A `"keys"` delta names nodes and edges only. {@link evidencedRevisionCount}
 * still counts an identity assertion as completeness evidence, deliberately:
 * the merge diff that prunes by this source reads identity through its own
 * path and needs the node/edge delta to stay bounded across an identity write.
 * A caller holding only the key delta has no such second path, so a span this
 * answers `true` for changed something that delta cannot name. A token this
 * module did not mint has no revision to compare, and is reported as changed.
 */
async function recordedIdentityChangedSince<G extends GraphDef>(
  store: RecordedLineageStore<G>,
  session: LineageSession,
  since: EngineRevision,
): Promise<boolean> {
  const parsed = parseLineageRevision(since);
  if (parsed === undefined) return true;
  const rows = await session.execute<Readonly<{ changed: unknown }>>(
    asCompiledRowsSql(sql`
      SELECT 1 AS changed
      FROM ${store.revisionSchema.recordedIdentityAssertionsTable}
      WHERE graph_id = ${store.graphId}
        AND ${changedAfterRevision(parsed.revision)}
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/**
 * One declared read-set scope after the store validated it, in the terms a
 * lineage source answers: which rows the scope covers, and the scope's
 * position in the caller's list.
 */
export type ReadSetRegion = Readonly<{ index: number }> &
  ReadSetScopeDescriptor;

/** How a changed region is reported: its position and its descriptor. */
function reportedScope(
  region: ReadSetRegion,
): Pick<ReadSetScopeChange, "index" | "scope"> {
  const { index, ...scope } = region;
  return { index, scope };
}

/** Whether a scope's report names at least one changed key. */
function scopeChanged(change: ReadSetScopeChange): boolean {
  return change.nodes.length > 0 || change.edges.length > 0;
}

/** The recorded-edges filter selecting the edges at one endpoint of a node. */
function recordedEdgeEndpointFilter(
  endpoint: "from" | "to",
  nodeKind: string,
  nodeId: string,
  edgeKind: string | undefined,
): SqlFragment {
  const endpointMatch =
    endpoint === "from" ?
      sql`from_kind = ${nodeKind} AND from_id = ${nodeId}`
    : sql`to_kind = ${nodeKind} AND to_id = ${nodeId}`;
  return edgeKind === undefined ? endpointMatch : (
      sql`${endpointMatch} AND kind = ${edgeKind}`
    );
}

const EDGE_ENDPOINTS_BY_DIRECTION: Readonly<
  Record<ReadSetEdgeDirection, readonly ("from" | "to")[]>
> = {
  out: ["from"],
  in: ["to"],
  both: ["from", "to"],
};

/**
 * One region's changed keys after `sinceRevision`, read by index seek from
 * the recorded relations: a row by `(graph_id, kind, id)` (`entity_idx`), a
 * neighbourhood by its endpoint (`from_idx` / `to_idx`, both directions as a
 * union), a kind by `(graph_id, kind)`, the whole graph by the whole-graph
 * keys.
 */
async function recordedRegionChange(
  session: LineageSession,
  schema: SqlSchema,
  graphId: string,
  sinceRevision: number,
  region: ReadSetRegion,
): Promise<ReadSetScopeChange> {
  const noKeys: readonly ReadSetChangedKey[] = [];
  switch (region.target) {
    case "node": {
      const nodes = await changedEntityKeysWhere(
        session,
        schema.recordedNodesTable,
        graphId,
        sinceRevision,
        [sql`kind = ${region.kind} AND id = ${region.id}`],
      );
      return { ...reportedScope(region), nodes, edges: noKeys };
    }
    case "edge": {
      const edges = await changedEntityKeysWhere(
        session,
        schema.recordedEdgesTable,
        graphId,
        sinceRevision,
        [sql`kind = ${region.kind} AND id = ${region.id}`],
      );
      return { ...reportedScope(region), nodes: noKeys, edges };
    }
    case "edgesAt": {
      const edges = await changedEntityKeysWhere(
        session,
        schema.recordedEdgesTable,
        graphId,
        sinceRevision,
        EDGE_ENDPOINTS_BY_DIRECTION[region.direction].map((endpoint) =>
          recordedEdgeEndpointFilter(
            endpoint,
            region.nodeKind,
            region.nodeId,
            region.edgeKind,
          ),
        ),
      );
      return { ...reportedScope(region), nodes: noKeys, edges };
    }
    case "nodeKind": {
      const nodes = await changedEntityKeysWhere(
        session,
        schema.recordedNodesTable,
        graphId,
        sinceRevision,
        [sql`kind = ${region.kind}`],
      );
      return { ...reportedScope(region), nodes, edges: noKeys };
    }
    case "edgeKind": {
      const edges = await changedEntityKeysWhere(
        session,
        schema.recordedEdgesTable,
        graphId,
        sinceRevision,
        [sql`kind = ${region.kind}`],
      );
      return { ...reportedScope(region), nodes: noKeys, edges };
    }
    case "graph": {
      const nodes = await changedEntityKeys(
        session,
        schema.recordedNodesTable,
        graphId,
        sinceRevision,
      );
      const edges = await changedEntityKeys(
        session,
        schema.recordedEdgesTable,
        graphId,
        sinceRevision,
      );
      return { ...reportedScope(region), nodes, edges };
    }
  }
}

/** One changed row of a key delta, as {@link readSetRegionContains} tests it. */
type ChangedRow = Readonly<{ entity: "node" | "edge"; key: EntityKey }>;

/** Whether an `edgesAt` region names an edge of `edgeKind`. */
function neighbourhoodCoversEdgeKind(
  region: Readonly<{ edgeKind: string | undefined }>,
  edgeKind: string,
): boolean {
  return region.edgeKind === undefined || region.edgeKind === edgeKind;
}

/**
 * THE one predicate deciding whether a changed row of a key delta falls
 * inside a declared region — the answer every non-recorded source gives by
 * filtering.
 *
 * A key delta names an edge by kind and id only, never by the endpoints it
 * had. Reading its endpoints now would not help: an edge can be hard deleted
 * and recreated under the same id at other endpoints, so its current row
 * cannot prove where it was during the span. A neighbourhood therefore
 * counts every changed edge of its kind — sound, at the price of refusing
 * when an edge of that kind changed elsewhere. The recorded relations keep
 * every version's endpoints and answer a neighbourhood exactly.
 */
function readSetRegionContains(
  region: ReadSetRegion,
  row: ChangedRow,
): boolean {
  switch (region.target) {
    case "node": {
      return (
        row.entity === "node" &&
        row.key.kind === region.kind &&
        row.key.id === region.id
      );
    }
    case "edge": {
      return (
        row.entity === "edge" &&
        row.key.kind === region.kind &&
        row.key.id === region.id
      );
    }
    case "edgesAt": {
      return (
        row.entity === "edge" &&
        neighbourhoodCoversEdgeKind(region, row.key.kind)
      );
    }
    case "nodeKind": {
      return row.entity === "node" && row.key.kind === region.kind;
    }
    case "edgeKind": {
      return row.entity === "edge" && row.key.kind === region.kind;
    }
    case "graph": {
      return true;
    }
  }
}

/**
 * A key delta filtered region by region with {@link readSetRegionContains}:
 * the answer of every source without a scoped read of its own.
 */
function regionChangesFromKeyDelta(
  delta: LineageDelta,
  regions: readonly ReadSetRegion[],
): ReadSetDelta {
  if (delta.kind === "unbounded") return UNBOUNDED_READ_SET_DELTA;
  const changes = regions
    .map((region) => ({
      ...reportedScope(region),
      nodes: delta.nodes.filter((key) =>
        readSetRegionContains(region, { entity: "node", key }),
      ),
      edges: delta.edges.filter((key) =>
        readSetRegionContains(region, { entity: "edge", key }),
      ),
    }))
    .filter((change) => scopeChanged(change));
  return { kind: "changes", changes };
}

/**
 * Builds a `lineage` capability sourced from `store`'s own recorded
 * relations. Callers get this indirectly through {@link resolveLineage};
 * call it directly only to consult the recorded-relations source even when
 * the backend also declares its own `lineage` (e.g. the conformance suite).
 *
 * `revision`/`changesSince` run every READ on the {@link LineageSession}
 * they are given, never on a backend this function closed over — the same
 * "session facts come from the session that enforces them" contract every
 * `LineageMembers` implementation honors (see that type's own doc). Every
 * call graph-merge makes into this source (`branch()`'s fork-revision
 * capture, `staging.ts`'s pruning, `base-version.ts`'s
 * `lineageDeltaSinceAnchor`) runs at PLANNING time, strictly outside any
 * commit transaction, and passes the root backend it already holds as the
 * session — the recorded-relations source never actually reaches a
 * `transaction()` handle today, but nothing in `changesSince`'s
 * implementation depends on that: it reads correctly on whatever session a
 * future caller hands it, transaction handle included. `revision()`'s
 * ORIGIN resolution (`resolveOrigin`, see its own doc) is the one
 * exception: it always goes through `store.allocationOwner()`, never
 * `session`, for BOTH the mint and the ordinary read — minting is a WRITE,
 * and `session` for a capture-enabled store's `lineage` is the
 * recorded-capture wrapper, which refuses raw `executeStatement` outright,
 * but even a plain read cannot safely run on `session` ahead of the DDL
 * that guarantees the origins relation exists. `changesSince`'s own
 * live-origin comparison (below) DOES read on `session`, unlike
 * `resolveOrigin`: by the time a real `since` token reaches it, some prior
 * `revision()` call already minted this graph's origin through
 * `store.allocationOwner()`, so the relation is already physically
 * present for any session sharing that database.
 */
export function recordedRelationsLineage<G extends GraphDef>(
  store: RecordedLineageStore<G>,
): LineageMembers {
  return recordedRelationsSource(store).lineage;
}

/**
 * The recorded-relations source behind {@link recordedRelationsLineage}: its
 * `lineage` members and the scoped read-set answer only this source can give
 * by index seek ({@link LineageSource}'s `readSetDelta`). Both prove the
 * span through one helper, `provenSpanStart`, so the whole-graph delta and
 * the scoped one can never disagree about which anchors they can answer.
 */
function recordedRelationsSource<G extends GraphDef>(
  store: RecordedLineageStore<G>,
): Pick<LineageSource, "lineage" | "readSetDelta"> {
  if (!storeCaptureEnabled(store)) {
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

  /**
   * Resolves this graph's durable revision-origin nonce entirely through
   * `store.allocationOwner()` — never by reading {@link readRevisionOrigin}
   * on `session` first. A direct read on `session` would throw rather than
   * return `undefined` on a backend whose `ensureRevisionOriginsTable`
   * provisions the origins relation lazily (see the module doc's "Revision
   * encoding" section): the relation would not exist yet, and `session` (a
   * `LineageSession`) has no `ensureRevisionOriginsTable` member with which
   * to create it. `store.allocationOwner()` already ensures the relation
   * and mints a fresh origin only when none exists, so this function has no
   * ensure-or-mint logic of its own to get out of step with it. Takes no
   * `session`: there is nothing left for one to read.
   */
  function resolveOrigin(): Promise<string> {
    return store.allocationOwner().then((owner) => owner.origin);
  }

  async function revision(session: LineageSession): Promise<EngineRevision> {
    const [origin, instant] = await Promise.all([
      resolveOrigin(),
      readRecordedClock(session, schema, graphId),
    ]);
    return encodeRecordedLineageRevision(origin, instant);
  }

  /**
   * The numeric revision `since` names when this source can prove the span
   * from it to the graph's current clock, else `undefined` (`unbounded`):
   * the token parses, its origin is the graph's LIVE origin, it is not newer
   * than the clock, and every revision in the span left recorded evidence.
   */
  async function provenSpanStart(
    session: LineageSession,
    since: EngineRevision,
  ): Promise<number | undefined> {
    const parsed = parseLineageRevision(since);
    if (parsed === undefined) return undefined;

    // Token identity (see the module doc): a revision minted before this
    // graph's origin last rotated (a `clear()`), or by a different physical
    // store that happens to share this `graphId`, can never satisfy this
    // check even when the numeric clock values below coincide. Reading
    // directly on `session` (rather than through `resolveOrigin`) is safe
    // here, unlike in `revision()`: a real `since` already came from some
    // earlier `revision()` call, which only ever returns after
    // `store.allocationOwner()` has ensured the origins relation exists.
    const liveOrigin = await readRevisionOrigin(session, schema, graphId);
    if (liveOrigin === undefined || liveOrigin !== parsed.origin) {
      return undefined;
    }

    const requested = parsed.revision;
    const currentInstant = await readRecordedClock(session, schema, graphId);
    const currentRevision =
      currentInstant === undefined ?
        GENESIS_REVISION_NUMBER
      : recordedInstantRevision(currentInstant);
    if (requested > currentRevision) return undefined;

    if (requested < currentRevision) {
      // Completeness evidence (see the module doc): the span is trustworthy
      // only when EVERY revision in it left a recorded row behind.
      const evidenced = await evidencedRevisionCount(
        session,
        schema,
        graphId,
        requested,
        currentRevision,
      );
      if (evidenced < currentRevision - requested) return undefined;
    }
    return requested;
  }

  async function changesSince(
    session: LineageSession,
    since: EngineRevision,
    requestedGraphId: string,
  ): Promise<LineageDelta> {
    refuseForeignGraph(requestedGraphId);
    const requested = await provenSpanStart(session, since);
    if (requested === undefined) return UNBOUNDED_DELTA;

    const [nodes, edges] = await Promise.all([
      changedEntityKeys(session, schema.recordedNodesTable, graphId, requested),
      changedEntityKeys(session, schema.recordedEdgesTable, graphId, requested),
    ]);
    return { kind: "keys", nodes, edges };
  }

  /**
   * Answers each region with an index seek over the recorded relations
   * ({@link recordedRegionChange}). Regions are read one after another: the
   * session is a transaction, and a driver may refuse overlapping queries
   * on one connection.
   */
  async function readSetDelta(
    session: LineageSession,
    since: EngineRevision,
    regions: readonly ReadSetRegion[],
  ): Promise<ReadSetDelta> {
    const requested = await provenSpanStart(session, since);
    if (requested === undefined) return UNBOUNDED_READ_SET_DELTA;
    const changes: ReadSetScopeChange[] = [];
    for (const region of regions) {
      const change = await recordedRegionChange(
        session,
        schema,
        graphId,
        requested,
        region,
      );
      if (scopeChanged(change)) changes.push(change);
    }
    return { kind: "changes", changes };
  }

  return {
    lineage: Object.freeze({ revision, changesSince }),
    readSetDelta,
  };
}

/**
 * Journal-backed lineage for live revision-tracked Stores. Bundled SQL
 * backends use row triggers installed by a privileged schema owner to write
 * every node/edge key into the same transaction as its mutation. A non-entity
 * sidecar write leaves an incomplete journal row, so this source refuses to
 * claim a complete delta.
 */
function revisionJournalSource<G extends GraphDef>(
  store: RecordedLineageStore<G>,
): Pick<LineageSource, "lineage" | "readSetDelta"> {
  const schema = store.revisionSchema;
  const graphId = store.graphId;

  /**
   * The journal's key delta read on `session` alone. Journal readiness is
   * checked by the callers below, on the store's own backend, which is a
   * second connection: inside a transaction on an engine that admits one
   * connection at a time, that check would wait on the very transaction
   * that asked.
   */
  async function journalKeyDelta(
    session: LineageSession,
    since: EngineRevision,
  ): Promise<LineageDelta> {
    const parsed = parseLineageRevision(since);
    if (parsed === undefined) return UNBOUNDED_DELTA;
    const liveOrigin = await readRevisionOrigin(session, schema, graphId);
    if (liveOrigin === undefined || liveOrigin !== parsed.origin) {
      return UNBOUNDED_DELTA;
    }
    const currentInstant = await readRecordedClock(session, schema, graphId);
    const current =
      currentInstant === undefined ? 0 : (
        recordedInstantRevision(currentInstant)
      );
    if (parsed.revision > current) return UNBOUNDED_DELTA;
    if (parsed.revision === current) {
      return { kind: "keys", nodes: [], edges: [] };
    }

    const rows = await session.execute<
      Readonly<{
        revision_count: string;
        all_complete: number;
        entity: unknown;
        kind: unknown;
        id: unknown;
      }>
    >(
      asCompiledRowsSql(sql`
        WITH changes AS (
          SELECT revision, entity, kind, id, complete
          FROM ${sql.identifier(resolveRevisionChangesTableName(schema.tables))}
          WHERE graph_id = ${graphId} AND revision > ${parsed.revision}
            AND revision <= ${current}
        ), summary AS (
          SELECT CAST(count(DISTINCT revision) AS text) AS revision_count,
            COALESCE(min(CASE WHEN complete AND entity IN ('node', 'edge')
              THEN 1 ELSE 0 END), 1) AS all_complete
          FROM changes
        )
        SELECT summary.revision_count, summary.all_complete,
          keys.entity, keys.kind, keys.id
        FROM summary LEFT JOIN (
          SELECT DISTINCT entity, kind, id FROM changes
          WHERE entity IN ('node', 'edge')
        ) AS keys ON TRUE
        ORDER BY keys.entity, keys.kind, keys.id
      `),
    );
    const summary = rows[0];
    if (
      summary === undefined ||
      Number(summary.revision_count) !== current - parsed.revision ||
      summary.all_complete !== 1
    ) {
      return UNBOUNDED_DELTA;
    }
    const nodes: EntityKey[] = [];
    const edges: EntityKey[] = [];
    for (const row of rows) {
      if (typeof row.entity !== "string") continue;
      if (typeof row.kind !== "string" || typeof row.id !== "string")
        return UNBOUNDED_DELTA;
      if (row.entity === "node") nodes.push({ kind: row.kind, id: row.id });
      if (row.entity === "edge") edges.push({ kind: row.kind, id: row.id });
    }
    return { kind: "keys", nodes, edges };
  }

  const lineage: LineageMembers = Object.freeze({
    async revision(session: LineageSession): Promise<EngineRevision> {
      await assertRevisionChangesJournalReady(storeBackend(store));
      const [origin, instant] = await Promise.all([
        store.allocationOwner().then((owner) => owner.origin),
        readRecordedClock(session, schema, graphId),
      ]);
      return encodeRecordedLineageRevision(origin, instant);
    },
    async changesSince(
      session: LineageSession,
      since: EngineRevision,
      requestedGraphId: string,
    ): Promise<LineageDelta> {
      await assertRevisionChangesJournalReady(storeBackend(store));
      if (requestedGraphId !== graphId) {
        throw new ConfigurationError(
          "revision journal lineage was called for a different graph than the one it was derived from.",
          { expectedGraphId: graphId, actualGraphId: requestedGraphId },
        );
      }
      return journalKeyDelta(session, since);
    },
  });

  /**
   * Runs inside the caller's write transaction, so it relies on the
   * readiness check `revision()` ran when it minted the anchor rather than
   * repeating it on a second connection. A trigger dropped or disabled
   * between the anchor and this check is a change made outside the store, the
   * same class as a write that bypasses it.
   */
  async function readSetDelta(
    session: LineageSession,
    since: EngineRevision,
    regions: readonly ReadSetRegion[],
  ): Promise<ReadSetDelta> {
    return regionChangesFromKeyDelta(
      await journalKeyDelta(session, since),
      regions,
    );
  }

  return { lineage, readSetDelta };
}

/**
 * Whether this store's base token is namespaced by the graph's durable
 * revision origin — true for TypeGraph revision tracking and for an untracked
 * lineage store whose backend supports the origins relation. The latter uses
 * a complete content fingerprint namespaced by that same origin. `Store.clear()`
 * rotates exactly the origins that `computeBaseVersion` can include.
 */
export function mintsOriginNamespacedAnchor<G extends GraphDef>(
  store: RecordedLineageStore<G>,
  originsSupported: boolean,
): boolean {
  return (
    store.revisionTrackingEnabled ||
    (resolveLineage(store) !== undefined && originsSupported)
  );
}

/**
 * A selected lineage source, with the one thing its `"keys"` delta can leave
 * out: `identityChangedSince` is present only on the source whose delta stays
 * bounded across an identity write it does not name.
 */
type LineageSource = Readonly<{
  lineage: LineageMembers;
  identityChangedSince?: (
    session: LineageSession,
    since: EngineRevision,
  ) => Promise<boolean>;
  /**
   * The read-set delta `tx.assertUnchangedSince()` decides from, read on
   * `session`. The recorded relations answer each region by index seek;
   * every other source filters its key delta with
   * {@link readSetRegionContains}.
   */
  readSetDelta: (
    session: LineageSession,
    since: EngineRevision,
    regions: readonly ReadSetRegion[],
  ) => Promise<ReadSetDelta>;
}>;

/**
 * THE one owner of lineage source selection: the backend's own `lineage`
 * when it declares one, else the store's recorded-relations lineage when
 * it captures history, else the trigger-backed revision journal for a
 * revision-tracked first-party SQL backend, else `undefined`. Both
 * {@link resolveLineage} and {@link changesSinceIncludingIdentity} read the
 * choice from here instead of re-deriving it.
 */
function resolveLineageSource<G extends GraphDef>(
  store: RecordedLineageStore<G>,
): LineageSource | undefined {
  const backend = storeBackend(store);
  const engineLineage = backend.lineage;
  if (engineLineage !== undefined) {
    return {
      lineage: engineLineage,
      readSetDelta: async (session, since, regions) =>
        regionChangesFromKeyDelta(
          await engineLineage.changesSince(session, since, store.graphId),
          regions,
        ),
    };
  }
  if (storeCaptureEnabled(store)) {
    return {
      ...recordedRelationsSource(store),
      identityChangedSince: (session, since) =>
        recordedIdentityChangedSince(store, session, since),
    };
  }
  if (
    store.revisionTrackingEnabled &&
    store.revisionJournalEnabled !== false &&
    isFirstPartyFactory(backend)
  ) {
    return revisionJournalSource(store);
  }
  return undefined;
}

/**
 * The lineage a store's graph-merge pruning and base tokens read: the source
 * {@link resolveLineageSource} selects, or `undefined` when there is none.
 * Its `changesSince` is a NODE AND EDGE delta — graph-merge's pruned diff
 * reads identity through its own path, and relies on this staying bounded
 * across an identity write.
 */
export function resolveLineage<G extends GraphDef>(
  store: RecordedLineageStore<G>,
): LineageMembers | undefined {
  return resolveLineageSource(store)?.lineage;
}

/**
 * The delta `Store.changesSince` answers: the selected source's node and edge
 * keys, or `unbounded` whenever an identity change the keys cannot name fell
 * in the span. A caller of the public method has only the keys to go on, so an
 * identity write must never read as "nothing changed".
 *
 * The identity probe runs after the key delta, so a write landing between the
 * two can only turn a bounded answer into `unbounded`, never hide a change.
 */
export async function changesSinceIncludingIdentity<G extends GraphDef>(
  store: RecordedLineageStore<G>,
  session: LineageSession,
  since: EngineRevision,
): Promise<LineageDelta> {
  const source = resolveLineageSource(store);
  if (source === undefined) return UNBOUNDED_DELTA;
  const delta = await source.lineage.changesSince(
    session,
    since,
    store.graphId,
  );
  if (delta.kind === "unbounded") return delta;
  if (source.identityChangedSince === undefined) return delta;
  return (await source.identityChangedSince(session, since)) ?
      UNBOUNDED_DELTA
    : delta;
}

/**
 * The read-set delta `tx.assertUnchangedSince()` decides from: for each
 * declared region, the node and edge keys that changed in it since `since`,
 * or `unbounded` when the selected source cannot prove the span.
 *
 * Built on the node-and-edge delta graph merge reads, not
 * {@link changesSinceIncludingIdentity}: an identity write in the span must
 * not make every read set unverifiable. Each source answers through its own
 * `readSetDelta` (see {@link LineageSource}). Any recorded change counts,
 * including one a later write reversed.
 */
export async function changesInReadSet<G extends GraphDef>(
  store: RecordedLineageStore<G>,
  session: LineageSession,
  since: EngineRevision,
  regions: readonly ReadSetRegion[],
): Promise<ReadSetDelta> {
  const source = resolveLineageSource(store);
  if (source === undefined) return UNBOUNDED_READ_SET_DELTA;
  return source.readSetDelta(session, since, regions);
}
