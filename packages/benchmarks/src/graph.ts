import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  inverseOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    city: z.string(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({
    title: z.string(),
  }),
});

const follows = defineEdge("follows");
const authored = defineEdge("authored");
const nextEdge = defineEdge("next");

export const perfGraph = defineGraph({
  id: "perf_sanity",
  nodes: {
    User: { type: User },
    Post: { type: Post },
  },
  edges: {
    follows: {
      type: follows,
      from: [User],
      to: [User],
      cardinality: "many",
    },
    authored: {
      type: authored,
      from: [User],
      to: [Post],
      cardinality: "many",
    },
    next: {
      type: nextEdge,
      from: [User],
      to: [User],
      cardinality: "many",
    },
  },
  ontology: [inverseOf(nextEdge, nextEdge)],
});

export type PerfStore = ReturnType<typeof createStore<typeof perfGraph>>;
