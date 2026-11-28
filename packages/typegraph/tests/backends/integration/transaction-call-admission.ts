/**
 * Every public member reachable from a transaction context is a call of the
 * context's session, a read as much as a write: refused before any statement
 * while another call's savepoint unit is open on the session, and — a read —
 * in flight from its entry until its promise settles, so a unit another call
 * tries to open meanwhile is refused.
 *
 * The audit is a ratchet. It enumerates the members a context, its
 * collections, its identity facade, its read backend and a query built on it
 * actually expose, and requires each to have a disposition here: a call (with
 * an invocation the audit runs), or not a call (with the reason, naming the
 * member whose calls it hands out). A new member without a disposition fails
 * the audit, and so does a call member that runs beside another call's unit
 * or lets a unit open beside it.
 *
 * Every call member is checked inside a savepoint unit another call holds
 * open: it must reject (never throw synchronously, when it returns a promise)
 * with `savepoint-open`, having issued no statement. Every read member is then
 * held in flight at its first statement while a unit tries to open beside it:
 * the unit must be refused with `siblings-in-flight`, and the read must still
 * succeed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  count,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  field,
} from "../../../src";
import { GRAPH_BACKEND_PROJECTION_KEYS } from "../../../src/backend/graph-backend-keys";
import type { EngineRevision } from "../../../src/backend/types";
import { defineNodeIndex } from "../../../src/indexes";
import { runRecordedTransactionSavepoint } from "../../../src/store/recorded-capture";
import type { MeasurableHistoryTransactionContext } from "../../../src/store/types";
import { requireDefined } from "../../../src/utils/presence";
import { createGate, type Gate } from "../../concurrency-utils";
import { savepointUnitEntry } from "../../helpers/savepoint-unit";
import type { IntegrationTestContext } from "./test-context";
import {
  gatedBackend,
  type Refusal,
  refusalOf,
  SAVEPOINT_OPEN_REFUSAL,
  savepointStatements,
  SIBLINGS_IN_FLIGHT_REFUSAL,
  typedErrorOf,
} from "./transaction-session-hazards";

const AdItem = defineNode("AdItem", {
  schema: z.object({ label: z.string(), group: z.string() }),
});
const AdLink = defineEdge("AdLink", { schema: z.object({}) });
const adItemGroup = defineNodeIndex(AdItem, {
  name: "ad_item_group",
  fields: ["group"],
});

let graphCounter = 0;

function buildGraph() {
  graphCounter += 1;
  return defineGraph({
    id: `transaction_call_admission_${graphCounter}`,
    nodes: {
      AdItem: {
        type: AdItem,
        unique: [
          {
            name: "ad_item_label",
            fields: ["label"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: { AdLink: { type: AdLink, from: [AdItem], to: [AdItem] } },
    indexes: [adItemGroup],
    identity: { sameIdAcrossKinds: "fold" },
  });
}

type AdContext = MeasurableHistoryTransactionContext<
  ReturnType<typeof buildGraph>
>;

/**
 * `context` as the audit drives it: every transaction context the audit
 * reaches (a `transactionWithReceipt` callback's, a `measure` scope's, a
 * `transaction` callback's) is one of a history store's, with the same members.
 */
function loose(context: object): AdContext {
  return context as AdContext;
}

/** What a call member's invocation needs beyond the context. */
type Fixture = Readonly<{ anchor: EngineRevision; graphId: string }>;

type Invoke = (tx: AdContext, fixture: Fixture) => unknown;

/**
 * A member's disposition: a read call, a write call, a call that is
 * synchronous by contract, or not a call (why, and whose calls it hands out).
 */
type Disposition =
  | Readonly<{ read: Invoke }>
  | Readonly<{ write: Invoke }>
  | Readonly<{ synchronous: Invoke }>
  | Readonly<{ notACall: string }>;

const S1 = { kind: "AdItem", id: asNodeId<typeof AdItem>("s1") } as const;
const S2 = { kind: "AdItem", id: asNodeId<typeof AdItem>("s2") } as const;
const S1_ID = S1.id;
const L1_ID = asEdgeId<typeof AdLink>("l1");

