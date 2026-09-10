/**
 * Compile-time type tests for C.1 (typed subsumption).
 *
 * Tests marked with @ts-expect-error verify that an incompatible
 * `subClassOf` / `equivalentTo` pair is refused AT COMPILE TIME,
 * with the failure carrier (`StructuralSubtypeMismatch`) naming the
 * offending fields. Load-bearing: see
 * tests/property/typed-subsumption-agreement.test.ts for the runtime-side
 * agreement pin, and lane-C13-load-bearing.md for the revert/mutation check
 * performed on this file.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  type BaseStoreOptions,
  broader,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  equivalentTo,
  type NodeType,
  relatedTo,
  type Store,
  subClassOf,
} from "../src";
import type {
  IncompatibleKeys,
  OntologyRelation,
  StructuralSubtypeMismatch,
  TypedOntologyRelation,
} from "../src/ontology/types";
import {
  type AliasExpansionOptions,
  type DefaultAliasExpansionAxis,
} from "../src/query/builder/alias-expansion";
import { buildKindRegistry } from "../src/registry/builders";

// ============================================================
// Fixtures
// ============================================================

const Media = defineNode("Media", {
  schema: z.object({ title: z.string() }),
});

const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string(), employeeId: z.string() }),
});

const Status = defineNode("Status", {
  schema: z.object({ state: z.enum(["active", "inactive", "pending"]) }),
});

const ActiveStatus = defineNode("ActiveStatus", {
  schema: z.object({ state: z.literal("active") }),
});

const RequiredWidget = defineNode("RequiredWidget", {
  schema: z.object({ label: z.string() }),
});

const OptionalWidget = defineNode("OptionalWidget", {
  schema: z.object({ label: z.string().optional() }),
});

/**
 * A caller's own taxonomy helper, annotated with bare `NodeType` endpoints:
 * the shape that keeps the `subClassOf` meta-edge name literal and loses the
 * endpoint kind literals.
 */
function declareTaxonomy(child: NodeType, parent: NodeType) {
  return subClassOf(child, parent);
}

describe("C.1 — subClassOf structural contract", () => {
  it("compiles when the child's schema extends the parent's", () => {
    const relation = subClassOf(Podcast, Media);
    expect(relation.metaEdge.name).toBe("subClassOf");
    expect(relation.from).toBe(Podcast);
    expect(relation.to).toBe(Media);
  });

  it("refuses a child missing a required parent property, naming the field", () => {
    expectTypeOf<
      IncompatibleKeys<
        z.infer<(typeof Person)["schema"]>,
        z.infer<(typeof Employee)["schema"]>
      >
    >().toEqualTypeOf<"employeeId">();

    // @ts-expect-error - Person lacks Employee's required employeeId field
    subClassOf(Person, Employee);
  });

  it("compiles for an empty-schema parent (C13-R1-10: the 4bf9b4f9 false-positive fix has no regression pin)", () => {
    // A parent with an EMPTY schema (`z.object({})`) has `keyof {} = never`,
    // which is the exact inference trap `SubClassOfCheck`'s docblock
    // documents (`src/ontology/types.ts`): the intersection-parameter form
    // (`parent: P & SubClassOfCheck<C, P>`) is what keeps this compiling.
    const EmptySchemaParent = defineNode("EmptySchemaParent", {
      schema: z.object({}),
    });
    const AnyChild = defineNode("AnyChildOfEmptyParent", {
      schema: z.object({ note: z.string() }),
    });
    const relation = subClassOf(AnyChild, EmptySchemaParent);
    expect(relation.to).toBe(EmptySchemaParent);
  });

  it("accepts a child narrowing a parent enum to a literal", () => {
    const relation = subClassOf(ActiveStatus, Status);
    expect(relation.from).toBe(ActiveStatus);
  });

  it("refuses a child relaxing a parent-required property to optional", () => {
    // @ts-expect-error - OptionalWidget relaxes RequiredWidget's required label
    subClassOf(OptionalWidget, RequiredWidget);
  });

  it("accepts width subtyping — the child may add properties", () => {
    // Podcast adds rssUrl on top of Media's title; already exercised above,
    // pinned again here for the width-subtyping-by-name test in §5.1.
    const relation = subClassOf(Podcast, Media);
    expect(relation.to).toBe(Media);
  });

  it("names the message in StructuralSubtypeMismatch", () => {
    expectTypeOf<
      StructuralSubtypeMismatch<"Person", "Employee", "employeeId">
    >().toHaveProperty("__typegraphSubClassOfError");
  });
});

