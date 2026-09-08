/**
 * Compile-time type tests for C.1 (typed subsumption).
 *
 * Tests marked with @ts-expect-error verify that an incompatible
 * `subClassOf` / `equivalentTo` / `sameAs` pair is refused AT COMPILE TIME,
 * with the failure carrier (`StructuralSubtypeMismatch`) naming the
 * offending fields. Load-bearing: see
 * tests/property/typed-subsumption-agreement.test.ts for the runtime-side
 * agreement pin, and lane-C13-load-bearing.md for the revert/mutation check
 * performed on this file.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  createQueryBuilder,
  defineGraph,
  defineNode,
  equivalentTo,
  sameAs,
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

describe("C.1 — sameAs carries the same contract as equivalentTo", () => {
  it("compiles for an identical pair", () => {
    const Gamma = defineNode("Gamma", {
      schema: z.object({ y: z.number() }),
    });
    const Delta = defineNode("Delta", {
      schema: z.object({ y: z.number() }),
    });
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const relation = sameAs(Gamma, Delta);
    expect(relation.metaEdge.name).toBe("sameAs");
  });

  it("refuses an incompatible pair — the deprecated alias is not an escape hatch", () => {
    // @ts-expect-error - Person is missing Employee's employeeId field
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    sameAs(Person, Employee);
  });
});

describe("Q3/C.1.4 — alias typing under the polymorphic axis", () => {
  const MediaKind = defineNode("MediaAliasTest", {
    schema: z.object({ title: z.string() }),
  });
  const PodcastKind = defineNode("PodcastAliasTest", {
    schema: z.object({ title: z.string(), rssUrl: z.string() }),
  });

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

  it("includeSubClasses: false keeps kind literal even on an affected alias", () => {
    const query = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    )
      .from("MediaAliasTest", "m", { includeSubClasses: false })
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

  it("refuses includeSubClasses + includeNarrower together, at compile time and at runtime", () => {
    const builder = createQueryBuilder<typeof affectedGraph>(
      affectedGraph.id,
      affectedRegistry,
    );
    const conflictingOptions = {
      includeSubClasses: true,
      includeNarrower: true,
    } as const;

    expect(() => {
      // @ts-expect-error - includeSubClasses and includeNarrower are mutually exclusive
      builder.from("MediaAliasTest", "m", conflictingOptions);
    }).toThrow("cannot both be requested");
  });
});