function items(tx: AdContext) {
  return tx.query().from("AdItem", "item");
}

function selected(tx: AdContext) {
  return items(tx)
    .select((select) => select.item.id)
    .orderBy("item", "id");
}

const CONTEXT_MEMBERS: Readonly<Record<string, Disposition>> = {
  nodes: { notACall: "a collection map: see NODE_COLLECTION_MEMBERS" },
  edges: { notACall: "a collection map: see EDGE_COLLECTION_MEMBERS" },
  writeNodeUpsertBatch: {
    write: (tx) =>
      tx.writeNodeUpsertBatch([
        {
          kind: "AdItem",
          id: asNodeId<typeof AdItem>("u1"),
          props: { label: "u1", group: "g" },
        },
      ]),
  },
  query: { notACall: "a query builder: see QUERY_TERMINALS" },
  describe: { read: (tx) => tx.describe() },
  validateStore: {
    read: (tx) => tx.validateStore({ entity: "node", kind: "AdItem" }),
  },
  batchOnce: { read: (tx) => tx.batchOnce(() => [selected(tx)] as const) },
  neighbors: { read: (tx) => tx.neighbors(S1, { edges: ["AdLink"] }) },
  countNeighbors: {
    read: (tx) => tx.countNeighbors(S1, { edges: ["AdLink"] }),
  },
  subgraph: { read: (tx) => tx.subgraph(S1, { edges: ["AdLink"] }) },
  assertUnchangedSince: {
    read: (tx, fixture) =>
      tx.assertUnchangedSince(fixture.anchor, [{ node: S1 }]),
  },
  identity: { notACall: "the identity facade: see IDENTITY_MEMBERS" },
  backend: { notACall: "the read backend: see BACKEND_MEMBERS" },
  getNodeCollection: {
    notACall: "returns this context's collection: see NODE_COLLECTION_MEMBERS",
  },
  getNodeByRef: { read: (tx) => tx.getNodeByRef(S1) },
  getEdgeCollection: {
    notACall: "returns this context's collection: see EDGE_COLLECTION_MEMBERS",
  },
  getEdgeCollectionOrThrow: {
    notACall: "returns this context's collection: see EDGE_COLLECTION_MEMBERS",
  },
  requestRecordedRevision: {
    synchronous: (tx) => {
      tx.requestRecordedRevision();
    },
  },
  sqlAvailability: { notACall: "a value" },
  sql: {
    notACall:
      "a history store's guard, which throws on access: raw SQL is never offered beside recorded capture",
  },
  measure: {
    notACall:
      "runs a callback over a scoped context whose members are these (audited on the scoped context)",
  },
};

