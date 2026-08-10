import { requireDefined } from "../utils/presence";
/**
 * State-diff engine: compute the per-fork delta (new / modified / deleted nodes
 * and edges) of a working copy against the IMMUTABLE original base store.
 *
 * Why backend-level enumeration (not `Store.find()`): the collection API
 * silently hides soft-deleted rows, so a node deleted in a fork would be
 * invisible and the diff could never report a deletion. We therefore go through
 * the backend with `excludeDeleted: false` and read the raw `NodeRow`/`EdgeRow`.
 *
 * Row representation contract (verified against `NodeRow`/`EdgeRow`):
 *   - `props` is a JSON string (SQLite) or a driver-parsed object (Postgres
 *     jsonb) — every comparison routes it through `parseRowProps` before
 *     `canonicalizeProps`, never feeding a raw string to the serializer (that
 *     would key on incidental string-literal order, not canonical structure).
 *   - `deleted_at` is a field, `undefined` for live rows. Liveness is
 *     `row.deleted_at === undefined`.
 *
 * Enumeration ordering: both nodes AND edges use KEYSET pagination
 * (`orderBy: "id"` + `after` cursor) over the unique `id`, a TOTAL order, so
 * paging can neither skip nor duplicate a row even when many rows share a
 * `created_at`. (Edges previously had only offset paging over the non-unique
 * `created_at`, which could skip a boundary row under a reordering query plan.)
 *
 * Concurrency: P0 assumes quiesced (non-concurrent) forks per design §10.
 * Concurrent-write enumeration is a P1 concern.
 */
import {
  canonicalizeProps,
  edgeStateSignature,
  parseRowProps,
} from "./canonical-props";
import { assertionIdentityKey, assertionTruthKey } from "./merge-identity";
import { compareStrings, type MergeKey, mergeKey } from "./node-key";
import type {
  EdgeId,
  GraphBackend,
  GraphDef,
  IdentityTransferAssertion,
  NodeId,
  NodeType,
  Store,
  TransactionBackend,
} from "./typegraph-internal";
import {
  canonicalizeDatabaseTimestamp,
  getEdgeKinds,
  getNodeKinds,
} from "./typegraph-internal";
import { storeBackend, storeRuntime } from "./typegraph-internal";

/**
 * Local structural mirror of TypeGraph's internal `NodeRow`. 0.29.0 does NOT
 * re-export `NodeRow`/`EdgeRow` from any public entrypoint, but `GraphBackend`
 * (public) returns rows of exactly this shape from `findNodesByKind`, so the
 * runtime values are structurally assignable. Keep this local mirror until using
 * the backend row type directly buys enough clarity to justify the coupling.
 */
