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
 *   - `props` is a JSON STRING — every comparison `JSON.parse`s it before
 *     `canonicalizeProps`, never feeding the raw string to the serializer (that
 *     would key on incidental string-literal order, not canonical structure).
 *   - `deleted_at` is a field, `undefined` for live rows. Liveness is
 *     `row.deleted_at === undefined`.
 *
 * Enumeration ordering:
 *   - Nodes use KEYSET pagination (`orderBy: "id"` + `after` cursor) over the
 *     unique `id`, a TOTAL order, so paging can neither skip nor duplicate a row.
 *   - Edges have NO keyset on `findEdgesByKind` (offset only) and the backend
 *     orders edges by the NON-unique `created_at`, so a bulk-seeded set of >1 page
 *     of edges sharing a `created_at` could, under a query plan that reorders ties
 *     across executions, return a boundary row in two adjacent pages. We therefore
 *     DEDUPE the assembled rows by `id` and sort by `id`, so the result is a pure
 *     function of the row SET regardless of paging happenstance.
 *
 * Concurrency: P0 assumes quiesced (non-concurrent) forks per design §10. The
 * dedupe-by-id above also makes edge enumeration robust to a non-total backend
 * sort independent of that assumption; concurrent-write enumeration is a P1
 * concern.
 */

import { canonicalizeProps } from "./canonical-props";
import type {
  EdgeId,
  GraphBackend,
  GraphDef,
  NodeId,
  NodeType,
  Store,
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
  props: string;
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
  props: string;
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
}>;

/**
 * Enumerates EVERY node of `kind` for `graphId` (live and soft-deleted) via
 * keyset pagination on `id`. Returns rows in ascending `id` order.
 */
export async function enumerateAllNodes(
  backend: GraphBackend,
  graphId: string,
  kind: string,
): Promise<readonly NodeRow[]> {
  const collected: NodeRow[] = [];
  let after: string | undefined = undefined;
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
 * `limit`/`offset` paging (no keyset on `findEdgesByKind`). Because the backend
 * orders edges by the NON-unique `created_at`, a tied row at a page boundary could
 * be returned twice across adjacent pages under a reordering query plan; rows are
 * therefore DEDUPED by `id` (first occurrence wins) and the assembled set is sorted
 * by `id`, so the result is a pure function of the row SET, never the paging order.
 */
export async function enumerateAllEdges(
  backend: GraphBackend,
  graphId: string,
  kind: string,
): Promise<readonly EdgeRow[]> {
  const collected = new Map<string, EdgeRow>();
  let offset = 0;
  for (;;) {
    const page: readonly EdgeRow[] = await backend.findEdgesByKind({
      graphId,
      kind,
      excludeDeleted: false,
      limit: ENUMERATION_PAGE_SIZE,
      offset,
    });
    for (const row of page) {
      if (!collected.has(row.id)) {
        collected.set(row.id, row);
      }
    }
    if (page.length < ENUMERATION_PAGE_SIZE) {
      break;
    }
    offset += ENUMERATION_PAGE_SIZE;
  }
  return [...collected.values()].sort((left, right) =>
    left.id < right.id ? -1
    : left.id > right.id ? 1
    : 0,
  );
}

/**
 * Parses a row's JSON `props` string into a plain object. Centralized so every
 * caller agrees that the canonical serializer is fed PARSED objects.
 */
function parseProps(props: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(props);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

/** True when the row is live (not soft-deleted). */
function isLive(row: Readonly<{ deleted_at: string | undefined }>): boolean {
  return row.deleted_at === undefined;
}

/** Indexes node rows by id for O(1) base-vs-fork lookup. */
function indexNodesById(
  rows: readonly NodeRow[],
): ReadonlyMap<string, NodeRow> {
  const index = new Map<string, NodeRow>();
  for (const row of rows) {
    index.set(row.id, row);
  }
  return index;
}

/** Indexes edge rows by id for O(1) base-vs-fork lookup. */
function indexEdgesById(
  rows: readonly EdgeRow[],
): ReadonlyMap<string, EdgeRow> {
  const index = new Map<string, EdgeRow>();
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
  const baseIndex = indexNodesById(baseRows);
  const forkIndex = indexNodesById(forkRows);

  const created: ChangedNode[] = [];
  const modified: ModifiedNode[] = [];
  const deleted: DeletedNode[] = [];

  for (const forkRow of forkRows) {
    if (!isLive(forkRow)) {
      continue;
    }
    const baseRow = baseIndex.get(forkRow.id);
    const forkProps = parseProps(forkRow.props);
    if (baseRow === undefined || !isLive(baseRow)) {
      created.push({
        id: forkRow.id as NodeId<NodeType>,
        kind,
        props: forkProps,
        row: forkRow,
      });
      continue;
    }
    const baseProps = parseProps(baseRow.props);
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
  const baseIndex = indexEdgesById(baseRows);
  const forkIndex = indexEdgesById(forkRows);

  const created: ChangedEdge[] = [];
  const modified: ModifiedEdge[] = [];
  const deleted: DeletedEdge[] = [];

  for (const forkRow of forkRows) {
    if (!isLive(forkRow)) {
      continue;
    }
    const baseRow = baseIndex.get(forkRow.id);
    const forkProps = parseProps(forkRow.props);
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
    const baseProps = parseProps(baseRow.props);
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
  return (
    left.id < right.id ? -1
    : left.id > right.id ? 1
    : 0
  );
}

/**
 * Computes the full {@link StateDiff} of `forkStore` against `baseStore`.
 *
 * Both stores MUST share the same graph definition (the fork is a clone of the
 * base). The diff is keyed by id and sorted by `(kind, id)` so its shape is a
 * pure function of the stores' content, independent of enumeration order. No
 * branch tag is attached here — provenance tagging happens in T7 (staging).
 */
export async function diffAgainstBase<G extends GraphDef>(
  baseStore: Store<G>,
  forkStore: Store<G>,
): Promise<StateDiff> {
  const graph = baseStore.graph;
  const nodeKinds = getNodeKinds(graph);
  const edgeKinds = getEdgeKinds(graph);

  const newNodes: ChangedNode[] = [];
  const modifiedNodes: ModifiedNode[] = [];
  const deletedNodes: DeletedNode[] = [];

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
  };
}