describe("C.1 — equivalentTo mutual structural contract", () => {
  it("compiles both directions for an identical pair", () => {
    const Alpha = defineNode("Alpha", { schema: z.object({ x: z.string() }) });
    const Beta = defineNode("Beta", { schema: z.object({ x: z.string() }) });
    const forward = equivalentTo(Alpha, Beta);
    const backward = equivalentTo(Beta, Alpha);
    expect(forward.from).toBe(Alpha);
    expect(backward.from).toBe(Beta);
  });

  it("refuses the direction that fails for an asymmetric pair", () => {
    // Employee has an extra required field over Person; Employee -> Person
    // holds (Employee narrows to Person's shape is false, but
    // Person -> Employee holds mutual-subtype only if BOTH directions
    // extend). Person lacks employeeId, so neither direction is a full
    // equivalence.
    // @ts-expect-error - Person is missing Employee's employeeId field
    equivalentTo(Person, Employee);
  });

  it("allows the IRI form with no schema check", () => {
    const relation = equivalentTo(Person, "https://schema.org/Person");
    expect(relation.to).toBe("https://schema.org/Person");
  });
});

describe("Q3/C.1.4 — alias typing under the polymorphic axis", () => {
  const MediaKind = defineNode("MediaAliasTest", {
    schema: z.object({ title: z.string() }),
  });
  const PodcastKind = defineNode("PodcastAliasTest", {
    schema: z.object({ title: z.string(), rssUrl: z.string() }),
  });
  const cites = defineEdge("citesAliasTest", { schema: z.object({}) });

  const affectedGraph = defineGraph({
    id: "alias_typing_affected",
    nodes: {
      MediaAliasTest: { type: MediaKind },
      PodcastAliasTest: { type: PodcastKind },
    },
    edges: {},
    ontology: [subClassOf(PodcastKind, MediaKind)],
  });
  const affectedRegistry = buildKindRegistry(affectedGraph);

  const plainGraph = defineGraph({
    id: "alias_typing_plain",
    nodes: { MediaAliasTest: { type: MediaKind } },
    edges: {},
    ontology: [],
  });
  const plainRegistry = buildKindRegistry(plainGraph);

  it("widens kind to string on a subsumption-affected alias with no explicit option", () => {
    const query = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    )
      .from("MediaAliasTest", "m")
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<string>();
  });

  it("keeps kind literal when the graph declares no subsumption relations", () => {
    const query = createQueryBuilder<typeof plainGraph>(
      plainGraph.id,
      plainRegistry,
    )
      .from("MediaAliasTest", "m")
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<"MediaAliasTest">();
  });

  it("widens kind to string when the ontology tuple is annotated as bare OntologyRelation[] (C13-R2-01)", () => {
    // The changeset's Breaking-changes bullet blesses this exact pattern:
    // "Code that annotates a relation's result as `OntologyRelation` still
    // compiles unchanged." Annotating the array itself erases every element
    // to the untyped `OntologyRelation` shape, so `SubsumptionAffected` can
    // no longer see the `to: { kind: "MediaAliasTest" }` literal by
    // `Extract`ing it — it must fall back to conservative widening instead
    // of silently reporting `false`, which would let the alias stay narrow
    // while the runtime alias is genuinely polymorphic.
    const annotatedOntology: readonly OntologyRelation[] = [
      subClassOf(PodcastKind, MediaKind),
    ];
    const annotatedGraph = defineGraph({
      id: "alias_typing_annotated",
      nodes: {
        MediaAliasTest: { type: MediaKind },
        PodcastAliasTest: { type: PodcastKind },
      },
      edges: {},
      ontology: annotatedOntology,
    });
    const annotatedRegistry = buildKindRegistry(annotatedGraph);

    const query = createQueryBuilder<typeof annotatedGraph>(
      annotatedGraph.id,
      annotatedRegistry,
    )
      .from("MediaAliasTest", "m")
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<string>();
  });

  it('expansion: "exact" keeps kind literal even on an affected alias', () => {
    const query = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    )
      .from("MediaAliasTest", "m", { expansion: "exact" })
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<"MediaAliasTest">();
  });

  it("refuses passing a polymorphic alias's row.id to the exact-kind collection's update()", () => {
    // A polymorphic-affected alias's `id` is widened so an exact `NodeId`
    // is assignable TO it but not FROM it (§1.4 of the typed-subsumption
    // plan) — the row may be a subclass, so `store.nodes.<K>.update(row.id)`
    // must not typecheck against the exact collection.
    const query = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    )
      .from("MediaAliasTest", "m")
      .select((ctx) => ctx.m);
    type Row = Awaited<ReturnType<typeof query.execute>>[number];

    // Type-checked only — never called, so nothing here runs at test time.
    function assertRowIdRejectedByExactUpdate(): void {
      const store = undefined as unknown as Store<typeof affectedGraph>;
      const row = undefined as unknown as Row;
      // @ts-expect-error - row.id is widened (may be a PodcastAliasTest id); Media's update() requires an exact NodeId<MediaAliasTest>
      void store.nodes.MediaAliasTest.update(row.id, { title: "x" });
    }
    void assertRowIdRejectedByExactUpdate;
    expect(query).toBeDefined();
  });

  it("accepts an empty options object and an explicit undefined, typed like no options at all", () => {
    // R-S1: ordinary option forwarding. A caller threading an options bag
    // it did not populate must not have to drop the argument entirely.
    const builder = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    );
    const emptyOptions = builder
      .from("MediaAliasTest", "m", {})
      .select((ctx) => ctx.m);
    const undefinedOptions = builder
      .from("MediaAliasTest", "m", undefined)
      .select((ctx) => ctx.m);
    expect(emptyOptions).toBeDefined();
    expect(undefinedOptions).toBeDefined();

    type EmptyRow = Awaited<ReturnType<typeof emptyOptions.execute>>[number];
    type UndefinedRow = Awaited<
      ReturnType<typeof undefinedOptions.execute>
    >[number];
    expectTypeOf<EmptyRow["kind"]>().toEqualTypeOf<string>();
    expectTypeOf<UndefinedRow["kind"]>().toEqualTypeOf<string>();
  });

  it("forwards an unstated option identically on every expansion entry point", () => {
    // R-S1, load-bearing at COMPILE time: each call below fails to typecheck
    // if its entry point's default overload stops admitting the shape the
    // caller passes. `exactOptionalPropertyTypes` makes the three shapes
    // genuinely distinct — a bare `expansion?: "subclasses"` rejects the
    // stated `undefined`, which is what `fromDynamic`/`toDynamic` used to do
    // while `from`/`to` accepted it.
    const edgeGraph = defineGraph({
      id: "rs1_forwarding",
      nodes: {
        MediaAliasTest: { type: MediaKind },
        PodcastAliasTest: { type: PodcastKind },
      },
      edges: {
        citesAliasTest: {
          type: cites,
          from: [MediaKind],
          to: [MediaKind, PodcastKind],
        },
      },
      ontology: [subClassOf(PodcastKind, MediaKind)],
    });
    const edgeRegistry = buildKindRegistry(edgeGraph);
    const builder = () =>
      createQueryBuilder<typeof edgeGraph>(edgeGraph.id, edgeRegistry);
    const unstated: { expansion?: undefined } = {};

    const fromCalls = [
      builder().from("MediaAliasTest", "m"),
      builder().from("MediaAliasTest", "m", {}),
      builder().from("MediaAliasTest", "m", undefined),
      builder().from("MediaAliasTest", "m", { expansion: undefined }),
      builder().from("MediaAliasTest", "m", unstated),
    ];
    const fromDynamicCalls = [
      builder().fromDynamic("MediaAliasTest", "m"),
      builder().fromDynamic("MediaAliasTest", "m", {}),
      builder().fromDynamic("MediaAliasTest", "m", undefined),
      builder().fromDynamic("MediaAliasTest", "m", { expansion: undefined }),
      builder().fromDynamic("MediaAliasTest", "m", unstated),
    ];
    const traversal = () =>
      builder()
        .from("MediaAliasTest", "m", { expansion: "exact" })
        .traverse("citesAliasTest", "e");
    const toCalls = [
      traversal().to("MediaAliasTest", "t"),
      traversal().to("MediaAliasTest", "t", {}),
      traversal().to("MediaAliasTest", "t", undefined),
      traversal().to("MediaAliasTest", "t", { expansion: undefined }),
      traversal().to("MediaAliasTest", "t", unstated),
    ];
    const toDynamicCalls = [
      traversal().toDynamic("MediaAliasTest", "t"),
      traversal().toDynamic("MediaAliasTest", "t", {}),
      traversal().toDynamic("MediaAliasTest", "t", undefined),
      traversal().toDynamic("MediaAliasTest", "t", { expansion: undefined }),
      traversal().toDynamic("MediaAliasTest", "t", unstated),
    ];

    // Every shape resolves to the SAME builder type per entry point, so the
    // aliases projected off one of them stand for all five: `from` widens to
    // the polymorphic kind under the store default, and a `"narrower"`-free
    // `toDynamic` does too.
    const fromQuery = builder()
      .from("MediaAliasTest", "m", {})
      .select((ctx) => ctx.m);
    expect(fromQuery).toBeDefined();
    type FromRow = Awaited<ReturnType<typeof fromQuery.execute>>[number];
    expectTypeOf<FromRow["kind"]>().toEqualTypeOf<string>();
    const toQuery = traversal()
      .to("MediaAliasTest", "t", { expansion: undefined })
      .select((ctx) => ctx.t);
    expect(toQuery).toBeDefined();
    type ToRow = Awaited<ReturnType<typeof toQuery.execute>>[number];
    expectTypeOf<ToRow["kind"]>().toEqualTypeOf<string>();

    for (const call of [
      ...fromCalls,
      ...fromDynamicCalls,
      ...toCalls,
      ...toDynamicCalls,
    ]) {
      expect(call).toBeDefined();
    }
  });

  it("forwards an options bag that can carry an axis, on every entry point", () => {
    // The other half of forwarding: a wrapper that narrows SOME calls has to
    // be able to hand its own bag through. Every shape below carries a
    // stateable axis, so none of them matches a per-axis overload — each one
    // is a compile error if the forwarding overload is missing. The alias
    // type is the conservative untyped one, because the axis is not a literal
    // at the call site.
    const edgeGraph = defineGraph({
      id: "rs1_forwarding_axis",
      nodes: {
        MediaAliasTest: { type: MediaKind },
        PodcastAliasTest: { type: PodcastKind },
      },
      edges: {
        citesAxisTest: {
          type: cites,
          from: [MediaKind],
          to: [MediaKind, PodcastKind],
        },
      },
      ontology: [subClassOf(PodcastKind, MediaKind)],
    });
    const edgeRegistry = buildKindRegistry(edgeGraph);
    const builder = () =>
      createQueryBuilder<typeof edgeGraph>(edgeGraph.id, edgeRegistry);
    const owned: AliasExpansionOptions = { expansion: "exact" };
    const narrowingOnly: { expansion?: "exact" } = {};
    const eitherSubsumptionAxis: {
      expansion?: "exact" | "subclasses" | undefined;
    } = {};
    const bags = [owned, narrowingOnly, eitherSubsumptionAxis];
    const traversal = () =>
      builder()
        .from("MediaAliasTest", "m", { expansion: "exact" })
        .traverse("citesAxisTest", "e");
    const calls = bags.flatMap((bag) => [
      builder().from("MediaAliasTest", "m", bag),
      builder().fromDynamic("MediaAliasTest", "m", bag),
      traversal().to("MediaAliasTest", "t", bag),
      traversal().toDynamic("MediaAliasTest", "t", bag),
    ]);
    for (const call of calls) expect(call).toBeDefined();

    const forwardedQuery = builder()
      .from("MediaAliasTest", "m", owned)
      .select((ctx) => ctx.m);
    expect(forwardedQuery).toBeDefined();
    type ForwardedRow = Awaited<
      ReturnType<typeof forwardedQuery.execute>
    >[number];
    expectTypeOf<ForwardedRow["kind"]>().toEqualTypeOf<string>();

    // The store-wide spellings of the same option forward a stated
    // `undefined` too — a bare optional would reject it under
    // `exactOptionalPropertyTypes`.
    const defaultAxis: DefaultAliasExpansionAxis | undefined = undefined;
    const scopedBuilder = createQueryBuilder<typeof edgeGraph>(
      edgeGraph.id,
      edgeRegistry,
      { defaultExpansion: defaultAxis },
    );
    expect(scopedBuilder).toBeDefined();
    const storeOptions: BaseStoreOptions = {
      queryDefaults: { expansion: defaultAxis },
    };
    expect(storeOptions).toBeDefined();
  });

  it("refuses an expansion axis outside the option's domain", () => {
    const builder = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    );
    expect(() =>
      // Unreachable through the typed overloads; a JavaScript caller can
      // still get here, and expanding to the wrong kind list silently
      // would be worse than a refusal.
      builder.from("MediaAliasTest", "m", {
        expansion: "subClasses",
      } as never),
    ).toThrow("Unknown alias expansion");
  });
});