export type NodeRow = Readonly<{
  graph_id: string;
  kind: string;
  id: string;
  props: string | Readonly<Record<string, unknown>>;
  version: number;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

/** Local structural mirror of TypeGraph's internal `EdgeRow`. See {@link NodeRow}. */
export type EdgeRow = Readonly<{
  graph_id: string;
  id: string;
  kind: string;
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  props: string | Readonly<Record<string, unknown>>;
  valid_from: string | undefined;
  valid_to: string | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
}>;

/**
 * Page size for keyset/offset enumeration. Large enough to keep round-trips low
 * on demo-scale graphs; the algorithm is correct for any positive value.
 */
const ENUMERATION_PAGE_SIZE = 1000;

/**
 * A node that exists in both base and fork but whose canonicalized props differ.
 * Carries the parsed fork props so downstream phases (staging, conflict) avoid
 * re-parsing.
 */
export type ModifiedNode = Readonly<{
  id: NodeId<NodeType>;
  kind: string;
  baseProps: Readonly<Record<string, unknown>>;
  forkProps: Readonly<Record<string, unknown>>;
  row: NodeRow;
}>;

/** A node present and live only on one side of the diff. */
export type ChangedNode = Readonly<{
  id: NodeId<NodeType>;
  kind: string;
  props: Readonly<Record<string, unknown>>;
  row: NodeRow;
}>;

/** Identifier of a node that the fork removed (live in base, gone in fork). */
export type DeletedNode = Readonly<{
  id: NodeId<NodeType>;
  kind: string;
  /**
   * The instant the fork soft-deleted the node, read from its own row, or
   * `undefined` when the fork carries no row at all (a HARD delete, which
   * removes the row rather than tombstoning it).
   *
   * Soft and hard deletion leave different evidence behind, and
   * {@link RetractionCause} needs to tell them apart: only a hard delete
   * removes the assertion rows outright, so only a hard delete can explain a
   * retraction with no surviving fork row.
   */
  deletedAt: string | undefined;
}>;

/** A node reference naming the endpoint whose deletion cascaded. */
type CascadeCauseNode = Readonly<{ kind: string; id: string }>;

/**
 * Why an assertion stopped being current in the fork.
 *
 * `cascade` is READ, not guessed: a node soft-delete ends every open assertion
 * touching that node and stamps the deleted node's `(kind, id)` onto each row
 * it ends (see `detachIdentityForNode`), so the row states its own cause. An
 * assertion the fork retracted explicitly carries no stamp — including the
 * same-branch retract-then-delete sequence, where the explicit retraction
 * closed the row before the delete ran, so the cascade never touched it, no
 * matter how close together the two acts fell.
 *
 * ONE case is genuinely undecidable and resolves to `cascade`, the conservative
 * side (a dropped ending keeps identity truth; a wrongly kept one destroys it):
 * a HARD delete physically removes every assertion row touching the node,
 * taking the stamp with it along with any earlier explicit retraction of the
 * same row — a hard delete is then the only thing that can have produced the
 * retraction.
 */
export type RetractionCause =
  | Readonly<{ kind: "explicit" }>
  | Readonly<{ kind: "cascade"; deletedNode: CascadeCauseNode }>;

/** An assertion the fork stopped asserting, with the cause of its ending. */
type RetractedAssertion = Readonly<{
  assertion: IdentityTransferAssertion;
  cause: RetractionCause;
}>;

/** The `explicit` cause — a single shared value; the variant carries no data. */
const EXPLICIT_RETRACTION: RetractionCause = { kind: "explicit" };

/** An edge present and live only on one side of the diff. */
export type ChangedEdge = Readonly<{
  id: EdgeId;
  kind: string;
  fromId: NodeId<NodeType>;
  toId: NodeId<NodeType>;
  fromKind: string;
  toKind: string;
  props: Readonly<Record<string, unknown>>;
  row: EdgeRow;
}>;

/** An edge present in both base and fork but whose canonicalized props differ. */
export type ModifiedEdge = Readonly<{
  id: EdgeId;
  kind: string;
  fromId: NodeId<NodeType>;
  toId: NodeId<NodeType>;
  fromKind: string;
  toKind: string;
  baseProps: Readonly<Record<string, unknown>>;
  forkProps: Readonly<Record<string, unknown>>;
  row: EdgeRow;
}>;

/** Identifier of an edge the fork removed (live in base, gone in fork). */
export type DeletedEdge = Readonly<{
  id: EdgeId;
  kind: string;
}>;

/**
 * A row's valid-time window, normalized to canonical UTC instants.
 *
 * The raw `valid_from` / `valid_to` columns are TEXT whose formatting differs
 * per driver (postgres-js hands back `timestamptz` as its own raw rendering),
 * so comparing or ordering the stored strings would resolve differently on
 * SQLite and PostgreSQL. Every window the diff reports is canonicalized here
 * once, and every downstream comparison operates on this shape.
 */
export type ValidWindow = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
}>;

/**
 * An inherited node — live in BOTH base and fork — whose valid-time window the
 * fork changed. Independent of {@link ModifiedNode}: modification detection
 * compares props only, so a row can appear in one bucket, the other, or both.
 *
 * Keeping the two buckets separate is what makes an end-of-validity behave as a
 * sibling of deletion rather than as a modification: a window-only change never
 * enters delete/modify resolution, so a branch that ends a row another branch
 * deleted raises no conflict — the deletion simply absorbs the weaker claim.
 */
export type WindowedNode = Readonly<{
  id: NodeId<NodeType>;
  kind: string;
  base: ValidWindow;
  fork: ValidWindow;
}>;

/**
 * The edge analogue of {@link WindowedNode}. Carries the edge's endpoints and
 * parsed props too, because an inherited edge whose ONLY change is its window is
 * not otherwise staged — the repoint phase needs the full record to carry the
 * ending through to the commit.
 *
 * `baseProps` is the same record {@link ModifiedEdge} carries, and for the same
 * consumer: the repoint fold judges each contributor's property values against
 * its own base, so an untouched value never enters the union as an authored claim
 * (issue #408). A window-only fork's `props` happen to equal its `baseProps`,
 * which is exactly what makes such a copy contribute nothing — but that equality
 * is a fact about the fork, not something the fold should have to assume.
 */