const NODE_COLLECTION_MEMBERS: Readonly<Record<string, Disposition>> = {
  create: {
    write: (tx) => tx.nodes.AdItem.create({ label: "w1", group: "g" }),
  },
  createFromRecord: {
    write: (tx) =>
      tx.nodes.AdItem.createFromRecord({ label: "w2", group: "g" }),
  },
  getById: { read: (tx) => tx.nodes.AdItem.getById(S1_ID) },
  getByIds: { read: (tx) => tx.nodes.AdItem.getByIds([S1_ID]) },
  update: {
    write: (tx) => tx.nodes.AdItem.update(S1_ID, { group: "h" }),
  },
  compareAndSet: {
    write: (tx) =>
      tx.nodes.AdItem.compareAndSet(S1_ID, {
        expected: { group: "g" },
        patch: { group: "h" },
      }),
  },
  updateWhere: {
    write: (tx) =>
      tx.nodes.AdItem.updateWhere({ all: true, patch: { group: "h" } }),
  },
  reparent: {
    write: (tx) => tx.nodes.AdItem.reparent(S1_ID, {} as never),
  },
  bulkReparent: {
    write: (tx) =>
      tx.nodes.AdItem.bulkReparent([{ id: S1_ID, options: {} as never }]),
  },
  delete: { write: (tx) => tx.nodes.AdItem.delete(S1_ID) },
  hardDelete: { write: (tx) => tx.nodes.AdItem.hardDelete(S1_ID) },
  planDelete: {
    read: (tx) => tx.nodes.AdItem.planDelete(asNodeId<typeof AdItem>("s3")),
  },
  find: { read: (tx) => tx.nodes.AdItem.find() },
  count: { read: (tx) => tx.nodes.AdItem.count() },
  upsertById: {
    write: (tx) =>
      tx.nodes.AdItem.upsertById("w3", { label: "w3", group: "g" }),
  },
  upsertByIdFromRecord: {
    write: (tx) =>
      tx.nodes.AdItem.upsertByIdFromRecord("w4", { label: "w4", group: "g" }),
  },
  bulkCreate: {
    write: (tx) =>
      tx.nodes.AdItem.bulkCreate([{ props: { label: "w5", group: "g" } }]),
  },
  bulkReplaceById: {
    write: (tx) =>
      tx.nodes.AdItem.bulkReplaceById([
        { id: "s1", props: { label: "s1", group: "h" } },
      ]),
  },
  bulkUpsertById: {
    write: (tx) =>
      tx.nodes.AdItem.bulkUpsertById([
        { id: "w6", props: { label: "w6", group: "g" } },
      ]),
  },
  bulkInsert: {
    write: (tx) =>
      tx.nodes.AdItem.bulkInsert([{ props: { label: "w7", group: "g" } }]),
  },
  bulkDelete: { write: (tx) => tx.nodes.AdItem.bulkDelete([S1_ID]) },
  bulkHardDelete: {
    write: (tx) => tx.nodes.AdItem.bulkHardDelete([S1_ID]),
  },
  findByConstraint: {
    read: (tx) =>
      tx.nodes.AdItem.findByConstraint("ad_item_label", {
        label: "s1",
        group: "g",
      }),
  },
  bulkFindByConstraint: {
    read: (tx) =>
      tx.nodes.AdItem.bulkFindByConstraint("ad_item_label", [
        { props: { label: "s1", group: "g" } },
      ]),
  },
  bulkFindByIndex: {
    read: (tx) =>
      tx.nodes.AdItem.bulkFindByIndex("ad_item_group", [
        { props: { group: "g" } },
      ]),
  },
  getOrCreateByConstraint: {
    write: (tx) =>
      tx.nodes.AdItem.getOrCreateByConstraint("ad_item_label", {
        label: "w8",
        group: "g",
      }),
  },
  bulkGetOrCreateByConstraint: {
    write: (tx) =>
      tx.nodes.AdItem.bulkGetOrCreateByConstraint("ad_item_label", [
        { props: { label: "w9", group: "g" } },
      ]),
  },
};

const DEFERRED_EDGE_READ =
  "a deferred read store.batch() runs on the target it is handed, which joins as a session of its own";

