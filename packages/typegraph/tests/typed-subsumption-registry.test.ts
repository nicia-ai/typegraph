/**
 * The registry-build-time structural subsumption check.
 *
 * The compile-time check refuses everything TypeScript's structural
 * assignability over `z.infer` can see; it is blind to value-level
 * constraints (`z.string().min(3)` tightening a bare `z.string()`), so most
 * fixtures here deliberately construct pairs that are TYPE-compatible (so
 * `subClassOf`/`equivalentTo` compiles) but VALUE-level incompatible — the
 * "the compile-time check accepts strictly more than the registry check
 * refuses" gap, and exactly the case only the runtime check can catch.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  equivalentTo,
  type GraphDef,
  subClassOf,
} from "../src";
import { ConfigurationError } from "../src/errors";
import { defineGraphExtension } from "../src/graph-extension";
import { buildKindRegistry } from "../src/registry/builders";
import {
  computeSchemaHash,
  deserializeSchema,
  serializeSchema,
} from "../src/schema";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

describe("registry check — subClassOf refused when the child is not a structural subtype", () => {
  it("refuses a direct value-constraint mismatch, naming the codes and fields", () => {
    const Loose = defineNode("Loose", {
      schema: z.object({ code: z.string() }),
    });
    const Tight = defineNode("Tight", {
      schema: z.object({ code: z.string().min(5) }),
    });
    const relation = subClassOf(Loose, Tight);

    let caught: unknown;
    try {
      buildKindRegistry(
        defineGraph({
          id: "subclass_value_mismatch",
          nodes: { Loose: { type: Loose }, Tight: { type: Tight } },
          edges: {},
          ontology: [relation],
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    const configError = caught as ConfigurationError;
    expect(configError.details["code"]).toBe(
      "ONTOLOGY_SUBCLASS_NOT_STRUCTURAL_SUBTYPE",
    );
    expect(configError.details["childKind"]).toBe("Loose");
    expect(configError.details["parentKind"]).toBe("Tight");
    expect(configError.details["declared"]).toBe(true);
    expect(configError.details["violations"]).toBeInstanceOf(Array);
  });

  it("refuses a pair reached only transitively, with declared: false", () => {
    // A and B are structurally equal (subtype trivially); B does not extend
    // C. The transitive closure still puts C in A's ancestors, and THAT
    // pair was never directly declared.
    const A = defineNode("A", { schema: z.object({ code: z.string() }) });
    const B = defineNode("B", { schema: z.object({ code: z.string() }) });
    const C = defineNode("C", {
      schema: z.object({ code: z.string().min(5) }),
    });

    let caught: unknown;
    try {
      buildKindRegistry(
        defineGraph({
          id: "subclass_transitive",
          nodes: { A: { type: A }, B: { type: B }, C: { type: C } },
          edges: {},
          ontology: [subClassOf(A, B), subClassOf(B, C)],
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    const violations = (caught as ConfigurationError).details[
      "violations"
    ] as readonly Readonly<{
      childKind: string;
      parentKind: string;
      declared: boolean;
    }>[];
    const transitiveViolation = violations.find(
      (violation) =>
        violation.childKind === "A" && violation.parentKind === "C",
    );
    expect(transitiveViolation).toBeDefined();
    expect(transitiveViolation?.declared).toBe(false);
  });

  it("skips an unregistered parent kind — the documented external-parent pattern", () => {
    const Child = defineNode("Child", {
      schema: z.object({ code: z.string() }),
    });
    // Parent is never added to `nodes` — a supported "referenced but not
    // registered" pattern; subsumption cannot apply to a kind whose shape
    // this registry does not know.
    const UnregisteredParent = defineNode("UnregisteredParent", {
      schema: z.object({ code: z.string().min(5) }),
    });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "subclass_unregistered_parent",
          nodes: { Child: { type: Child } },
          edges: {},
          ontology: [subClassOf(Child, UnregisteredParent)],
        }),
      ),
    ).not.toThrow();
  });

  it("skips an external IRI on equivalentTo", () => {
    const Kind = defineNode("Kind", {
      schema: z.object({ code: z.string() }),
    });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "subclass_external_iri",
          nodes: { Kind: { type: Kind } },
          edges: {},
          ontology: [equivalentTo(Kind, "https://schema.org/Kind")],
        }),
      ),
    ).not.toThrow();
  });

  it("refuses an opaque construct (z.intersection) as incomparable, never silently accepted", () => {
    // Child's `tag` differs from Parent's `tag` ONLY by a value-level
    // constraint (`minLength: 3`) TypeScript's z.infer cannot see, so the
    // pair still compiles under the compile-time check (both infer `string`) — but the
    // projected JSON Schema is NOT byte-identical, so the identity rule
    // cannot fire, and the opaque `allOf` keyword must still
    // surface the refusal. Width subtyping (the child adding "note") must
    // not mask it either. Two string schemas, because the projection merges
    // an intersection of two object schemas into one comparable object.
    const Child = defineNode("Child", {
      schema: z.object({
        tag: z.intersection(z.string().min(3), z.string().max(10)),
        note: z.string(),
      }),
    });
    const Parent = defineNode("Parent", {
      schema: z.object({
        tag: z.intersection(z.string(), z.string().max(10)),
      }),
    });

    let caught: unknown;
    try {
      buildKindRegistry(
        defineGraph({
          id: "subclass_opaque",
          nodes: { Child: { type: Child }, Parent: { type: Parent } },
          edges: {},
          ontology: [subClassOf(Child, Parent)],
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).details["code"]).toBe(
      "ONTOLOGY_SUBCLASS_SCHEMA_INCOMPARABLE",
    );
  });

  it("accepts a child that copies a recursive/intersection parent property VERBATIM and adds a field", () => {
    // A schema is trivially a subtype of itself regardless of which
    // keywords it carries — including `$ref` (recursive z.lazy) and `allOf`
    // (z.intersection), which the structural-subtype predicate otherwise
    // cannot judge at all. Before the fix, compareSchemas ran the
    // $ref/unmodeled guards BEFORE the identity shortcut, so this pair was
    // refused as SCHEMA_INCOMPARABLE even though the child copies the
    // parent's property verbatim.
    const sharedIntersection = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.string() }),
    );
    interface RecursiveTree {
      readonly children: readonly RecursiveTree[];
    }
    const sharedRecursive: z.ZodType<RecursiveTree> = z.lazy(() =>
      z.object({ children: z.array(sharedRecursive) }),
    );

    const IntersectionParent = defineNode("IntersectionParent", {
      schema: z.object({ tag: sharedIntersection }),
    });
    const IntersectionChild = defineNode("IntersectionChild", {
      schema: z.object({ tag: sharedIntersection, note: z.string() }),
    });
    const RecursiveParent = defineNode("RecursiveParent", {
      schema: z.object({ tree: sharedRecursive }),
    });
    const RecursiveChild = defineNode("RecursiveChild", {
      schema: z.object({ tree: sharedRecursive, note: z.string() }),
    });

    const registry = buildKindRegistry(
      defineGraph({
        id: "subclass_verbatim_copy",
        nodes: {
          IntersectionParent: { type: IntersectionParent },
          IntersectionChild: { type: IntersectionChild },
          RecursiveParent: { type: RecursiveParent },
          RecursiveChild: { type: RecursiveChild },
        },
        edges: {},
        ontology: [
          subClassOf(IntersectionChild, IntersectionParent),
          subClassOf(RecursiveChild, RecursiveParent),
        ],
      }),
    );
    expect(
      registry.isAssignableTo("IntersectionChild", "IntersectionParent"),
    ).toBe(true);
    expect(registry.isAssignableTo("RecursiveChild", "RecursiveParent")).toBe(
      true,
    );
  });

  it("orders violations in stable compareCodePoints order, astral names included", () => {
    // U+10000 sorts ABOVE any BMP character in code-point order but BELOW
    // most BMP characters in UTF-16 code-UNIT order — a real ordering
    // divergence, not a coincidence.
    const AstralKind = "\u{10000}Astral";
    const Astral = defineNode(AstralKind, {
      schema: z.object({ code: z.string() }),
    });
    const Bmp = defineNode("BmpOnly", {
      schema: z.object({ code: z.string() }),
    });
    // Both children fail against a strict target so both are violations;
    // the registry itself only surfaces the FIRST in code-point order via
    // its top-level `childKind`.
    const Target = defineNode("StrictTarget", {
      schema: z.object({ code: z.string().min(5) }),
    });

    let caught: unknown;
    try {
      buildKindRegistry(
        defineGraph({
          id: "subclass_ordering",
          nodes: {
            [AstralKind]: { type: Astral },
            BmpOnly: { type: Bmp },
            StrictTarget: { type: Target },
          },
          edges: {},
          ontology: [subClassOf(Astral, Target), subClassOf(Bmp, Target)],
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    // "BmpOnly" < "\u{10000}Astral" in code-point order (BMP code points are
    // numerically smaller than any astral code point).
    expect((caught as ConfigurationError).details["childKind"]).toBe("BmpOnly");
  });
});

describe("registry check — equivalentTo refused in the failing direction only", () => {
  it("refuses the direction whose schema is not a structural subtype, with the equivalence code", () => {
    // X requires a tighter constraint than Y; X -> Y holds (X asks more),
    // Y -> X does not (a short Y-valid string fails X's bound).
    const X = defineNode("X", {
      schema: z.object({ a: z.string().min(3) }),
    });
    const Y = defineNode("Y", {
      schema: z.object({ a: z.string() }),
    });

    let caught: unknown;
    try {
      buildKindRegistry(
        defineGraph({
          id: "equivalence_direction",
          nodes: { X: { type: X }, Y: { type: Y } },
          edges: {},
          ontology: [equivalentTo(X, Y)],
        }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigurationError);
    const configError = caught as ConfigurationError;
    expect(configError.details["code"]).toBe(
      "ONTOLOGY_EQUIVALENCE_NOT_STRUCTURAL_SUBTYPE",
    );
    expect(configError.details["childKind"]).toBe("Y");
    expect(configError.details["parentKind"]).toBe("X");
    expect(configError.details["viaEquivalence"]).toBe(true);
  });
});

describe("registry check — deserialized documents are checked identically to live graphs", () => {
  it("refuses a persisted document carrying an incompatible subClassOf", () => {
    const Loose = defineNode("Loose", {
      schema: z.object({ code: z.string() }),
    });
    const Tight = defineNode("Tight", {
      schema: z.object({ code: z.string().min(5) }),
    });
    const graph = defineGraph({
      id: "subclass_persisted",
      nodes: { Loose: { type: Loose }, Tight: { type: Tight } },
      edges: {},
      // Bypass buildKindRegistry (which would refuse at defineGraph-adjacent
      // build time) by serializing a graph with no ontology, then hand-
      // crafting the persisted relation the way an older, laxer validator
      // could have written it.
      ontology: [],
    });
    const serialized = serializeSchema(graph, 1);
    const withIncompatibleRelation = {
      ...serialized,
      ontology: {
        ...serialized.ontology,
        relations: [
          ...serialized.ontology.relations,
          { metaEdge: "subClassOf", from: "Loose", to: "Tight" },
        ],
      },
    };

    expect(() =>
      deserializeSchema(withIncompatibleRelation).buildRegistry(),
    ).toThrow(ConfigurationError);
  });
});

describe("registry check — evolve() checks an authored extension before any write", () => {
  it("refuses an extension declaring an incompatible child, before the store accepts the kind", async () => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const baseGraph = defineGraph({
      id: "evolve_incompatible_child",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const extension = defineGraphExtension({
      nodes: {
        Base: { properties: { code: { type: "string", minLength: 5 } } },
        Derived: { properties: { code: { type: "string" } } },
      },
      ontology: [{ metaEdge: "subClassOf", from: "Derived", to: "Base" }],
    });

    await expect(store.evolve(extension)).rejects.toThrow(ConfigurationError);
    // No partial write: the extension kind never became reachable.
    expect(store.getNodeCollection("Derived")).toBeUndefined();
  });

  it("refuses evolve() redeclaring an existing kind so it stops extending its parent", async () => {
    const Media = defineNode("Media", {
      schema: z.object({ title: z.string().min(3) }),
    });
    const baseGraph = defineGraph({
      id: "evolve_redeclare_breaks_parent",
      nodes: { Media: { type: Media } },
      edges: {},
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    // First evolve declares a compatible Podcast subclass.
    const compatibleExtension = defineGraphExtension({
      nodes: {
        Podcast: {
          properties: {
            title: { type: "string", minLength: 3 },
            rssUrl: { type: "string" },
          },
        },
      },
      ontology: [{ metaEdge: "subClassOf", from: "Podcast", to: "Media" }],
    });
    const evolved = await store.evolve(compatibleExtension);
    expect(evolved.getNodeCollection("Podcast")).toBeDefined();

    // Redeclaring Podcast with a looser title breaks the already-declared
    // subClassOf(Podcast, Media) — refused, even though nothing about the
    // relation itself changed.
    const breakingExtension = defineGraphExtension({
      nodes: {
        Podcast: {
          properties: {
            title: { type: "string" },
            rssUrl: { type: "string" },
          },
        },
      },
      ontology: [{ metaEdge: "subClassOf", from: "Podcast", to: "Media" }],
    });

    await expect(evolved.evolve(breakingExtension)).rejects.toThrow(
      ConfigurationError,
    );
  });
});

/** Pinned before per-field comparison existed: it must never move. */
const PERSISTED_EMBEDDING_KIND_PROJECTION = JSON.stringify({ type: "object" });
const PERSISTED_EMBEDDING_GRAPH_HASH = "061d57c95847595f";