export type WindowedEdge = Readonly<{
  id: EdgeId;
  kind: string;
  fromId: NodeId<NodeType>;
  toId: NodeId<NodeType>;
  fromKind: string;
  toKind: string;
  props: Readonly<Record<string, unknown>>;
  baseProps: Readonly<Record<string, unknown>>;
  base: ValidWindow;
  fork: ValidWindow;
}>;

/** Reads a row's window as canonical instants. */
function validWindowOf(
  row: Readonly<{
    valid_from: string | undefined;
    valid_to: string | undefined;
  }>,
): ValidWindow {
  return {
    validFrom: canonicalizeDatabaseTimestamp(row.valid_from),
    validTo: canonicalizeDatabaseTimestamp(row.valid_to),
  };
}

/** True when two canonicalized windows differ in either endpoint. */
function windowsDiffer(left: ValidWindow, right: ValidWindow): boolean {
  return left.validFrom !== right.validFrom || left.validTo !== right.validTo;
}

/**
 * The complete delta of a fork against the original base store.
 */
export type StateDiff = Readonly<{
  nodes: Readonly<{
    new: readonly ChangedNode[];
    modified: readonly ModifiedNode[];
    deleted: readonly DeletedNode[];
    /** Inherited nodes whose valid-time window the fork changed. */
    windowed: readonly WindowedNode[];
  }>;
  edges: Readonly<{
    new: readonly ChangedEdge[];
    modified: readonly ModifiedEdge[];
    deleted: readonly DeletedEdge[];
    /** Inherited edges whose valid-time window the fork changed. */
    windowed: readonly WindowedEdge[];
  }>;
  /**
   * Identity-ledger delta: assertions current in the fork but not the base
   * (`new`), and assertions current in the base but no longer in the fork
   * (`retracted`). An id current on BOTH sides with DIFFERENT complete truth
   * (a hard-delete/recreate replacement) appears in both lists. Entries carry
   * the ledger's own {@link IdentityTransferAssertion} shape — the same
   * records the merge commit hands back to the identity import — so the diff
   * never re-declares (and can never drift from) the assertion contract.
   *
   * Each retraction additionally carries its {@link RetractionCause}, so the
   * merge planner can tie a cascade ending's fate to the deletion that caused
   * it instead of inferring intent from branch-level provenance.
   */
  identity: Readonly<{
    new: readonly IdentityTransferAssertion[];
    retracted: readonly RetractedAssertion[];
  }>;
  /**
   * `(kind, id) -> version` for every fork-store node observed during this diff
   * (live and soft-deleted). Captured from the same enumeration the diff reads,
   * so it is the fork's exact observed state — the incremental merge uses the
   * target branch's map as the plan-time baseline for its commit-time
   * lost-update guard (see assertInheritedTargetUnchanged in merge.ts).
   */
  forkNodeVersions: ReadonlyMap<MergeKey, number>;
  /**
   * `(kind, id) -> {@link edgeStateSignature}` for every fork-store edge observed
   * during this diff (live and soft-deleted). The edge-half analogue of
   * {@link forkNodeVersions}: edges carry no `version` column, so the guard
   * fingerprints their mergeable content (endpoints, liveness, canonical props)
   * instead. The incremental merge uses the target branch's map as the plan-time
   * baseline for the commit-time lost-update guard.
   */
  forkEdgeSignatures: ReadonlyMap<MergeKey, string>;
}>;

/**
 * Enumerates EVERY node of `kind` for `graphId` (live and soft-deleted) via
 * keyset pagination on `id`. Returns rows ascending in the BACKEND's own id
 * ordering — byte order on SQLite/PGlite, the database collation on server
 * Postgres. That order is deterministic and pagination-consistent (the cursor
 * comparison uses the same collation as ORDER BY), but it is NOT guaranteed to
 * equal JS code-unit order for mixed-case ids; consumers needing a canonical
 * cross-backend order sort in JS (as `stateDiff` and the base@V fingerprint
 * do).
 */
