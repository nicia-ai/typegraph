/**
 * Type-level contract for `StoreView` (the read-only `(mode, asOf)` lens).
 *
 * Much of StoreView is a TypeScript contract: the entry points return a
 * `StoreView`, the read surfaces keep their result types, the per-call
 * temporal options are removed (the pin owns them), writes are absent, and
 * `asOfRecorded` returns the narrow recorded-time `RecordedStoreView`.
 */
import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  asRecordedInstant,
  createFragment,
  defineEdge,
  defineGraph,
  defineNode,
  type Edge,
  type EdgeBatchReads,
  type EdgeCollection,
  type EdgeId,
  type EdgeTemporalReads,
  type EdgeWrites,
  type EmptyEdgeAliasMap,
  type EmptyRecursiveAliasMap,
  type Node,
  type NodeAlias,
  type NodeCollection,
  type NodeCurrentReads,
  type NodeId,
  type NodeRef,
  type NodeTemporalReads,
  type NodeWrites,
  type InitialQueryBuilder,
  type QueryOptions,
  type ReachableNode,
  type RecordedInstant,
  type RecordedStoreView,
  type RecordedStoreViewEdgeCollection,
  type RecordedStoreViewNodeCollection,
  type Store,
  type StoreSearch,
  type StoreView,
  type StoreViewEdgeCollection,
  type StoreViewNodeCollection,
  type TemporalMode,
  type WeaklyConnectedComponentMembership,
} from "..";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });

