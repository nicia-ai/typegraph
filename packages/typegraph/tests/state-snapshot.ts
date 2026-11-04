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
 *
 * {@link dumpRoundTripState} widens the snapshot for interchange laws, where
 * the windows and the derived ledgers ARE the payload: each row's
 * `valid_from` / `valid_to`, the edge claim rows, and the identity ledger
 * (assertions, closure, separation, transition log).
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

type RowWindow = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
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

type WindowedNode = SnapshotNode & RowWindow;
type WindowedEdge = SnapshotEdge & RowWindow;

function withoutWindow<T extends RowWindow>(
  row: T,
): Omit<T, "validFrom" | "validTo"> {
  const { validFrom: _validFrom, validTo: _validTo, ...rest } = row;
  return rest;
}

/** Every node and edge row, tombstones included, sorted by `(kind, id)`. */
async function collectRows<G extends GraphDef>(
  store: Store<G>,
): Promise<
  Readonly<{ nodes: readonly WindowedNode[]; edges: readonly WindowedEdge[] }>
> {
  const backend: GraphBackend = storeBackend(store);
  const graphId = store.graphId;
  const nodes: WindowedNode[] = [];
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
        validFrom: canonicalInstant(row.valid_from),
        validTo: canonicalInstant(row.valid_to),
      });
    }
  }

  const edges: WindowedEdge[] = [];
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
        validFrom: canonicalInstant(row.valid_from),
        validTo: canonicalInstant(row.valid_to),
      });
    }
  }

  return {
    nodes: nodes.toSorted((left, right) => byNodeIdentity(left, right)),
    edges: edges.toSorted((left, right) => byEdgeIdentity(left, right)),
  };
}

/**
 * One spelling for an instant whichever driver read it: PostgreSQL may hand
 * back a `Date` or a zoneless string where SQLite returns canonical ISO text.
 */
function canonicalInstant(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const zoned = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(value);
    return new Date(
      zoned ? value : `${value.replace(" ", "T")}Z`,
    ).toISOString();
  }
  throw new TypeError(`Unexpected instant value: ${JSON.stringify(value)}`);
}

/** A JSON column, whether the driver returns it parsed (jsonb) or as text. */
function jsonColumn(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? JSON.parse(value) : value;
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
  const { nodes, edges } = await collectRows(store);

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
    nodes: nodes.map((node) => withoutWindow(node)),
    edges: edges.map((edge) => withoutWindow(edge)),
    uniques: uniques.toSorted((left, right) => byUniqueIdentity(left, right)),
    fulltext: fulltext.toSorted((left, right) =>
      byFulltextIdentity(left, right),
    ),
  };
}

type SnapshotEdgeClaim = Readonly<{
  axis: string;
  key: string;
  edgeId: string;
}>;

type SnapshotIdentityAssertion = Readonly<{
  id: string;
  relation: string;
  a: string;
  b: string;
  validFrom: string | undefined;
  validTo: string | undefined;
  deleted: boolean;
  endedBy: string | undefined;
}>;

type SnapshotIdentityTransition = Readonly<{
  transitionId: string;
  recordedRevision: number;
  recordedAt: string | undefined;
  validAt: string | undefined;
  cause: string;
  classRef: string;
  priorClassRef: string | undefined;
  assertionIds: unknown;
  decision: unknown;
}>;

export type RoundTripState = Readonly<{
  nodes: readonly WindowedNode[];
  edges: readonly WindowedEdge[];
  uniques: ObservableState["uniques"];
  fulltext: ObservableState["fulltext"];
  /** The claim rows that still reserve their key (see {@link claimStands}). */
  edgeClaims: readonly SnapshotEdgeClaim[];
  identity: Readonly<{
    assertions: readonly SnapshotIdentityAssertion[];
    /** `member -> class`, one entry per closure row. */
    closure: readonly string[];
    /** `low | high` class-key pairs. */
    separation: readonly string[];
    transitions: readonly SnapshotIdentityTransition[];
  }>;
}>;

function refKey(kind: unknown, id: unknown): string {
  return `${String(kind)}:${String(id)}`;
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return values.toSorted(compareStrings);
}

/**
 * Whether a claim row still reserves its key, by the rule the claim module
 * states (src/store/claims/edge-claims.ts): a claim needs no release path, so
 * a row whose holder is no longer live — or, on an active-only population, no
 * longer open — is a stale row the next claimant takes over, not a
 * reservation. Two stores that agree on every live row may disagree on how
 * many stale rows they kept; they must agree on the standing ones.
 *
 * A small reference model rather than the store's predicate: each edge kind
 * here declares one population, so "active-only" is a fact of the kind.
 */
function claimStands(
  graph: GraphDef,
  edges: readonly WindowedEdge[],
  holderId: string,
): boolean {
  const holder = edges.find((edge) => edge.id === holderId && !edge.deleted);
  if (holder === undefined) return false;
  if (holder.validTo === undefined || Date.parse(holder.validTo) > Date.now()) {
    return true;
  }
  const registration = graph.edges[holder.kind];
  return (
    registration?.cardinality !== "oneActive" &&
    registration?.targetCardinality !== "oneActive"
  );
}

