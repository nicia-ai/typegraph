/**
 * Unit tests for vector index management.
 */
import { describe, expect, it } from "vitest";

import {
  createSqliteVectorIndex,
  dropSqliteVectorIndex,
  generateVectorIndexName,
  type VectorIndexOptions,
} from "../src/backend/drizzle/vector-index";

// ============================================================
// generateVectorIndexName
// ============================================================

describe("generateVectorIndexName", () => {
  it("generates consistent index name with default metric", () => {
    const name = generateVectorIndexName("my-graph", "Document", "embedding");
    expect(name).toBe("idx_emb_my_graph_document_embedding_cosine");
  });

  it("includes metric in index name", () => {
    const cosine = generateVectorIndexName("g", "Node", "emb", "cosine");
    const l2 = generateVectorIndexName("g", "Node", "emb", "l2");
    const ip = generateVectorIndexName("g", "Node", "emb", "inner_product");

    expect(cosine).toContain("cosine");
    expect(l2).toContain("l2");
    expect(ip).toContain("inner_product");
  });

  it("sanitizes graph ID", () => {
    const name = generateVectorIndexName(
      "My-Graph.Test!123",
      "Document",
      "emb",
    );
    expect(name).toContain("my_graph_test_123");
    expect(name).not.toContain("-");
    expect(name).not.toContain(".");
    expect(name).not.toContain("!");
  });

  it("sanitizes node kind", () => {
    const name = generateVectorIndexName("g", "My-Node.Kind", "emb");
    expect(name).toContain("my_node_kind");
  });

  it("sanitizes field path", () => {
    const name = generateVectorIndexName("g", "Node", "my-embedding.field");
    expect(name).toContain("my_embedding_fiel");
  });

  it("truncates long identifiers to 20 chars", () => {
    const name = generateVectorIndexName(
      "very_long_graph_identifier_that_exceeds_limit",
      "VeryLongNodeKindNameThatExceedsLimit",
      "very_long_field_path_name",
    );
    // Each part is truncated to 20 chars
    expect(
      name
        .split("_")
        .slice(2, 5)
        .every((p) => p.length <= 20),
    ).toBe(true);
  });

  it("lowercases all parts", () => {
    const name = generateVectorIndexName("GRAPH", "NODE", "FIELD");
    expect(name).toBe("idx_emb_graph_node_field_cosine");
  });

  it("handles empty strings gracefully", () => {
    const name = generateVectorIndexName("", "", "");
    expect(name).toBe("idx_emb____cosine");
  });

  it("handles special characters in all parts", () => {
    const name = generateVectorIndexName("graph@123", "node#456", "field$789");
    // Should replace special chars with underscores
    expect(name).toMatch(/^idx_emb_[a-z0-9_]+_[a-z0-9_]+_[a-z0-9_]+_cosine$/);
  });
});

// ============================================================
// createSqliteVectorIndex
// ============================================================

describe("createSqliteVectorIndex", () => {
  const baseOptions: VectorIndexOptions = {
    graphId: "test-graph",
    nodeKind: "Document",
    fieldPath: "embedding",
    dimensions: 1536,
  };

  it("returns success with no-op message", () => {
    const result = createSqliteVectorIndex(baseOptions);

    expect(result.success).toBe(true);
    expect(result.indexName).toBe(
      "idx_emb_test_graph_document_embedding_cosine",
    );
    expect(result.message).toContain("sqlite-vec");
    expect(result.message).toContain("no explicit index needed");
  });

  it("uses provided metric in index name", () => {
    const result = createSqliteVectorIndex({
      ...baseOptions,
      metric: "l2",
    });

    expect(result.indexName).toContain("l2");
  });

  it("ignores index type parameter", () => {
    const hnsw = createSqliteVectorIndex({
      ...baseOptions,
      indexType: "hnsw",
    });
    const ivfflat = createSqliteVectorIndex({
      ...baseOptions,
      indexType: "ivfflat",
    });

    // Both should succeed since SQLite ignores index type
    expect(hnsw.success).toBe(true);
    expect(ivfflat.success).toBe(true);
  });

  it("ignores HNSW parameters", () => {
    const result = createSqliteVectorIndex({
      ...baseOptions,
      indexType: "hnsw",
      hnswM: 32,
      hnswEfConstruction: 128,
    });

    expect(result.success).toBe(true);
  });

  it("ignores IVFFlat parameters", () => {
    const result = createSqliteVectorIndex({
      ...baseOptions,
      indexType: "ivfflat",
      ivfflatLists: 200,
    });

    expect(result.success).toBe(true);
  });
});

// ============================================================
// dropSqliteVectorIndex
// ============================================================

describe("dropSqliteVectorIndex", () => {
  it("returns success with no-op message", () => {
    const result = dropSqliteVectorIndex("graph", "Node", "embedding");

    expect(result.success).toBe(true);
    expect(result.indexName).toBe("idx_emb_graph_node_embedding_cosine");
    expect(result.message).toContain("sqlite-vec");
    expect(result.message).toContain("does not use explicit indexes");
  });

  it("uses provided metric in index name", () => {
    const result = dropSqliteVectorIndex("graph", "Node", "embedding", "l2");

    expect(result.indexName).toContain("l2");
  });

  it("uses default cosine metric", () => {
    const result = dropSqliteVectorIndex("graph", "Node", "embedding");

    expect(result.indexName).toContain("cosine");
  });
});
