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
  broader,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  equivalentTo,
  relatedTo,
  type Store,
  subClassOf,
} from "../src";
import type {
  IncompatibleKeys,
  OntologyRelation,
  StructuralSubtypeMismatch,
} from "../src/ontology/types";
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
});
