import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  inverseOf,
  searchable,
} from "@nicia-ai/typegraph";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    city: z.string(),
    bio: z.string(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({
    title: z.string(),
    body: z.string(),
  }),
});

export const EMBEDDING_DIMENSIONS = 384;

/**
 * Dedicated node kind for search-shape benchmarks. Keeping `Doc` separate
 * from `User`/`Post` means adding fulltext and embedding fields doesn't
 * change the measurements of the original shapes.
 */
const Doc = defineNode("Doc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    category: z.string(),
    embedding: embedding(EMBEDDING_DIMENSIONS),
  }),
});

const follows = defineEdge("follows");
const authored = defineEdge("authored");
const nextEdge = defineEdge("next");

/**
 * Expression index on `User.city` with `name` as a covering field.
 *
 * Seeded data splits users across two cities (1/3 San Francisco, 2/3
 * New York), so filter-by-city returns hundreds of rows. With the covering
 * field, smart-select queries that touch `name` can be satisfied as
 * index-only scans. Paired with `perfTables` in backend setup.
 */
const userCityIndex = defineNodeIndex(User, {
  fields: ["city"],
  coveringFields: ["name"],
});

export const perfIndexes = [userCityIndex];

export const perfGraph = defineGraph({
  id: "perf_sanity",
  nodes: {
    User: { type: User },
    Post: { type: Post },
    Doc: { type: Doc },
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
