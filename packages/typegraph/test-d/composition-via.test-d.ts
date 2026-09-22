/**
 * `via` as an edge type checks attachment props and types composition reads.
 * A kind string stays unchecked at compile time.
 */
import { expectError } from "tsd";
import { z } from "zod";

import { type Store, defineEdge, defineGraph, defineNode, partOf } from "..";

const Episode = defineNode("Episode", {
  schema: z.object({ title: z.string() }),
});
const Show = defineNode("Show", { schema: z.object({ name: z.string() }) });
const episodeOf = defineEdge("episodeOf", {
  schema: z.object({ season: z.number() }),
  from: [Episode],
  to: [Show],
});

const graph = defineGraph({
  id: "typed-via",
  nodes: { Episode: { type: Episode }, Show: { type: Show } },
  edges: {
    episodeOf: {
      type: episodeOf,
      from: [Episode],
      to: [Show],
      cardinality: "one",
    },
  },
  ontology: [partOf(Episode, Show, { via: episodeOf })],
});

declare const store: Store<typeof graph>;
declare const episodeId: string;

expectError(
  store.nodes.Episode.create(
    { title: "one" },
    {
      partOf: {
        kind: "Show",
        id: "show",
        via: episodeOf,
        props: { season: "nope" },
      },
    },
  ),
);

store.nodes.Episode.create(
  { title: "one" },
  {
    partOf: { kind: "Show", id: "show", via: episodeOf, props: { season: 1 } },
  },
);

store.nodes.Episode.create(
  { title: "one" },
  {
    partOf: {
      kind: "Show",
      id: "show",
      via: "episodeOf",
      props: { season: "unchecked" },
    },
  },
);

expectError(
  store.nodes.Episode.reparent(episodeId as never, {
    kind: "Show",
    id: "show",
    via: episodeOf,
    props: { season: "nope" },
  }),
);
