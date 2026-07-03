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
import { compareStrings, type MergeKey, mergeKey } from "./node-key";
import type {
  EdgeId,
  GraphBackend,
  GraphDef,
  NodeId,
  NodeType,
  Store,
  TransactionBackend,
} from "./typegraph-internal";
import { getEdgeKinds, getNodeKinds } from "./typegraph-internal";

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
}>;

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
 * The complete delta of a fork against the original base store.
 */
export type StateDiff = Readonly<{
  nodes: Readonly<{
    new: readonly ChangedNode[];
    modified: readonly ModifiedNode[];
    deleted: readonly DeletedNode[];
  }>;
  edges: Readonly<{
    new: readonly ChangedEdge[];
    modified: readonly ModifiedEdge[];
    deleted: readonly DeletedEdge[];
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
    after = page.at(-1)!.id;
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
    after = page.at(-1)!.id;
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
}> {
  const baseIndex = indexById(baseRows);
  const forkIndex = indexById(forkRows);

  const created: ChangedNode[] = [];
  const modified: ModifiedNode[] = [];
  const deleted: DeletedNode[] = [];

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
  }

  for (const baseRow of baseRows) {
    if (!isLive(baseRow)) {
      continue;
    }
    const forkRow = forkIndex.get(baseRow.id);
    if (forkRow === undefined || !isLive(forkRow)) {
      deleted.push({ id: baseRow.id as NodeId<NodeType>, kind });
    }
  }

  return { new: created, modified, deleted };
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
}> {
  const baseIndex = indexById(baseRows);
  const forkIndex = indexById(forkRows);

  const created: ChangedEdge[] = [];
  const modified: ModifiedEdge[] = [];
  const deleted: DeletedEdge[] = [];

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

  return { new: created, modified, deleted };
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

  const newNodes: ChangedNode[] = [];
  const modifiedNodes: ModifiedNode[] = [];
  const deletedNodes: DeletedNode[] = [];
  // Version snapshot of the fork store as observed by THIS diff's enumeration
  // (the same read the plan resolves against), keyed by merge identity.
  const forkNodeVersions = new Map<MergeKey, number>();

  for (const kind of nodeKinds) {
    const baseRows = await enumerateAllNodes(
      baseStore.backend,
      baseStore.graphId,
      kind,
    );
    const forkRows = await enumerateAllNodes(
      forkStore.backend,
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
  }

  const newEdges: ChangedEdge[] = [];
  const modifiedEdges: ModifiedEdge[] = [];
  const deletedEdges: DeletedEdge[] = [];
  // Content fingerprint of the fork store's edges as observed by THIS diff's
  // enumeration — the edge-half baseline for the commit-time lost-update guard
  // (edges have no version, so we key on mergeable content instead).
  const forkEdgeSignatures = new Map<MergeKey, string>();

  for (const kind of edgeKinds) {
    const baseRows = await enumerateAllEdges(
      baseStore.backend,
      baseStore.graphId,
      kind,
    );
    const forkRows = await enumerateAllEdges(
      forkStore.backend,
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
  }

  return {
    nodes: {
      new: newNodes.sort((left, right) => byId(left, right)),
      modified: modifiedNodes.sort((left, right) => byId(left, right)),
      deleted: deletedNodes.sort((left, right) => byId(left, right)),
    },
    edges: {
      new: newEdges.sort((left, right) => byId(left, right)),
      modified: modifiedEdges.sort((left, right) => byId(left, right)),
      deleted: deletedEdges.sort((left, right) => byId(left, right)),
    },
    forkNodeVersions,
    forkEdgeSignatures,
  };
}
