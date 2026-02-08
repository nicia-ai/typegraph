/**
 * Tests for SQL schema configuration and validation.
 *
 * Covers createSqlSchema table name validation to prevent SQL injection
 * and ensure cross-database compatibility.
 */
import { describe, expect, it } from "vitest";

import { createSqlSchema } from "../src/query/compiler/schema";

describe("createSqlSchema", () => {
  describe("default table names", () => {
    it("uses standard TypeGraph table names by default", () => {
      const schema = createSqlSchema();

      expect(schema.tables.nodes).toBe("typegraph_nodes");
      expect(schema.tables.edges).toBe("typegraph_edges");
      expect(schema.tables.embeddings).toBe("typegraph_node_embeddings");
    });

    it("creates SQL references for default tables", () => {
      const schema = createSqlSchema();

      // Verify SQL objects are created (they wrap the quoted identifiers)
      expect(schema.nodesTable).toBeDefined();
      expect(schema.edgesTable).toBeDefined();
      expect(schema.embeddingsTable).toBeDefined();
    });
  });

  describe("custom table names", () => {
    it("accepts valid custom table names", () => {
      const schema = createSqlSchema({
        nodes: "myapp_nodes",
        edges: "myapp_edges",
        embeddings: "myapp_embeddings",
      });

      expect(schema.tables.nodes).toBe("myapp_nodes");
      expect(schema.tables.edges).toBe("myapp_edges");
      expect(schema.tables.embeddings).toBe("myapp_embeddings");
    });

    it("allows partial overrides", () => {
      const schema = createSqlSchema({
        nodes: "custom_nodes",
      });

      expect(schema.tables.nodes).toBe("custom_nodes");
      expect(schema.tables.edges).toBe("typegraph_edges");
      expect(schema.tables.embeddings).toBe("typegraph_node_embeddings");
    });

    it("accepts names starting with underscore", () => {
      const schema = createSqlSchema({
        nodes: "_private_nodes",
      });

      expect(schema.tables.nodes).toBe("_private_nodes");
    });

    it("accepts names with dollar signs (PostgreSQL extension)", () => {
      const schema = createSqlSchema({
        nodes: "nodes$v2",
      });

      expect(schema.tables.nodes).toBe("nodes$v2");
    });

    it("accepts names with digits after first character", () => {
      const schema = createSqlSchema({
        nodes: "nodes123",
      });

      expect(schema.tables.nodes).toBe("nodes123");
    });
  });

  describe("validation: empty names", () => {
    it("rejects empty string for nodes table", () => {
      expect(() => createSqlSchema({ nodes: "" })).toThrow(
        "nodes table name cannot be empty",
      );
    });

    it("rejects empty string for edges table", () => {
      expect(() => createSqlSchema({ edges: "" })).toThrow(
        "edges table name cannot be empty",
      );
    });

    it("rejects empty string for embeddings table", () => {
      expect(() => createSqlSchema({ embeddings: "" })).toThrow(
        "embeddings table name cannot be empty",
      );
    });
  });

  describe("validation: identifier length", () => {
    it("accepts names at max length (63 characters)", () => {
      const maxLengthName = "a".repeat(63);
      const schema = createSqlSchema({ nodes: maxLengthName });

      expect(schema.tables.nodes).toBe(maxLengthName);
    });

    it("rejects names exceeding 63 characters", () => {
      const tooLongName = "a".repeat(64);

      expect(() => createSqlSchema({ nodes: tooLongName })).toThrow(
        "exceeds maximum length of 63 characters",
      );
    });
  });

  describe("validation: invalid identifiers", () => {
    it("rejects names starting with a digit", () => {
      expect(() => createSqlSchema({ nodes: "123nodes" })).toThrow(
        "not a valid SQL identifier",
      );
    });

    it("rejects names with spaces", () => {
      expect(() => createSqlSchema({ nodes: "my nodes" })).toThrow(
        "not a valid SQL identifier",
      );
    });

    it("rejects names with hyphens", () => {
      expect(() => createSqlSchema({ nodes: "my-nodes" })).toThrow(
        "not a valid SQL identifier",
      );
    });

    it("rejects names with special characters", () => {
      expect(() => createSqlSchema({ nodes: "nodes@table" })).toThrow(
        "not a valid SQL identifier",
      );
    });

    it("rejects names with semicolons (SQL injection attempt)", () => {
      expect(() => createSqlSchema({ nodes: "nodes; DROP TABLE" })).toThrow(
        "not a valid SQL identifier",
      );
    });

    it("rejects names with quotes (SQL injection attempt)", () => {
      expect(() => createSqlSchema({ nodes: 'nodes"--' })).toThrow(
        "not a valid SQL identifier",
      );
    });
  });
});
