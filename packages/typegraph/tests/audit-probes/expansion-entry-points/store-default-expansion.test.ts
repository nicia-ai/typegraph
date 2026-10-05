import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createQueryBuilder,
  defineGraph,
  defineNode,
  subClassOf,
} from "../../../src";
import { buildKindRegistry } from "../../../src/registry";
import { createStoreWithSchema } from "../../../src/store/store";
import { createTestBackend } from "../../test-utils";

const Media = defineNode("Media", { schema: z.object({ title: z.string() }) });
const Podcast = defineNode("Podcast", {
  schema: z.object({ title: z.string(), rssUrl: z.string() }),
});
const graph = defineGraph({
  id: "audit_store_default_expansion",
  nodes: { Media: { type: Media }, Podcast: { type: Podcast } },
  edges: {},
  ontology: [subClassOf(Podcast, Media)],
});

async function openStoreWithDefault(expansion: unknown) {
  const [store] = await createStoreWithSchema(graph, createTestBackend(), {
    queryDefaults: { expansion: expansion as never },
  });
  await store.nodes.Media.create({ title: "plain" });
  await store.nodes.Podcast.create({ title: "cast", rssUrl: "u" });
  return store;
}

async function refusalOf(attempt: () => Promise<unknown>): Promise<unknown> {
  try {
    await attempt();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("expansion-entry-points", () => {
  // queryDefaults.expansion is validated nowhere: an unknown value is stored
  // verbatim, flows into expandKindsForAxis, which returns undefined for it,
  // and the first from() crashes with a bare TypeError ("reading 'length'").
  // The per-alias option refuses the same value with QUERY_ALIAS_EXPANSION_INVALID.
  it("store-default-expansion-unknown-value", async () => {
    const storeRefusal = await refusalOf(async () => {
      const store = await openStoreWithDefault("bogus");
      await store.query().from("Media", "m").select((ctx) => ctx.m).execute();
    });
    expect.soft(storeRefusal).toBeInstanceOf(ConfigurationError);
    expect
      .soft(
        storeRefusal instanceof ConfigurationError ?
          storeRefusal.details["code"]
        : undefined,
      )
      .toBe("QUERY_ALIAS_EXPANSION_INVALID");

    const builderRefusal = await refusalOf(async () => {
      const builder = createQueryBuilder<typeof graph>(
        graph.id,
        buildKindRegistry(graph),
        { defaultExpansion: "bogus" as never },
      );
      builder.from("Media", "m");
    });
    expect.soft(builderRefusal).toBeInstanceOf(ConfigurationError);
  });

  // The store-wide default type deliberately excludes "narrower" (an untyped
  // axis must not become every alias's default). A JavaScript caller (or a
  // cast) who states it gets it silently applied instead of refused.
  it("store-default-expansion-narrower", async () => {
    const refusal = await refusalOf(async () => {
      const store = await openStoreWithDefault("narrower");
      await store.query().from("Media", "m").select((ctx) => ctx.m).execute();
    });
    expect(refusal).toBeInstanceOf(ConfigurationError);
  });
});
