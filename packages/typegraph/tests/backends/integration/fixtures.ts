import { z } from "zod";

import type { createStore } from "../../../src";
import {
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
  embedding,
  searchable,
} from "../../../src";

/**
 * Test graph definition used across all backend integration tests.
 */
const Product = defineNode("Product", {
  schema: z.object({
    name: z.string(),
    price: z.number(),
    category: z.string(),
    inStock: z.boolean().optional(),
    rating: z.number().optional(),
  }),
});

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number().optional(),
    email: z.string().optional(),
    isActive: z.boolean().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

/**
 * Document node for testing array and object predicates.
 */
const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    publishedAt: z.date().optional(),
    tags: z.array(z.string()).optional(),
    scores: z.array(z.number()).optional(),
    metadata: z
      .object({
        author: z.string().optional(),
        // Nullable so pointer-predicate tests can pin the JSON-null case.
        reviewer: z.string().nullable().optional(),
        version: z.number().optional(),
        flags: z
          .object({
            published: z.boolean().optional(),
            archived: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
  }),
});

/**
 * Article node for testing fulltext and hybrid search. Carries
 * `searchable()` fields plus an optional embedding so the same fixture
 * exercises both relevance paths on backends that support them.
 */
const Article = defineNode("Article", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    category: z.string(),
    published: z.boolean(),
    embedding: embedding(4).optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    salary: z.number().optional(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string().optional(),
    // Nullable so weighted-traversal tests can pin the JSON-null case.
    weight: z.number().nullable().optional(),
  }),
});

/**
 * Declared node indexes exercised by the `bulkFindByIndex` suite. Names are
 * stable so tests can reference them. These are declared but not materialized
 * by the shared store factory — `bulkFindByIndex` is correct either way.
 */
const productCategoryIndex = defineNodeIndex(Product, {
  name: "product_category",
  fields: ["category"],
});

const productCategoryInStockIndex = defineNodeIndex(Product, {
  name: "product_category_in_stock",
  fields: ["category"],
  where: (w) => w.inStock.eq(true),
});

const personActiveNameIndex = defineNodeIndex(Person, {
  name: "person_active_name",
  fields: ["isActive", "name"],
});

const documentAuthorIndex = defineNodeIndex(Document, {
  name: "document_author",
  fields: [["metadata", "author"] as const],
});

// Date-typed key — bulkFindByIndex rejects this (no cross-backend parity).
const documentPublishedAtIndex = defineNodeIndex(Document, {
  name: "document_published_at",
  fields: ["publishedAt"],
});

// keySystemColumns-only covering index (index-only join coverage): it carries
// no prop `fields`, so bulkFindByIndex has nothing to probe by and rejects it.
const companyIdCoveringIndex = defineNodeIndex(Company, {
  name: "company_id_covering",
  keySystemColumns: ["id"],
  coveringFields: ["name"],
});

export const integrationTestGraph = defineGraph({
  id: "integration_test",
  nodes: {
    Product: { type: Product },
    Person: { type: Person },
    Company: { type: Company },
    Document: { type: Document },
    Article: { type: Article },
  },
  indexes: [
    productCategoryIndex,
    productCategoryInStockIndex,
    personActiveNameIndex,
    documentAuthorIndex,
    documentPublishedAtIndex,
    companyIdCoveringIndex,
  ],
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

type IntegrationTestGraph = typeof integrationTestGraph;
export type IntegrationStore = ReturnType<
  typeof createStore<IntegrationTestGraph>
>;
