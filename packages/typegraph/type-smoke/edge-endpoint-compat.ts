import type { z } from "zod";
import type {
  EdgeKinds,
  GraphDef,
  TransactionContext,
  StoreView,
  Store,
  DynamicEdgeCollection,
  DynamicStoreViewEdgeCollection,
} from "@nicia-ai/typegraph";

export async function verifyGenericEdgeDispatch<
  G extends GraphDef,
  K extends EdgeKinds<G>,
>(
  tx: TransactionContext<G>,
  kind: K,
  from: NodeRef,
  to: NodeRef,
  props: z.input<G["edges"][K]["type"]["schema"]>,
  id: string,
  view: StoreView<G>,
  store: Store<G>,
): Promise<void> {
  const edges = tx.getEdgeCollectionOrThrow(kind);
  await edges.getOrCreateByEndpoints(from, to, props, { ifExists: "update" });
  await edges.findByEndpoints(from, to);
  edges.batchFindByEndpoints(from, to);
  await edges.create(from, to, props);
  await edges.bulkCreate([{ from, to, props }]);
  await edges.bulkInsert([{ from, to, props }]);
  await edges.bulkUpsertById([{ id, from, to, props }]);
  await edges.bulkGetOrCreateByEndpoints([{ from, to, props }], {
    ifExists: "update",
  });
  await tx.getEdgeCollection(kind)?.create(from, to, props);
  await store.getEdgeCollection(kind)?.getOrCreateByEndpoints(from, to, props);
  await store
    .getEdgeCollectionOrThrow(kind)
    .getOrCreateByEndpoints(from, to, props);
  await view.getEdgeCollection(kind)?.findByEndpoints(from, to, { props });
}

// Concrete registration tests must accompany the generic cases: an unguarded
// fallback would fix every positive call above by discarding pair safety.
import {
  asEdgeId,
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeCollection,
  type EdgeId,
  type EdgeRegistration,
  type NodeRef,
  type NodeType,
  type AnyEdgeType,
  type TypedEdgeCollection,
} from "@nicia-ai/typegraph";
import { z as schema } from "zod";

const Employee = defineNode("Employee", { schema: schema.object({}) });
const Student = defineNode("Student", { schema: schema.object({}) });
const Department = defineNode("Department", { schema: schema.object({}) });
const Course = defineNode("Course", { schema: schema.object({}) });
const assigned = defineEdge("assigned", {
  schema: schema.object({ weight: schema.number() }),
});
const backup = defineEdge("backup", {
  schema: schema.object({ weight: schema.number() }),
});
const graph = defineGraph({
  id: "endpoint_type_compat",
  nodes: {
    Employee: { type: Employee },
    Student: { type: Student },
    Department: { type: Department },
    Course: { type: Course },
  },
  edges: {
    mapped: {
      type: assigned,
      from: [Employee, Student],
      to: { Employee: [Department], Student: [Course] },
    },
    cartesian: {
      type: assigned,
      from: [Employee, Student],
      to: [Department, Course],
    },
    backup: {
      type: backup,
      from: [Employee, Student],
      to: [Department, Course],
    },
  },
});