export async function enumerateAllNodes(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  kind: string,
): Promise<readonly NodeRow[]> {
  const collected: NodeRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page: readonly NodeRow[] = await backend.findNodesByKind({
      graphId,
      kind,
      excludeDeleted: false,
      orderBy: "id",
      limit: ENUMERATION_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    for (const row of page) {
      collected.push(row);
    }
    if (page.length < ENUMERATION_PAGE_SIZE) {
      break;
    }
    after = requireDefined(page.at(-1)).id;
  }
  return collected;
}

/**
 * Enumerates EVERY edge of `kind` for `graphId` (live and soft-deleted) via
 * keyset pagination on the unique `id` (a TOTAL order), so paging can neither
 * skip nor duplicate a row regardless of how many edges share a `created_at`.
 * Returns rows ascending in the backend's own id ordering (see
 * {@link enumerateAllNodes} for the collation caveat). Mirrors
 * {@link enumerateAllNodes}.
 */
export async function enumerateAllEdges(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  kind: string,
): Promise<readonly EdgeRow[]> {
  const collected: EdgeRow[] = [];
  let after: string | undefined;
  for (;;) {
    const page: readonly EdgeRow[] = await backend.findEdgesByKind({
      graphId,
      kind,
      excludeDeleted: false,
      orderBy: "id",
      limit: ENUMERATION_PAGE_SIZE,
      ...(after === undefined ? {} : { after }),
    });
    for (const row of page) {
      collected.push(row);
    }
    if (page.length < ENUMERATION_PAGE_SIZE) {
      break;
    }
    after = requireDefined(page.at(-1)).id;
  }
  return collected;
}

/** True when the row is live (not soft-deleted). */
function isLive(row: Readonly<{ deleted_at: string | undefined }>): boolean {
  return row.deleted_at === undefined;
}

/** Indexes rows by id for O(1) base-vs-fork lookup. */
function indexById<T extends Readonly<{ id: string }>>(
  rows: readonly T[],
): ReadonlyMap<string, T> {
  const index = new Map<string, T>();
  for (const row of rows) {
    index.set(row.id, row);
  }
  return index;
}

/**
 * Diffs the node sets of one kind. `new` = absent-in-base, live-in-fork;
 * `deleted` = live-in-base, absent-or-soft-deleted-in-fork; `modified` =
 * live in both with differing canonicalized props.
 */
function diffNodeKind(
  kind: string,
  baseRows: readonly NodeRow[],
  forkRows: readonly NodeRow[],
): Readonly<{
  new: ChangedNode[];
  modified: ModifiedNode[];
  deleted: DeletedNode[];
  windowed: WindowedNode[];
}> {
  const baseIndex = indexById(baseRows);
  const forkIndex = indexById(forkRows);

  const created: ChangedNode[] = [];
  const modified: ModifiedNode[] = [];
  const deleted: DeletedNode[] = [];
  const windowed: WindowedNode[] = [];

  for (const forkRow of forkRows) {
    if (!isLive(forkRow)) {
      continue;
    }
    const baseRow = baseIndex.get(forkRow.id);
    const forkProps = parseRowProps(forkRow.props);
    if (baseRow === undefined || !isLive(baseRow)) {
      created.push({
        id: forkRow.id as NodeId<NodeType>,
        kind,
        props: forkProps,
        row: forkRow,
      });
      continue;
    }
    const baseProps = parseRowProps(baseRow.props);
    if (canonicalizeProps(baseProps) !== canonicalizeProps(forkProps)) {
      modified.push({
        id: forkRow.id as NodeId<NodeType>,
        kind,
        baseProps,
        forkProps,
        row: forkRow,
      });
    }
    const baseWindow = validWindowOf(baseRow);
    const forkWindow = validWindowOf(forkRow);
    if (windowsDiffer(baseWindow, forkWindow)) {
      windowed.push({
        id: forkRow.id as NodeId<NodeType>,
        kind,
        base: baseWindow,
        fork: forkWindow,
      });
    }
  }

  for (const baseRow of baseRows) {
    if (!isLive(baseRow)) {
      continue;
    }
    const forkRow = forkIndex.get(baseRow.id);
    if (forkRow === undefined || !isLive(forkRow)) {
      deleted.push({
        id: baseRow.id as NodeId<NodeType>,
        kind,
        deletedAt:
          forkRow === undefined ? undefined : (
            canonicalizeDatabaseTimestamp(forkRow.deleted_at)
          ),
      });
    }
  }

  return { new: created, modified, deleted, windowed };
}

/**
 * Diffs the edge sets of one kind. Same liveness/modification rules as nodes,
 * carrying endpoint ids/kinds for the downstream repoint phase.
 */
function diffEdgeKind(
  kind: string,
  baseRows: readonly EdgeRow[],
  forkRows: readonly EdgeRow[],
): Readonly<{
  new: ChangedEdge[];
  modified: ModifiedEdge[];
  deleted: DeletedEdge[];
  windowed: WindowedEdge[];
}> {
  const baseIndex = indexById(baseRows);
  const forkIndex = indexById(forkRows);

  const created: ChangedEdge[] = [];
  const modified: ModifiedEdge[] = [];
  const deleted: DeletedEdge[] = [];
  const windowed: WindowedEdge[] = [];

  for (const forkRow of forkRows) {
    if (!isLive(forkRow)) {
      continue;
    }
    const baseRow = baseIndex.get(forkRow.id);
    const forkProps = parseRowProps(forkRow.props);
    if (baseRow === undefined || !isLive(baseRow)) {
      created.push({
        id: forkRow.id as EdgeId,
        kind,
        fromId: forkRow.from_id as NodeId<NodeType>,
        toId: forkRow.to_id as NodeId<NodeType>,
        fromKind: forkRow.from_kind,
        toKind: forkRow.to_kind,
        props: forkProps,
        row: forkRow,
      });
      continue;
    }
    const baseProps = parseRowProps(baseRow.props);
    if (canonicalizeProps(baseProps) !== canonicalizeProps(forkProps)) {
      modified.push({
        id: forkRow.id as EdgeId,
        kind,
        fromId: forkRow.from_id as NodeId<NodeType>,
        toId: forkRow.to_id as NodeId<NodeType>,
        fromKind: forkRow.from_kind,
        toKind: forkRow.to_kind,
        baseProps,
        forkProps,
        row: forkRow,
      });
    }
    const baseWindow = validWindowOf(baseRow);
    const forkWindow = validWindowOf(forkRow);
    if (windowsDiffer(baseWindow, forkWindow)) {
      windowed.push({
        id: forkRow.id as EdgeId,
        kind,
        fromId: forkRow.from_id as NodeId<NodeType>,
        toId: forkRow.to_id as NodeId<NodeType>,
        fromKind: forkRow.from_kind,
        toKind: forkRow.to_kind,
        props: forkProps,
        baseProps,
        base: baseWindow,
        fork: forkWindow,
      });
    }
  }

  for (const baseRow of baseRows) {
    if (!isLive(baseRow)) {
      continue;
    }
    const forkRow = forkIndex.get(baseRow.id);
    if (forkRow === undefined || !isLive(forkRow)) {
      deleted.push({ id: baseRow.id as EdgeId, kind });
    }
  }

  return { new: created, modified, deleted, windowed };
}

/**
 * Classifies ONE retracted assertion against this fork's node deletions.
 *
 * The rule is the one documented on {@link RetractionCause}:
 *
 *   - the fork's row carries an `endedBy` stamp naming a node this fork
 *     deleted — that deletion's cascade ended it, `cascade`;
 *   - the fork has NO row for the id, and an endpoint was HARD-deleted (the
 *     only deletion that removes assertion rows) — nothing else can have ended
 *     it, `cascade`. Evaluated endpoint-first in `(a, b)` order so a retraction
 *     whose both endpoints were hard-deleted names a deterministic cause;
 *   - anything else the fork did to the assertion was its own act, `explicit`.
 *
 * A stamp naming a node the fork later RESURRECTED is deliberately `explicit`:
 * the merge ties a cascade's fate to a staged deletion, and this fork staged
 * none for that node, so its ending stands on its own.
 *
 * @param forkAssertion The fork's own row for this id, or `undefined` when the
 *   fork has no row for it at all (hard-deleted, or replaced under the same id).
 */
function classifyRetraction(
  assertion: IdentityTransferAssertion,
  deletedByKey: ReadonlyMap<MergeKey, DeletedNode>,
  forkAssertion: IdentityTransferAssertion | undefined,
): RetractionCause {
  if (forkAssertion !== undefined) {
    const stamp = forkAssertion.endedBy;
    if (
      stamp !== undefined &&
      deletedByKey.has(mergeKey(stamp.kind, stamp.id))
    ) {
      return { kind: "cascade", deletedNode: { ...stamp } };
    }
    return EXPLICIT_RETRACTION;
  }
  for (const endpoint of [assertion.a, assertion.b]) {
    const deletion = deletedByKey.get(mergeKey(endpoint.kind, endpoint.id));
    if (deletion !== undefined && deletion.deletedAt === undefined) {
      return {
        kind: "cascade",
        deletedNode: { kind: deletion.kind, id: deletion.id },
      };
    }
  }
  return EXPLICIT_RETRACTION;
}

/**
 * Classifies every retraction in one fork.
 *
 * The fork's archival row owns the authored retraction boundary. Preserve that
 * complete ended truth in the plan whenever the row still identifies the base
 * assertion; a hard delete can remove the row entirely, in which case the node
 * deletion itself owns the commit-time cascade.
 */
function classifyRetractions(
  retracted: readonly IdentityTransferAssertion[],
  deletedNodes: readonly DeletedNode[],
  forkRowsById: ReadonlyMap<string, IdentityTransferAssertion>,
): readonly RetractedAssertion[] {
  if (retracted.length === 0) return [];
  const deletedByKey = new Map<MergeKey, DeletedNode>(
    deletedNodes.map((deletion) => [
      mergeKey(deletion.kind, deletion.id),
      deletion,
    ]),
  );
  return retracted.map((assertion) => {
    const forkAssertion = forkRowsById.get(assertion.id);
    const endedAssertion =
      (
        forkAssertion?.validTo !== undefined &&
        assertionIdentityKey(forkAssertion) === assertionIdentityKey(assertion)
      ) ?
        forkAssertion
      : assertion;
    return {
      assertion: endedAssertion,
      cause: classifyRetraction(assertion, deletedByKey, forkAssertion),
    };
  });
}

/** Stable id-ascending comparator over any `{ id: string }`. */
function byId<T extends Readonly<{ id: string }>>(left: T, right: T): number {
  return compareStrings(left.id, right.id);
}

/**
 * Computes the full {@link StateDiff} of `forkStore` against `baseStore`.
 *
 * Both stores MUST share the same graph definition (the fork is a clone of the
 * base). The diff is keyed by id and sorted by `(kind, id)` so its shape is a
 * pure function of the stores' content, independent of enumeration order. No
 * branch tag is attached here — provenance tagging happens in T7 (staging).
 *
 * @param captureForkState Whether to populate {@link StateDiff.forkNodeVersions}
 *   / {@link StateDiff.forkEdgeSignatures}. `stageBranches` only ever keeps these
 *   maps for the one branch matching `captureTargetStateFor`, and computing the
 *   edge signatures (canonicalizing props + stringifying every edge) is real
 *   work — so callers that don't need them for this branch can skip it. Defaults
 *   to `true` so direct callers (e.g. tests) get the full diff without having to
 *   know this parameter exists.
 */
export async function diffAgainstBase<G extends GraphDef>(
  baseStore: Store<G>,
  forkStore: Store<G>,
  captureForkState = true,
): Promise<StateDiff> {
  const graph = baseStore.graph;
  const nodeKinds = getNodeKinds(graph);
  const edgeKinds = getEdgeKinds(graph);
  const [baseIdentity, forkIdentity] = await Promise.all([
    storeRuntime(baseStore).readCurrentIdentityAssertions("archival"),
    storeRuntime(forkStore).readCurrentIdentityAssertions("archival"),
  ]);
  const baseIdentityById = new Map(
    baseIdentity.map((assertion) => [assertion.id, assertion]),
  );
  const forkIdentityById = new Map(
    forkIdentity.map((assertion) => [assertion.id, assertion]),
  );

  const newNodes: ChangedNode[] = [];
  const modifiedNodes: ModifiedNode[] = [];
  const deletedNodes: DeletedNode[] = [];
  const windowedNodes: WindowedNode[] = [];
  // Version snapshot of the fork store as observed by THIS diff's enumeration
  // (the same read the plan resolves against), keyed by merge identity.
  const forkNodeVersions = new Map<MergeKey, number>();

  for (const kind of nodeKinds) {
    const baseRows = await enumerateAllNodes(
      storeBackend(baseStore),
      baseStore.graphId,
      kind,
    );
    const forkRows = await enumerateAllNodes(
      storeBackend(forkStore),
      forkStore.graphId,
      kind,
    );
    if (captureForkState) {
      for (const row of forkRows) {
        forkNodeVersions.set(mergeKey(kind, row.id), row.version);
      }
    }
    const delta = diffNodeKind(kind, baseRows, forkRows);
    for (const entry of delta.new) {
      newNodes.push(entry);
    }
    for (const entry of delta.modified) {
      modifiedNodes.push(entry);
    }
    for (const entry of delta.deleted) {
      deletedNodes.push(entry);
    }
    for (const entry of delta.windowed) {
      windowedNodes.push(entry);
    }
  }

  const newEdges: ChangedEdge[] = [];
  const modifiedEdges: ModifiedEdge[] = [];
  const deletedEdges: DeletedEdge[] = [];
  const windowedEdges: WindowedEdge[] = [];
  // Content fingerprint of the fork store's edges as observed by THIS diff's
  // enumeration — the edge-half baseline for the commit-time lost-update guard
  // (edges have no version, so we key on mergeable content instead).
  const forkEdgeSignatures = new Map<MergeKey, string>();

  for (const kind of edgeKinds) {
    const baseRows = await enumerateAllEdges(
      storeBackend(baseStore),
      baseStore.graphId,
      kind,
    );
    const forkRows = await enumerateAllEdges(
      storeBackend(forkStore),
      forkStore.graphId,
      kind,
    );
    if (captureForkState) {
      for (const row of forkRows) {
        forkEdgeSignatures.set(
          mergeKey(kind, row.id),
          edgeStateSignature({
            fromKind: row.from_kind,
            fromId: row.from_id,
            toKind: row.to_kind,
            toId: row.to_id,
            live: isLive(row),
            props: parseRowProps(row.props),
          }),
        );
      }
    }
    const delta = diffEdgeKind(kind, baseRows, forkRows);
    for (const entry of delta.new) {
      newEdges.push(entry);
    }
    for (const entry of delta.modified) {
      modifiedEdges.push(entry);
    }
    for (const entry of delta.deleted) {
      deletedEdges.push(entry);
    }
    for (const entry of delta.windowed) {
      windowedEdges.push(entry);
    }
  }

  // Ids present on BOTH sides are compared by COMPLETE truth, not presence: a
  // fork can hard-delete an assertion's endpoint (physically removing the row),
  // recreate it, and legally import the same id for different truth. Presence-
  // only comparison would diff that replacement as empty and the merge would
  // silently keep the base truth. A shared id with changed truth surfaces as
  // BOTH retracted (the base row) and new (the fork row), so planning sees the
  // replacement and can refuse unsupported id reuse as a typed conflict.
  const retractedAssertions = baseIdentity
    .filter((assertion) => {
      const fork = forkIdentityById.get(assertion.id);
      return (
        fork === undefined ||
        assertionTruthKey(fork) !== assertionTruthKey(assertion)
      );
    })
    .toSorted((left, right) => compareStrings(left.id, right.id));
  const classifiedRetractions = classifyRetractions(
    retractedAssertions,
    deletedNodes,
    forkIdentityById,
  );

  return {
    nodes: {
      new: newNodes.sort((left, right) => byId(left, right)),
      modified: modifiedNodes.sort((left, right) => byId(left, right)),
      deleted: deletedNodes.sort((left, right) => byId(left, right)),
      windowed: windowedNodes.sort((left, right) => byId(left, right)),
    },
    edges: {
      new: newEdges.sort((left, right) => byId(left, right)),
      modified: modifiedEdges.sort((left, right) => byId(left, right)),
      deleted: deletedEdges.sort((left, right) => byId(left, right)),
      windowed: windowedEdges.sort((left, right) => byId(left, right)),
    },
    identity: {
      // Ids present on BOTH sides are compared by COMPLETE truth, not
      // presence: a fork can hard-delete an assertion's endpoint (physically
      // removing the row), recreate it, and legally import the same id for
      // different truth. Presence-only comparison would diff that replacement
      // as empty and the merge would silently keep the base truth. A shared
      // id with changed truth surfaces as BOTH retracted (the base row) and
      // new (the fork row), so planning sees the replacement and can refuse
      // unsupported id reuse as a typed conflict.
      new: forkIdentity
        .filter((assertion) => {
          const base = baseIdentityById.get(assertion.id);
          return (
            base === undefined ||
            (assertionIdentityKey(base) !== assertionIdentityKey(assertion) &&
              assertionTruthKey(base) !== assertionTruthKey(assertion))
          );
        })
        .toSorted((left, right) => compareStrings(left.id, right.id)),
      retracted: classifiedRetractions,
    },
    forkNodeVersions,
    forkEdgeSignatures,
  };
}
