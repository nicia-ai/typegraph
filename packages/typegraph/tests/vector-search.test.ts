/**
 * Vector Search Tests
 *
 * Tests the embedding type, schema introspection, predicate builders,
 * and dialect adapter SQL generation for vector similarity search.
 */
import { sql } from "drizzle-orm";
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
// Dialect Adapter Vector Operations Tests
// ============================================================

describe("PostgreSQL dialect vector operations", () => {
  const testEmbedding = [0.1, 0.2, 0.3];

  it("should support vectors", () => {
    expect(postgresDialect.supportsVectors).toBe(true);
  });

  it("should format embeddings as PostgreSQL vector literals", () => {
    const formatted = postgresDialect.formatEmbedding(testEmbedding);
    // The formatted embedding should be an SQL template
    expect(formatted).toBeDefined();
    expect(formatted.queryChunks).toBeDefined();
  });

  it("should generate cosine distance SQL", () => {
    const column = sql.raw("embedding_column");
    const distance = postgresDialect.vectorDistance(
      column,
      testEmbedding,
      "cosine",
    );
    // Should return an SQL template
    expect(distance).toBeDefined();
    expect(distance.queryChunks).toBeDefined();
  });

  it("should generate L2 distance SQL", () => {
    const column = sql.raw("embedding_column");
    const distance = postgresDialect.vectorDistance(
      column,
      testEmbedding,
      "l2",
    );
    expect(distance).toBeDefined();
    expect(distance.queryChunks).toBeDefined();
  });

  it("should generate inner product distance SQL", () => {
    const column = sql.raw("embedding_column");
    const distance = postgresDialect.vectorDistance(
      column,
      testEmbedding,
      "inner_product",
    );
    expect(distance).toBeDefined();
    expect(distance.queryChunks).toBeDefined();
  });
});

describe("SQLite dialect vector operations", () => {
  const testEmbedding = [0.1, 0.2, 0.3];

  it("should support vectors", () => {
    expect(sqliteDialect.supportsVectors).toBe(true);
  });

  it("should format embeddings using vec_f32", () => {
    const formatted = sqliteDialect.formatEmbedding(testEmbedding);
    expect(formatted).toBeDefined();
    expect(formatted.queryChunks).toBeDefined();
  });

  it("should generate cosine distance SQL", () => {
    const column = sql.raw("embedding_column");
    const distance = sqliteDialect.vectorDistance(
      column,
      testEmbedding,
      "cosine",
    );
    expect(distance).toBeDefined();
    expect(distance.queryChunks).toBeDefined();
  });

  it("should generate L2 distance SQL", () => {
    const column = sql.raw("embedding_column");
    const distance = sqliteDialect.vectorDistance(column, testEmbedding, "l2");
    expect(distance).toBeDefined();
    expect(distance.queryChunks).toBeDefined();
  });

  it("should throw for inner product distance (not supported by sqlite-vec)", () => {
    const column = sql.raw("embedding_column");
    expect(() => {
      sqliteDialect.vectorDistance(column, testEmbedding, "inner_product");
    }).toThrow("Inner product distance is not supported by sqlite-vec");
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

// ============================================================
// Vector Index Name Generation Tests
// ============================================================

describe("vector index name generation", () => {
  it("should generate consistent index names", async () => {
    const { generateVectorIndexName } =
      await import("../src/backend/drizzle/vector-index");

    const name1 = generateVectorIndexName(
      "my-graph",
      "Document",
      "embedding",
      "cosine",
    );
    const name2 = generateVectorIndexName(
      "my-graph",
      "Document",
      "embedding",
      "cosine",
    );

    expect(name1).toBe(name2);
    expect(name1).toContain("idx_emb");
    expect(name1).toContain("cosine");
  });

  it("should generate different names for different metrics", async () => {
    const { generateVectorIndexName } =
      await import("../src/backend/drizzle/vector-index");

    const cosine = generateVectorIndexName("g", "N", "e", "cosine");
    const l2 = generateVectorIndexName("g", "N", "e", "l2");
    const ip = generateVectorIndexName("g", "N", "e", "inner_product");

    expect(cosine).not.toBe(l2);
    expect(cosine).not.toBe(ip);
    expect(l2).not.toBe(ip);
  });

  it("should sanitize special characters in names", async () => {
    const { generateVectorIndexName } =
      await import("../src/backend/drizzle/vector-index");

    const name = generateVectorIndexName(
      "my-graph!",
      "Node.Type",
      "field/path",
      "cosine",
    );

    // Should not contain special characters
    expect(name).not.toContain("!");
    expect(name).not.toContain(".");
    expect(name).not.toContain("/");
    // Should only contain valid SQL identifier characters
    expect(name).toMatch(/^[a-z0-9_]+$/);
  });
});