export async function verifyConcreteEdgeDispatch(
  tx: TransactionContext<typeof graph>,
  view: StoreView<typeof graph>,
  dynamic: NodeRef,
  fromUnion: NodeRef<typeof Employee | typeof Student>,
  toUnion: NodeRef<typeof Department | typeof Course>,
): Promise<void> {
  const employee = { kind: "Employee", id: "employee" } as const;
  const department = { kind: "Department", id: "department" } as const;
  const course = { kind: "Course", id: "course" } as const;
  const props = { weight: 1 };
  const id = asEdgeId<typeof assigned>("edge");
  await tx.edges.mapped.create(employee, department, props);
  await tx.edges.mapped.findByEndpoints(employee, department);
  tx.edges.mapped.batchFindByEndpoints(employee, department);
  await tx.edges.mapped.getOrCreateByEndpoints(employee, department, props);
  await tx.edges.mapped.bulkCreate([{ from: employee, to: department, props }]);
  await tx.edges.mapped.bulkInsert([{ from: employee, to: department, props }]);
  await tx.edges.mapped.bulkUpsertById([
    { id, from: employee, to: department, props },
  ]);
  await tx.edges.mapped.bulkGetOrCreateByEndpoints([
    { from: employee, to: department, props },
  ]);
  await view.edges.mapped.findByEndpoints(employee, department);
  // @ts-expect-error Undeclared pair must retain static pair checking.
  await tx.edges.mapped.create(employee, course, props);
  // @ts-expect-error Undeclared pair.
  await tx.edges.mapped.findByEndpoints(employee, course);
  // @ts-expect-error Undeclared pair.
  tx.edges.mapped.batchFindByEndpoints(employee, course);
  // @ts-expect-error Undeclared pair.
  await tx.edges.mapped.getOrCreateByEndpoints(employee, course, props);
  // @ts-expect-error Undeclared pair.
  await tx.edges.mapped.bulkCreate([{ from: employee, to: course, props }]);
  // @ts-expect-error Undeclared pair.
  await tx.edges.mapped.bulkInsert([{ from: employee, to: course, props }]);
  await tx.edges.mapped.bulkUpsertById([
    // @ts-expect-error Undeclared pair.
    { id, from: employee, to: course, props },
  ]);
  await tx.edges.mapped.bulkGetOrCreateByEndpoints([
    // @ts-expect-error Undeclared pair.
    { from: employee, to: course, props },
  ]);
  // @ts-expect-error Undeclared pair in a pinned view.
  await view.edges.mapped.findByEndpoints(employee, course);
  // @ts-expect-error Independent endpoint unions do not establish a valid pair.
  await tx.edges.mapped.getOrCreateByEndpoints(fromUnion, toUnion, props);
  // @ts-expect-error Widening refs cannot bypass the concrete endpoint domains.
  await tx.edges.mapped.findByEndpoints(dynamic, dynamic);
  await tx.edges.mapped.findByEndpoints(
    // @ts-expect-error Inline literals cannot widen during inference.
    { kind: "Employee", id: "e" },
    { kind: "Course", id: "c" },
  );
  // @ts-expect-error Required edge properties remain required.
  await tx.edges.mapped.create(employee, department);
  // @ts-expect-error Property validation remains typed.
  await tx.edges.mapped.getOrCreateByEndpoints(employee, department, {
    weight: "wrong",
  });
  // @ts-expect-error Pinned views do not accept a temporal override.
  await view.edges.mapped.findByEndpoints(employee, department, undefined, {
    temporalMode: "includeTombstones",
  });
  // Cartesian endpoints intentionally permit independent unions and cross-pairs.
  await tx.edges.cartesian.create(employee, course, props);
  await tx.edges.cartesian.getOrCreateByEndpoints(fromUnion, toUnion, props);
}

export async function verifyConcreteKindUnion<K extends "cartesian" | "backup">(
  tx: TransactionContext<typeof graph>,
  kind: K,
): Promise<void> {
  await tx.edges[kind].getOrCreateByEndpoints(
    { kind: "Employee", id: "e" },
    { kind: "Course", id: "c" },
    { weight: 1 },
  );
}

export function verifyExistingAnnotations(
  one: DynamicEdgeCollection<typeof assigned>,
  two: TypedEdgeCollection<
    EdgeRegistration<
      typeof assigned,
      typeof Employee,
      NodeType,
      readonly NodeType[]
    >
  >,
  three: TypedEdgeCollection<
    EdgeRegistration<typeof assigned, typeof Employee, typeof Department>
  >,
  erased: EdgeCollection<typeof assigned>,
): void {
  const employee = { kind: "Employee", id: "e" } as const;
  const department = { kind: "Department", id: "d" } as const;
  void one.getOrCreateByEndpoints(employee, department, { weight: 1 });
  void two.getOrCreateByEndpoints(employee, department, { weight: 1 });
  void three.getOrCreateByEndpoints(employee, department, { weight: 1 });
  void erased.getOrCreateByEndpoints(employee, department, { weight: 1 });
  // @ts-expect-error A two-argument registration retains its explicit source.
  void two.getOrCreateByEndpoints(department, employee, { weight: 1 });
  // @ts-expect-error A three-argument registration retains its explicit target.
  void three.getOrCreateByEndpoints(employee, employee, { weight: 1 });
}

type CartesianGraph = GraphDef &
  Readonly<{
    edges: Record<
      string,
      Readonly<{
        type: AnyEdgeType;
        from: readonly NodeType[];
        to: readonly NodeType[];
      }>
    >;
  }>;

export async function verifyArrayOnlyGenericDispatch<
  G extends CartesianGraph,
  K extends EdgeKinds<G>,
>(
  tx: TransactionContext<G>,
  kind: K,
  from: NodeRef,
  to: NodeRef,
  props: z.input<G["edges"][K]["type"]["schema"]>,
): Promise<void> {
  await tx
    .getEdgeCollectionOrThrow(kind)
    .getOrCreateByEndpoints(from, to, props, {
      ifExists: "update",
    });
  await tx.getEdgeCollectionOrThrow(kind).findByEndpoints(from, to);
  await tx.getEdgeCollectionOrThrow(kind).bulkCreate([{ from, to, props }]);
}

export function verifyGenericAnnotations<E extends AnyEdgeType>(
  edge: DynamicEdgeCollection<E>,
  view: DynamicStoreViewEdgeCollection<E>,
  from: NodeRef,
  to: NodeRef,
  props: z.input<E["schema"]>,
): void {
  void edge.findByEndpoints(from, to);
  void edge.getOrCreateByEndpoints(from, to, props);
  void edge.bulkCreate([{ from, to, props }]);
  void edge.update("edge", props);
  void view.findByEndpoints(from, to, { props });
}

