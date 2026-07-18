/**
 * Whole-store observable-state snapshots for algebraic law tests.
 *
 * Law tests assert relations BETWEEN states — `unRetract ∘ retract` restores
 * the state, `import(export(store))` reproduces it, operation order does not
 * matter — so they need cheap equality over everything a user can observe:
 * node rows, edge rows, uniqueness reservations, and fulltext rows.
 *
 * Timestamps (`created_at`, `updated_at`, `valid_from` defaults) and
 * `version` counters are deliberately EXCLUDED: they advance on any write, so
 * including them would make every lawful round trip "unequal" for reasons no
 * user observes through queries. Tombstone state is captured as a boolean for
 * the same reason (the tombstone instant differs per run; its presence is
 * what queries observe). Embedding tables are strategy-owned per
 * `(kind, field)` and are not captured here — cover them with targeted tests.
 */
import { type GraphBackend, rowPropsToObject } from "../src/backend/types";
import type { GraphDef } from "../src/core/define-graph";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { storeBackend } from "../src/store/runtime-port";
import type { Store } from "../src/store/store";
import { compareStrings } from "../src/utils/compare";

type SnapshotNode = Readonly<{
  kind: string;
  id: string;
  props: Record<string, unknown>;
  deleted: boolean;
}>;

type SnapshotEdge = Readonly<{
  kind: string;
  id: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  props: Record<string, unknown>;
  deleted: boolean;
}>;

type SnapshotUnique = Readonly<{
  nodeKind: string;
  constraintName: string;
  key: string;
  nodeId: string;
  concreteKind: string;
}>;

type SnapshotFulltext = Readonly<{
  nodeKind: string;
  nodeId: string;
  language: string;
  content: string;
}>;

export type ObservableState = Readonly<{
  nodes: readonly SnapshotNode[];
  edges: readonly SnapshotEdge[];
  uniques: readonly SnapshotUnique[];
  fulltext: readonly SnapshotFulltext[];
}>;

function byNodeIdentity(left: SnapshotNode, right: SnapshotNode): number {
  return (
    compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id)
  );
}

function byEdgeIdentity(left: SnapshotEdge, right: SnapshotEdge): number {
  return (
    compareStrings(left.kind, right.kind) || compareStrings(left.id, right.id)
  );
}

function byUniqueIdentity(left: SnapshotUnique, right: SnapshotUnique): number {
  return (
    compareStrings(left.nodeKind, right.nodeKind) ||
    compareStrings(left.constraintName, right.constraintName) ||
    compareStrings(left.key, right.key)
  );
}

function byFulltextIdentity(
  left: SnapshotFulltext,
  right: SnapshotFulltext,
): number {
  return (
    compareStrings(left.nodeKind, right.nodeKind) ||
    compareStrings(left.nodeId, right.nodeId) ||
    compareStrings(left.language, right.language)
  );
}

/**
 * Captures everything a user can observe about a store (default table names).
 * Compare snapshots with `expect(after).toEqual(before)`.
 */
export async function dumpObservableState<G extends GraphDef>(
  store: Store<G>,
): Promise<ObservableState> {
  const backend: GraphBackend = storeBackend(store);
  const graphId = store.graphId;

  const nodes: SnapshotNode[] = [];
  for (const kind of Object.keys(store.graph.nodes)) {
    const rows = await backend.findNodesByKind({
      graphId,
      kind,
      excludeDeleted: false,
      temporalMode: "includeTombstones",
      orderBy: "id",
    });
    for (const row of rows) {
      nodes.push({
        kind: row.kind,
        id: row.id,
        props: rowPropsToObject(row.props),
        deleted: row.deleted_at !== undefined,
      });
    }
  }

  const edges: SnapshotEdge[] = [];
  for (const kind of Object.keys(store.graph.edges)) {
    const rows = await backend.findEdgesByKind({
      graphId,
      kind,
      excludeDeleted: false,
      temporalMode: "includeTombstones",
      orderBy: "id",
    });
    for (const row of rows) {
      edges.push({
        kind: row.kind,
        id: row.id,
        fromKind: row.from_kind,
        fromId: row.from_id,
        toKind: row.to_kind,
        toId: row.to_id,
        props: rowPropsToObject(row.props),
        deleted: row.deleted_at !== undefined,
      });
    }
  }

  const uniqueRows = await backend.execute<{
    node_kind: string;
    constraint_name: string;
    key: string;
    node_id: string;
    concrete_kind: string;
  }>(
    asCompiledRowsSql(sql`
      SELECT node_kind, constraint_name, key, node_id, concrete_kind
      FROM ${sql.raw("typegraph_node_uniques")}
      WHERE graph_id = ${graphId} AND deleted_at IS NULL
    `),
  );
  const uniques = uniqueRows.map((row): SnapshotUnique => ({
    nodeKind: row.node_kind,
    constraintName: row.constraint_name,
    key: row.key,
    nodeId: row.node_id,
    concreteKind: row.concrete_kind,
  }));

  const fulltextRows = await backend.execute<{
    node_kind: string;
    node_id: string;
    language: string;
    content: string;
  }>(
    asCompiledRowsSql(sql`
      SELECT node_kind, node_id, language, content
      FROM ${sql.raw("typegraph_node_fulltext")}
      WHERE graph_id = ${graphId}
    `),
  );
  const fulltext = fulltextRows.map((row): SnapshotFulltext => ({
    nodeKind: row.node_kind,
    nodeId: row.node_id,
    language: row.language,
    content: row.content,
  }));

  return {
    nodes: nodes.toSorted((left, right) => byNodeIdentity(left, right)),
    edges: edges.toSorted((left, right) => byEdgeIdentity(left, right)),
    uniques: uniques.toSorted((left, right) => byUniqueIdentity(left, right)),
    fulltext: fulltext.toSorted((left, right) =>
      byFulltextIdentity(left, right),
    ),
  };
}
