/**
 * External Reference Tests
 *
 * Tests for the externalRef() helper used in hybrid overlay patterns
 * where TypeGraph stores graph relationships while referencing entities
 * in external data sources.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createExternalRef,
  defineGraph,
  defineNode,
  externalRef,
  getExternalRefTable,
  isExternalRefSchema,
} from "../src";

describe("externalRef()", () => {
  it("creates a schema for external references", () => {
    const schema = externalRef("documents");

    const result = schema.safeParse({ table: "documents", id: "doc_123" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ table: "documents", id: "doc_123" });
  });

  it("validates table name matches", () => {
    const schema = externalRef("documents");

    const result = schema.safeParse({ table: "users", id: "user_123" });
    expect(result.success).toBe(false);
  });

  it("requires non-empty id", () => {
    const schema = externalRef("documents");

    const emptyId = schema.safeParse({ table: "documents", id: "" });
    expect(emptyId.success).toBe(false);

    const validId = schema.safeParse({ table: "documents", id: "doc_1" });
    expect(validId.success).toBe(true);
  });

  it("rejects missing fields", () => {
    const schema = externalRef("documents");

    expect(schema.safeParse({ table: "documents" }).success).toBe(false);
    expect(schema.safeParse({ id: "doc_123" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("throws on empty table name", () => {
    expect(() => externalRef("")).toThrow(
      "External reference table must be a non-empty string",
    );
  });

  it("attaches table metadata for introspection", () => {
    const schema = externalRef("documents");

    expect(isExternalRefSchema(schema)).toBe(true);
    expect(getExternalRefTable(schema)).toBe("documents");
  });

  it("supports optional external refs in node schemas", () => {
    const Document = defineNode("Document", {
      schema: z.object({
        source: externalRef("documents").optional(),
        title: z.string(),
      }),
    });

    // Without external ref
    const withoutRef = Document.schema.safeParse({ title: "Test" });
    expect(withoutRef.success).toBe(true);

    // With external ref
    const withRef = Document.schema.safeParse({
      title: "Test",
      source: { table: "documents", id: "doc_123" },
    });
    expect(withRef.success).toBe(true);
  });
});

describe("isExternalRefSchema()", () => {
  it("returns true for external ref schemas", () => {
    expect(isExternalRefSchema(externalRef("users"))).toBe(true);
    expect(isExternalRefSchema(externalRef("documents"))).toBe(true);
  });

  it("returns false for other schemas", () => {
    expect(isExternalRefSchema(z.string())).toBe(false);
    expect(isExternalRefSchema(z.object({ id: z.string() }))).toBe(false);
  });
});

describe("getExternalRefTable()", () => {
  it("returns the table name for external ref schemas", () => {
    expect(getExternalRefTable(externalRef("users"))).toBe("users");
    expect(getExternalRefTable(externalRef("app_documents"))).toBe(
      "app_documents",
    );
  });

  it("returns undefined for non-external-ref schemas", () => {
    expect(getExternalRefTable(z.string())).toBeUndefined();
    expect(getExternalRefTable(z.object({ id: z.string() }))).toBeUndefined();
  });
});

describe("createExternalRef()", () => {
  it("creates a factory for typed references", () => {
    const documentRef = createExternalRef("documents");

    const ref = documentRef("doc_123");
    expect(ref).toEqual({ table: "documents", id: "doc_123" });
  });

  it("validates against the schema", () => {
    const documentRef = createExternalRef("documents");
    const schema = externalRef("documents");

    const ref = documentRef("doc_456");
    expect(schema.safeParse(ref).success).toBe(true);
  });
});

describe("externalRef in graph definitions", () => {
  it("works in node schemas within a graph", () => {
    const Document = defineNode("Document", {
      schema: z.object({
        source: externalRef("app_documents"),
        extractedText: z.string().optional(),
      }),
    });

    const graph = defineGraph({
      id: "hybrid_graph",
      nodes: {
        Document: { type: Document },
      },
      edges: {},
    });

    expect(graph.nodes.Document.type.name).toBe("Document");

    // Verify the schema validates correctly
    const validData = {
      source: { table: "app_documents", id: "doc_abc" },
      extractedText: "Hello world",
    };
    expect(Document.schema.safeParse(validData).success).toBe(true);
  });

  it("supports multiple external refs in one node", () => {
    const Relationship = defineNode("Relationship", {
      schema: z.object({
        fromUser: externalRef("users"),
        toUser: externalRef("users"),
        relationshipType: z.enum(["friend", "colleague", "family"]),
      }),
    });

    const validData = {
      fromUser: { table: "users", id: "user_1" },
      toUser: { table: "users", id: "user_2" },
      relationshipType: "friend" as const,
    };
    expect(Relationship.schema.safeParse(validData).success).toBe(true);
  });

  it("supports different external tables in same node", () => {
    const Comment = defineNode("Comment", {
      schema: z.object({
        author: externalRef("users"),
        document: externalRef("documents"),
        text: z.string(),
      }),
    });

    const validData = {
      author: { table: "users", id: "user_123" },
      document: { table: "documents", id: "doc_456" },
      text: "Great article!",
    };
    expect(Comment.schema.safeParse(validData).success).toBe(true);

    // Wrong table name should fail
    const invalidData = {
      author: { table: "documents", id: "user_123" }, // wrong table
      document: { table: "documents", id: "doc_456" },
      text: "Great article!",
    };
    expect(Comment.schema.safeParse(invalidData).success).toBe(false);
  });
});