export function verifyDynamicProperties(
  tx: TransactionContext<typeof graph>,
  view: StoreView<typeof graph>,
): void {
  const edges = tx.getEdgeCollectionOrThrow("mapped");
  const from = { kind: "Employee", id: "e" };
  const to = { kind: "Course", id: "c" };
  // Runtime dispatch deliberately accepts unchecked endpoints; writes still validate them.
  void edges.create(from, to, { weight: 1 });
  // @ts-expect-error Known edge schemas are retained on dynamic lookups.
  void edges.create(from, to, { weight: "bad" });
  // @ts-expect-error Required properties stay required.
  void edges.create(from, to);
  void edges.bulkUpsertById([
    {
      id: "id",
      from,
      to,
      props: { weight: 1 },
      validTo: "date",
      // @ts-expect-error Temporal set and clear remain mutually exclusive.
      clearValidTo: true,
    },
  ]);
  const pinned = view.getEdgeCollection("mapped");
  // @ts-expect-error Dynamic pinned reads have no writes.
  void pinned?.create(from, to, { weight: 1 });
  // @ts-expect-error Dynamic pinned reads have no temporal override.
  void pinned?.findByEndpoints(from, to, undefined, {
    temporalMode: "includeTombstones",
  });
}

export async function verifyDynamicResults(
  tx: TransactionContext<typeof graph>,
): Promise<void> {
  const result = await tx
    .getEdgeCollectionOrThrow("mapped")
    .create(
      { kind: "Employee", id: "e" },
      { kind: "Department", id: "d" },
      { weight: 1 },
    );
  const weight: number = result.weight;
  const id: EdgeId<typeof assigned> = result.id;
  void weight;
  void id;
}

// Query factories are a distinct 0.55 regression: the target node's schema may
// remain generic even when its kind and registration are known.
declare function storeForGraph<G extends GraphDef>(definition: G): Store<G>;
export function verifyGenericTraversal<T extends NodeType<"Target">>(
  Target: T,
  targetKind: T["kind"],
): void {
  const Source = defineNode("Source", { schema: schema.object({}) });
  const link = defineEdge("link");
  const definition = defineGraph({
    id: "generic_traversal",
    nodes: { Source: { type: Source }, Target: { type: Target } },
    edges: { link: { type: link, from: [Source], to: [Target] } },
  });
  const traversal = storeForGraph(definition)
    .query()
    .from("Source", "source")
    .traverse("link", "edge");
  traversal.to(targetKind, "target");
  // @ts-expect-error Target inference must not widen to every string.
  traversal.to("Missing", "missing");
}

export function verifyMappedTraversal(store: Store<typeof graph>): void {
  const traversal = store
    .query()
    .from("Employee", "employee")
    .traverse("mapped", "edge");
  traversal.to("Department", "department");
  traversal.to("Course", "course");
  // Traversal targets use the union of declared ranges; endpoint writes retain pair correlation.
  // @ts-expect-error Undeclared target kind must remain rejected.
  traversal.to("Employee", "other");
}

export function verifyUnionTraversal(): void {
  const SourceA = defineNode("SourceA", { schema: schema.object({}) });
  const SourceB = defineNode("SourceB", { schema: schema.object({}) });
  const TargetA = defineNode("TargetA", { schema: schema.object({}) });
  const TargetB = defineNode("TargetB", { schema: schema.object({}) });
  const link = defineEdge("link");
  const definition = defineGraph({
    id: "union_traversal",
    nodes: {
      SourceA: { type: SourceA },
      SourceB: { type: SourceB },
      TargetA: { type: TargetA },
      TargetB: { type: TargetB },
    },
    edges: {
      first: { type: link, from: [SourceA], to: { SourceA: [TargetA] } },
      second: { type: link, from: [SourceB], to: { SourceB: [TargetB] } },
      cartesian: { type: link, from: [SourceA], to: [TargetA] },
    },
  });
  const store = storeForGraph(definition);
  const kind: "first" | "second" = Math.random() > 0.5 ? "first" : "second";
  const traversal = store
    .query()
    .from("SourceA", "source")
    .traverse(kind, "edge");
  traversal.to("TargetA", "a");
  traversal.to("TargetB", "b");
  // @ts-expect-error A union of map declarations must not widen its range.
  traversal.to("SourceA", "invalid");
  const mixedKind: "cartesian" | "second" =
    Math.random() > 0.5 ? "cartesian" : "second";
  const mixed = store
    .query()
    .from("SourceA", "source")
    .traverse(mixedKind, "edge");
  mixed.to("TargetA", "a");
  mixed.to("TargetB", "b");
  // @ts-expect-error Mixed array/map ranges stay exact.
  mixed.to("SourceA", "invalid");
}