const EDGE_COLLECTION_MEMBERS: Readonly<Record<string, Disposition>> = {
  create: { write: (tx) => tx.edges.AdLink.create(S2, S1, {}) },
  getById: { read: (tx) => tx.edges.AdLink.getById(L1_ID) },
  getByIds: { read: (tx) => tx.edges.AdLink.getByIds([L1_ID]) },
  update: { write: (tx) => tx.edges.AdLink.update(L1_ID, {}) },
  findFrom: { read: (tx) => tx.edges.AdLink.findFrom(S1) },
  findTo: { read: (tx) => tx.edges.AdLink.findTo(S2) },
  bulkFindFrom: { read: (tx) => tx.edges.AdLink.bulkFindFrom([S1]) },
  bulkFindTo: { read: (tx) => tx.edges.AdLink.bulkFindTo([S2]) },
  batchFindFrom: { notACall: DEFERRED_EDGE_READ },
  batchFindTo: { notACall: DEFERRED_EDGE_READ },
  batchFindByEndpoints: { notACall: DEFERRED_EDGE_READ },
  delete: { write: (tx) => tx.edges.AdLink.delete(L1_ID) },
  hardDelete: { write: (tx) => tx.edges.AdLink.hardDelete(L1_ID) },
  find: { read: (tx) => tx.edges.AdLink.find() },
  count: { read: (tx) => tx.edges.AdLink.count() },
  bulkCreate: {
    write: (tx) => tx.edges.AdLink.bulkCreate([{ from: S2, to: S1 }]),
  },
  bulkUpsertById: {
    write: (tx) =>
      tx.edges.AdLink.bulkUpsertById([
        { id: asEdgeId<typeof AdLink>("l2"), from: S2, to: S1 },
      ]),
  },
  bulkInsert: {
    write: (tx) => tx.edges.AdLink.bulkInsert([{ from: S2, to: S1 }]),
  },
  bulkDelete: { write: (tx) => tx.edges.AdLink.bulkDelete([L1_ID]) },
  bulkHardDelete: { write: (tx) => tx.edges.AdLink.bulkHardDelete([L1_ID]) },
  findByEndpoints: { read: (tx) => tx.edges.AdLink.findByEndpoints(S1, S2) },
  getOrCreateByEndpoints: {
    write: (tx) => tx.edges.AdLink.getOrCreateByEndpoints(S2, S1, {}),
  },
  bulkGetOrCreateByEndpoints: {
    write: (tx) =>
      tx.edges.AdLink.bulkGetOrCreateByEndpoints([
        { from: S2, to: S1, props: {} },
      ]),
  },
};

const IDENTITY_MEMBERS: Readonly<Record<string, Disposition>> = {
  classes: { read: (tx) => tx.identity.classes({ limit: 10 }) },
  representativeOf: { read: (tx) => tx.identity.representativeOf(S1) },
  membersOf: { read: (tx) => tx.identity.membersOf(S1) },
  nodesOf: { read: (tx) => tx.identity.nodesOf(S1) },
  areSame: { read: (tx) => tx.identity.areSame(S1, S2) },
  areDifferent: { read: (tx) => tx.identity.areDifferent(S1, S2) },
  assertionsOf: { read: (tx) => tx.identity.assertionsOf(S1) },
  explainSame: { read: (tx) => tx.identity.explainSame(S1, S2) },
  transitionsOf: { read: (tx) => tx.identity.transitionsOf(S1) },
  replay: { read: (tx) => tx.identity.replay(S1) },
  assertSame: { write: (tx) => tx.identity.assertSame(S1, S2) },
  assertDifferent: { write: (tx) => tx.identity.assertDifferent(S1, S2) },
  bulkAssertSame: {
    write: (tx) => tx.identity.bulkAssertSame([{ a: S1, b: S2 }]),
  },
  bulkAssertDifferent: {
    write: (tx) => tx.identity.bulkAssertDifferent([{ a: S1, b: S2 }]),
  },
  retractAssertion: {
    write: (tx) => tx.identity.retractAssertion("missing" as never),
  },
  retractSameAssertion: {
    write: (tx) => tx.identity.retractSameAssertion(S1, S2),
  },
  retractDifferentAssertion: {
    write: (tx) => tx.identity.retractDifferentAssertion(S1, S2),
  },
  bulkRetractAssertions: {
    write: (tx) => tx.identity.bulkRetractAssertions(["missing" as never]),
  },
};

const BACKEND_VALUE = "a value the projection exposes without a statement";

