/**
 * Composition relation declaration tests (item E, lane E-a).
 *
 * Covers the two families of composition checks:
 *  - shape checks, owned by `validateOntologyRelations`
 *    (`ONTOLOGY_COMPOSITION_VIA_REQUIRED` / `..._FORBIDDEN` /
 *    `..._PART_SIDE_FORBIDDEN`) — exercised directly against
 *    `validateOntologyRelations` with hand-built `NamedOntologyRelation`s,
 *    since `via` is a compile-time-required option on the `partOf`/`hasPart`
 *    factories and cannot be omitted through them.
 *  - registration-dependent checks, owned by `buildCompositionRelation`
 *    (orientation, cardinality, exactness, population) — exercised through
 *    `buildKindRegistry`, which is how every real caller reaches them.
 *
 * MUTATION CHECK (recorded in the lane's load-bearing note): each
 * `issues.push({ code: "ONTOLOGY_COMPOSITION_*", ... })` branch in
 * `src/ontology/validation.ts` and `src/registry/composition-relation.ts`
 * was deleted/commented in turn; exactly the one test naming that code
 * flipped from throwing to passing, and no other test in this file changed
 * outcome. Restored after each check.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, hasPart, partOf } from "../src";
import { validateOntologyRelations } from "../src/ontology/validation";
import { buildKindRegistry } from "../src/registry";
import { matchingObject } from "./test-utils";

const emptySchema = z.object({});

/** Asserts `fn` throws a `ConfigurationError` carrying exactly this composition code. */
function expectCompositionCode(fn: () => unknown, code: string): void {
  expect(fn).toThrow(
    expect.objectContaining({
      code: "CONFIGURATION_ERROR",
      details: matchingObject({ code }),
    }),
  );
}

// ============================================================
// Shape checks — validateOntologyRelations directly
// ============================================================

describe("composition shape checks (validateOntologyRelations)", () => {
  it("ONTOLOGY_COMPOSITION_VIA_REQUIRED: partOf/hasPart with no via", () => {
    const issues = validateOntologyRelations([
      { metaEdge: "partOf", from: "Part", to: "Whole" },
    ]);
    expect(issues.map((issue) => issue.code)).toContain(
      "ONTOLOGY_COMPOSITION_VIA_REQUIRED",
    );
  });

  it("ONTOLOGY_COMPOSITION_VIA_REQUIRED: hasPart with no via", () => {
    const issues = validateOntologyRelations([
      { metaEdge: "hasPart", from: "Whole", to: "Part" },
    ]);
    expect(issues.map((issue) => issue.code)).toContain(
      "ONTOLOGY_COMPOSITION_VIA_REQUIRED",
    );
  });

  it("ONTOLOGY_COMPOSITION_VIA_FORBIDDEN: a non-composition meta-edge carrying via", () => {
    const issues = validateOntologyRelations([
      { metaEdge: "subClassOf", from: "A", to: "B", via: "someEdge" },
    ]);
    expect(issues.map((issue) => issue.code)).toContain(
      "ONTOLOGY_COMPOSITION_VIA_FORBIDDEN",
    );
  });

  it("ONTOLOGY_COMPOSITION_PART_SIDE_FORBIDDEN: a non-composition meta-edge carrying partSide", () => {
    const issues = validateOntologyRelations([
      { metaEdge: "broader", from: "A", to: "B", partSide: "from" },
    ]);
    expect(issues.map((issue) => issue.code)).toContain(
      "ONTOLOGY_COMPOSITION_PART_SIDE_FORBIDDEN",
    );
  });

  it("accepts a well-formed partOf relation with via and no partSide", () => {
    const issues = validateOntologyRelations([
      { metaEdge: "partOf", from: "Part", to: "Whole", via: "realizes" },
    ]);
    expect(issues).toEqual([]);
  });
});

// ============================================================
// Registration-dependent checks — buildKindRegistry
// ============================================================

