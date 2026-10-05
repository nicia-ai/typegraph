import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, subClassOf } from "../../../src";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Media = defineNode("Media", { schema: z.object({ title: z.string() }) });
const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});
const Curator = defineNode("Curator", {
  schema: z.object({ name: z.string() }),
});
const curates = defineEdge("curates", { schema: z.object({}) });
const graph = defineGraph({
  id: "audit_paginate_traversal_fanout",
  nodes: {
    Media: { type: Media },
    Podcast: { type: Podcast },
    Curator: { type: Curator },
  },
  edges: { curates: { type: curates, from: [Curator], to: [Media] } },
  ontology: [subClassOf(Podcast, Media)],
});

describe("expansion-entry-points", () => {
  // The keyset cursor is (caller order keys, start-alias identity). A traversal
  // that fans out one start node into several result rows (the polymorphic
  // to() default makes that common) produces rows that tie on every cursor
  // column, so "rows after the cursor" skips every sibling of the last row on
  // the page. Walking all pages loses rows silently.
  it("paginate-fanout-skips-sibling-rows", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const curator = await store.nodes.Curator.create({ name: "c" });
    const titles = ["m1", "m2", "m3", "m4"];
    for (const title of titles) {
      const media = await store.nodes.Media.create({ title });
      await store.edges.curates.create(curator, media, {});
    }

    const seen: string[] = [];
    let after: string | undefined;
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const page = await store
        .query()
        .from("Curator", "c")
        .traverse("curates", "e")
        .to("Media", "m")
        .orderBy("c", "name", "asc")
        .select((ctx) => ctx.m.title)
        .paginate({ first: 2, ...(after === undefined ? {} : { after }) });
      seen.push(...page.data);
      if (page.nextCursor === undefined) break;
      after = page.nextCursor;
    }

    expect(seen.toSorted()).toEqual(titles);
  });
});