const BACKEND_MEMBERS: Readonly<Record<string, Disposition>> = {
  dialect: { notACall: BACKEND_VALUE },
  capabilities: { notACall: BACKEND_VALUE },
  tableNames: { notACall: BACKEND_VALUE },
  fulltextStrategy: { notACall: BACKEND_VALUE },
  vectorStrategy: { notACall: BACKEND_VALUE },
  compileSql: { notACall: "compiles a fragment; issues no statement" },
  getNode: {
    read: (tx, { graphId }) => tx.backend.getNode(graphId, "AdItem", "s1"),
  },
  getNodes: {
    read: (tx, { graphId }) =>
      requireDefined(tx.backend.getNodes)(graphId, "AdItem", ["s1"]),
  },
  getEdge: { read: (tx, { graphId }) => tx.backend.getEdge(graphId, "l1") },
  getEdges: {
    read: (tx, { graphId }) =>
      requireDefined(tx.backend.getEdges)(graphId, ["l1"]),
  },
  countEdgesAtEndpoint: {
    read: (tx, { graphId }) =>
      tx.backend.countEdgesAtEndpoint({
        graphId,
        edgeKind: "AdLink",
        endpoint: "from",
        endpointKind: "AdItem",
        endpointId: "s1",
      }),
  },
  edgeExistsBetween: {
    read: (tx, { graphId }) =>
      tx.backend.edgeExistsBetween({
        graphId,
        edgeKind: "AdLink",
        fromKind: "AdItem",
        fromId: "s1",
        toKind: "AdItem",
        toId: "s2",
      }),
  },
  findEdgesConnectedTo: {
    read: (tx, { graphId }) =>
      tx.backend.findEdgesConnectedTo({
        graphId,
        nodeKind: "AdItem",
        nodeId: "s1",
      }),
  },
  findNodesByKind: {
    read: (tx, { graphId }) =>
      tx.backend.findNodesByKind({ graphId, kind: "AdItem" }),
  },
  findNodesAcrossKinds: {
    read: (tx, { graphId }) =>
      requireDefined(tx.backend.findNodesAcrossKinds)({
        graphId,
        kinds: ["AdItem"],
        limit: 10,
      }),
  },
  countNodesByKind: {
    read: (tx, { graphId }) =>
      tx.backend.countNodesByKind({ graphId, kind: "AdItem" }),
  },
  findEdgesByKind: {
    read: (tx, { graphId }) =>
      tx.backend.findEdgesByKind({ graphId, kind: "AdLink" }),
  },
  findActiveEdgesBySourceV1: {
    read: (tx, { graphId }) =>
      requireDefined(tx.backend.findActiveEdgesBySourceV1)({
        graphId,
        edgeKind: "AdLink",
        fromKind: "AdItem",
        fromId: "s1",
      }),
  },
  findEdgesAcrossKinds: {
    read: (tx, { graphId }) =>
      requireDefined(tx.backend.findEdgesAcrossKinds)({
        graphId,
        kinds: ["AdLink"],
        limit: 10,
      }),
  },
  countEdgesByKind: {
    read: (tx, { graphId }) =>
      tx.backend.countEdgesByKind({ graphId, kind: "AdLink" }),
  },
  getActiveSchema: {
    read: (tx, { graphId }) => tx.backend.getActiveSchema(graphId),
  },
  getSchemaVersion: {
    read: (tx, { graphId }) => tx.backend.getSchemaVersion(graphId, 1),
  },
};

const BUILDER_STEP =
  "a builder step: returns a query whose terminals are calls";
const NO_STATEMENT = "compiles or describes the query; issues no statement";

