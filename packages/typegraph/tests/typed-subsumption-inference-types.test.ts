/**
 * Compile-time tests for how subsumption typing is inferred from the shapes
 * callers actually write: an ontology array built apart from `defineGraph`,
 * an options bag forwarded through a helper, a narrowed search hit, a
 * generic relation helper, and type-only schema facts (`.brand()`,
 * `.readonly()`, `embedding()`).
 *
 * Every positive case sits next to a `@ts-expect-error` negative, so a rule
 * that widens or narrows too far fails `pnpm typecheck` here. The probe
 * functions that take a `Store` are type-checked only and never called.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  type AliasExpansionAxis,
  type AliasExpansionOptions,
  type AssignableNodeKinds,
  type CompositionWholeKinds,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  embedding,
  equivalentTo,
  type EquivalentToCheck,
  type ExpansionAliasNodeType,
  type ForwardedExpansionAxes,
  type Node,
  type NodeType,
  type OntologyRelation,
  type PolymorphicNodeType,
  type Store,
  type StructuralSubtypeMismatch,
  subClassOf,
  type SubClassOfCheck,
} from "../src";
import { searchable } from "../src/core/searchable";

// ============================================================
// Fixtures
// ============================================================

const Person = defineNode("InferPerson", {
  schema: z.object({ name: searchable() }),
});
const Employee = defineNode("InferEmployee", {
  schema: z.object({ name: searchable(), employeeId: z.string() }),
});
const Company = defineNode("InferCompany", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("inferWorksAt");
const nodes = {
  InferPerson: { type: Person },
  InferEmployee: { type: Employee },
  InferCompany: { type: Company },
} as const;
const edges = {
  inferWorksAt: { type: worksAt, from: [Person], to: [Company] },
} as const;

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected a nonempty list");
  return item;
}

async function firstRow<Row>(
  query: Readonly<{ execute: () => Promise<readonly Row[]> }>,
): Promise<Row> {
  return first(await query.execute());
}

type RowOf<Query extends Readonly<{ execute: () => Promise<unknown> }>> =
  Awaited<ReturnType<Query["execute"]>> extends readonly (infer Row)[] ? Row
  : never;

// The project-structure layout: an ontology array with no `as const` and no
// annotation, exported apart from `defineGraph`.
const disjointOnly = [disjointWith(Person, Company)];
const disjointGraph = defineGraph({
  id: "infer_disjoint_array",
  nodes,
  edges,
  ontology: disjointOnly,
});

const withSubclass = [
  subClassOf(Employee, Person),
  disjointWith(Person, Company),
];
const subclassGraph = defineGraph({
  id: "infer_subclass_array",
  nodes,
  edges,
  ontology: withSubclass,
});

const usersOntology = [disjointWith(Person, Company)];
const peopleOntology = [subClassOf(Employee, Person)];
const spreadGraph = defineGraph({
  id: "infer_spread_array",
  nodes,
  edges,
  ontology: [...usersOntology, ...peopleOntology],
});

const annotated: readonly OntologyRelation[] = [disjointWith(Person, Company)];
const annotatedGraph = defineGraph({
  id: "infer_annotated_array",
  nodes,
  edges,
  ontology: annotated,
});

const mutableAnnotated: OntologyRelation[] = [disjointWith(Person, Company)];
const mutableAnnotatedGraph = defineGraph({
  id: "infer_mutable_annotated_array",
  nodes,
  edges,
  ontology: mutableAnnotated,
});

const omittedGraph = defineGraph({ id: "infer_omitted", nodes, edges });

const forwardGraph = defineGraph({
  id: "infer_forwarded_bag",
  nodes,
  edges: {
    inferWorksAt: { type: worksAt, from: [Person], to: [Person, Company] },
  },
  ontology: [subClassOf(Employee, Person)],
});
type ForwardStore = Store<typeof forwardGraph>;

// ============================================================
// Ontology-array probes
// ============================================================

async function probeDisjointArray(
  store: Store<typeof disjointGraph>,
): Promise<void> {
  const row = await firstRow(
    store
      .query()
      .from("InferPerson", "p")
      .select((ctx) => ctx.p),
  );
  expectTypeOf(row.kind).toEqualTypeOf<"InferPerson">();
  await store.nodes.InferPerson.getById(row.id);
  const asPerson: Node<typeof Person> = row;
  const edge = await store.edges.inferWorksAt.create(row, {
    kind: "InferCompany",
    id: "c",
  });
  await store.nodes.InferCompany.getById(edge.toId);
  void asPerson;
}

async function probeSubclassArray(
  store: Store<typeof subclassGraph>,
): Promise<void> {
  const person = await firstRow(
    store
      .query()
      .from("InferPerson", "p")
      .select((ctx) => ctx.p),
  );
  expectTypeOf(person.kind).toEqualTypeOf<string>();
  // @ts-expect-error - an InferPerson alias may return InferEmployee rows
  await store.nodes.InferPerson.getById(person.id);

  const company = await firstRow(
    store
      .query()
      .from("InferCompany", "c")
      .select((ctx) => ctx.c),
  );
  expectTypeOf(company.kind).toEqualTypeOf<"InferCompany">();
  await store.nodes.InferCompany.getById(company.id);
}

async function probeSpreadArray(
  store: Store<typeof spreadGraph>,
): Promise<void> {
  const company = await firstRow(
    store
      .query()
      .from("InferCompany", "c")
      .select((ctx) => ctx.c),
  );
  await store.nodes.InferCompany.getById(company.id);
  const person = await firstRow(
    store
      .query()
      .from("InferPerson", "p")
      .select((ctx) => ctx.p),
  );
  // @ts-expect-error - the spread still carries subClassOf(Employee, Person)
  await store.nodes.InferPerson.getById(person.id);
}

async function probeAnnotatedArrays(
  annotatedStore: Store<typeof annotatedGraph>,
  mutableStore: Store<typeof mutableAnnotatedGraph>,
): Promise<void> {
  const company = await firstRow(
    annotatedStore
      .query()
      .from("InferCompany", "c")
      .select((ctx) => ctx.c),
  );
  expectTypeOf(company.kind).toEqualTypeOf<string>();
  // @ts-expect-error - an erased ontology may subclass any kind
  await annotatedStore.nodes.InferCompany.getById(company.id);

  const mutableCompany = await firstRow(
    mutableStore
      .query()
      .from("InferCompany", "c")
      .select((ctx) => ctx.c),
  );
  expectTypeOf(mutableCompany.kind).toEqualTypeOf<string>();
}

async function probeOmittedOntology(
  store: Store<typeof omittedGraph>,
): Promise<void> {
  const person = await firstRow(
    store
      .query()
      .from("InferPerson", "p")
      .select((ctx) => ctx.p),
  );
  await store.nodes.InferPerson.getById(person.id);
}

// ============================================================
// Forwarded-bag probes
// ============================================================

function forwardPeople(
  store: ForwardStore,
  options?: { expansion?: "exact" | "subclasses" },
) {
  return store
    .query()
    .from("InferPerson", "p", options)
    .select((ctx) => ({ name: ctx.p.name, kind: ctx.p.kind }));
}

function forwardExactCompanies(
  store: ForwardStore,
  options?: { expansion?: "exact" },
) {
  return store
    .query()
    .from("InferCompany", "c", options)
    .select((ctx) => ctx.c);
}

function forwardExactPeople(
  store: ForwardStore,
  options: { expansion: "exact" },
) {
  return store
    .query()
    .from("InferPerson", "p", options)
    .select((ctx) => ctx.p);
}

// A bag that may state "exact" or leave the store default keeps the default
// overload's type, polymorphic for an affected kind.
function forwardDefaultPeople(
  store: ForwardStore,
  options?: { expansion?: "exact" },
) {
  return store
    .query()
    .from("InferPerson", "p", options)
    .select((ctx) => ctx.p);
}

function forwardAnyAxis(store: ForwardStore, options: AliasExpansionOptions) {
  return store
    .query()
    .from("InferCompany", "c", options)
    .select((ctx) => ctx.c);
}

function forwardNarrowerName(
  store: ForwardStore,
  options?: { expansion?: "exact" | "narrower" },
) {
  return (
    store
      .query()
      .from("InferCompany", "c", options)
      // @ts-expect-error - a "narrower" alias claims no schema, so no typed props
      .select((ctx) => ({ name: ctx.c.name }))
  );
}

async function probeForwardedPolymorphicId(
  store: ForwardStore,
  options?: { expansion?: "exact" | "subclasses" },
): Promise<void> {
  const row = await firstRow(
    store
      .query()
      .from("InferPerson", "p", options)
      .select((ctx) => ctx.p),
  );
  // @ts-expect-error - the bag may expand to InferEmployee rows
  await store.nodes.InferPerson.getById(row.id);
}

function forwardListed(
  store: ForwardStore,
  options?: { expansion?: "exact" | "subclasses" },
) {
  return store
    .query()
    .from(["InferPerson", "InferCompany"], "n", options)
    .select((ctx) => ctx.n);
}

function forwardListedExact(
  store: ForwardStore,
  options: { expansion: "exact" },
) {
  return store
    .query()
    .from(["InferPerson", "InferCompany"], "n", options)
    .select((ctx) => ctx.n);
}

function forwardDynamic(
  store: ForwardStore,
  options?: { expansion?: "exact" | "subclasses" },
) {
  return store
    .query()
    .fromDynamic("InferPerson", "p", options)
    .select((ctx) => ctx.p);
}

function forwardTraversed(
  store: ForwardStore,
  options?: { expansion?: "exact" | "subclasses" },
) {
  return store
    .query()
    .from("InferPerson", "p", { expansion: "exact" })
    .traverse("inferWorksAt", "e")
    .to("InferPerson", "q", options)
    .select((ctx) => ({ name: ctx.q.name, kind: ctx.q.kind }));
}

function forwardTraversedExact(
  store: ForwardStore,
  options?: { expansion?: "exact" },
) {
  return store
    .query()
    .from("InferPerson", "p", { expansion: "exact" })
    .traverse("inferWorksAt", "e")
    .to("InferCompany", "c", options)
    .select((ctx) => ctx.c);
}

// ============================================================
// Search-hit probe
// ============================================================

async function probeNarrowedSearchHit(store: ForwardStore): Promise<void> {
  const hits = await store.search.fulltext("InferPerson", {
    query: "x",
    limit: 5,
    expansion: "subclasses",
  });
  for (const hit of hits) {
    if (hit.node.kind !== "InferEmployee") continue;
    const employee = await store.getNodeByRef({
      kind: hit.node.kind,
      id: hit.node.id,
    });
    expectTypeOf(employee).toEqualTypeOf<Node<typeof Employee> | undefined>();
    // @ts-expect-error - narrowing the kind does not narrow the id brand
    await store.nodes.InferEmployee.getById(hit.node.id);
  }
}

// ============================================================
// Generic relation helpers
// ============================================================

function declareSubclass<C extends NodeType, P extends NodeType>(
  child: C,
  parent: P & SubClassOfCheck<C, P>,
) {
  return subClassOf<C, P>(child, parent);
}

function declareEquivalent<A extends NodeType, B extends NodeType>(
  firstKind: A,
  secondKind: B & EquivalentToCheck<A, B>,
) {
  return equivalentTo<A, B>(firstKind, secondKind);
}

// ============================================================
// Tests
// ============================================================

describe("an ontology array built apart from defineGraph", () => {
  it("keeps every kind exact when the array holds no subsumption relation", () => {
    expect(typeof probeDisjointArray).toBe("function");
    expect(disjointGraph.ontology).toHaveLength(1);
    expectTypeOf<
      AssignableNodeKinds<typeof disjointGraph, "InferPerson">
    >().toEqualTypeOf<"InferPerson">();
    expectTypeOf<
      CompositionWholeKinds<typeof disjointGraph, "InferPerson">
    >().toEqualTypeOf<never>();
  });

  it("widens exactly the kinds the array's elements name", () => {
    expect(typeof probeSubclassArray).toBe("function");
    expect(subclassGraph.ontology).toHaveLength(2);
    expectTypeOf<
      AssignableNodeKinds<typeof subclassGraph, "InferPerson">
    >().toEqualTypeOf<"InferPerson" | "InferEmployee">();
    expectTypeOf<
      AssignableNodeKinds<typeof subclassGraph, "InferCompany">
    >().toEqualTypeOf<"InferCompany">();
  });

  it("reads a spread of two arrays like the arrays themselves", () => {
    expect(typeof probeSpreadArray).toBe("function");
    expect(spreadGraph.ontology).toHaveLength(2);
  });

  it("still widens every kind when the array is annotated with the wide relation type", () => {
    expect(typeof probeAnnotatedArrays).toBe("function");
    expect(annotatedGraph.ontology).toHaveLength(1);
    expect(mutableAnnotatedGraph.ontology).toHaveLength(1);
    expectTypeOf<
      AssignableNodeKinds<typeof annotatedGraph, "InferCompany">
    >().toEqualTypeOf<"InferPerson" | "InferEmployee" | "InferCompany">();
  });

  it("keeps an omitted ontology exact", () => {
    expect(typeof probeOmittedOntology).toBe("function");
    expect(omittedGraph.ontology).toHaveLength(0);
  });
});

describe("an options bag forwarded into from() / to()", () => {
  it("resolves the axes a bag type can carry, the store default included", () => {
    expect(forwardGraph.ontology).toHaveLength(1);
    expectTypeOf<
      ForwardedExpansionAxes<undefined>
    >().toEqualTypeOf<undefined>();
    expectTypeOf<
      ForwardedExpansionAxes<{ expansion: "exact" }>
    >().toEqualTypeOf<"exact">();
    expectTypeOf<
      ForwardedExpansionAxes<{ expansion?: "exact" } | undefined>
    >().toEqualTypeOf<"exact" | undefined>();
    expectTypeOf<ForwardedExpansionAxes<AliasExpansionOptions>>().toEqualTypeOf<
      AliasExpansionAxis | undefined
    >();
    expectTypeOf<
      ForwardedExpansionAxes<Record<never, never>>
    >().toEqualTypeOf<undefined>();
    type Exact = typeof Person;
    type Polymorphic = PolymorphicNodeType<typeof Person>;
    expectTypeOf<
      ExpansionAliasNodeType<"exact", Exact, Polymorphic, Polymorphic>
    >().toEqualTypeOf<Exact>();
    expectTypeOf<
      ExpansionAliasNodeType<"exact" | undefined, Exact, Exact, Polymorphic>
    >().toEqualTypeOf<Exact>();
    expectTypeOf<
      ExpansionAliasNodeType<"exact" | "subclasses", Exact, Exact, Polymorphic>
    >().toEqualTypeOf<Polymorphic>();
    expectTypeOf<
      ExpansionAliasNodeType<AliasExpansionAxis, Exact, Exact, Polymorphic>
    >().toEqualTypeOf<NodeType>();
  });

  it("compiles an optional bag, typed by the axes it can carry", () => {
    type PeopleRow = RowOf<ReturnType<typeof forwardPeople>>;
    expectTypeOf<PeopleRow["name"]>().toEqualTypeOf<string>();
    expectTypeOf<PeopleRow["kind"]>().toEqualTypeOf<string>();
    type CompanyRow = RowOf<ReturnType<typeof forwardExactCompanies>>;
    expectTypeOf<CompanyRow["kind"]>().toEqualTypeOf<"InferCompany">();
    type ExactPersonRow = RowOf<ReturnType<typeof forwardExactPeople>>;
    expectTypeOf<ExactPersonRow["kind"]>().toEqualTypeOf<"InferPerson">();
    type DefaultPersonRow = RowOf<ReturnType<typeof forwardDefaultPeople>>;
    expectTypeOf<DefaultPersonRow["kind"]>().toEqualTypeOf<string>();
    expect([
      forwardPeople,
      forwardExactCompanies,
      forwardExactPeople,
      forwardDefaultPeople,
    ]).toHaveLength(4);
  });

  it("keeps the narrower axis untyped and refuses a polymorphic id where an exact one is required", () => {
    type AnyAxisRow = RowOf<ReturnType<typeof forwardAnyAxis>>;
    expectTypeOf<AnyAxisRow["kind"]>().toEqualTypeOf<string>();
    expect([
      forwardAnyAxis,
      forwardNarrowerName,
      probeForwardedPolymorphicId,
    ]).toHaveLength(3);
  });

  it("forwards a bag through list sources, fromDynamic() and to()", () => {
    type ListedRow = RowOf<ReturnType<typeof forwardListed>>;
    expectTypeOf<ListedRow["kind"]>().toEqualTypeOf<string>();
    type ListedExactRow = RowOf<ReturnType<typeof forwardListedExact>>;
    expectTypeOf<ListedExactRow["kind"]>().toEqualTypeOf<
      "InferPerson" | "InferCompany"
    >();
    type TraversedRow = RowOf<ReturnType<typeof forwardTraversed>>;
    expectTypeOf<TraversedRow["name"]>().toEqualTypeOf<string>();
    expectTypeOf<TraversedRow["kind"]>().toEqualTypeOf<string>();
    type TraversedExactRow = RowOf<ReturnType<typeof forwardTraversedExact>>;
    expectTypeOf<TraversedExactRow["kind"]>().toEqualTypeOf<"InferCompany">();
    expect([
      forwardListed,
      forwardListedExact,
      forwardDynamic,
      forwardTraversed,
      forwardTraversedExact,
    ]).toHaveLength(5);
  });
});

describe("narrowing an expanded search hit", () => {
  it("resolves a narrowed hit through getNodeByRef, not the narrowed kind's collection", () => {
    expect(typeof probeNarrowedSearchHit).toBe("function");
  });
});

describe("a generic helper around subClassOf / equivalentTo", () => {
  it("checks the helper's callers and keeps the endpoint literals", () => {
    const relation = declareSubclass(Employee, Person);
    expectTypeOf(relation.to).toEqualTypeOf<typeof Person>();
    expect(relation.metaEdge.name).toBe("subClassOf");

    const PersonTwin = defineNode("InferPersonTwin", {
      schema: z.object({ name: searchable() }),
    });
    expect(declareEquivalent(Person, PersonTwin).to).toBe(PersonTwin);

    // @ts-expect-error - InferPerson lacks InferEmployee's employeeId
    declareSubclass(Person, Employee);
    // @ts-expect-error - InferPerson lacks InferEmployee's employeeId
    declareEquivalent(Person, Employee);
  });
});

describe("the compile-time check and type-only schema facts", () => {
  it("accepts a brand on the parent, readonly on the child and the embedding marker", () => {
    const relations = [
      subClassOf(
        defineNode("InferPlainEmail", { schema: z.object({ f: z.string() }) }),
        defineNode("InferBrandedEmail", {
          schema: z.object({ f: z.string().brand<"Email">() }),
        }),
      ),
      subClassOf(
        defineNode("InferReadonlyTags", {
          schema: z.object({ f: z.array(z.string()).readonly() }),
        }),
        defineNode("InferMutableTags", {
          schema: z.object({ f: z.array(z.string()) }),
        }),
      ),
      subClassOf(
        defineNode("InferReadonlyTuple", {
          schema: z.object({
            f: z.tuple([z.string(), z.number()]).readonly(),
          }),
        }),
        defineNode("InferMutableTuple", {
          schema: z.object({ f: z.tuple([z.string(), z.number()]) }),
        }),
      ),
      subClassOf(
        defineNode("InferNestedPlain", {
          schema: z.object({
            n: z.object({ tags: z.array(z.string()).readonly() }),
          }),
        }),
        defineNode("InferNestedBranded", {
          schema: z.object({
            n: z.object({ tags: z.array(z.string().brand<"Tag">()) }),
          }),
        }),
      ),
      subClassOf(
        defineNode("InferEmbeddingChild", {
          schema: z.object({ v: embedding(3) }),
        }),
        defineNode("InferNumberArrayParent", {
          schema: z.object({ v: z.array(z.number()) }),
        }),
      ),
      subClassOf(
        defineNode("InferFixedArrayChild", {
          schema: z.object({ v: z.array(z.number()).length(3) }),
        }),
        defineNode("InferEmbeddingParent", {
          schema: z.object({ v: embedding(3) }),
        }),
      ),
      equivalentTo(
        defineNode("InferPlainTwin", { schema: z.object({ f: z.string() }) }),
        defineNode("InferBrandedTwin", {
          schema: z.object({ f: z.string().brand<"Email">() }),
        }),
      ),
    ];
    expect(relations).toHaveLength(7);
  });

  it("still refuses what the parent's runtime schema refuses", () => {
    const refused = [
      subClassOf(
        defineNode("InferOptionalEmail", {
          schema: z.object({ f: z.string().optional() }),
        }),
        // @ts-expect-error - an optional child under a required branded parent
        defineNode("InferRequiredBrandedEmail", {
          schema: z.object({ f: z.string().brand<"Email">() }),
        }),
      ),
      subClassOf(
        defineNode("InferWideString", { schema: z.object({ f: z.string() }) }),
        // @ts-expect-error - a wider string under a branded literal
        defineNode("InferBrandedLiteral", {
          schema: z.object({ f: z.literal("a").brand<"A">() }),
        }),
      ),
      subClassOf(
        defineNode("InferNullableString", {
          schema: z.object({ f: z.string().nullable() }),
        }),
        // @ts-expect-error - a nullable child under a non-null branded parent
        defineNode("InferNonNullBranded", {
          schema: z.object({ f: z.string().brand<"Email">() }),
        }),
      ),
      subClassOf(
        defineNode("InferReadonlyNumbers", {
          schema: z.object({ f: z.array(z.number()).readonly() }),
        }),
        // @ts-expect-error - readonly does not hide an element type mismatch
        defineNode("InferMutableStrings", {
          schema: z.object({ f: z.array(z.string()) }),
        }),
      ),
      subClassOf(
        defineNode("InferShortTuple", {
          schema: z.object({ f: z.tuple([z.string()]).readonly() }),
        }),
        // @ts-expect-error - readonly does not hide a tuple arity mismatch
        defineNode("InferLongTuple", {
          schema: z.object({ f: z.tuple([z.string(), z.number()]) }),
        }),
      ),
    ];
    expect(refused).toHaveLength(5);
  });

  it("names the relation a refused pair comes from", () => {
    expectTypeOf<
      StructuralSubtypeMismatch<
        "equivalentTo",
        "A",
        "B",
        "f"
      >["__typegraphStructuralSubtypeError"]
    >().toEqualTypeOf<"equivalentTo(A, B): each kind's schema must extend the other's, and the first named here does not extend the second">();
    expectTypeOf<
      StructuralSubtypeMismatch<"equivalentTo", "A", "B", "f">["fix"]
    >().toEqualTypeOf<"Give the first kind these properties with compatible types, or declare subClassOf() in the one direction that holds.">();
    expectTypeOf<
      StructuralSubtypeMismatch<
        "subClassOf",
        "A",
        "B",
        "f"
      >["__typegraphStructuralSubtypeError"]
    >().toEqualTypeOf<"subClassOf(A, B): the child's schema must extend the parent's">();
    expectTypeOf<
      EquivalentToCheck<typeof Person, typeof Employee>
    >().toEqualTypeOf<
      StructuralSubtypeMismatch<
        "equivalentTo",
        "InferPerson",
        "InferEmployee",
        "employeeId"
      >
    >();
  });
});