/** The `ConfigurationError` a registry build throws, or `undefined` when it builds. */
function registryRefusal(graph: GraphDef): ConfigurationError | undefined {
  try {
    buildKindRegistry(graph);
    return undefined;
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
}

describe("registry check — a field the projection cannot convert is accepted unjudged, every other field is still compared", () => {
  // `z.toJSONSchema` has no spelling for `embedding()` (a `z.custom()`),
  // `z.date()`, `z.set()`, `z.map()`, `z.bigint()` or a `.transform()`. A
  // live graph's comparison projection marks each such node on its own, so
  // that node is accepted without a verdict while its siblings are judged.
  it("refuses a subclass that adds embedding() when an unrelated field is incompatible", () => {
    const Tight = defineNode("Tight", {
      schema: z.object({ code: z.string().min(5) }),
    });
    const Embedded = defineNode("Embedded", {
      schema: z.object({ code: z.string(), vector: embedding(3) }),
    });

    const refusal = registryRefusal(
      defineGraph({
        id: "subclass_embedding_with_mismatch",
        nodes: { Tight: { type: Tight }, Embedded: { type: Embedded } },
        edges: {},
        ontology: [subClassOf(Embedded, Tight)],
      }),
    );

    expect(refusal?.details["code"]).toBe(
      "ONTOLOGY_SUBCLASS_NOT_STRUCTURAL_SUBTYPE",
    );
    expect(refusal?.details["childKind"]).toBe("Embedded");
    expect(refusal?.details["parentKind"]).toBe("Tight");
    expect(refusal?.details["reason"]).toBe("string-length-not-tighter");
    expect(refusal?.details["path"]).toEqual(["code"]);
  });

  it("refuses a live pair whose incompatibility sits beside a z.set() field both sides declare", () => {
    const SetChildLive = defineNode("SetChildLive", {
      schema: z.object({ code: z.string(), tags: z.set(z.string()) }),
    });
    const SetParentLive = defineNode("SetParentLive", {
      schema: z.object({
        code: z.string().min(5),
        tags: z.set(z.string()),
      }),
    });

    const refusal = registryRefusal(
      defineGraph({
        id: "subclass_set_with_mismatch",
        nodes: {
          SetChildLive: { type: SetChildLive },
          SetParentLive: { type: SetParentLive },
        },
        edges: {},
        ontology: [subClassOf(SetChildLive, SetParentLive)],
      }),
    );

    expect(refusal?.details["reason"]).toBe("string-length-not-tighter");
    expect(refusal?.details["path"]).toEqual(["code"]);
  });

  it("refuses a nested object holding an opaque field beside an incompatible sibling", () => {
    const Parent = defineNode("Parent", {
      schema: z.object({
        details: z.object({ at: z.date(), code: z.string().min(5) }),
      }),
    });
    const Child = defineNode("Child", {
      schema: z.object({
        details: z.object({ at: z.date(), code: z.string() }),
      }),
    });

    const refusal = registryRefusal(
      defineGraph({
        id: "subclass_nested_opaque_with_mismatch",
        nodes: { Parent: { type: Parent }, Child: { type: Child } },
        edges: {},
        ontology: [subClassOf(Child, Parent)],
      }),
    );

    expect(refusal?.details["reason"]).toBe("string-length-not-tighter");
    expect(refusal?.details["path"]).toEqual(["details", "code"]);
  });

  it("accepts independently declared z.date() fields on both sides", () => {
    const Event = defineNode("Event", {
      schema: z.object({ title: z.string(), at: z.date() }),
    });
    const Meeting = defineNode("Meeting", {
      schema: z.object({
        title: z.string().min(1),
        at: z.date(),
        room: z.string(),
      }),
    });

    const graph = defineGraph({
      id: "subclass_independent_dates",
      nodes: { Event: { type: Event }, Meeting: { type: Meeting } },
      edges: {},
      ontology: [subClassOf(Meeting, Event)],
    });

    expect(registryRefusal(graph)).toBeUndefined();
    expect(buildKindRegistry(graph).isAssignableTo("Meeting", "Event")).toBe(
      true,
    );
  });

  it("accepts a subclass that redeclares a parent's plain field through a .transform()", () => {
    const Tagged = defineNode("Tagged", {
      schema: z.object({ label: z.string().min(2) }),
    });
    const Normalized = defineNode("Normalized", {
      schema: z.object({
        label: z.string().transform((value) => value.trim()),
      }),
    });

    expect(
      registryRefusal(
        defineGraph({
          id: "subclass_transform_redeclaration",
          nodes: { Tagged: { type: Tagged }, Normalized: { type: Normalized } },
          edges: {},
          ontology: [subClassOf(Normalized, Tagged)],
        }),
      ),
    ).toBeUndefined();
  });

  // Only the CHILD holds an unprojectable field, and nothing else differs.
  const UNPROJECTABLE_FIELDS = {
    embedding: () => embedding(3),
    "optional embedding": () => embedding(3).optional(),
    "z.set": () => z.set(z.string()),
    "z.map": () => z.map(z.string(), z.number()),
    "z.date": () => z.date(),
    "z.bigint": () => z.bigint(),
    transform: () => z.string().transform((value) => value.length),
  } as const;

  const PROJECTABLE_PARENTS = {
    "a required property": () => z.object({ title: z.string() }),
    "an optional property": () => z.object({ title: z.string().optional() }),
  } as const;

  for (const [parentLabel, parentSchema] of Object.entries(
    PROJECTABLE_PARENTS,
  )) {
    for (const [fieldLabel, field] of Object.entries(UNPROJECTABLE_FIELDS)) {
      it(`accepts a subclass adding ${fieldLabel} under a parent with ${parentLabel}`, () => {
        const Document = defineNode("Document", { schema: parentSchema() });
        const Article = defineNode("Article", {
          schema: z.object({
            title: z.string(),
            body: z.string(),
            extra: field(),
          }),
        });
        const graph = defineGraph({
          id: "subclass_unprojectable_child",
          nodes: { Document: { type: Document }, Article: { type: Article } },
          edges: {},
          ontology: [subClassOf(Article, Document)],
        });

        expect(registryRefusal(graph)).toBeUndefined();
        // The persisted document reaches the same verdict as the live graph.
        expect(() =>
          deserializeSchema(serializeSchema(graph, 1)).buildRegistry(),
        ).not.toThrow();
      });
    }
  }

  it("accepts an equivalentTo pair when one side holds an unprojectable field", () => {
    const Plain = defineNode("Plain", {
      schema: z.object({ title: z.string() }),
    });
    const Dated = defineNode("Dated", {
      schema: z.object({ title: z.string(), at: z.date().optional() }),
    });

    expect(
      registryRefusal(
        defineGraph({
          id: "equivalence_unprojectable_side",
          nodes: { Plain: { type: Plain }, Dated: { type: Dated } },
          edges: {},
          ontology: [equivalentTo(Plain, Dated)],
        }),
      ),
    ).toBeUndefined();
  });

  it("opens a store whose subclass adds an embedding to its parent", async () => {
    const Content = defineNode("Content", {
      schema: z.object({ title: z.string(), createdBy: z.string() }),
    });
    const Document = defineNode("Document", {
      schema: z.object({
        title: z.string(),
        createdBy: z.string(),
        embedding: embedding(8).optional(),
      }),
    });
    const [store] = await createStoreWithSchema(
      defineGraph({
        id: "subclass_embedding_store",
        nodes: { Content: { type: Content }, Document: { type: Document } },
        edges: {},
        ontology: [subClassOf(Document, Content)],
      }),
      createTestBackend(),
    );

    await store.nodes.Document.create({ title: "Spec", createdBy: "ada" });
    const contents = await store
      .query()
      .from("Content", "content")
      .select((context) => context.content)
      .execute();
    expect(contents.map((content) => content.kind)).toEqual(["Document"]);
  });

  // The per-field markers exist only in the comparison input: the persisted
  // projection of a kind holding embedding() is still the whole-kind
  // placeholder, so neither the stored document nor its hash moves.
  it("leaves the persisted projection and the schema hash of a kind with embedding() unchanged", async () => {
    const Content = defineNode("Content", {
      schema: z.object({ title: z.string() }),
    });
    const Document = defineNode("Document", {
      schema: z.object({ title: z.string(), embedding: embedding(4) }),
    });
    const graph = defineGraph({
      id: "subclass_embedding_hash",
      nodes: { Content: { type: Content }, Document: { type: Document } },
      edges: {},
      ontology: [subClassOf(Document, Content)],
    });

    buildKindRegistry(graph);
    const serialized = serializeSchema(graph, 1);

    expect(JSON.stringify(serialized.nodes["Document"]?.properties)).toBe(
      PERSISTED_EMBEDDING_KIND_PROJECTION,
    );
    expect(await computeSchemaHash(serialized)).toBe(
      PERSISTED_EMBEDDING_GRAPH_HASH,
    );
  });
});

describe("registry check — a persisted document compares an unprojectable kind as a whole", () => {
  // A deserialized document has no Zod schema, only the persisted
  // projection, and a kind holding a construct `z.toJSONSchema` cannot
  // convert is persisted as the whole-kind placeholder. There is nothing to
  // compare, so a pair with such a kind on either side is skipped. This
  // pair is genuinely incompatible (Parent requires a "tags" set the Child
  // does not declare) and is accepted. The compile-time check would refuse
  // it, so it reaches the registry through a hand-assembled document, the
  // way an older, laxer validator could have written it.
  it("does not refuse a persisted subClassOf pair that differs only inside a z.set()/z.map() field", () => {
    const SetChild = defineNode("SetChild", {
      schema: z.object({ note: z.string() }),
    });
    const SetParent = defineNode("SetParent", {
      schema: z.object({ note: z.string(), tags: z.set(z.string()) }),
    });
    const graph = defineGraph({
      id: "subclass_unconvertible_gap",
      nodes: { SetChild: { type: SetChild }, SetParent: { type: SetParent } },
      edges: {},
      ontology: [],
    });
    const serialized = serializeSchema(graph, 1);
    const withUnconvertibleRelation = {
      ...serialized,
      ontology: {
        ...serialized.ontology,
        relations: [
          ...serialized.ontology.relations,
          { metaEdge: "subClassOf", from: "SetChild", to: "SetParent" },
        ],
      },
    };

    expect(() =>
      deserializeSchema(withUnconvertibleRelation).buildRegistry(),
    ).not.toThrow();
  });
});