const graph = defineGraph({
  id: "store_view_types",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

declare const store: Store<typeof graph>;
declare const view: StoreView<typeof graph>;
declare const personId: NodeId<typeof Person>;
declare const personRef: NodeRef<typeof Person>;
declare const companyRef: NodeRef<typeof Company>;
declare const worksAtId: EdgeId<typeof worksAt>;
declare const recordedAnchor: RecordedInstant;

const CANONICAL = "2024-01-01T00:00:00.000Z";
const LEAKED_RECORDED_OPTIONS = { recordedAsOf: recordedAnchor };
type PersonAliasMap = Readonly<Record<"p", NodeAlias<typeof Person>>>;

// ============================================================
// Entry points return a StoreView
// ============================================================

expectType<StoreView<typeof graph>>(store.asOf(CANONICAL));
expectType<StoreView<typeof graph>>(store.view({ mode: "current" }));
expectType<StoreView<typeof graph>>(
  store.view({ mode: "asOf", asOf: CANONICAL }),
);

// The coordinate is a discriminated union: the type mirrors the runtime
// contract instead of merely deferring to a ValidationError.
// `"asOf"` requires a timestamp …
expectError(store.view({ mode: "asOf" }));
// … and every other mode rejects one.
expectError(store.view({ mode: "current", asOf: CANONICAL }));
expectError(store.view({ mode: "includeEnded", asOf: CANONICAL }));
expectError(store.view({ mode: "includeTombstones", asOf: CANONICAL }));

// `asOfRecorded` pins the recorded/system-time axis and returns the narrow
// `RecordedStoreView` (reconstructing-safe reads only). The instant is branded —
// see recorded-instant.test-d.ts for the full brand contract.
expectType<RecordedStoreView<typeof graph>>(
  store.asOfRecorded(asRecordedInstant(CANONICAL)),
);
// Diagonal sugar composes off a valid-time pin too.
expectType<RecordedStoreView<typeof graph>>(
  store.asOf(CANONICAL).asOfRecorded(asRecordedInstant(CANONICAL)),
);
// A raw string is rejected; the timestamp is required.
expectError(store.asOfRecorded(CANONICAL));
expectError(store.asOfRecorded());

// ============================================================
// Pinned coordinate
// ============================================================

expectType<TemporalMode>(view.mode);
expectType<string | undefined>(view.asOf);

// ============================================================
// Read surfaces are pinned and keep their result types
// ============================================================

expectType<Promise<Node<typeof Person> | undefined>>(
  view.nodes.Person.getById(personId),
);
expectAssignable<Promise<Node<typeof Person>[]>>(
  view.nodes.Person.find({ where: (person) => person.name.eq("x"), limit: 5 }),
);
expectType<Promise<number>>(view.nodes.Person.count());
expectAssignable<Promise<Edge<typeof worksAt>[]>>(
  view.edges.worksAt.findFrom(personRef),
);
expectType<InitialQueryBuilder<typeof graph, "sealed">>(view.query());
expectType<StoreSearch<typeof graph>>(view.search);
expectAssignable<Promise<readonly ReachableNode[]>>(
  view.reachable(personId, { edges: ["knows"] }),
);
expectAssignable<Promise<readonly WeaklyConnectedComponentMembership[]>>(
  view.algorithms.weaklyConnectedComponents({ edges: ["knows"] }),
);

// StoreView owns the read coordinate. Its query builder stays fluent for
// predicates/projections, but callers cannot re-coordinate it with
// `.temporal(...)`; only the live Store produces an open query builder.
expectType<InitialQueryBuilder<typeof graph, "open">>(store.query());
void store.query().temporal("current");
expectError(view.query().temporal("current"));
expectError(view.query().from("Person", "p").temporal("current"));
expectError(
  view
    .query()
    .from("Person", "p")
    .traverse("knows", "k")
    .to("Person", "friend")
    .temporal("current"),
);
expectError(
  view
    .query()
    .from("Person", "p")
    .optionalTraverse("knows", "k")
    .to("Person", "friend")
    .temporal("current"),
);
expectError(
  view
    .query()
    .from("Person", "p")
    .traverseDynamic("knows", "k")
    .toDynamic("Person", "friend")
    .temporal("current"),
);
expectError(
  view
    .query()
    .from("Person", "p")
    .optionalTraverseDynamic("knows", "k")
    .toDynamic("Person", "friend")
    .temporal("current"),
);

const fragment = createFragment<typeof graph>();
const personNameFragment = fragment<
  PersonAliasMap,
  PersonAliasMap,
  EmptyEdgeAliasMap,
  EmptyEdgeAliasMap,
  EmptyRecursiveAliasMap,
  EmptyRecursiveAliasMap
>((query) => query.whereNode("p", ({ name }) => name.eq("Alice")));

void store
  .query()
  .from("Person", "p")
  .pipe(personNameFragment)
  .temporal("current");
expectError(
  view.query().from("Person", "p").pipe(personNameFragment).temporal("current"),
);
expectError(fragment((query) => query.temporal("current")));

// ============================================================
// Per-call temporal options are removed — the pin owns the axis
// ============================================================

expectError(view.nodes.Person.getById(personId, { temporalMode: "asOf" }));
expectError(view.nodes.Person.find({ temporalMode: "asOf" }));
expectError(view.nodes.Person.count({ temporalMode: "current" }));
expectError(view.edges.worksAt.findFrom(personRef, { temporalMode: "asOf" }));
expectError(view.edges.worksAt.find({ temporalMode: "asOf" }));
expectError(
  view.reachable(personId, { edges: ["knows"], temporalMode: "asOf" }),
);
expectError(view.degree(personId, { temporalMode: "asOf" }));
expectError(
  view.algorithms.weaklyConnectedComponents({
    edges: ["knows"],
    temporalMode: "asOf",
  }),
);
expectError(
  view.subgraph(personId, { edges: ["knows"], temporalMode: "asOf" }),
);
expectError(
  store.subgraph(personId, {
    edges: ["knows"],
    recordedAsOf: CANONICAL,
  }),
);

// Public temporal options reject recorded-time coordinates even when the
// object is pre-bound before the call site. This closes the excess-property
// loophole where `{ recordedAsOf }` variables can otherwise sneak past the
// inline object-literal check.
expectError(store.nodes.Person.getById(personId, LEAKED_RECORDED_OPTIONS));
expectError(store.nodes.Person.getByIds([personId], LEAKED_RECORDED_OPTIONS));
expectError(store.nodes.Person.find(undefined, LEAKED_RECORDED_OPTIONS));
expectError(store.nodes.Person.count(LEAKED_RECORDED_OPTIONS));
expectError(store.edges.worksAt.getById(worksAtId, LEAKED_RECORDED_OPTIONS));
expectError(store.edges.worksAt.getByIds([worksAtId], LEAKED_RECORDED_OPTIONS));
expectError(store.edges.worksAt.find(undefined, LEAKED_RECORDED_OPTIONS));
expectError(store.edges.worksAt.findFrom(personRef, LEAKED_RECORDED_OPTIONS));
expectError(store.edges.worksAt.findTo(companyRef, LEAKED_RECORDED_OPTIONS));
expectError(
  store.edges.worksAt.findByEndpoints(
    personRef,
    companyRef,
    undefined,
    LEAKED_RECORDED_OPTIONS,
  ),
);
expectError(
  store.edges.worksAt.batchFindFrom(personRef, LEAKED_RECORDED_OPTIONS),
);
expectError(
  store.edges.worksAt.batchFindTo(companyRef, LEAKED_RECORDED_OPTIONS),
);
expectError(
  store.edges.worksAt.batchFindByEndpoints(
    personRef,
    companyRef,
    undefined,
    LEAKED_RECORDED_OPTIONS,
  ),
);
expectError(
  store.subgraph(personId, {
    edges: ["knows"],
    ...LEAKED_RECORDED_OPTIONS,
  }),
);
expectError(
  store.algorithms.reachable(personId, {
    edges: ["knows"],
    ...LEAKED_RECORDED_OPTIONS,
  }),
);
expectError(
  store.algorithms.degree(personId, {
    edges: ["knows"],
    ...LEAKED_RECORDED_OPTIONS,
  }),
);
expectError(
  store.algorithms.weaklyConnectedComponents({
    edges: ["knows"],
    ...LEAKED_RECORDED_OPTIONS,
  }),
);

// ============================================================
// Writes are omitted from the read-only view
// ============================================================

expectError(view.nodes.Person.create({ name: "x" }));
expectError(view.nodes.Person.update(personId, { name: "x" }));
expectError(view.nodes.Person.delete(personId));
expectError(view.nodes.Person.upsertById("id", { name: "x" }));
expectError(view.edges.worksAt.create(personRef, companyRef, { role: "x" }));
expectError(view.edges.worksAt.delete("id"));

// No transaction surface on a read-only view.
expectError(view.transaction(async () => undefined));

// ============================================================
// Current-state-only reads are exposed (delegated on a current view,
// refused at runtime on a temporal pin) — see the generalized search rule
// ============================================================

expectType<Promise<Node<typeof Person> | undefined>>(
  view.nodes.Person.findByConstraint("byName", { name: "x" }),
);
expectAssignable<Promise<readonly Node<typeof Person>[][]>>(
  view.nodes.Person.bulkFindByIndex("byName", [{ props: { name: "x" } }]),
);

// Edge `findByEndpoints` now has temporal parity — it is a *pinned* read on
// the view (the per-call temporal arg is dropped; the pin supplies it).
expectAssignable<Promise<Edge<typeof worksAt> | undefined>>(
  view.edges.worksAt.findByEndpoints(personRef, companyRef),
);
expectError(
  view.edges.worksAt.findByEndpoints(personRef, companyRef, undefined, {
    temporalMode: "asOf",
  }),
);

// ============================================================
// Conformance: the read/write buckets exactly partition the live collection
// (a new method cannot be silently dropped from the view's surface decision)
// ============================================================

type NodePartition = NodeTemporalReads<typeof Person> &
  NodeCurrentReads<typeof Person> &
  NodeWrites<typeof Person>;
expectAssignable<NodeCollection<typeof Person>>({} as NodePartition);
expectAssignable<NodePartition>({} as NodeCollection<typeof Person>);

type EdgePartition = EdgeTemporalReads<typeof worksAt> &
  EdgeBatchReads<typeof worksAt> &
  EdgeWrites<typeof worksAt>;
expectAssignable<EdgeCollection<typeof worksAt>>({} as EdgePartition);
expectAssignable<EdgePartition>({} as EdgeCollection<typeof worksAt>);

// ============================================================
// Conformance: the view's temporal surface IS the pinned form of the live
// temporal reads (a trailing QueryOptions arg dropped) — proves the
// normalization + derivation, so a new temporal read auto-pins
// ============================================================

type DropTemporalArg<A extends readonly unknown[]> =
  A extends readonly [...infer Head, QueryOptions | undefined] ? Head
  : A extends readonly [...infer Head, (QueryOptions | undefined)?] ? Head
  : A;

type Pinned<T> = {
  readonly [K in keyof T]: T[K] extends (...args: infer A) => infer R ?
    (...args: DropTemporalArg<A>) => R
  : T[K];
};

type ViewNodeTemporal = Omit<
  StoreViewNodeCollection<typeof Person>,
  keyof NodeCurrentReads<typeof Person>
>;
expectAssignable<Pinned<NodeTemporalReads<typeof Person>>>(
  {} as ViewNodeTemporal,
);
expectAssignable<ViewNodeTemporal>(
  {} as Pinned<NodeTemporalReads<typeof Person>>,
);

type ViewEdgeTemporal = StoreViewEdgeCollection<typeof worksAt>;
expectAssignable<Pinned<EdgeTemporalReads<typeof worksAt>>>(
  {} as ViewEdgeTemporal,
);
expectAssignable<ViewEdgeTemporal>(
  {} as Pinned<EdgeTemporalReads<typeof worksAt>>,
);

// ============================================================
// Conformance: RecordedStoreView's reconstructing surface does not drift from
// StoreView's. The recorded view is a hand-written class (not a structural
// `Pick<StoreView, …>`), so a shared method's signature could silently diverge
// — these mutual-assignability checks turn any drift into a build break.
// ============================================================

type RecordedSharedKeys =
  | "query"
  | "subgraph"
  | "reachable"
  | "canReach"
  | "shortestPath"
  | "neighbors"
  | "degree"
  | "weaklyConnectedComponents"
  | "algorithms"
  | "mode"
  | "asOf";

expectAssignable<Pick<StoreView<typeof graph>, RecordedSharedKeys>>(
  {} as Pick<RecordedStoreView<typeof graph>, RecordedSharedKeys>,
);
expectAssignable<Pick<RecordedStoreView<typeof graph>, RecordedSharedKeys>>(
  {} as Pick<StoreView<typeof graph>, RecordedSharedKeys>,
);

// ============================================================
// Conformance: the recorded view's collections expose EXACTLY the two
// reconstructing point reads, and those reads ARE StoreView's point reads.
// Narrowness (the `keyof` checks) turns silently widening the recorded surface
// back to include find / findFrom / etc. into a build break; the mutual
// assignability locks each point read's signature to StoreView's, so a getById
// change can't drift the two apart.
// ============================================================

expectType<"getById" | "getByIds">(
  {} as keyof RecordedStoreViewNodeCollection<typeof Person>,
);
expectType<"getById" | "getByIds">(
  {} as keyof RecordedStoreViewEdgeCollection<typeof worksAt>,
);

expectAssignable<
  Pick<StoreViewNodeCollection<typeof Person>, "getById" | "getByIds">
>({} as RecordedStoreViewNodeCollection<typeof Person>);
expectAssignable<RecordedStoreViewNodeCollection<typeof Person>>(
  {} as Pick<StoreViewNodeCollection<typeof Person>, "getById" | "getByIds">,
);
expectAssignable<
  Pick<StoreViewEdgeCollection<typeof worksAt>, "getById" | "getByIds">
>({} as RecordedStoreViewEdgeCollection<typeof worksAt>);
expectAssignable<RecordedStoreViewEdgeCollection<typeof worksAt>>(
  {} as Pick<StoreViewEdgeCollection<typeof worksAt>, "getById" | "getByIds">,
);

// The recorded view's per-kind accessors yield exactly those narrow
// collections, so the class wiring cannot drift from the collection types.
expectAssignable<RecordedStoreViewNodeCollection<typeof Person>>(
  {} as RecordedStoreView<typeof graph>["nodes"]["Person"],
);
expectAssignable<RecordedStoreViewEdgeCollection<typeof worksAt>>(
  {} as RecordedStoreView<typeof graph>["edges"]["worksAt"],
);
