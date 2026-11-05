/**
 * A composition relation's `partSide` is persisted only when it decides
 * something: a side the realizing edge's endpoints already fix serializes,
 * hashes and diffs like an omitted one, while a side the edge admits both
 * ways is kept.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import { createTestBackend } from "./test-utils";

const Chapter = defineNode("PartSideChapter", { schema: z.object({}) });
const Book = defineNode("PartSideBook", { schema: z.object({}) });
const chapterOf = defineEdge("partSideChapterOf", { schema: z.object({}) });

function chapterGraph(partSide: "omitted" | "from") {
  return defineGraph({
    id: "composition_part_side_redundant",
    nodes: { PartSideChapter: { type: Chapter }, PartSideBook: { type: Book } },
    edges: {
      partSideChapterOf: {
        type: chapterOf,
        from: [Chapter],
        to: [Book],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(Chapter, Book, {
        via: chapterOf,
        ...(partSide === "from" ? { partSide: "from" as const } : {}),
      }),
    ],
  });
}

const Section = defineNode("PartSideSection", { schema: z.object({}) });
const sectionOf = defineEdge("partSideSectionOf", { schema: z.object({}) });

function sectionGraph(partSide: "from" | "to") {
  return defineGraph({
    id: "composition_part_side_decisive",
    nodes: { PartSideSection: { type: Section } },
    edges: {
      partSideSectionOf: {
        type: sectionOf,
        from: [Section],
        to: [Section],
        cardinality: partSide === "from" ? "one" : "many",
        targetCardinality: partSide === "to" ? "one" : "many",
      },
    },
    ontology: [partOf(Section, Section, { via: sectionOf, partSide })],
  });
}

function serializedPartSides(
  graph: Parameters<typeof serializeSchema>[0],
): readonly (string | undefined)[] {
  return serializeSchema(graph, 1).ontology.relations.map(
    (relation) => relation.partSide,
  );
}

describe("composition partSide in the schema document", () => {
  it("serializes a partSide the realizing edge already decides like an omitted one", async () => {
    expect(serializedPartSides(chapterGraph("from"))).toEqual([undefined]);
    expect(
      await computeSchemaHash(serializeSchema(chapterGraph("from"), 1)),
    ).toBe(
      await computeSchemaHash(serializeSchema(chapterGraph("omitted"), 1)),
    );
  });

  it("reopens unchanged when only a redundant partSide is spelled out", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(chapterGraph("omitted"), backend);

    const [, spelledOut] = await createStoreWithSchema(
      chapterGraph("from"),
      backend,
    );
    const [, omittedAgain] = await createStoreWithSchema(
      chapterGraph("omitted"),
      backend,
    );

    expect(spelledOut.status).toBe("unchanged");
    expect(omittedAgain.status).toBe("unchanged");
  });

  it("keeps a partSide that decides a same-kind composition", () => {
    expect(serializedPartSides(sectionGraph("from"))).toEqual(["from"]);
    expect(serializedPartSides(sectionGraph("to"))).toEqual(["to"]);
  });
});