describe("composition registration checks (buildKindRegistry)", () => {
  const Part = defineNode("Part", { schema: emptySchema });
  const Whole = defineNode("Whole", { schema: emptySchema });
  const Other = defineNode("Other", { schema: emptySchema });

  it("ONTOLOGY_COMPOSITION_VIA_UNKNOWN: via names an unregistered edge kind", () => {
    const ghost = defineEdge("ghost", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-via-unknown",
      nodes: { Part: { type: Part }, Whole: { type: Whole } },
      edges: {},
      ontology: [partOf(Part, Whole, { via: ghost })],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_VIA_UNKNOWN",
    );
  });

  it("ONTOLOGY_COMPOSITION_VIA_ENDPOINTS: via's endpoints admit neither orientation", () => {
    const wrongEdge = defineEdge("wrongEdge", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-via-endpoints",
      nodes: {
        Part: { type: Part },
        Whole: { type: Whole },
        Other: { type: Other },
      },
      edges: {
        wrongEdge: {
          type: wrongEdge,
          from: [Other],
          to: [Other],
          cardinality: "one",
        },
      },
      ontology: [partOf(Part, Whole, { via: wrongEdge })],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_VIA_ENDPOINTS",
    );
  });

  it("ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED: an ambiguous same-kind edge with no declared partSide", () => {
    const Section = defineNode("Section", { schema: emptySchema });
    const containsSection = defineEdge("containsSection", {
      schema: emptySchema,
    });
    const graph = defineGraph({
      id: "composition-part-side-required",
      nodes: { Section: { type: Section } },
      edges: {
        containsSection: {
          type: containsSection,
          from: [Section],
          to: [Section],
          cardinality: "one",
        },
      },
      ontology: [partOf(Section, Section, { via: containsSection })],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED",
    );
  });

  it("builds a reflexive composition pair when partSide disambiguates it (§2.7)", () => {
    const Section = defineNode("Section", { schema: emptySchema });
    const containsSection = defineEdge("containsSection", {
      schema: emptySchema,
    });
    const graph = defineGraph({
      id: "composition-reflexive-ok",
      nodes: { Section: { type: Section } },
      edges: {
        containsSection: {
          type: containsSection,
          from: [Section],
          to: [Section],
          cardinality: "one",
        },
      },
      ontology: [
        partOf(Section, Section, {
          via: containsSection,
          partSide: "from",
        }),
      ],
    });
    const registry = buildKindRegistry(graph);
    expect(registry.isCompositionEdge("containsSection")).toBe(true);
    expect(registry.compositionPartSide("containsSection")).toBe("from");
  });

  it("ONTOLOGY_COMPOSITION_PART_SIDE_INVALID: a declared partSide contradicting the endpoints", () => {
    const Engine = defineNode("Engine", { schema: emptySchema });
    const Car = defineNode("Car", { schema: emptySchema });
    const installedIn = defineEdge("installedIn", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-part-side-invalid",
      nodes: { Engine: { type: Engine }, Car: { type: Car } },
      edges: {
        installedIn: {
          type: installedIn,
          from: [Engine],
          to: [Car],
          cardinality: "one",
        },
      },
      ontology: [partOf(Engine, Car, { via: installedIn, partSide: "to" })],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_PART_SIDE_INVALID",
    );
  });

  it("accepts a redundant-but-consistent declared partSide", () => {
    const Engine = defineNode("Engine", { schema: emptySchema });
    const Car = defineNode("Car", { schema: emptySchema });
    const installedIn = defineEdge("installedIn", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-part-side-redundant",
      nodes: { Engine: { type: Engine }, Car: { type: Car } },
      edges: {
        installedIn: {
          type: installedIn,
          from: [Engine],
          to: [Car],
          cardinality: "one",
        },
      },
      ontology: [partOf(Engine, Car, { via: installedIn, partSide: "from" })],
    });
    const registry = buildKindRegistry(graph);
    expect(registry.getCompositionEdge("Engine", "Car")).toEqual(
      matchingObject({ partSide: "from", population: "one" }),
    );
  });

  it("ONTOLOGY_COMPOSITION_CARDINALITY: via declares no constraining cardinality", () => {
    const weakLink = defineEdge("weakLink", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-cardinality",
      nodes: { Part: { type: Part }, Whole: { type: Whole } },
      edges: {
        weakLink: { type: weakLink, from: [Part], to: [Whole] },
      },
      ontology: [partOf(Part, Whole, { via: weakLink })],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_CARDINALITY",
    );
  });

  it("hasPart orientation: whole is `from`, fenced by targetCardinality", () => {
    const Wheel = defineNode("Wheel", { schema: emptySchema });
    const Bicycle = defineNode("Bicycle", { schema: emptySchema });
    const hasWheel = defineEdge("hasWheel", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-haspart-orientation",
      nodes: { Wheel: { type: Wheel }, Bicycle: { type: Bicycle } },
      edges: {
        hasWheel: {
          type: hasWheel,
          from: [Bicycle],
          to: [Wheel],
          targetCardinality: "one",
        },
      },
      ontology: [hasPart(Bicycle, Wheel, { via: hasWheel })],
    });
    const registry = buildKindRegistry(graph);
    expect(registry.compositionPartSide("hasWheel")).toBe("to");
    expect(registry.compositionPopulation("Wheel")).toBe("one");
    expect(registry.getCompositionEdge("Wheel", "Bicycle")).toEqual(
      matchingObject({ viaEdgeKind: "hasWheel", partSide: "to" }),
    );
  });

  it("ONTOLOGY_COMPOSITION_VIA_MIXED: the via edge admits a pair no relation declares", () => {
    const PartA = defineNode("PartA", { schema: emptySchema });
    const PartB = defineNode("PartB", { schema: emptySchema });
    const WholeX = defineNode("WholeX", { schema: emptySchema });
    const ownsItem = defineEdge("ownsItem", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-via-mixed",
      nodes: {
        PartA: { type: PartA },
        PartB: { type: PartB },
        WholeX: { type: WholeX },
      },
      edges: {
        ownsItem: {
          type: ownsItem,
          from: [WholeX],
          to: [PartA, PartB],
          targetCardinality: "one",
        },
      },
      // Only PartA is declared a composition pair; PartB is a legal
      // endpoint of `ownsItem` but not declared, so the edge is not
      // exclusively a composition edge.
      ontology: [hasPart(WholeX, PartA, { via: ownsItem })],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_VIA_MIXED",
    );
  });

  it("ONTOLOGY_COMPOSITION_VIA_MIXED: the same via edge realizes two orientations", () => {
    // `link`'s source-dependent target map admits (A -> B) and (C -> D). The
    // first declaration is only forward-compatible (A -> B); the second is
    // only reverse-compatible (whole C -> part D), so `link` ends up
    // realizing composition in two different orientations. There is no
    // dedicated check for this: recording the second declaration's pair
    // under the wrong global orientation is exactly what composition-
    // exactness (the general "every admitted pair is declared" check) also
    // catches, because the corrupted pair can no longer cover (A, B).
    const A = defineNode("A", { schema: emptySchema });
    const B = defineNode("B", { schema: emptySchema });
    const C = defineNode("C", { schema: emptySchema });
    const D = defineNode("D", { schema: emptySchema });
    const link = defineEdge("link", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-via-mixed-orientation",
      nodes: { A: { type: A }, B: { type: B }, C: { type: C }, D: { type: D } },
      edges: {
        link: {
          type: link,
          from: [A, C],
          to: { A: [B], C: [D] },
          cardinality: "one",
          targetCardinality: "one",
        },
      },
      ontology: [partOf(A, B, { via: link }), hasPart(C, D, { via: link })],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_VIA_MIXED",
    );
  });

  it("ONTOLOGY_COMPOSITION_POPULATION_MIXED: one part kind under edges with different populations", () => {
    const SharedPart = defineNode("SharedPart", { schema: emptySchema });
    const WholeOne = defineNode("WholeOne", { schema: emptySchema });
    const WholeTwo = defineNode("WholeTwo", { schema: emptySchema });
    const edgeOne = defineEdge("edgeOne", { schema: emptySchema });
    const edgeTwo = defineEdge("edgeTwo", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-population-mixed",
      nodes: {
        SharedPart: { type: SharedPart },
        WholeOne: { type: WholeOne },
        WholeTwo: { type: WholeTwo },
      },
      edges: {
        edgeOne: {
          type: edgeOne,
          from: [SharedPart],
          to: [WholeOne],
          cardinality: "one",
        },
        edgeTwo: {
          type: edgeTwo,
          from: [SharedPart],
          to: [WholeTwo],
          cardinality: "oneActive",
        },
      },
      ontology: [
        partOf(SharedPart, WholeOne, { via: edgeOne }),
        partOf(SharedPart, WholeTwo, { via: edgeTwo }),
      ],
    });
    expectCompositionCode(
      () => buildKindRegistry(graph),
      "ONTOLOGY_COMPOSITION_POPULATION_MIXED",
    );
  });
});