/** The members of a selected query, and the terminals of the shapes it builds. */
const QUERY_MEMBERS: Readonly<Record<string, Disposition>> = {
  constructor: { notACall: "the class" },
  toAst: { notACall: NO_STATEMENT },
  orderBy: { notACall: BUILDER_STEP },
  limit: { notACall: BUILDER_STEP },
  offset: { notACall: BUILDER_STEP },
  pipe: { notACall: BUILDER_STEP },
  union: { notACall: `${BUILDER_STEP} (QUERY_TERMINALS: union)` },
  unionAll: { notACall: BUILDER_STEP },
  intersect: { notACall: BUILDER_STEP },
  except: { notACall: BUILDER_STEP },
  toSQL: { notACall: NO_STATEMENT },
  compile: { notACall: NO_STATEMENT },
  compileNodeCandidateIds: { notACall: NO_STATEMENT },
  prepare: { notACall: `${BUILDER_STEP} (QUERY_TERMINALS: prepared)` },
  execute: { read: (tx) => selected(tx).execute() },
  first: { read: (tx) => selected(tx).first() },
  count: { read: (tx) => selected(tx).count() },
  exists: { read: (tx) => selected(tx).exists() },
  executeChecked: { read: (tx) => selected(tx).executeChecked(1) },
  checkSqlNamesBeforeExecution: { notACall: NO_STATEMENT },
  executeOn: {
    notACall:
      "runs on the target it is handed, which joins as a session of its own",
  },
  oneStatementBatchProvenance: { notACall: NO_STATEMENT },
  toNodeCandidateSelection: { notACall: NO_STATEMENT },
  compileOneStatementBatchItem: { notACall: NO_STATEMENT },
  paginate: { read: (tx) => selected(tx).paginate({ first: 1 }) },
  page: { read: (tx) => selected(tx).page({ first: 1 }).execute() },
  stream: {
    read: (tx) =>
      (
        selected(tx).stream({
          batchSize: 1,
        }) as unknown as AsyncIterable<unknown>
      )
        [Symbol.asyncIterator]()
        .next(),
  },
};

/** Terminals of the other query shapes a transaction's builder produces. */
const QUERY_TERMINALS: Readonly<Record<string, Disposition>> = {
  "builder.count": { read: (tx) => items(tx).count() },
  "builder.exists": { read: (tx) => items(tx).exists() },
  "prepared.execute": { read: (tx) => selected(tx).prepare().execute() },
  "union.execute": {
    read: (tx) => selected(tx).union(selected(tx)).execute(),
  },
  "aggregate.execute": {
    read: (tx) =>
      items(tx)
        .groupBy("item", "group")
        .aggregate({ group: field("item", "group"), total: count("item") })
        .execute(),
  },
  "projection.execute": {
    read: (tx) =>
      items(tx)
        .project((fields) => ({ label: fields.item.label }))
        .execute(),
  },
  "projection.count": {
    read: (tx) =>
      items(tx)
        .project((fields) => ({ label: fields.item.label }))
        .count(),
  },
};

type Surface = Readonly<{
  name: string;
  members: (tx: AdContext) => readonly string[];
  table: Readonly<Record<string, Disposition>>;
  /**
   * Members a backend may lack: the read projection offers an optional
   * member only when the transaction implements it.
   */
  optional?: ReadonlySet<string>;
}>;

function ownKeys(value: object): readonly string[] {
  return Object.keys(value).toSorted();
}

function prototypeKeys(value: object): readonly string[] {
  return Object.getOwnPropertyNames(Object.getPrototypeOf(value)).toSorted();
}

const SURFACES: readonly Surface[] = [
  { name: "tx", members: (tx) => ownKeys(tx), table: CONTEXT_MEMBERS },
  {
    name: "tx.nodes.<Kind>",
    members: (tx) => ownKeys(tx.nodes.AdItem),
    table: NODE_COLLECTION_MEMBERS,
  },
  {
    name: "tx.edges.<Kind>",
    members: (tx) => ownKeys(tx.edges.AdLink),
    table: EDGE_COLLECTION_MEMBERS,
  },
  {
    name: "tx.identity",
    members: (tx) => ownKeys(tx.identity),
    table: IDENTITY_MEMBERS,
  },
  {
    name: "tx.backend",
    members: (tx) => ownKeys(tx.backend),
    table: BACKEND_MEMBERS,
    optional: new Set([
      "tableNames",
      "fulltextStrategy",
      "vectorStrategy",
      "getNodes",
      "getEdges",
      "findNodesAcrossKinds",
      "findActiveEdgesBySourceV1",
      "findEdgesAcrossKinds",
      "compileSql",
    ]),
  },
  {
    name: "tx.query()...select()",
    members: (tx) => prototypeKeys(selected(tx)),
    table: QUERY_MEMBERS,
  },
];

