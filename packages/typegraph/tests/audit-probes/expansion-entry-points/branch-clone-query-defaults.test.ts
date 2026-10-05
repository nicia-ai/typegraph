import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, subClassOf } from "../../../src";
import { branch } from "../../../src/graph-merge/branch";
import { unwrap } from "../../../src/graph-merge/result";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Media = defineNode("Media", { schema: z.object({ title: z.string() }) });
const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});
const graph = defineGraph({
  id: "audit_branch_clone_query_defaults",
  nodes: { Media: { type: Media }, Podcast: { type: Podcast } },
  edges: {},
  ontology: [subClassOf(Podcast, Media)],
});

describe("expansion-entry-points", () => {
  // createStore(..., { queryDefaults: { expansion: "exact" } }) is the one place
  // a store opts out of polymorphic aliases. branch()'s default clone strategy
  // opens the working copy with only revisionTracking, so the same query
  // returns different rows on the branch store than on the store it forked.
  it("branch-clone-drops-query-defaults", async () => {
    const [base] = await createStoreWithSchema(graph, createTestBackend(), {
      queryDefaults: { expansion: "exact" },
    });
    await base.nodes.Media.create({ title: "plain" });
    await base.nodes.Podcast.create({ title: "cast", rssUrl: "u" });

    const forked = unwrap(await branch(base, async () => createTestBackend()));
    try {
      const kindsOn = async (store: typeof base) =>
        (
          await store
            .query()
            .from("Media", "m")
            .select((ctx) => ctx.m.kind)
            .execute()
        ).toSorted();

      expect(await kindsOn(base)).toEqual(["Media"]);
      expect(await kindsOn(forked.store)).toEqual(["Media"]);
    } finally {
      await forked.close();
    }
  });
});
