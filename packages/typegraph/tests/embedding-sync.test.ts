/**
 * Unit tests for embedding sync utilities.
 *
 * Tests the automatic synchronization of embedding fields with the embeddings table.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { embedding } from "../src/core/embedding";
import {
  deleteNodeEmbeddings,
  type EmbeddingSyncContext,
  getEmbeddingFields,
  syncEmbeddings,
} from "../src/store/embedding-sync";

// ============================================================
// Test Helpers
// ============================================================

function createMockBackend() {
  return {
    upsertEmbedding: vi.fn(),
    deleteEmbedding: vi.fn(),
  };
}

function createDeleteOnlyMockBackend() {
  return {
    deleteEmbedding: vi.fn(),
  };
}

function createContext(
  backend: ReturnType<typeof createMockBackend>,
): EmbeddingSyncContext {
  return {
    graphId: "test-graph",
    nodeKind: "Document",
    nodeId: "doc-123",
    backend: backend as never,
  };
}

function createDeleteContext(
  backend: ReturnType<typeof createDeleteOnlyMockBackend>,
): EmbeddingSyncContext {
  return {
    graphId: "test-graph",
    nodeKind: "Document",
    nodeId: "doc-123",
    backend: backend as never,
  };
}

// ============================================================
// getEmbeddingFields
// ============================================================

describe("getEmbeddingFields", () => {
  it("extracts embedding fields from object schema", () => {
    const schema = z.object({
      name: z.string(),
      embedding: embedding(1536),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      fieldPath: "embedding",
      dimensions: 1536,
    });
  });

  it("extracts multiple embedding fields", () => {
    const schema = z.object({
      title: z.string(),
      titleEmbedding: embedding(384),
      contentEmbedding: embedding(1536),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.fieldPath).toSorted()).toEqual([
      "contentEmbedding",
      "titleEmbedding",
    ]);
  });

  it("handles optional embedding fields", () => {
    const schema = z.object({
      name: z.string(),
      embedding: embedding(768).optional(),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.dimensions).toBe(768);
  });

  it("handles nullable embedding fields", () => {
    const schema = z.object({
      name: z.string(),
      embedding: embedding(512).nullable(),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.dimensions).toBe(512);
  });

  it("handles default embedding fields", () => {
    const defaultVector = Array.from({ length: 256 }, () => 0);
    const schema = z.object({
      name: z.string(),
      embedding: embedding(256).default(defaultVector as never),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.dimensions).toBe(256);
  });

  it("handles readonly embedding fields", () => {
    const schema = z.object({
      name: z.string(),
      embedding: embedding(1024).readonly(),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.dimensions).toBe(1024);
  });

  it("handles deeply nested wrappers", () => {
    const schema = z.object({
      name: z.string(),
      embedding: embedding(384).optional().nullable(),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.dimensions).toBe(384);
  });

  it("returns empty array for non-object schema", () => {
    const schema = z.string();

    const fields = getEmbeddingFields(schema);

    expect(fields).toEqual([]);
  });

  it("returns empty array for schema without embedding fields", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      tags: z.array(z.string()),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toEqual([]);
  });

  it("ignores non-embedding array fields", () => {
    const schema = z.object({
      numbers: z.array(z.number()),
      embedding: embedding(128),
    });

    const fields = getEmbeddingFields(schema);

    expect(fields).toHaveLength(1);
    expect(fields[0]?.fieldPath).toBe("embedding");
  });
});

// ============================================================
// syncEmbeddings
// ============================================================

describe("syncEmbeddings", () => {
  const schema = z.object({
    name: z.string(),
    embedding: embedding(3),
  });

  it("upserts embedding when value is provided", async () => {
    const backend = createMockBackend();
    const ctx = createContext(backend);
    const embeddingValue = [0.1, 0.2, 0.3];

    await syncEmbeddings(ctx, schema, {
      name: "Test",
      embedding: embeddingValue,
    });

    expect(backend.upsertEmbedding).toHaveBeenCalledWith({
      graphId: "test-graph",
      nodeKind: "Document",
      nodeId: "doc-123",
      fieldPath: "embedding",
      embedding: embeddingValue,
      dimensions: 3,
    });
  });

  it("deletes embedding when value is undefined", async () => {
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, schema, {
      name: "Test",
      embedding: undefined,
    });

    expect(backend.deleteEmbedding).toHaveBeenCalledWith({
      graphId: "test-graph",
      nodeKind: "Document",
      nodeId: "doc-123",
      fieldPath: "embedding",
    });
    expect(backend.upsertEmbedding).not.toHaveBeenCalled();
  });

  it("skips when value is not a valid embedding (object)", async () => {
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, schema, {
      name: "Test",
      embedding: { invalid: true } as unknown,
    });

    expect(backend.upsertEmbedding).not.toHaveBeenCalled();
    expect(backend.deleteEmbedding).not.toHaveBeenCalled();
  });

  it("skips when value is invalid (not an array)", async () => {
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, schema, {
      name: "Test",
      embedding: "not an array",
    });

    expect(backend.upsertEmbedding).not.toHaveBeenCalled();
    expect(backend.deleteEmbedding).not.toHaveBeenCalled();
  });

  it("skips when value contains non-finite numbers", async () => {
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, schema, {
      name: "Test",
      embedding: [0.1, Number.NaN, 0.3],
    });

    expect(backend.upsertEmbedding).not.toHaveBeenCalled();
    expect(backend.deleteEmbedding).not.toHaveBeenCalled();
  });

  it("skips when value contains non-numbers", async () => {
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, schema, {
      name: "Test",
      embedding: [0.1, "string", 0.3],
    });

    expect(backend.upsertEmbedding).not.toHaveBeenCalled();
    expect(backend.deleteEmbedding).not.toHaveBeenCalled();
  });

  it("handles multiple embedding fields", async () => {
    const multiEmbeddingSchema = z.object({
      name: z.string(),
      titleEmbedding: embedding(2),
      contentEmbedding: embedding(3),
    });
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, multiEmbeddingSchema, {
      name: "Test",
      titleEmbedding: [0.1, 0.2],
      contentEmbedding: [0.3, 0.4, 0.5],
    });

    expect(backend.upsertEmbedding).toHaveBeenCalledTimes(2);
  });

  it("handles mixed update/delete for multiple fields", async () => {
    const multiEmbeddingSchema = z.object({
      name: z.string(),
      titleEmbedding: embedding(2),
      contentEmbedding: embedding(3),
    });
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, multiEmbeddingSchema, {
      name: "Test",
      titleEmbedding: [0.1, 0.2],
      contentEmbedding: undefined,
    });

    expect(backend.upsertEmbedding).toHaveBeenCalledTimes(1);
    expect(backend.deleteEmbedding).toHaveBeenCalledTimes(1);
  });

  it("does nothing when backend does not support embeddings", async () => {
    const backendWithoutEmbeddings = {};
    const ctx: EmbeddingSyncContext = {
      graphId: "test-graph",
      nodeKind: "Document",
      nodeId: "doc-123",
      backend: backendWithoutEmbeddings as never,
    };

    // Should not throw
    await syncEmbeddings(ctx, schema, {
      name: "Test",
      embedding: [0.1, 0.2, 0.3],
    });
  });

  it("does nothing for schema without embedding fields", async () => {
    const nonEmbeddingSchema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const backend = createMockBackend();
    const ctx = createContext(backend);

    await syncEmbeddings(ctx, nonEmbeddingSchema, {
      name: "Test",
      age: 25,
    });

    expect(backend.upsertEmbedding).not.toHaveBeenCalled();
    expect(backend.deleteEmbedding).not.toHaveBeenCalled();
  });
});

// ============================================================
// deleteNodeEmbeddings
// ============================================================

describe("deleteNodeEmbeddings", () => {
  const schema = z.object({
    name: z.string(),
    embedding: embedding(3),
  });

  it("deletes embedding for single field", async () => {
    const backend = createDeleteOnlyMockBackend();
    const ctx = createDeleteContext(backend);

    await deleteNodeEmbeddings(ctx, schema);

    expect(backend.deleteEmbedding).toHaveBeenCalledWith({
      graphId: "test-graph",
      nodeKind: "Document",
      nodeId: "doc-123",
      fieldPath: "embedding",
    });
  });

  it("deletes embeddings for multiple fields", async () => {
    const multiEmbeddingSchema = z.object({
      name: z.string(),
      titleEmbedding: embedding(2),
      contentEmbedding: embedding(3),
    });
    const backend = createDeleteOnlyMockBackend();
    const ctx = createDeleteContext(backend);

    await deleteNodeEmbeddings(ctx, multiEmbeddingSchema);

    expect(backend.deleteEmbedding).toHaveBeenCalledTimes(2);
  });

  it("does nothing when backend does not support embeddings", async () => {
    const backendWithoutEmbeddings = {};
    const ctx: EmbeddingSyncContext = {
      graphId: "test-graph",
      nodeKind: "Document",
      nodeId: "doc-123",
      backend: backendWithoutEmbeddings as never,
    };

    // Should not throw
    await deleteNodeEmbeddings(ctx, schema);
  });

  it("does nothing for schema without embedding fields", async () => {
    const nonEmbeddingSchema = z.object({
      name: z.string(),
      age: z.number(),
    });
    const backend = createDeleteOnlyMockBackend();
    const ctx = createDeleteContext(backend);

    await deleteNodeEmbeddings(ctx, nonEmbeddingSchema);

    expect(backend.deleteEmbedding).not.toHaveBeenCalled();
  });
});