type Call = Readonly<{
  name: string;
  kind: "read" | "write" | "synchronous";
  invoke: Invoke;
  /** Whether `tx` offers the member (an optional one may be absent). */
  offered: (tx: AdContext) => boolean;
}>;

function callsOf(
  table: Readonly<Record<string, Disposition>>,
  prefix: string,
  offered: (tx: AdContext, member: string) => boolean,
) {
  return Object.entries(table).flatMap(([member, disposition]): Call[] => {
    const name = `${prefix}.${member}`;
    const call = { name, offered: (tx: AdContext) => offered(tx, member) };
    if ("read" in disposition)
      return [{ ...call, kind: "read", invoke: disposition.read }];
    if ("write" in disposition)
      return [{ ...call, kind: "write", invoke: disposition.write }];
    if ("synchronous" in disposition)
      return [
        { ...call, kind: "synchronous", invoke: disposition.synchronous },
      ];
    return [];
  });
}

const CALLS: readonly Call[] = [
  ...SURFACES.flatMap((surface) =>
    callsOf(surface.table, surface.name, (tx, member) =>
      surface.members(tx).includes(member),
    ),
  ),
  ...callsOf(QUERY_TERMINALS, "tx.query()", () => true),
];

/** What one call did when invoked: how it refused, and whether synchronously. */
type Invocation = Readonly<{
  outcome: Refusal;
  threwSynchronously: boolean;
}>;

async function invocationOf(call: () => unknown): Promise<Invocation> {
  let returned: unknown;
  try {
    returned = call();
  } catch (error) {
    return { outcome: typedErrorOf(error), threwSynchronously: true };
  }
  return {
    outcome: await refusalOf(Promise.resolve(returned)),
    threwSynchronously: false,
  };
}

/** A history store over a traced backend, with `s1`, `s2` and `l1`. */
async function setUp(
  context: IntegrationTestContext,
  options: Readonly<{ hold?: () => Promise<void> }>,
) {
  const graph = buildGraph();
  const backend = context.getBackend();
  const hold = options.hold;
  const gated = gatedBackend(backend, {
    ...(hold === undefined ?
      {}
    : {
        after: Object.fromEntries(
          GRAPH_BACKEND_PROJECTION_KEYS.map((key) => [key, hold]),
        ),
      }),
  });
  const [store] = await createStoreWithSchema(graph, gated.backend, {
    history: true,
  });
  await store.nodes.AdItem.bulkCreate([
    { props: { label: "s1", group: "g" }, id: "s1" },
    { props: { label: "s2", group: "g" }, id: "s2" },
    { props: { label: "s3", group: "g" }, id: "s3" },
  ]);
  await store.edges.AdLink.create(S1, S2, {}, { id: "l1" });
  const fixture: Fixture = {
    anchor: requireDefined(await store.lineageRevisionNow()),
    graphId: graph.id,
  };
  return {
    store,
    fixture,
    trace: gated.trace,
    statements: savepointStatements(backend),
  };
}

