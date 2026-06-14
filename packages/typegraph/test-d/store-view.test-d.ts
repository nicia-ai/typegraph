/**
 * Type-level contract for `StoreView` (the read-only `(mode, asOf)` lens).
 *
 * Much of StoreView is a TypeScript contract: the entry points return a
 * `StoreView`, the read surfaces keep their result types, the per-call
 * temporal options are removed (the pin owns them), writes are absent, and
 * `asOfRecorded` is reserved for Unit 2.
 */
import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type Edge,
  type EdgeBatchReads,
  type EdgeCollection,
  type EdgeTemporalReads,
  type EdgeWrites,
  type Node,
  type NodeCollection,
  type NodeCurrentReads,
  type NodeId,
  type NodeRef,
  type NodeTemporalReads,
  type NodeWrites,
  type QueryBuilder,
  type QueryOptions,
  type ReachableNode,
  type Store,
  type StoreSearch,
  type StoreView,
  type StoreViewEdgeCollection,
  type StoreViewNodeCollection,
  type TemporalMode,
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

const CANONICAL = "2024-01-01T00:00:00.000Z";

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

// `asOfRecorded` is reserved for Unit 2 — not implemented.
expectError(store.asOfRecorded(CANONICAL));

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
expectType<QueryBuilder<typeof graph>>(view.query());
expectType<StoreSearch<typeof graph>>(view.search);
expectAssignable<Promise<readonly ReachableNode[]>>(
  view.reachable(personId, { edges: ["knows"] }),
);

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
  view.subgraph(personId, { edges: ["knows"], temporalMode: "asOf" }),
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
