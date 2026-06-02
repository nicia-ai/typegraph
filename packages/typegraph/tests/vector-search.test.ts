/**
 * Vector Search Tests
 *
 * Tests the embedding type, schema introspection, predicate builders,
 * and dialect adapter SQL generation for vector similarity search.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  getEmbeddingDimensions,
  isEmbeddingSchema,
} from "../src";
import { postgresDialect } from "../src/query/dialect/postgres";
import { sqliteDialect } from "../src/query/dialect/sqlite";
import { createSchemaIntrospector } from "../src/query/schema-introspector";

// ============================================================
// Embedding Type Tests
// ============================================================

describe("embedding type", () => {
  it("should create an embedding schema with dimensions", () => {
    const schema = embedding(1536);
    expect(isEmbeddingSchema(schema)).toBe(true);
    expect(getEmbeddingDimensions(schema)).toBe(1536);
  });

  it("should support different dimension sizes", () => {
    const small = embedding(384);
    const medium = embedding(768);
    const large = embedding(3072);

    expect(getEmbeddingDimensions(small)).toBe(384);
    expect(getEmbeddingDimensions(medium)).toBe(768);
    expect(getEmbeddingDimensions(large)).toBe(3072);
  });

  it("should throw for invalid dimensions", () => {
    expect(() => embedding(0)).toThrow();
    expect(() => embedding(-1)).toThrow();
    expect(() => embedding(1.5)).toThrow();
  });

  it("should validate embedding arrays correctly", () => {
    const schema = embedding(3);

    expect(schema.safeParse([1, 2, 3]).success).toBe(true);
    expect(schema.safeParse([0.1, 0.2, 0.3]).success).toBe(true);

    // Wrong length
    expect(schema.safeParse([1, 2]).success).toBe(false);
    expect(schema.safeParse([1, 2, 3, 4]).success).toBe(false);

    // Non-arrays
    expect(schema.safeParse("not an array").success).toBe(false);
    expect(schema.safeParse(123).success).toBe(false);

    // Invalid elements
    expect(schema.safeParse([1, "two", 3]).success).toBe(false);
    expect(schema.safeParse([1, Number.NaN, 3]).success).toBe(false);
    expect(schema.safeParse([1, Infinity, 3]).success).toBe(false);
  });

  it("should work with optional wrapper", () => {
    const schema = embedding(512).optional();

    // eslint-disable-next-line unicorn/no-useless-undefined -- Testing optional accepts undefined
    expect(schema.safeParse(undefined).success).toBe(true);
    expect(schema.safeParse(Array.from({ length: 512 }).fill(0)).success).toBe(
      true,
    );
    expect(schema.safeParse(Array.from({ length: 256 }).fill(0)).success).toBe(
      false,
    );
  });
});

// ============================================================
// Schema Introspection Tests
// ============================================================

describe("schema introspector with embeddings", () => {
  it("should detect embedding fields and their dimensions", () => {
    const Document = defineNode("Document", {
      schema: z.object({
        title: z.string(),
        embedding: embedding(1536),
      }),
    });

    const nodeKinds = new Map([["Document", { schema: Document.schema }]]);

    const introspector = createSchemaIntrospector(nodeKinds);
    const embeddingInfo = introspector.getFieldTypeInfo(
      "Document",
      "embedding",
    );

    expect(embeddingInfo).toBeDefined();
    expect(embeddingInfo?.valueType).toBe("embedding");
    expect(embeddingInfo?.dimensions).toBe(1536);
  });

  it("should detect optional embedding fields", () => {
    const Article = defineNode("Article", {
      schema: z.object({
        content: z.string(),
        embedding: embedding(768).optional(),
      }),
    });

    const nodeKinds = new Map([["Article", { schema: Article.schema }]]);

    const introspector = createSchemaIntrospector(nodeKinds);
    const embeddingInfo = introspector.getFieldTypeInfo("Article", "embedding");

    expect(embeddingInfo).toBeDefined();
    expect(embeddingInfo?.valueType).toBe("embedding");
    expect(embeddingInfo?.dimensions).toBe(768);
  });

  it("should detect non-embedding fields correctly", () => {
    const Simple = defineNode("Simple", {
      schema: z.object({
        name: z.string(),
        count: z.number(),
        tags: z.array(z.string()),
      }),
    });

    const nodeKinds = new Map([["Simple", { schema: Simple.schema }]]);

    const introspector = createSchemaIntrospector(nodeKinds);

    expect(introspector.getFieldTypeInfo("Simple", "name")?.valueType).toBe(
      "string",
    );
    expect(introspector.getFieldTypeInfo("Simple", "count")?.valueType).toBe(
      "number",
    );
    expect(introspector.getFieldTypeInfo("Simple", "tags")?.valueType).toBe(
      "array",
    );
  });
});

// ============================================================
// Dialect Adapter Vector Capability Tests
// ============================================================
//
// The dialect now exposes only the compile-time `supportsVectors` gate and
// its advertised `vectorMetrics`; the distance/format SQL moved entirely
// into the per-engine `VectorStrategy`, each with its own executable
// suite (`vector/libsql-strategy`, `vector/sqlite-vec-strategy`,
// `vector/pgvector-strategy`, `vector-cross-backend-parity`).

describe("PostgreSQL dialect vector capabilities", () => {
  it("advertises vector support", () => {
    expect(postgresDialect.supportsVectors).toBe(true);
  });

  it("advertises cosine, l2, and inner_product metrics", () => {
    expect(postgresDialect.capabilities.vectorMetrics).toEqual([
      "cosine",
      "l2",
      "inner_product",
    ]);
  });
});

describe("SQLite dialect vector capabilities", () => {
  it("advertises vector support", () => {
    expect(sqliteDialect.supportsVectors).toBe(true);
  });

  it("advertises cosine and l2 metrics (no inner_product)", () => {
    expect(sqliteDialect.capabilities.vectorMetrics).toEqual(["cosine", "l2"]);
    expect(sqliteDialect.capabilities.vectorMetrics).not.toContain(
      "inner_product",
    );
  });
});

// ============================================================
// Graph Definition with Embeddings Tests
// ============================================================

describe("graph definition with embeddings", () => {
  it("should allow defining nodes with embedding properties", () => {
    const Document = defineNode("Document", {
      schema: z.object({
        title: z.string(),
        content: z.string(),
        embedding: embedding(1536),
      }),
    });

    const graph = defineGraph({
      id: "test-graph",
      nodes: { Document: { type: Document } },
      edges: {},
    });

    expect(graph.nodes.Document).toBeDefined();
    expect(graph.nodes.Document.type).toBeDefined();
    expect(graph.nodes.Document.type.schema).toBeDefined();
  });

  it("should allow multiple nodes with different embedding dimensions", () => {
    const Document = defineNode("Document", {
      schema: z.object({
        title: z.string(),
        embedding: embedding(1536),
      }),
    });

    const Image = defineNode("Image", {
      schema: z.object({
        url: z.string(),
        clipEmbedding: embedding(512),
      }),
    });

    const Sentence = defineNode("Sentence", {
      schema: z.object({
        text: z.string(),
        embedding: embedding(384),
      }),
    });

    const graph = defineGraph({
      id: "multi-embedding-graph",
      nodes: {
        Document: { type: Document },
        Image: { type: Image },
        Sentence: { type: Sentence },
      },
      edges: {},
    });

    expect(graph.nodes.Document).toBeDefined();
    expect(graph.nodes.Image).toBeDefined();
    expect(graph.nodes.Sentence).toBeDefined();
  });
});

// ============================================================
// Embedding Sync Helper Tests
// ============================================================

describe("embedding extraction from schema", () => {
  it("should extract embedding fields from node schema", async () => {
    const { getEmbeddingFields } = await import("../src/store/embedding-sync");

    const schema = z.object({
      title: z.string(),
      embedding: embedding(1536),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.fieldPath).toBe("embedding");
    expect(fields[0]?.dimensions).toBe(1536);
  });

  it("should extract optional embedding fields", async () => {
    const { getEmbeddingFields } = await import("../src/store/embedding-sync");

    const schema = z.object({
      title: z.string(),
      embedding: embedding(768).optional(),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.fieldPath).toBe("embedding");
    expect(fields[0]?.dimensions).toBe(768);
  });

  it("should return empty array for schemas without embeddings", async () => {
    const { getEmbeddingFields } = await import("../src/store/embedding-sync");

    const schema = z.object({
      name: z.string(),
      count: z.number(),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(0);
  });

  it("should return empty array for non-object schemas", async () => {
    const { getEmbeddingFields } = await import("../src/store/embedding-sync");

    expect(getEmbeddingFields(z.string())).toHaveLength(0);
    expect(getEmbeddingFields(z.number())).toHaveLength(0);
    expect(getEmbeddingFields(z.array(z.string()))).toHaveLength(0);
  });
});