export function registerTransactionCallAdmissionTests(
  context: IntegrationTestContext,
): void {
  describe("transaction call admission", () => {
    it("gives every member of a transaction context a disposition", async () => {
      const { store } = await setUp(context, {});
      const undisposed = await store.transactionWithReceipt(async (tx) => {
        const scoped = await tx.measure((inner) =>
          Promise.resolve(
            ownKeys(inner).filter((key) => !(key in CONTEXT_MEMBERS)),
          ),
        );
        return {
          ...Object.fromEntries(
            SURFACES.map((surface) => [
              surface.name,
              surface
                .members(loose(tx))
                .filter((member) => !(member in surface.table)),
            ]),
          ),
          "tx.measure() scope": scoped.result,
        };
      });
      expect(undisposed.result).toEqual({
        ...Object.fromEntries(SURFACES.map((surface) => [surface.name, []])),
        "tx.measure() scope": [],
      });
      // And every disposition names a member that exists.
      const stale = await store.transactionWithReceipt((tx) =>
        Promise.resolve(
          SURFACES.flatMap((surface) => {
            const members = new Set(surface.members(loose(tx)));
            return Object.keys(surface.table)
              .filter(
                (member) =>
                  !members.has(member) &&
                  surface.optional?.has(member) !== true,
              )
              .map((member) => `${surface.name}.${member}`);
          }),
        ),
      );
      expect(stale.result).toEqual([]);
    });

    it("refuses every call that starts inside another call's savepoint unit, before any statement", async () => {
      const { store, fixture, trace, statements } = await setUp(context, {});
      const observed: Record<string, unknown> = {};
      let offered: readonly Call[] = [];
      await store.transactionWithReceipt(async (tx) => {
        offered = CALLS.filter((call) => call.offered(loose(tx)));
        const scoped = await tx.measure((inner) => Promise.resolve(inner));
        const contexts = [
          ["tx", loose(tx)],
          ["scope", loose(scoped.result)],
        ] as const;
        const [operation] = savepointUnitEntry(tx);
        await refusalOf(
          runRecordedTransactionSavepoint(
            operation,
            operation.backend,
            statements,
            "admission_audit_unit",
            async () => {
              for (const [label, target] of contexts) {
                for (const call of CALLS.filter((entry) =>
                  entry.offered(target),
                )) {
                  const mark = trace.length;
                  const invocation = await invocationOf(() =>
                    call.invoke(target, fixture),
                  );
                  observed[`${label}: ${call.name}`] = {
                    ...invocation,
                    statements: trace.slice(mark).map((entry) => entry.member),
                  };
                }
              }
              throw new Error("the audit's unit rolls back");
            },
          ),
        );
      });
      const refused = (call: Call) => ({
        outcome: SAVEPOINT_OPEN_REFUSAL,
        // A synchronous member refuses synchronously; every other returns a
        // promise that rejects.
        threwSynchronously: call.kind === "synchronous",
        statements: [],
      });
      expect(observed).toEqual(
        Object.fromEntries(
          ["tx", "scope"].flatMap((label) =>
            offered.map((call) => [`${label}: ${call.name}`, refused(call)]),
          ),
        ),
      );
    });

    it("refuses a unit that tries to open while any read is in flight, and the read still succeeds", async () => {
      let armed: Readonly<{ held: Gate; release: Gate }> | undefined;
      const { store, fixture, trace, statements } = await setUp(context, {
        hold: async () => {
          const gates = armed;
          if (gates === undefined) return;
          armed = undefined;
          gates.held.open();
          await gates.release.opened;
        },
      });
      const observed: Record<string, unknown> = {};
      let reads: readonly Call[] = [];
      await store.transaction(async (tx) => {
        reads = CALLS.filter(
          (call) => call.kind === "read" && call.offered(loose(tx)),
        );
        for (const call of reads) {
          const held = createGate();
          const release = createGate();
          armed = { held, release };
          const read = refusalOf(
            Promise.resolve(call.invoke(loose(tx), fixture)),
          );
          // Paused right after the read's first statement resolved.
          const paused = await Promise.race([
            held.opened.then(() => true),
            read.then(() => false),
          ]);
          const mark = trace.length;
          const [operation] = savepointUnitEntry(tx);
          const unit = await refusalOf(
            runRecordedTransactionSavepoint(
              operation,
              operation.backend,
              statements,
              "admission_audit_sibling",
              () => {
                throw new Error("the unit opened beside a running read");
              },
            ),
          );
          const unitStatements = trace.slice(mark).map((entry) => entry.member);
          armed = undefined;
          release.open();
          observed[call.name] = {
            paused,
            unit,
            unitStatements,
            read: await read,
          };
        }
      });
      expect(observed).toEqual(
        Object.fromEntries(
          reads.map((call) => [
            call.name,
            {
              paused: true,
              unit: SIBLINGS_IN_FLIGHT_REFUSAL,
              unitStatements: [],
              read: { fulfilled: true },
            },
          ]),
        ),
      );
    });
  });
}
