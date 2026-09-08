/**
 * C.2 — the registry-build-time structural subsumption check.
 *
 * C.1 (compile time) refuses everything TypeScript's structural
 * assignability over `z.infer` can see; it is blind to value-level
 * constraints (`z.string().min(3)` tightening a bare `z.string()`), so most
 * fixtures here deliberately construct pairs that are TYPE-compatible (so
 * `subClassOf`/`equivalentTo` compiles) but VALUE-level incompatible — the
 * "C.1 accepts strictly more than C.2 refuses" gap the roadmap names in
 * §1.3, and exactly the case only the runtime check can catch.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, equivalentTo, subClassOf } from "../src";
import { ConfigurationError } from "../src/errors";
import { defineGraphExtension } from "../src/graph-extension";
import { buildKindRegistry } from "../src/registry/builders";
import { deserializeSchema, serializeSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

describe("C.2 — subClassOf refused when the child is not a structural subtype", () => {
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
    const sharedField = z.intersection(
      z.object({ a: z.string() }),
      z.object({ b: z.string() }),
    );
    // The child adds an unrelated property so the two schemas are NOT
    // identical overall — otherwise `isStructuralSubtype`'s top-level
    // reflexivity fast path would return "subtype" without ever descending
    // into `tag` to find the unmodeled `allOf`. Width subtyping (the child
    // adding a property) must still surface the opaque field's refusal.
    const Child = defineNode("Child", {
      schema: z.object({ tag: sharedField, note: z.string() }),
    });
    const Parent = defineNode("Parent", {
      schema: z.object({ tag: sharedField }),
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

describe("C.2 — equivalentTo refused in the failing direction only", () => {
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

describe("C.2 — deserialized documents are checked identically to live graphs", () => {
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

describe("C.2 — evolve() checks an authored extension before any write", () => {
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