// ============================================================
// A valid multi-relation declaration
// ============================================================

describe("a valid multi-relation composition declaration", () => {
  const Podcast = defineNode("Podcast", { schema: emptySchema });
  const Episode = defineNode("Episode", { schema: emptySchema });
  const Segment = defineNode("Segment", { schema: emptySchema });
  const episodeOf = defineEdge("episodeOf", { schema: emptySchema });
  const segmentOf = defineEdge("segmentOf", { schema: emptySchema });

  const graph = defineGraph({
    id: "composition-multi-relation",
    nodes: {
      Podcast: { type: Podcast },
      Episode: { type: Episode },
      Segment: { type: Segment },
    },
    edges: {
      episodeOf: {
        type: episodeOf,
        from: [Episode],
        to: [Podcast],
        cardinality: "one",
      },
      segmentOf: {
        type: segmentOf,
        from: [Segment],
        to: [Episode],
        cardinality: "oneActive",
      },
    },
    ontology: [
      partOf(Episode, Podcast, { via: episodeOf }),
      partOf(Segment, Episode, { via: segmentOf }),
    ],
  });

  const registry = buildKindRegistry(graph);

  it("reports the expected pairs, edge-kind union, and orientation map", () => {
    const relation = registry.compositionRelation();
    expect(relation.pairs).toEqual([
      {
        partKind: "Episode",
        wholeKind: "Podcast",
        viaEdgeKind: "episodeOf",
        partSide: "from",
        population: "one",
      },
      {
        partKind: "Segment",
        wholeKind: "Episode",
        viaEdgeKind: "segmentOf",
        partSide: "from",
        population: "oneActive",
      },
    ]);
    expect(relation.edgeKinds).toEqual(new Set(["episodeOf", "segmentOf"]));
    expect(relation.partSideByEdgeKind).toEqual(
      new Map([
        ["episodeOf", "from"],
        ["segmentOf", "from"],
      ]),
    );
  });

  it("reaches across heterogeneous edge kinds transitively", () => {
    expect(registry.compositionEdgeKindsUnder("Podcast")).toEqual([
      "episodeOf",
      "segmentOf",
    ]);
    expect(registry.compositionEdgeKindsOver("Segment")).toEqual([
      "episodeOf",
      "segmentOf",
    ]);
  });
});