describe("R2 — typed relations and conservative widening", () => {
  const IriMedia = defineNode("IriMedia", {
    schema: z.object({ title: z.string() }),
  });
  const IriPerson = defineNode("IriPerson", {
    schema: z.object({ name: z.string() }),
  });

  const iriGraph = defineGraph({
    id: "r2_iri_equivalence",
    nodes: { IriMedia: { type: IriMedia }, IriPerson: { type: IriPerson } },
    edges: {},
    ontology: [equivalentTo(IriMedia, "https://schema.org/CreativeWork")],
  });
  const iriRegistry = buildKindRegistry(iriGraph);

  it("widens because an IRI-routed equivalence really does expand at runtime", () => {
    // The RUNTIME premise behind the type widening above: a second kind
    // mapped to the same external term joins the first kind's subclass
    // closure, so a query on `IriMedia` can genuinely return rows of a kind
    // its declared type never named. Without this, the widening would be
    // pessimism rather than soundness.
    const CoRegistered = defineNode("IriCoRegistered", {
      schema: z.object({ title: z.string() }),
    });
    const sharedIri = "https://schema.org/CreativeWork";
    const sharedRegistry = buildKindRegistry(
      defineGraph({
        id: "r2_iri_shared_term",
        nodes: {
          IriMedia: { type: IriMedia },
          IriCoRegistered: { type: CoRegistered },
        },
        edges: {},
        ontology: [
          equivalentTo(IriMedia, sharedIri),
          equivalentTo(CoRegistered, sharedIri),
        ],
      }),
    );
    expect(sharedRegistry.expandSubClasses("IriMedia")).toContain(
      "IriCoRegistered",
    );
    expect(sharedRegistry.expandSubClasses("IriMedia")).not.toContain(
      sharedIri,
    );
  });

  it("widens the alias of a kind whose only equivalence is IRI-routed", () => {
    const query = createQueryBuilder<typeof iriGraph>(iriGraph.id, iriRegistry)
      .from("IriMedia", "m")
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<string>();
  });

  it("keeps a kind the IRI equivalence does not name exact", () => {
    // The other half of the load-bearing pair: before the IRI overload was
    // typed it returned a bare `OntologyRelation`, which the conservative
    // arm widens WHOLESALE — every kind in the graph, including this one.
    // Only a relation carrying `from: { kind: "IriMedia" }` can widen one
    // kind and leave the other alone.
    const query = createQueryBuilder<typeof iriGraph>(iriGraph.id, iriRegistry)
      .from("IriPerson", "p")
      .select((ctx) => ctx.p);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<"IriPerson">();
  });

  it("keeps a kind exact when every tuple element is a typed non-subsumption relation", () => {
    const TaxonomyMedia = defineNode("TaxonomyMedia", {
      schema: z.object({ title: z.string() }),
    });
    const TaxonomyPodcast = defineNode("TaxonomyPodcast", {
      schema: z.object({ title: z.string(), rssUrl: z.string() }),
    });
    const taxonomyGraph = defineGraph({
      id: "r2_typed_tuple",
      nodes: {
        TaxonomyMedia: { type: TaxonomyMedia },
        TaxonomyPodcast: { type: TaxonomyPodcast },
      },
      edges: {},
      ontology: [
        broader(TaxonomyPodcast, TaxonomyMedia),
        relatedTo(TaxonomyMedia, TaxonomyPodcast),
      ],
    });
    const taxonomyRegistry = buildKindRegistry(taxonomyGraph);
    const query = createQueryBuilder<typeof taxonomyGraph>(
      taxonomyGraph.id,
      taxonomyRegistry,
    )
      .from("TaxonomyMedia", "m")
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<"TaxonomyMedia">();
  });

  it("widens every kind when one tuple element is annotated as a bare OntologyRelation", () => {
    const AnnotatedMedia = defineNode("AnnotatedMedia", {
      schema: z.object({ title: z.string() }),
    });
    const AnnotatedPerson = defineNode("AnnotatedPerson", {
      schema: z.object({ name: z.string() }),
    });
    // The element — not the array — is annotated, so the tuple keeps its
    // literal length `1` and `OntologyTypeErased` stays false. Only the
    // per-element bare check can see this.
    const annotatedRelation: OntologyRelation = broader(
      AnnotatedPerson,
      AnnotatedMedia,
    );
    const annotatedGraph = defineGraph({
      id: "r2_annotated_element",
      nodes: {
        AnnotatedMedia: { type: AnnotatedMedia },
        AnnotatedPerson: { type: AnnotatedPerson },
      },
      edges: {},
      ontology: [annotatedRelation],
    });
    const annotatedRegistry = buildKindRegistry(annotatedGraph);
    const query = createQueryBuilder<typeof annotatedGraph>(
      annotatedGraph.id,
      annotatedRegistry,
    )
      .from("AnnotatedPerson", "p")
      .select((ctx) => ctx.p);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<string>();
  });
  it("widens every kind when a subClassOf's endpoint kind literals are erased", () => {
    const ErasedMedia = defineNode("ErasedMedia", {
      schema: z.object({ title: z.string() }),
    });
    const ErasedPodcast = defineNode("ErasedPodcast", {
      schema: z.object({ title: z.string(), rssUrl: z.string() }),
    });
    // `declareTaxonomy` states only `NodeType` for its endpoints. The
    // meta-edge NAME literal survives — `MetaEdge<"subClassOf">` is not
    // mutually assignable with `MetaEdge<string>`, so a bare-relation test
    // cannot see this — and the tuple keeps its literal length `1`, so
    // `OntologyTypeErased` cannot either. What is gone is `to.kind`: the
    // exact literal the `Extract` matches on.
    const erasedGraph = defineGraph({
      id: "r2_erased_endpoint_kinds",
      nodes: {
        ErasedMedia: { type: ErasedMedia },
        ErasedPodcast: { type: ErasedPodcast },
      },
      edges: {},
      ontology: [declareTaxonomy(ErasedPodcast, ErasedMedia)],
    });
    const erasedRegistry = buildKindRegistry(erasedGraph);
    // The runtime premise: the relation is a real `subClassOf`, so a
    // supertype query genuinely comes back with subtype rows.
    expect(erasedRegistry.expandSubClasses("ErasedMedia")).toContain(
      "ErasedPodcast",
    );
    const query = createQueryBuilder<typeof erasedGraph>(
      erasedGraph.id,
      erasedRegistry,
    )
      .from("ErasedMedia", "m")
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<string>();
  });

  it("keeps an unnamed kind exact when only the subClassOf child is erased", () => {
    // Precision half of the same arm: the `Extract` reads a `subClassOf`'s
    // `to`, never its `from`, so an erased CHILD leaves the decision intact.
    // The supertype this relation names widens; a kind it does not name
    // stays exact instead of the whole graph widening.
    const ChildErasedMedia = defineNode("ChildErasedMedia", {
      schema: z.object({ title: z.string() }),
    });
    const ChildErasedPodcast = defineNode("ChildErasedPodcast", {
      schema: z.object({ title: z.string(), rssUrl: z.string() }),
    });
    const ChildErasedPerson = defineNode("ChildErasedPerson", {
      schema: z.object({ name: z.string() }),
    });
    const childErased: TypedOntologyRelation<
      "subClassOf",
      NodeType,
      typeof ChildErasedMedia
    > = subClassOf(ChildErasedPodcast, ChildErasedMedia);
    const childErasedGraph = defineGraph({
      id: "r2_erased_child_kind",
      nodes: {
        ChildErasedMedia: { type: ChildErasedMedia },
        ChildErasedPodcast: { type: ChildErasedPodcast },
        ChildErasedPerson: { type: ChildErasedPerson },
      },
      edges: {},
      ontology: [childErased],
    });
    const childErasedRegistry = buildKindRegistry(childErasedGraph);
    const builder = () =>
      createQueryBuilder<typeof childErasedGraph>(
        childErasedGraph.id,
        childErasedRegistry,
      );
    const namedQuery = builder()
      .from("ChildErasedMedia", "m")
      .select((ctx) => ctx.m);
    expect(namedQuery).toBeDefined();
    type NamedRow = Awaited<ReturnType<typeof namedQuery.execute>>[number];
    expectTypeOf<NamedRow["kind"]>().toEqualTypeOf<string>();
    const unnamedQuery = builder()
      .from("ChildErasedPerson", "p")
      .select((ctx) => ctx.p);
    expect(unnamedQuery).toBeDefined();
    type UnnamedRow = Awaited<ReturnType<typeof unnamedQuery.execute>>[number];
    expectTypeOf<UnnamedRow["kind"]>().toEqualTypeOf<"ChildErasedPerson">();
  });
});