/**
 * {@link dumpObservableState} plus what an interchange round trip must carry:
 * every row's validity window and the ledgers derived from rows — edge claims
 * and the identity ledger. Compare two stores' answers with `toEqual`.
 *
 * `transitions` selects which transition-log rows are the graph's history:
 * `"all"` on a store that recorded them itself, `"restored"` on an import
 * target, whose own import writes log transitions of their own (no
 * `restored_at`) that explain the import, not the source's history.
 */
export async function dumpRoundTripState<G extends GraphDef>(
  store: Store<G>,
  options: Readonly<{ transitions: "all" | "restored" }>,
): Promise<RoundTripState> {
  const backend: GraphBackend = storeBackend(store);
  const graphId = store.graphId;
  const { nodes, edges } = await collectRows(store);
  const { uniques, fulltext } = await dumpObservableState(store);

  const claimRows = await backend.execute<{
    axis: string;
    key: string;
    edge_id: string;
  }>(
    asCompiledRowsSql(sql`
      SELECT axis, key, edge_id
      FROM ${sql.raw("typegraph_edge_claims")}
      WHERE graph_id = ${graphId}
    `),
  );
  const edgeClaims = claimRows
    .filter((row) => claimStands(store.graph, edges, row.edge_id))
    .map((row): SnapshotEdgeClaim => ({
      axis: row.axis,
      key: row.key,
      edgeId: row.edge_id,
    }))
    .toSorted(
      (left, right) =>
        compareStrings(left.axis, right.axis) ||
        compareStrings(left.key, right.key) ||
        compareStrings(left.edgeId, right.edgeId),
    );

  if (store.graph.identity === undefined) {
    return {
      nodes,
      edges,
      uniques,
      fulltext,
      edgeClaims,
      identity: {
        assertions: [],
        closure: [],
        separation: [],
        transitions: [],
      },
    };
  }

  const assertionRows = await backend.execute<Record<string, unknown>>(
    asCompiledRowsSql(sql`
      SELECT id, rel, a_kind, a_id, b_kind, b_id, valid_from, valid_to,
        deleted_at, ended_by_kind, ended_by_id
      FROM ${sql.raw("typegraph_identity_assertions")}
      WHERE graph_id = ${graphId}
    `),
  );
  const assertions = assertionRows
    .map((row): SnapshotIdentityAssertion => ({
      id: String(row["id"]),
      relation: String(row["rel"]),
      a: refKey(row["a_kind"], row["a_id"]),
      b: refKey(row["b_kind"], row["b_id"]),
      validFrom: canonicalInstant(row["valid_from"]),
      validTo: canonicalInstant(row["valid_to"]),
      deleted: row["deleted_at"] !== null && row["deleted_at"] !== undefined,
      endedBy:
        row["ended_by_kind"] === null || row["ended_by_kind"] === undefined ?
          undefined
        : refKey(row["ended_by_kind"], row["ended_by_id"]),
    }))
    .toSorted((left, right) => compareStrings(left.id, right.id));

  const closureRows = await backend.execute<Record<string, unknown>>(
    asCompiledRowsSql(sql`
      SELECT member_kind, member_id, class_kind, class_id
      FROM ${sql.raw("typegraph_identity_closure")}
      WHERE graph_id = ${graphId}
    `),
  );
  const closure = sortedStrings(
    closureRows.map(
      (row) =>
        `${refKey(row["member_kind"], row["member_id"])} -> ${refKey(row["class_kind"], row["class_id"])}`,
    ),
  );

  const separationRows = await backend.execute<Record<string, unknown>>(
    asCompiledRowsSql(sql`
      SELECT class_key_low, class_key_high
      FROM ${sql.raw("typegraph_identity_separation")}
      WHERE graph_id = ${graphId}
    `),
  );
  const separation = sortedStrings(
    separationRows.map(
      (row) =>
        `${String(row["class_key_low"])} | ${String(row["class_key_high"])}`,
    ),
  );

  const transitionRows = await backend.execute<Record<string, unknown>>(
    asCompiledRowsSql(sql`
      SELECT transition_id, recorded_revision, recorded_at, valid_at, cause,
        class_kind, class_id, prior_class_kind, prior_class_id,
        assertion_ids, decision, restored_at
      FROM ${sql.raw("typegraph_identity_transitions")}
      WHERE graph_id = ${graphId}
    `),
  );
  const transitions = transitionRows
    .filter(
      (row) =>
        options.transitions === "all" ||
        (row["restored_at"] !== null && row["restored_at"] !== undefined),
    )
    .map((row): SnapshotIdentityTransition => ({
      transitionId: String(row["transition_id"]),
      recordedRevision: Number(row["recorded_revision"]),
      recordedAt: canonicalInstant(row["recorded_at"]),
      validAt: canonicalInstant(row["valid_at"]),
      cause: String(row["cause"]),
      classRef: refKey(row["class_kind"], row["class_id"]),
      priorClassRef:
        (
          row["prior_class_kind"] === null ||
          row["prior_class_kind"] === undefined
        ) ?
          undefined
        : refKey(row["prior_class_kind"], row["prior_class_id"]),
      assertionIds: jsonColumn(row["assertion_ids"]),
      decision: jsonColumn(row["decision"]),
    }))
    .toSorted((left, right) =>
      compareStrings(left.transitionId, right.transitionId),
    );

  return {
    nodes,
    edges,
    uniques,
    fulltext,
    edgeClaims,
    identity: { assertions, closure, separation, transitions },
  };
}
