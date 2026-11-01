/**
 * Compile-time type tests for typed subsumption.
 *
 * Tests marked with @ts-expect-error verify that an incompatible
 * `subClassOf` / `equivalentTo` pair is refused AT COMPILE TIME,
 * with the failure carrier (`StructuralSubtypeMismatch`) naming the
 * offending fields. Load-bearing: see
 * tests/property/typed-subsumption-agreement.test.ts for the runtime-side
 * agreement pin.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  type AssignableNodeKinds,
  type BaseStoreOptions,
  broader,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  equivalentTo,
  type FulltextSearchOptions,
  type GraphNodeReferenceInput,
  type HybridSearchOptions,
  type Node,
  type NodeId,
  type NodeReferenceLookup,
  type NodeType,
  relatedTo,
  type Store,
  subClassOf,
  type SubsumedNodeReference,
  type TransactionContext,
  type VectorSearchOptions,
} from "../src";
import { ConfigurationError } from "../src/errors";
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

function first<T>(items: readonly T[]): T {
  const [item] = items;
  if (item === undefined) throw new Error("expected a nonempty list");
  return item;
}

describe("subClassOf structural contract", () => {
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

  it("compiles for an empty-schema parent (a regression pin for the earlier false-positive fix)", () => {
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
    // pinned again here for the width-subtyping-by-name test.
    const relation = subClassOf(Podcast, Media);
    expect(relation.to).toBe(Media);
  });

  it("names the message in StructuralSubtypeMismatch", () => {
    expectTypeOf<
      StructuralSubtypeMismatch<"Person", "Employee", "employeeId">
    >().toHaveProperty("__typegraphSubClassOfError");
  });
});

describe("equivalentTo mutual structural contract", () => {
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

describe("alias typing under the polymorphic axis", () => {
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

  it("widens kind to string when the ontology tuple is annotated as bare OntologyRelation[]", () => {
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

  describe("list sources", () => {
    const CompanyKind = defineNode("CompanyListAliasTest", {
      schema: z.object({ title: z.string() }),
    });
    const listGraph = defineGraph({
      id: "alias_typing_list",
      nodes: {
        MediaAliasTest: { type: MediaKind },
        PodcastAliasTest: { type: PodcastKind },
        CompanyListAliasTest: { type: CompanyKind },
      },
      edges: {},
      ontology: [subClassOf(PodcastKind, MediaKind)],
    });
    const listRegistry = buildKindRegistry(listGraph);
    const LISTED = ["MediaAliasTest", "CompanyListAliasTest"] as const;
    const listQuery = () =>
      createQueryBuilder<typeof listGraph>(listGraph.id, listRegistry);

    it("types each listed kind as a single-kind alias over it would be when no expansion is stated", () => {
      const query = listQuery()
        .from(LISTED, "n")
        .select((ctx) => ctx.n);
      expect(query).toBeDefined();
      type Row = Awaited<ReturnType<typeof query.execute>>[number];
      expectTypeOf<Row["kind"]>().toEqualTypeOf<string>();
      expectTypeOf<
        Extract<Row, { kind: "CompanyListAliasTest" }>["id"]
      >().toEqualTypeOf<NodeId<typeof CompanyKind>>();
    });

    it('widens every listed kind under expansion: "subclasses"', () => {
      const query = listQuery()
        .from(LISTED, "n", { expansion: "subclasses" })
        .select((ctx) => ctx.n);
      expect(query).toBeDefined();
      const media = listQuery()
        .from("MediaAliasTest", "n", { expansion: "subclasses" })
        .select((ctx) => ctx.n);
      const company = listQuery()
        .from("CompanyListAliasTest", "n", { expansion: "subclasses" })
        .select((ctx) => ctx.n);
      expect(media).toBeDefined();
      expect(company).toBeDefined();
      type Row = Awaited<ReturnType<typeof query.execute>>[number];
      type MediaRow = Awaited<ReturnType<typeof media.execute>>[number];
      type CompanyRow = Awaited<ReturnType<typeof company.execute>>[number];
      expectTypeOf<
        Extract<Row, { kind: "CompanyListAliasTest" }>
      >().toEqualTypeOf<never>();
      expectTypeOf<Row>().toEqualTypeOf<MediaRow | CompanyRow>();
      expectTypeOf<Row["title"]>().toEqualTypeOf<string>();
    });

    it('keeps the exact union under expansion: "exact"', () => {
      const query = listQuery()
        .from(LISTED, "n", { expansion: "exact" })
        .select((ctx) => ctx.n);
      expect(query).toBeDefined();
      type Row = Awaited<ReturnType<typeof query.execute>>[number];
      expectTypeOf<Row["kind"]>().toEqualTypeOf<
        "MediaAliasTest" | "CompanyListAliasTest"
      >();
    });

    it("types an axis-unknown options bag as a single-kind source types it", () => {
      const options: AliasExpansionOptions = {};
      const listed = listQuery()
        .from(LISTED, "n", options)
        .select((ctx) => ctx.n);
      const single = listQuery()
        .from("CompanyListAliasTest", "n", options)
        .select((ctx) => ctx.n);
      expect(listed).toBeDefined();
      expect(single).toBeDefined();
      expectTypeOf<
        Awaited<ReturnType<typeof listed.execute>>[number]
      >().toEqualTypeOf<Awaited<ReturnType<typeof single.execute>>[number]>();
    });
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

  it('a store-wide default of "exact" changes the rows, not the alias type', () => {
    const query = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
      { defaultExpansion: "exact" },
    )
      .from("MediaAliasTest", "m")
      .select((ctx) => ctx.m);
    expect(query).toBeDefined();
    type Row = Awaited<ReturnType<typeof query.execute>>[number];
    expectTypeOf<Row["kind"]>().toEqualTypeOf<string>();
  });

  it("refuses passing a polymorphic alias's row.id to the exact-kind collection's update()", () => {
    // A polymorphic-affected alias's `id` is widened so an exact `NodeId`
    // is assignable TO it but not FROM it — the row may be a subclass, so `store.nodes.<K>.update(row.id)`
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

  it("types an expanded search hit like the alias it expands to, for every search form", () => {
    // Type-checked only — never called, so nothing here runs at test time.
    async function assertExpandedSearchTyping(): Promise<void> {
      const store = undefined as unknown as Store<typeof affectedGraph>;
      const vectorLeg = { fieldPath: "embedding", queryEmbedding: [0, 1] };
      const fulltextLeg = { query: "x" };

      // Exact, three spellings: omitted, stated, and an explicit undefined.
      const exactFulltext = first(
        await store.search.fulltext("MediaAliasTest", { query: "x", limit: 1 }),
      ).node;
      const exactVector = first(
        await store.search.vector("MediaAliasTest", {
          ...vectorLeg,
          limit: 1,
          expansion: "exact",
        }),
      ).node;
      const exactHybrid = first(
        await store.search.hybrid("MediaAliasTest", {
          vector: vectorLeg,
          fulltext: fulltextLeg,
          limit: 1,
          expansion: undefined,
        }),
      ).node;
      expectTypeOf(exactFulltext.kind).toEqualTypeOf<"MediaAliasTest">();
      expectTypeOf(exactVector.kind).toEqualTypeOf<"MediaAliasTest">();
      expectTypeOf(exactHybrid.kind).toEqualTypeOf<"MediaAliasTest">();
      void store.nodes.MediaAliasTest.update(exactFulltext.id, { title: "x" });

      const aliasRow = first(
        await store
          .query()
          .from("MediaAliasTest", "m")
          .select((ctx) => ctx.m)
          .execute(),
      );
      const fulltext = first(
        await store.search.fulltext("MediaAliasTest", {
          query: "x",
          limit: 1,
          expansion: "subclasses",
          where: (media) => media.title.eq("x"),
        }),
      ).node;
      const vector = first(
        await store.search.vector("MediaAliasTest", {
          ...vectorLeg,
          limit: 1,
          expansion: "subclasses",
        }),
      ).node;
      const hybridHit = first(
        await store.search.hybrid("MediaAliasTest", {
          vector: vectorLeg,
          fulltext: fulltextLeg,
          limit: 1,
          expansion: "subclasses",
        }),
      );
      expectTypeOf(fulltext.kind).toEqualTypeOf<string>();
      expectTypeOf(vector.kind).toEqualTypeOf<string>();
      expectTypeOf(hybridHit.node.kind).toEqualTypeOf<string>();
      expectTypeOf(hybridHit.vector?.node.kind).toEqualTypeOf<
        string | undefined
      >();
      expectTypeOf(hybridHit.fulltext?.node.kind).toEqualTypeOf<
        string | undefined
      >();
      expectTypeOf(aliasRow.id).toEqualTypeOf<typeof fulltext.id>();
      expectTypeOf(aliasRow.id).toEqualTypeOf<typeof vector.id>();
      expectTypeOf(aliasRow.id).toEqualTypeOf<typeof hybridHit.node.id>();
      expectTypeOf(fulltext.title).toEqualTypeOf<string>();
      // @ts-expect-error - the hit may be a PodcastAliasTest row; Media's update() requires an exact NodeId<MediaAliasTest>
      void store.nodes.MediaAliasTest.update(fulltext.id, { title: "x" });

      // A view's search facade is the store's own, so it types identically.
      const viewHit = first(
        await store
          .view({ mode: "current" })
          .search.fulltext("MediaAliasTest", {
            query: "x",
            limit: 1,
            expansion: "subclasses",
          }),
      );
      expectTypeOf(viewHit.node.kind).toEqualTypeOf<string>();

      // An axis the call site does not pin types conservatively.
      const forwardedAxis = "exact" as DefaultAliasExpansionAxis;
      const forwarded = first(
        await store.search.fulltext("MediaAliasTest", {
          query: "x",
          limit: 1,
          expansion: forwardedAxis,
        }),
      );
      expectTypeOf(forwarded.node.kind).toEqualTypeOf<string>();

      // Spelling the kind generic by hand still accepts the axis: the hit is
      // exact without it and widened with it, never an option the call refuses.
      const spelledExact = first(
        await store.search.fulltext<"MediaAliasTest">("MediaAliasTest", {
          query: "x",
          limit: 1,
        }),
      );
      const spelledExpanded = first(
        await store.search.fulltext<"MediaAliasTest">("MediaAliasTest", {
          query: "x",
          limit: 1,
          expansion: "subclasses",
        }),
      );
      expectTypeOf(spelledExact.node.kind).toEqualTypeOf<"MediaAliasTest">();
      expectTypeOf(spelledExpanded.node.kind).toEqualTypeOf<string>();

      // A stated "subclasses" widens even a kind the compile-time ontology
      // cannot affect, exactly as from(kind, alias, { expansion:
      // "subclasses" }) types its alias: a persisted extension may add a
      // subclass the compile-time graph never declares.
      const plainStore = undefined as unknown as Store<typeof plainGraph>;
      const plain = first(
        await plainStore.search.fulltext("MediaAliasTest", {
          query: "x",
          limit: 1,
          expansion: "subclasses",
        }),
      );
      const plainAliasRow = first(
        await plainStore
          .query()
          .from("MediaAliasTest", "m", { expansion: "subclasses" })
          .select((ctx) => ctx.m)
          .execute(),
      );
      expectTypeOf(plain.node.kind).toEqualTypeOf<string>();
      expectTypeOf(plainAliasRow.id).toEqualTypeOf<typeof plain.node.id>();
      expectTypeOf(plain.node.title).toEqualTypeOf<string>();
      // @ts-expect-error - the hit may be a subclass row a persisted extension added; Media's update() requires an exact NodeId<MediaAliasTest>
      void plainStore.nodes.MediaAliasTest.update(plain.node.id, {
        title: "x",
      });
      const plainForwarded = first(
        await plainStore.search.fulltext("MediaAliasTest", {
          query: "x",
          limit: 1,
          expansion: forwardedAxis,
        }),
      );
      expectTypeOf(plainForwarded.node.kind).toEqualTypeOf<string>();

      // A wrapper forwarding the library's own option types, whose
      // `expansion` is optional and either axis, reaches an overload; the
      // axis is unpinned, so the hit widens.
      async function forwardFulltext(
        options: FulltextSearchOptions<typeof MediaKind>,
      ) {
        return store.search.fulltext("MediaAliasTest", options);
      }
      async function forwardVector(
        options: VectorSearchOptions<typeof MediaKind>,
      ) {
        return store.search.vector("MediaAliasTest", options);
      }
      async function forwardHybrid(
        options: HybridSearchOptions<typeof MediaKind>,
      ) {
        return store.search.hybrid("MediaAliasTest", options);
      }
      const forwardedFulltext = first(
        await forwardFulltext({ query: "x", limit: 1 }),
      );
      const forwardedVector = first(
        await forwardVector({ ...vectorLeg, limit: 1 }),
      );
      const forwardedHybrid = first(
        await forwardHybrid({
          vector: vectorLeg,
          fulltext: fulltextLeg,
          limit: 1,
        }),
      );
      expectTypeOf(forwardedFulltext.node.kind).toEqualTypeOf<string>();
      expectTypeOf(forwardedVector.node.kind).toEqualTypeOf<string>();
      expectTypeOf(forwardedHybrid.node.kind).toEqualTypeOf<string>();
      expectTypeOf(forwardedFulltext.node.title).toEqualTypeOf<string>();
    }
    void assertExpandedSearchTyping;
    expect(affectedGraph.id).toBe("alias_typing_affected");
  });

  it("refuses an expansion axis outside the option's domain", () => {
    // Unreachable through the typed overloads; a JavaScript caller can still
    // get here, and expanding to the wrong kind list silently would be worse
    // than a refusal. Decided in `resolveAliasExpansion` before any SQL is
    // emitted, so this belongs here and not in the cross-backend suite — the
    // two dialects cannot disagree about it.
    const builder = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    );
    let caught: unknown;
    try {
      builder.from("MediaAliasTest", "m", {
        expansion: "subClasses",
      } as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).details["code"]).toBe(
      "QUERY_ALIAS_EXPANSION_INVALID",
    );
    expect((caught as ConfigurationError).message).toContain(
      'Unknown alias expansion "subClasses"',
    );
  });
});

describe("typed relations and conservative widening", () => {
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

  it("widens every kind an endpoint kind UNION can hold", () => {
    // A caller helper that declares a subclass of EITHER media root. Its
    // `to` is a union of two node types, so the relation keeps both its
    // meta-edge name literal and literal endpoint kinds — neither erased arm
    // sees it — yet no single `{ to: { kind: K } }` shape describes it.
    const UnionAudio = defineNode("UnionAudio", {
      schema: z.object({ title: z.string() }),
    });
    const UnionVideo = defineNode("UnionVideo", {
      schema: z.object({ title: z.string() }),
    });
    const UnionEpisode = defineNode("UnionEpisode", {
      schema: z.object({ title: z.string(), durationSeconds: z.number() }),
    });
    const UnionUnrelated = defineNode("UnionUnrelated", {
      schema: z.object({ name: z.string() }),
    });
    type MediaRoot = typeof UnionAudio | typeof UnionVideo;
    function declareEpisodeOf(root: MediaRoot) {
      return subClassOf(UnionEpisode, root);
    }
    const unionNodes = {
      UnionAudio: { type: UnionAudio },
      UnionVideo: { type: UnionVideo },
      UnionEpisode: { type: UnionEpisode },
      UnionUnrelated: { type: UnionUnrelated },
    } as const;
    const audioRootGraph = defineGraph({
      id: "r2_union_endpoint_audio",
      nodes: unionNodes,
      edges: {},
      ontology: [declareEpisodeOf(UnionAudio)],
    });
    const videoRootGraph = defineGraph({
      id: "r2_union_endpoint_video",
      nodes: unionNodes,
      edges: {},
      ontology: [declareEpisodeOf(UnionVideo)],
    });
    // The soundness argument, stated as an assertion: the two graphs have
    // IDENTICAL ontology types and DIFFERENT runtime subclass closures, so a
    // type that answered "unaffected" for either root would be wrong for one
    // of them.
    expectTypeOf<(typeof audioRootGraph)["ontology"]>().toEqualTypeOf<
      (typeof videoRootGraph)["ontology"]
    >();
    const audioRegistry = buildKindRegistry(audioRootGraph);
    const videoRegistry = buildKindRegistry(videoRootGraph);
    expect(audioRegistry.expandSubClasses("UnionAudio")).toContain(
      "UnionEpisode",
    );
    expect(audioRegistry.expandSubClasses("UnionVideo")).not.toContain(
      "UnionEpisode",
    );
    expect(videoRegistry.expandSubClasses("UnionVideo")).toContain(
      "UnionEpisode",
    );
    const builder = () =>
      createQueryBuilder<typeof audioRootGraph>(
        audioRootGraph.id,
        audioRegistry,
      );
    const audioQuery = builder()
      .from("UnionAudio", "a")
      .select((ctx) => ctx.a);
    expect(audioQuery).toBeDefined();
    type AudioRow = Awaited<ReturnType<typeof audioQuery.execute>>[number];
    expectTypeOf<AudioRow["kind"]>().toEqualTypeOf<string>();
    const videoQuery = builder()
      .from("UnionVideo", "v")
      .select((ctx) => ctx.v);
    expect(videoQuery).toBeDefined();
    type VideoRow = Awaited<ReturnType<typeof videoQuery.execute>>[number];
    expectTypeOf<VideoRow["kind"]>().toEqualTypeOf<string>();
    // Precision: distributing over the union widens the kinds the union can
    // hold and nothing else — a kind no endpoint names stays exact instead of
    // the whole graph widening the way an erased arm would.
    const unrelatedQuery = builder()
      .from("UnionUnrelated", "u")
      .select((ctx) => ctx.u);
    expect(unrelatedQuery).toBeDefined();
    type UnrelatedRow = Awaited<
      ReturnType<typeof unrelatedQuery.execute>
    >[number];
    expectTypeOf<UnrelatedRow["kind"]>().toEqualTypeOf<"UnionUnrelated">();
  });

  it("widens every kind an equivalentTo endpoint union can hold, on either side", () => {
    const EitherLeftA = defineNode("EitherLeftA", {
      schema: z.object({ title: z.string() }),
    });
    const EitherLeftB = defineNode("EitherLeftB", {
      schema: z.object({ title: z.string() }),
    });
    const EitherRightA = defineNode("EitherRightA", {
      schema: z.object({ title: z.string() }),
    });
    const EitherRightB = defineNode("EitherRightB", {
      schema: z.object({ title: z.string() }),
    });
    const EitherUnrelated = defineNode("EitherUnrelated", {
      schema: z.object({ name: z.string() }),
    });
    type LeftMember = typeof EitherLeftA | typeof EitherLeftB;
    type RightMember = typeof EitherRightA | typeof EitherRightB;
    // `equivalentTo` is matched on BOTH endpoints, so one relation whose two
    // sides are each a union must widen all four kinds it can hold.
    function declareEquivalence(left: LeftMember, right: RightMember) {
      return equivalentTo(left, right);
    }
    const eitherGraph = defineGraph({
      id: "r2_union_endpoint_equivalence",
      nodes: {
        EitherLeftA: { type: EitherLeftA },
        EitherLeftB: { type: EitherLeftB },
        EitherRightA: { type: EitherRightA },
        EitherRightB: { type: EitherRightB },
        EitherUnrelated: { type: EitherUnrelated },
      },
      edges: {},
      ontology: [declareEquivalence(EitherLeftA, EitherRightB)],
    });
    const eitherRegistry = buildKindRegistry(eitherGraph);
    expect(eitherRegistry.expandSubClasses("EitherLeftA")).toContain(
      "EitherRightB",
    );
    const builder = () =>
      createQueryBuilder<typeof eitherGraph>(eitherGraph.id, eitherRegistry);
    const leftAQuery = builder()
      .from("EitherLeftA", "x")
      .select((ctx) => ctx.x);
    expect(leftAQuery).toBeDefined();
    type LeftARow = Awaited<ReturnType<typeof leftAQuery.execute>>[number];
    expectTypeOf<LeftARow["kind"]>().toEqualTypeOf<string>();
    const leftBQuery = builder()
      .from("EitherLeftB", "x")
      .select((ctx) => ctx.x);
    expect(leftBQuery).toBeDefined();
    type LeftBRow = Awaited<ReturnType<typeof leftBQuery.execute>>[number];
    expectTypeOf<LeftBRow["kind"]>().toEqualTypeOf<string>();
    const rightAQuery = builder()
      .from("EitherRightA", "y")
      .select((ctx) => ctx.y);
    expect(rightAQuery).toBeDefined();
    type RightARow = Awaited<ReturnType<typeof rightAQuery.execute>>[number];
    expectTypeOf<RightARow["kind"]>().toEqualTypeOf<string>();
    const rightBQuery = builder()
      .from("EitherRightB", "y")
      .select((ctx) => ctx.y);
    expect(rightBQuery).toBeDefined();
    type RightBRow = Awaited<ReturnType<typeof rightBQuery.execute>>[number];
    expectTypeOf<RightBRow["kind"]>().toEqualTypeOf<string>();
    const unrelatedQuery = builder()
      .from("EitherUnrelated", "u")
      .select((ctx) => ctx.u);
    expect(unrelatedQuery).toBeDefined();
    type UnrelatedRow = Awaited<
      ReturnType<typeof unrelatedQuery.execute>
    >[number];
    expectTypeOf<UnrelatedRow["kind"]>().toEqualTypeOf<"EitherUnrelated">();
  });

  it("widens every kind a single endpoint's kind-literal union can hold", () => {
    // The second shape an endpoint union takes: not a union of endpoint
    // TYPES but a union inside ONE endpoint's `kind`, from a helper annotated
    // `NodeType<"LiteralAudio" | "LiteralVideo">`. Same unsoundness, same
    // remedy — the decision reduces the endpoint to the kind literals it can
    // hold rather than asking for assignability to a single-kind shape.
    const LiteralAudio = defineNode("LiteralAudio", {
      schema: z.object({ title: z.string() }),
    });
    const LiteralVideo = defineNode("LiteralVideo", {
      schema: z.object({ title: z.string() }),
    });
    const LiteralEpisode = defineNode("LiteralEpisode", {
      schema: z.object({ title: z.string(), durationSeconds: z.number() }),
    });
    const LiteralUnrelated = defineNode("LiteralUnrelated", {
      schema: z.object({ name: z.string() }),
    });
    function declareEpisodeUnderEither(
      root: NodeType<"LiteralAudio" | "LiteralVideo">,
    ) {
      return subClassOf(LiteralEpisode, root);
    }
    const literalUnionGraph = defineGraph({
      id: "r2_union_endpoint_kind_literal",
      nodes: {
        LiteralAudio: { type: LiteralAudio },
        LiteralVideo: { type: LiteralVideo },
        LiteralEpisode: { type: LiteralEpisode },
        LiteralUnrelated: { type: LiteralUnrelated },
      },
      edges: {},
      ontology: [declareEpisodeUnderEither(LiteralAudio)],
    });
    const literalUnionRegistry = buildKindRegistry(literalUnionGraph);
    expect(literalUnionRegistry.expandSubClasses("LiteralAudio")).toContain(
      "LiteralEpisode",
    );
    const builder = () =>
      createQueryBuilder<typeof literalUnionGraph>(
        literalUnionGraph.id,
        literalUnionRegistry,
      );
    const audioQuery = builder()
      .from("LiteralAudio", "a")
      .select((ctx) => ctx.a);
    expect(audioQuery).toBeDefined();
    type AudioRow = Awaited<ReturnType<typeof audioQuery.execute>>[number];
    expectTypeOf<AudioRow["kind"]>().toEqualTypeOf<string>();
    const videoQuery = builder()
      .from("LiteralVideo", "v")
      .select((ctx) => ctx.v);
    expect(videoQuery).toBeDefined();
    type VideoRow = Awaited<ReturnType<typeof videoQuery.execute>>[number];
    expectTypeOf<VideoRow["kind"]>().toEqualTypeOf<string>();
    const unrelatedQuery = builder()
      .from("LiteralUnrelated", "u")
      .select((ctx) => ctx.u);
    expect(unrelatedQuery).toBeDefined();
    type UnrelatedRow = Awaited<
      ReturnType<typeof unrelatedQuery.execute>
    >[number];
    expectTypeOf<UnrelatedRow["kind"]>().toEqualTypeOf<"LiteralUnrelated">();
  });
});

describe("typed edge collections under subsumption", () => {
  const Staff = defineNode("EndpointStaff", {
    schema: z.object({ name: z.string() }),
  });
  const Engineer = defineNode("EndpointEngineer", {
    schema: z.object({ name: z.string(), level: z.number() }),
  });
  const Lead = defineNode("EndpointLead", {
    schema: z.object({
      name: z.string(),
      level: z.number(),
      reports: z.number(),
    }),
  });
  const Contractor = defineNode("EndpointContractor", {
    schema: z.object({ name: z.string() }),
  });
  const Vendor = defineNode("EndpointVendor", {
    schema: z.object({ vendorCode: z.string() }),
  });
  const Supplier = defineNode("EndpointSupplier", {
    schema: z.object({ vendorCode: z.string() }),
  });
  const Firm = defineNode("EndpointFirm", {
    schema: z.object({ name: z.string() }),
  });
  const employs = defineEdge("endpointEmploys", { schema: z.object({}) });

  const nodes = {
    EndpointStaff: { type: Staff },
    EndpointEngineer: { type: Engineer },
    EndpointLead: { type: Lead },
    EndpointContractor: { type: Contractor },
    EndpointVendor: { type: Vendor },
    EndpointSupplier: { type: Supplier },
    EndpointFirm: { type: Firm },
  } as const;
  const edges = {
    endpointEmploys: { type: employs, from: [Firm], to: [Staff] },
  } as const;

  const affectedGraph = defineGraph({
    id: "endpoint_typing_affected",
    nodes,
    edges,
    ontology: [subClassOf(Engineer, Staff), subClassOf(Lead, Engineer)],
  });
  const plainGraph = defineGraph({
    id: "endpoint_typing_plain",
    nodes,
    edges,
    ontology: [],
  });
  type AffectedStore = Store<typeof affectedGraph>;
  type PlainStore = Store<typeof plainGraph>;
  type AffectedEdge = Awaited<
    ReturnType<AffectedStore["edges"]["endpointEmploys"]["findFrom"]>
  >[number];
  type PlainEdge = Awaited<
    ReturnType<PlainStore["edges"]["endpointEmploys"]["findFrom"]>
  >[number];

  it("widens an affected endpoint's kind and id on every edge read", () => {
    expectTypeOf<AffectedEdge["toKind"]>().toEqualTypeOf<string>();
    expectTypeOf<AffectedEdge["fromKind"]>().toEqualTypeOf<"EndpointFirm">();
    type ViewEdge = Awaited<
      ReturnType<
        ReturnType<AffectedStore["asOf"]>["edges"]["endpointEmploys"]["findTo"]
      >
    >[number];
    expectTypeOf<ViewEdge["toKind"]>().toEqualTypeOf<string>();
    type CreatedEdge = Awaited<
      ReturnType<AffectedStore["edges"]["endpointEmploys"]["create"]>
    >;
    expectTypeOf<CreatedEdge["toKind"]>().toEqualTypeOf<string>();
    type BulkEdge = Awaited<
      ReturnType<AffectedStore["bulkFindEdgesFrom"]>
    >[number]["edges"][number];
    expectTypeOf<BulkEdge["toKind"]>().toEqualTypeOf<string>();
  });

  it("types a bulk read's echoed reference as the input it accepted", () => {
    type FromBucket = Awaited<
      ReturnType<AffectedStore["bulkFindEdgesFrom"]>
    >[number];
    type ToBucket = Awaited<
      ReturnType<AffectedStore["bulkFindEdgesTo"]>
    >[number];
    type PlainBucket = Awaited<
      ReturnType<PlainStore["bulkFindEdgesFrom"]>
    >[number];
    expectTypeOf<FromBucket["source"]>().toEqualTypeOf<
      GraphNodeReferenceInput<typeof affectedGraph>
    >();
    expectTypeOf<ToBucket["target"]>().toEqualTypeOf<
      GraphNodeReferenceInput<typeof affectedGraph>
    >();
    expectTypeOf<FromBucket["source"]["kind"]>().toEqualTypeOf<string>();
    expectTypeOf<PlainBucket["source"]["kind"]>().toEqualTypeOf<
      keyof typeof nodes
    >();
  });

  it("keeps declared endpoint literals when the graph declares no subsumption", () => {
    expectTypeOf<PlainEdge["toKind"]>().toEqualTypeOf<"EndpointStaff">();
    expectTypeOf<PlainEdge["toId"]>().toEqualTypeOf<NodeId<typeof Staff>>();
  });

  it("refuses an affected endpoint's id on the declared kind's collection", () => {
    // Type-checked only — never called.
    function assertWidenedIdRefused(): void {
      const affected = undefined as unknown as AffectedStore;
      const plain = undefined as unknown as PlainStore;
      const affectedEdge = undefined as unknown as AffectedEdge;
      const plainEdge = undefined as unknown as PlainEdge;
      // @ts-expect-error - the target may be an EndpointEngineer row
      void affected.nodes.EndpointStaff.getById(affectedEdge.toId);
      void plain.nodes.EndpointStaff.getById(plainEdge.toId);
    }
    void assertWidenedIdRefused;
    expectTypeOf<AffectedEdge["toId"]>().not.toEqualTypeOf<
      NodeId<typeof Staff>
    >();
  });

  it("accepts a subclass node, a transitive descendant and a polymorphic row as an endpoint", () => {
    const registry = buildKindRegistry(affectedGraph);
    const rows = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      registry,
    )
      .from("EndpointStaff", "s")
      .select((ctx) => ctx.s);
    type StaffRow = Awaited<ReturnType<typeof rows.execute>>[number];
    expectTypeOf<StaffRow["kind"]>().toEqualTypeOf<string>();

    // Type-checked only — never called.
    function assertEndpointsAccepted(): void {
      const store = undefined as unknown as AffectedStore;
      const firm = undefined as unknown as Node<typeof Firm>;
      const engineer = undefined as unknown as Node<typeof Engineer>;
      const lead = undefined as unknown as Node<typeof Lead>;
      const row = undefined as unknown as StaffRow;
      void store.edges.endpointEmploys.create(firm, engineer);
      void store.edges.endpointEmploys.create(firm, lead);
      void store.edges.endpointEmploys.create(firm, row);
      void store.edges.endpointEmploys.create(firm, {
        kind: "EndpointLead",
        id: "lead-id",
      });
      void store.edges.endpointEmploys.findTo(engineer);
      void store.edges.endpointEmploys.bulkFindTo([engineer, row]);
      void store.edges.endpointEmploys.bulkCreate([{ from: firm, to: row }]);
      void store.edges.endpointEmploys.getOrCreateByEndpoints(firm, lead, {});
      void store
        .asOf("2026-01-01T00:00:00.000Z")
        .edges.endpointEmploys.findTo(row);
    }
    void assertEndpointsAccepted;
    expect(rows).toBeDefined();
  });

  it("still refuses an endpoint the ontology does not admit", () => {
    // Type-checked only — never called.
    function assertEndpointsRefused(): void {
      const affected = undefined as unknown as Store<typeof affectedGraph>;
      const plain = undefined as unknown as Store<typeof plainGraph>;
      const firm = undefined as unknown as Node<typeof Firm>;
      const engineer = undefined as unknown as Node<typeof Engineer>;
      const vendor = undefined as unknown as Node<typeof Vendor>;
      // @ts-expect-error - EndpointVendor is no subclass of EndpointStaff
      void affected.edges.endpointEmploys.create(firm, vendor);
      // @ts-expect-error - EndpointContractor is no subclass of EndpointStaff
      void affected.edges.endpointEmploys.create(firm, {
        kind: "EndpointContractor",
        id: "contractor-id",
      });
      // @ts-expect-error - without the subClassOf, EndpointEngineer is not admitted
      void plain.edges.endpointEmploys.create(firm, engineer);
    }
    void assertEndpointsRefused;
    expect(
      buildKindRegistry(plainGraph).expandSubClasses("EndpointStaff"),
    ).toEqual(["EndpointStaff"]);
    expectTypeOf<
      AssignableNodeKinds<typeof affectedGraph, "EndpointStaff">
    >().toEqualTypeOf<"EndpointStaff" | "EndpointEngineer" | "EndpointLead">();
    expectTypeOf<
      AssignableNodeKinds<typeof affectedGraph, "EndpointEngineer">
    >().toEqualTypeOf<"EndpointEngineer" | "EndpointLead">();
    expectTypeOf<
      AssignableNodeKinds<typeof plainGraph, "EndpointStaff">
    >().toEqualTypeOf<"EndpointStaff">();
  });

  it("passes a widened endpoint and a polymorphic row back into every endpoint input", () => {
    const registry = buildKindRegistry(affectedGraph);
    const rows = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      registry,
    )
      .from("EndpointStaff", "s")
      .select((ctx) => ctx.s);
    type StaffRow = Awaited<ReturnType<typeof rows.execute>>[number];

    // Type-checked only — never called.
    async function chainHops(
      store: AffectedStore,
      edge: AffectedEdge,
      row: StaffRow,
    ): Promise<void> {
      const target = { kind: edge.toKind, id: edge.toId };
      const edgeKinds = ["endpointEmploys"] as const;
      void store.edges.endpointEmploys.findTo(target);
      void store.bulkFindEdgesTo({
        targets: [{ kind: edge.toKind, ids: [edge.toId] }],
        edgeKinds,
      });
      void store.bulkFindEdgesFrom({
        sources: [
          { kind: edge.toKind, ids: [edge.toId] },
          { kind: row.kind, ids: [row.id] },
          { kind: edge.fromKind, ids: [edge.fromId] },
        ],
        edgeKinds,
      });
      void store.neighbors(target, { edges: edgeKinds, direction: "in" });
      void store.neighbors(row, { edges: edgeKinds, direction: "in" });
      void store.countNeighbors(target, { edges: edgeKinds });
      void store.batchOnce((read) => [
        read.neighbors(target, { edges: edgeKinds }),
        read.countNeighbors(row, { edges: edgeKinds }),
      ]);
      await store.transaction(async (tx) => {
        await tx.neighbors(target, { edges: edgeKinds });
        await tx.countNeighbors(row, { edges: edgeKinds });
      });
      if (edge.toKind === "EndpointEngineer") {
        const engineer = { kind: edge.toKind, id: edge.toId };
        void store.edges.endpointEmploys.findTo(engineer);
        void store.neighbors(engineer, { edges: edgeKinds });
        void store.bulkFindEdgesTo({
          targets: [{ kind: edge.toKind, ids: [edge.toId] }],
          edgeKinds,
        });
      }
    }
    void chainHops;
    expect(rows).toBeDefined();
  });

  it("refuses a reference whose id brand no admitted kind carries", () => {
    // Type-checked only — never called.
    function assertReferencesRefused(): void {
      const affected = undefined as unknown as AffectedStore;
      const plain = undefined as unknown as PlainStore;
      const plainEdge = undefined as unknown as PlainEdge;
      const vendor = undefined as unknown as Node<typeof Vendor>;
      const kind: string = affectedGraph.id;
      const edgeKinds = ["endpointEmploys"] as const;
      // @ts-expect-error - a bare string id carries no node brand
      void affected.neighbors({ kind, id: "raw-id" }, { edges: edgeKinds });
      // @ts-expect-error - EndpointVendor's id is not an EndpointStaff id
      void affected.neighbors({ kind, id: vendor.id }, { edges: edgeKinds });
      void affected.bulkFindEdgesTo({
        // @ts-expect-error - EndpointVendor's id is not an EndpointStaff id
        targets: [{ kind, ids: [vendor.id] }],
        edgeKinds,
      });
      // @ts-expect-error - EndpointVendor's id is not an EndpointStaff id
      void affected.edges.endpointEmploys.findTo({ kind, id: vendor.id });
      // @ts-expect-error - without subsumption, the kind stays a literal
      void plain.neighbors({ kind, id: plainEdge.toId }, { edges: edgeKinds });
      void plain.neighbors(
        { kind: plainEdge.toKind, id: plainEdge.toId },
        { edges: edgeKinds },
      );
    }
    void assertReferencesRefused;
    expectTypeOf<
      SubsumedNodeReference<typeof plainGraph, typeof Staff>
    >().toBeNever();
    expectTypeOf<
      SubsumedNodeReference<typeof affectedGraph, typeof Firm>
    >().toBeNever();
  });

  it("admits an unrelated kind whose properties include the declared kind's, structurally", () => {
    // Type-checked only — never called. The id brand is structural, so an
    // EndpointContractor (same properties as EndpointStaff, no ontology
    // relation) compiles; the runtime endpoint check refuses it with
    // EndpointError.
    type ContractorNode = Node<typeof Contractor>;
    function assertStructuralAdmission(): void {
      const store = undefined as unknown as AffectedStore;
      const firm = undefined as unknown as Node<typeof Firm>;
      const contractor = undefined as unknown as ContractorNode;
      void store.edges.endpointEmploys.create(firm, contractor);
    }
    void assertStructuralAdmission;
    expect(
      buildKindRegistry(affectedGraph).isAssignableTo(
        "EndpointContractor",
        "EndpointStaff",
      ),
    ).toBe(false);
  });

  it("admits every kind folded together by equivalence, through a shared IRI too", () => {
    const iri = "https://example.com/Worker";
    const equivalenceGraph = defineGraph({
      id: "endpoint_typing_equivalence",
      nodes,
      edges,
      ontology: [
        equivalentTo(Staff, Contractor),
        subClassOf(Engineer, Contractor),
        equivalentTo(Vendor, iri),
        equivalentTo(Supplier, iri),
      ],
    });
    expectTypeOf<
      AssignableNodeKinds<typeof equivalenceGraph, "EndpointStaff">
    >().toEqualTypeOf<
      "EndpointStaff" | "EndpointContractor" | "EndpointEngineer"
    >();
    expectTypeOf<
      AssignableNodeKinds<typeof equivalenceGraph, "EndpointVendor">
    >().toEqualTypeOf<"EndpointVendor" | "EndpointSupplier">();
    // The runtime closure the type mirrors.
    const registry = buildKindRegistry(equivalenceGraph);
    expect(registry.expandSubClasses("EndpointStaff").toSorted()).toEqual([
      "EndpointContractor",
      "EndpointEngineer",
      "EndpointStaff",
    ]);
    expect(registry.expandSubClasses("EndpointVendor").toSorted()).toEqual([
      "EndpointSupplier",
      "EndpointVendor",
    ]);
  });

  it("admits every kind when the ontology tuple lost its literals", () => {
    const erasedOntology: readonly OntologyRelation[] = [
      subClassOf(Engineer, Staff),
    ];
    const erasedGraph = defineGraph({
      id: "endpoint_typing_erased",
      nodes,
      edges,
      ontology: erasedOntology,
    });
    expectTypeOf<
      AssignableNodeKinds<typeof erasedGraph, "EndpointStaff">
    >().toEqualTypeOf<keyof typeof nodes>();
    expect(
      buildKindRegistry(erasedGraph).isAssignableTo(
        "EndpointEngineer",
        "EndpointStaff",
      ),
    ).toBe(true);
  });
});

describe("getNodeByRef result typing", () => {
  const Staff = defineNode("RefStaff", {
    schema: z.object({ name: z.string() }),
  });
  const Engineer = defineNode("RefEngineer", {
    schema: z.object({ name: z.string(), level: z.number() }),
  });
  const Firm = defineNode("RefFirm", {
    schema: z.object({ title: z.string() }),
  });
  const employs = defineEdge("refEmploys", { schema: z.object({}) });
  const graph = defineGraph({
    id: "node_by_ref_typing",
    nodes: {
      RefStaff: { type: Staff },
      RefEngineer: { type: Engineer },
      RefFirm: { type: Firm },
    },
    edges: { refEmploys: { type: employs, from: [Firm], to: [Staff] } },
    ontology: [subClassOf(Engineer, Staff)],
  });
  type GraphStore = Store<typeof graph>;
  type Employment = Awaited<
    ReturnType<GraphStore["edges"]["refEmploys"]["findFrom"]>
  >[number];

  it("resolves a typed reference to its kind's node", () => {
    // Type-checked only — never called.
    async function resolveFirm(
      store: Store<typeof graph>,
      edge: Employment,
    ): Promise<void> {
      const firm = await store.getNodeByRef({
        kind: edge.fromKind,
        id: edge.fromId,
      });
      expectTypeOf(firm).toEqualTypeOf<Node<typeof Firm> | undefined>();
    }
    void resolveFirm;
    expectTypeOf<Employment["fromKind"]>().toEqualTypeOf<"RefFirm">();
    expect(
      buildKindRegistry(graph).isAssignableTo("RefEngineer", "RefStaff"),
    ).toBe(true);
  });

  it("resolves a widened endpoint to a kind-discriminated union", () => {
    // Type-checked only — never called.
    async function narrowResolvedEndpoint(
      store: GraphStore,
      edge: Employment,
    ): Promise<void> {
      if (edge.toKind === "RefEngineer") {
        const engineer = await store.getNodeByRef({
          kind: edge.toKind,
          id: edge.toId,
        });
        expectTypeOf(engineer).toEqualTypeOf<
          Node<typeof Engineer> | undefined
        >();
      }
      const target = await store.getNodeByRef({
        kind: edge.toKind,
        id: edge.toId,
      });
      if (target?.kind === "RefEngineer") {
        expectTypeOf(target).toEqualTypeOf<Node<typeof Engineer> | Node>();
      }
    }
    void narrowResolvedEndpoint;
    type Resolved = Awaited<ReturnType<GraphStore["getNodeByRef"]>>;
    expectTypeOf<Resolved>().toEqualTypeOf<
      | Node<typeof Staff>
      | Node<typeof Engineer>
      | Node<typeof Firm>
      | Node
      | undefined
    >();
  });

  it("offers the same resolver on transactions and views", () => {
    type TransactionResolve = TransactionContext<typeof graph>["getNodeByRef"];
    expectTypeOf<TransactionResolve>().toEqualTypeOf<
      NodeReferenceLookup<typeof graph>
    >();
    type ViewResolved = Awaited<
      ReturnType<ReturnType<GraphStore["asOf"]>["getNodeByRef"]>
    >;
    expectTypeOf<ViewResolved>().toEqualTypeOf<
      Awaited<ReturnType<GraphStore["getNodeByRef"]>>
    >();
  });
});
