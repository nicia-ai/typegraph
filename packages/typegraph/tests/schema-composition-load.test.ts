/**
 * R3 — a persisted `partOf`/`hasPart` relation with no `via` is refused ON
 * LOAD, through the same `validateOntologyRelations` path the compile-time
 * builder and the extension builder already share (item E, lane E-a).
 *
 * `deserializeSchema(schema).buildRegistry()` is the exact function every
 * schema loader (`createStoreWithSchema`, `ensureSchema`, `migrateSchema`)
 * calls to interpret a persisted document, so exercising it directly here
 * tests the real load-time refusal without standing up a backend.
 *
 * MUTATION CHECK (recorded in the lane's load-bearing note): removed the
 * `relation.via === undefined` arm from `validateCompositionShape`
 * (`src/ontology/validation.ts`) — "refuses persisted partOf with no via"
 * flipped from throwing to passing (an inert relation loaded clean); no
 * other test in this file changed outcome. Restored after the check.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  partOf,
} from "../src";
import { type AnyEdgeType } from "../src/core/types";
import { mergeGraphExtension } from "../src/graph-extension/merge";
import { buildKindRegistry } from "../src/registry";
import { deserializeSchema } from "../src/schema/deserializer";
import { computeSchemaDiff } from "../src/schema/migration";
import { serializeSchema } from "../src/schema/serializer";
import { matchingObject } from "./test-utils";

const emptySchema = z.object({});

describe("R3: a persisted composition relation missing `via` is refused on load", () => {
  it("refuses persisted partOf with no via", () => {
    const Part = defineNode("Part", { schema: emptySchema });
    const Whole = defineNode("Whole", { schema: emptySchema });
    const graph = defineGraph({
      id: "composition-load-refusal",
      nodes: { Part: { type: Part }, Whole: { type: Whole } },
      edges: {},
      ontology: [],
    });
    const schema = serializeSchema(graph, 1);
    // Splice in a `partOf` relation with no `via`, as a pre-`via` schema
    // (or a hand-edited document) would carry it.
    const brokenSchema = {
      ...schema,
      ontology: {
        ...schema.ontology,
        relations: [{ metaEdge: "partOf", from: "Part", to: "Whole" }],
      },
    };

    expect(() => deserializeSchema(brokenSchema).buildRegistry()).toThrow(
      expect.objectContaining({
        code: "CONFIGURATION_ERROR",
        details: matchingObject({ code: "ONTOLOGY_COMPOSITION_VIA_REQUIRED" }),
      }),
    );
  });

  it("refuses the same shape through the extension builder", () => {
    expect(() =>
      defineGraphExtension({
        nodes: {
          Part: { properties: { name: { type: "string" } } },
          Whole: { properties: { name: { type: "string" } } },
        },
        ontology: [{ metaEdge: "partOf", from: "Part", to: "Whole" }],
      }),
    ).toThrow(
      expect.objectContaining({
        details: matchingObject({
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "ONTOLOGY_COMPOSITION_VIA_REQUIRED",
            }),
          ]),
        }),
      }),
    );
  });
});

describe("a `via` change diffs as remove + add, not a no-op", () => {
  // Kind names deliberately contain the two delimiters the old
  // `${metaEdge}:${from}:${to}` join used — the fix (`encodeTupleKey`) must
  // never re-split a joined key to build the change message.
  const Part = defineNode("Pa:rt", { schema: emptySchema });
  const Whole = defineNode("Wh|ole", { schema: emptySchema });
  const edgeOld = defineEdge("edgeOld", { schema: emptySchema });
  const edgeNew = defineEdge("edgeNew", { schema: emptySchema });

  function graphWithVia(viaEdge: AnyEdgeType, edgeKind: string) {
    return defineGraph({
      id: "composition-via-change",
      nodes: { [Part.kind]: { type: Part }, [Whole.kind]: { type: Whole } },
      edges: {
        [edgeKind]: {
          type: viaEdge,
          from: [Part],
          to: [Whole],
          cardinality: "one" as const,
        },
      },
      ontology: [partOf(Part, Whole, { via: viaEdge })],
    });
  }

  it("reports the via change as one removed relation and one added relation", () => {
    const before = serializeSchema(graphWithVia(edgeOld, "edgeOld"), 1);
    const after = serializeSchema(graphWithVia(edgeNew, "edgeNew"), 2);

    const diff = computeSchemaDiff(before, after);
    const relationChanges = diff.ontology.filter(
      (change) => change.entity === "relation",
    );

    expect(relationChanges).toHaveLength(2);
    const removed = relationChanges.find((change) => change.type === "removed");
    const added = relationChanges.find((change) => change.type === "added");
    expect(removed?.details).toBe(
      'Relation partOf(Pa:rt, Wh|ole) via "edgeOld" was removed',
    );
    expect(added?.details).toBe(
      'Relation partOf(Pa:rt, Wh|ole) via "edgeNew" was added',
    );
  });
});

describe("`partSide` round-trips across representations (E-a-4)", () => {
  // `partSide` is the one composition field that cannot be re-derived on
  // load: it is only required (and only meaningful) for the ambiguous R5
  // shape (a reflexive pair whose realizing edge admits both orientations),
  // so a dropped copy is silent until the next load of exactly that shape,
  // where it turns a valid persisted graph into an
  // ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED refusal.
  //
  // MUTATION CHECK (recorded in the lane's load-bearing note): removed the
  // `relation.partSide === undefined ? {} : { partSide: relation.partSide }`
  // spread from `buildRegistryFromSerializedSchema`
  // (`src/schema/deserializer.ts`) — "round-trips through
  // deserializeSchema" flipped from passing to throwing
  // ONTOLOGY_COMPOSITION_PART_SIDE_REQUIRED; the extension-path case was
  // unaffected (it does not go through the deserializer). Restored after
  // the check.
  const Section = defineNode("Section", { schema: emptySchema });
  const parentSection = defineEdge("parentSection", { schema: emptySchema });

  it("round-trips through deserializeSchema", () => {
    const graph = defineGraph({
      id: "composition-partside-roundtrip",
      nodes: { Section: { type: Section } },
      edges: {
        parentSection: {
          type: parentSection,
          from: [Section],
          to: [Section],
          cardinality: "one",
        },
      },
      ontology: [
        partOf(Section, Section, { via: parentSection, partSide: "from" }),
      ],
    });

    const schema = serializeSchema(graph, 1);
    const registry = deserializeSchema(schema).buildRegistry();

    expect(registry.compositionPartSide("parentSection")).toBe("from");
    expect(registry.compositionRelation().pairs).toEqual([
      {
        partKind: "Section",
        wholeKind: "Section",
        viaEdgeKind: "parentSection",
        partSide: "from",
        population: "one",
      },
    ]);
  });

  it("round-trips through mergeGraphExtension", () => {
    const baseGraph = defineGraph({
      id: "composition-partside-roundtrip-extension",
      nodes: { Section: { type: Section } },
      edges: {},
      ontology: [],
    });
    const extension = defineGraphExtension({
      nodes: {},
      edges: {
        parentSection: {
          from: ["Section"],
          to: ["Section"],
          cardinality: "one",
          properties: {},
        },
      },
      ontology: [
        {
          metaEdge: "partOf",
          from: "Section",
          to: "Section",
          via: "parentSection",
          partSide: "from",
        },
      ],
    });

    const merged = mergeGraphExtension(baseGraph, extension);
    const registry = buildKindRegistry(merged);

    expect(registry.compositionPartSide("parentSection")).toBe("from");
    expect(registry.compositionRelation().pairs).toEqual([
      {
        partKind: "Section",
        wholeKind: "Section",
        viaEdgeKind: "parentSection",
        partSide: "from",
        population: "one",
      },
    ]);
  });
});
