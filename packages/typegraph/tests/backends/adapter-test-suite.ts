/**
 * Shared Adapter Test Suite
 *
 * Validates that any GraphBackend implementation conforms to the interface contract.
 * All adapters (SQLite, Memory, PostgreSQL, etc.) must pass these tests.
 *
 * @example
 * ```typescript
 * import { createAdapterTestSuite } from "./adapter-test-suite";
 * import { createMemoryAdapter } from "../src/backend/memory";
 *
 * createAdapterTestSuite("Memory", () => createMemoryAdapter());
 * ```
 */
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { GraphBackend } from "../../src/backend/types";

// ============================================================
// Types
// ============================================================

/**
 * Factory function that creates a fresh adapter for each test.
 */
type AdapterFactory = () => GraphBackend;

/**
 * Options for the test suite.
 */
type TestSuiteOptions = Readonly<{
  /** Skip raw SQL query tests (memory adapter doesn't support execute()) */
  skipRawQueries?: boolean;
}>;

// ============================================================
// Test Suite
// ============================================================

/**
 * Creates a test suite for a GraphBackend implementation.
 *
 * @param name - Display name for the adapter (e.g., "SQLite", "Memory")
 * @param createAdapter - Factory function that returns a fresh adapter
 * @param options - Optional test configuration
 */
export function createAdapterTestSuite(
  name: string,
  createAdapter: AdapterFactory,
  options: TestSuiteOptions = {},
): void {
  const { skipRawQueries = false } = options;

  describe(`${name} Adapter`, () => {
    let backend: GraphBackend;

    beforeEach(() => {
      backend = createAdapter();
    });

    afterEach(async () => {
      // Close backend after each test to release resources (e.g., connection pools)
      await backend.close();
    });

    // ============================================================
    // Node Operations
    // ============================================================

    describe("Node Operations", () => {
      it("inserts and retrieves a node", async () => {
        const inserted = await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice", email: "alice@example.com" },
        });

        expect(inserted.id).toBe("person-1");
        expect(inserted.kind).toBe("Person");
        expect(inserted.graph_id).toBe("test_graph");
        expect(inserted.version).toBe(1);
        expect(inserted.deleted_at).toBeUndefined();
        expect(inserted.created_at).toBeDefined();
        expect(inserted.updated_at).toBeDefined();

        const props = JSON.parse(inserted.props);
        expect(props.name).toBe("Alice");
        expect(props.email).toBe("alice@example.com");

        // Retrieve
        const fetched = await backend.getNode(
          "test_graph",
          "Person",
          "person-1",
        );
        expect(fetched).toBeDefined();
        expect(fetched!.id).toBe("person-1");
        expect(fetched!.kind).toBe("Person");
      });

      it("inserts a node with temporal fields", async () => {
        const validFrom = "2024-01-01T00:00:00.000Z";
        const validTo = "2024-12-31T23:59:59.999Z";

        const inserted = await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-temporal",
          props: { name: "Bob" },
          validFrom,
          validTo,
        });

        expect(inserted.valid_from).toBe(validFrom);
        expect(inserted.valid_to).toBe(validTo);

        const fetched = await backend.getNode(
          "test_graph",
          "Person",
          "person-temporal",
        );
        expect(fetched!.valid_from).toBe(validFrom);
        expect(fetched!.valid_to).toBe(validTo);
      });

      it("updates a node without incrementing version", async () => {
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice" },
        });

        const updated = await backend.updateNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice Updated" },
          incrementVersion: false,
        });

        expect(updated.version).toBe(1);
        const props = JSON.parse(updated.props);
        expect(props.name).toBe("Alice Updated");
      });

      it("updates a node with version increment", async () => {
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice" },
        });

        const updated = await backend.updateNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice Updated", age: 30 },
          incrementVersion: true,
        });

        expect(updated.version).toBe(2);
        const props = JSON.parse(updated.props);
        expect(props.name).toBe("Alice Updated");
        expect(props.age).toBe(30);
      });

      it("updates a node with validTo", async () => {
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice" },
        });

        const validTo = "2025-01-01T00:00:00.000Z";
        const updated = await backend.updateNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice" },
          validTo,
        });

        expect(updated.valid_to).toBe(validTo);
      });

      it("soft deletes a node", async () => {
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice" },
        });

        await backend.deleteNode({
          graphId: "test_graph",
          kind: "Person",
          id: "person-1",
        });

        // Should still exist but with deleted_at set
        const fetched = await backend.getNode(
          "test_graph",
          "Person",
          "person-1",
        );
        expect(fetched).toBeDefined();
        expect(fetched!.deleted_at).toBeDefined();
      });

      it("returns undefined for non-existent node", async () => {
        const fetched = await backend.getNode(
          "test_graph",
          "Person",
          "not-found",
        );
        expect(fetched).toBeUndefined();
      });

      it("handles multiple nodes with different kinds", async () => {
        await backend.insertNode({
          graphId: "test_graph",
          kind: "Person",
          id: "entity-1",
          props: { name: "Alice" },
        });

        await backend.insertNode({
          graphId: "test_graph",
          kind: "Company",
          id: "entity-1",
          props: { name: "Acme" },
        });

        const person = await backend.getNode(
          "test_graph",
          "Person",
          "entity-1",
        );
        const company = await backend.getNode(
          "test_graph",
          "Company",
          "entity-1",
        );

        expect(person).toBeDefined();
        expect(company).toBeDefined();
        expect(JSON.parse(person!.props).name).toBe("Alice");
        expect(JSON.parse(company!.props).name).toBe("Acme");
      });

      it("handles nodes in different graphs", async () => {
        await backend.insertNode({
          graphId: "graph_a",
          kind: "Person",
          id: "person-1",
          props: { name: "Alice" },
        });

        await backend.insertNode({
          graphId: "graph_b",
          kind: "Person",
          id: "person-1",
          props: { name: "Bob" },
        });

        const fromA = await backend.getNode("graph_a", "Person", "person-1");
        const fromB = await backend.getNode("graph_b", "Person", "person-1");

        expect(JSON.parse(fromA!.props).name).toBe("Alice");
        expect(JSON.parse(fromB!.props).name).toBe("Bob");
      });
    });

    // ============================================================
    // Edge Operations
    // ============================================================

    describe("Edge Operations", () => {
      it("inserts and retrieves an edge", async () => {
        const inserted = await backend.insertEdge({
          graphId: "test_graph",
          id: "edge-1",
          kind: "worksAt",
          fromKind: "Person",
          fromId: "person-1",
          toKind: "Company",
          toId: "company-1",
          props: { role: "Engineer" },
        });

        expect(inserted.id).toBe("edge-1");
        expect(inserted.kind).toBe("worksAt");
        expect(inserted.from_kind).toBe("Person");
        expect(inserted.from_id).toBe("person-1");
        expect(inserted.to_kind).toBe("Company");
        expect(inserted.to_id).toBe("company-1");
        expect(inserted.deleted_at).toBeUndefined();

        const props = JSON.parse(inserted.props);
        expect(props.role).toBe("Engineer");

        // Retrieve
        const fetched = await backend.getEdge("test_graph", "edge-1");
        expect(fetched).toBeDefined();
        expect(fetched!.id).toBe("edge-1");
        expect(fetched!.kind).toBe("worksAt");
      });

      it("inserts an edge with temporal fields", async () => {
        const validFrom = "2024-01-01T00:00:00.000Z";
        const validTo = "2024-12-31T23:59:59.999Z";

        const inserted = await backend.insertEdge({
          graphId: "test_graph",
          id: "edge-temporal",
          kind: "worksAt",
          fromKind: "Person",
          fromId: "person-1",
          toKind: "Company",
          toId: "company-1",
          props: {},
          validFrom,
          validTo,
        });

        expect(inserted.valid_from).toBe(validFrom);
        expect(inserted.valid_to).toBe(validTo);
      });

      it("updates an edge", async () => {
        await backend.insertEdge({
          graphId: "test_graph",
          id: "edge-1",
          kind: "worksAt",
          fromKind: "Person",
          fromId: "person-1",
          toKind: "Company",
          toId: "company-1",
          props: { role: "Engineer" },
        });

        const updated = await backend.updateEdge({
          graphId: "test_graph",
          id: "edge-1",
          props: { role: "Senior Engineer", startDate: "2024-01-01" },
        });

        const props = JSON.parse(updated.props);
        expect(props.role).toBe("Senior Engineer");
        expect(props.startDate).toBe("2024-01-01");
      });

      it("updates an edge with validTo", async () => {
        await backend.insertEdge({
          graphId: "test_graph",
          id: "edge-1",
          kind: "worksAt",
          fromKind: "Person",
          fromId: "person-1",
          toKind: "Company",
          toId: "company-1",
          props: {},
        });

        const validTo = "2025-01-01T00:00:00.000Z";
        const updated = await backend.updateEdge({
          graphId: "test_graph",
          id: "edge-1",
          props: {},
          validTo,
        });

        expect(updated.valid_to).toBe(validTo);
      });

      it("soft deletes an edge", async () => {
        await backend.insertEdge({
          graphId: "test_graph",
          id: "edge-1",
          kind: "worksAt",
          fromKind: "Person",
          fromId: "person-1",
          toKind: "Company",
          toId: "company-1",
          props: {},
        });

        await backend.deleteEdge({
          graphId: "test_graph",
          id: "edge-1",
        });

        const fetched = await backend.getEdge("test_graph", "edge-1");
        expect(fetched).toBeDefined();
        expect(fetched!.deleted_at).toBeDefined();
      });

      it("returns undefined for non-existent edge", async () => {
        const fetched = await backend.getEdge("test_graph", "not-found");
        expect(fetched).toBeUndefined();
      });

      it("handles edges in different graphs", async () => {
        await backend.insertEdge({
          graphId: "graph_a",
          id: "edge-1",
          kind: "worksAt",
          fromKind: "Person",
          fromId: "p1",
          toKind: "Company",
          toId: "c1",
          props: { graph: "a" },
        });

        await backend.insertEdge({
          graphId: "graph_b",
          id: "edge-1",
          kind: "worksAt",
          fromKind: "Person",
          fromId: "p1",
          toKind: "Company",
          toId: "c1",
          props: { graph: "b" },
        });

        const fromA = await backend.getEdge("graph_a", "edge-1");
        const fromB = await backend.getEdge("graph_b", "edge-1");

        expect(JSON.parse(fromA!.props).graph).toBe("a");
        expect(JSON.parse(fromB!.props).graph).toBe("b");
      });
    });

    // ============================================================
    // Unique Constraint Operations
    // ============================================================

    describe("Unique Constraint Operations", () => {
      it("inserts and checks unique constraints", async () => {
        await backend.insertUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
          nodeId: "person-1",
          concreteKind: "Person",
        });

        // Check existing
        const existing = await backend.checkUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
        });

        expect(existing).toBeDefined();
        expect(existing!.node_id).toBe("person-1");
        expect(existing!.concrete_kind).toBe("Person");

        // Check non-existing
        const notFound = await backend.checkUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "bob@example.com",
        });

        expect(notFound).toBeUndefined();
      });

      it("soft deletes unique constraint entries", async () => {
        await backend.insertUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
          nodeId: "person-1",
          concreteKind: "Person",
        });

        await backend.deleteUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
        });

        // checkUnique should filter out soft-deleted entries
        const result = await backend.checkUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
        });

        expect(result).toBeUndefined();
      });

      it("allows re-insert with same nodeId (update scenario)", async () => {
        await backend.insertUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
          nodeId: "person-1",
          concreteKind: "Person",
        });

        // Re-insert with SAME nodeId should succeed (update case)
        await backend.insertUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
          nodeId: "person-1",
          concreteKind: "Person",
        });

        const result = await backend.checkUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
        });

        expect(result!.node_id).toBe("person-1");
      });

      it("rejects re-insert with different nodeId (uniqueness violation)", async () => {
        await backend.insertUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
          nodeId: "person-1",
          concreteKind: "Person",
        });

        // Re-insert with DIFFERENT nodeId should fail (uniqueness violation)
        await expect(
          backend.insertUnique({
            graphId: "test_graph",
            nodeKind: "Person",
            constraintName: "email_unique",
            key: "alice@example.com",
            nodeId: "person-2",
            concreteKind: "Person",
          }),
        ).rejects.toThrow(/uniqueness.*violation/i);

        // Original entry should still be intact
        const result = await backend.checkUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
        });

        expect(result!.node_id).toBe("person-1");
      });

      it("handles unique constraints in different graphs", async () => {
        await backend.insertUnique({
          graphId: "graph_a",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
          nodeId: "person-a",
          concreteKind: "Person",
        });

        await backend.insertUnique({
          graphId: "graph_b",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
          nodeId: "person-b",
          concreteKind: "Person",
        });

        const fromA = await backend.checkUnique({
          graphId: "graph_a",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
        });

        const fromB = await backend.checkUnique({
          graphId: "graph_b",
          nodeKind: "Person",
          constraintName: "email_unique",
          key: "alice@example.com",
        });

        expect(fromA!.node_id).toBe("person-a");
        expect(fromB!.node_id).toBe("person-b");
      });
    });

    // ============================================================
    // Schema Operations
    // ============================================================

    describe("Schema Operations", () => {
      it("inserts and retrieves active schema", async () => {
        const inserted = await backend.insertSchema({
          graphId: "test_graph",
          version: 1,
          schemaHash: "abc123",
          schemaDoc: { nodes: { Person: {} }, edges: {} },
          isActive: true,
        });

        expect(inserted.version).toBe(1);
        expect(inserted.schema_hash).toBe("abc123");
        expect(inserted.is_active).toBe(true);
        expect(inserted.created_at).toBeDefined();

        const schemaDocument = JSON.parse(inserted.schema_doc);
        expect(schemaDocument.nodes.Person).toBeDefined();

        const active = await backend.getActiveSchema("test_graph");
        expect(active).toBeDefined();
        expect(active!.version).toBe(1);
        expect(active!.schema_hash).toBe("abc123");
      });

      it("returns undefined when no active schema exists", async () => {
        const active = await backend.getActiveSchema("test_graph");
        expect(active).toBeUndefined();
      });

      it("inserts inactive schema", async () => {
        await backend.insertSchema({
          graphId: "test_graph",
          version: 1,
          schemaHash: "abc123",
          schemaDoc: {},
          isActive: false,
        });

        const active = await backend.getActiveSchema("test_graph");
        expect(active).toBeUndefined();
      });

      it("handles schemas in different graphs", async () => {
        await backend.insertSchema({
          graphId: "graph_a",
          version: 1,
          schemaHash: "hash-a",
          schemaDoc: { graph: "a" },
          isActive: true,
        });

        await backend.insertSchema({
          graphId: "graph_b",
          version: 1,
          schemaHash: "hash-b",
          schemaDoc: { graph: "b" },
          isActive: true,
        });

        const activeA = await backend.getActiveSchema("graph_a");
        const activeB = await backend.getActiveSchema("graph_b");

        expect(activeA!.schema_hash).toBe("hash-a");
        expect(activeB!.schema_hash).toBe("hash-b");
      });
    });

    // ============================================================
    // Transaction Operations
    // ============================================================

    describe("Transaction Operations", () => {
      it("commits successful transactions", async () => {
        await backend.transaction(async (tx) => {
          await tx.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-1",
            props: { name: "Alice" },
          });

          await tx.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-2",
            props: { name: "Bob" },
          });
        });

        // Both should exist after commit
        const alice = await backend.getNode("test_graph", "Person", "person-1");
        const bob = await backend.getNode("test_graph", "Person", "person-2");

        expect(alice).toBeDefined();
        expect(bob).toBeDefined();
      });

      it("rolls back failed transactions", async () => {
        try {
          await backend.transaction(async (tx) => {
            await tx.insertNode({
              graphId: "test_graph",
              kind: "Person",
              id: "person-1",
              props: { name: "Alice" },
            });

            // Force an error
            throw new Error("Simulated failure");
          });
        } catch {
          // Expected
        }

        // Should not exist due to rollback
        const alice = await backend.getNode("test_graph", "Person", "person-1");
        expect(alice).toBeUndefined();
      });

      it("returns value from successful transaction", async () => {
        const result = await backend.transaction(async (tx) => {
          const node = await tx.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-1",
            props: { name: "Alice" },
          });
          return node.id;
        });

        expect(result).toBe("person-1");
      });

      it("supports mixed operations in transaction", async () => {
        await backend.transaction(async (tx) => {
          await tx.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-1",
            props: { name: "Alice" },
          });

          await tx.insertNode({
            graphId: "test_graph",
            kind: "Company",
            id: "company-1",
            props: { name: "Acme" },
          });

          await tx.insertEdge({
            graphId: "test_graph",
            id: "edge-1",
            kind: "worksAt",
            fromKind: "Person",
            fromId: "person-1",
            toKind: "Company",
            toId: "company-1",
            props: { role: "Engineer" },
          });

          await tx.insertUnique({
            graphId: "test_graph",
            nodeKind: "Person",
            constraintName: "name_unique",
            key: "Alice",
            nodeId: "person-1",
            concreteKind: "Person",
          });
        });

        const person = await backend.getNode(
          "test_graph",
          "Person",
          "person-1",
        );
        const company = await backend.getNode(
          "test_graph",
          "Company",
          "company-1",
        );
        const edge = await backend.getEdge("test_graph", "edge-1");
        const unique = await backend.checkUnique({
          graphId: "test_graph",
          nodeKind: "Person",
          constraintName: "name_unique",
          key: "Alice",
        });

        expect(person).toBeDefined();
        expect(company).toBeDefined();
        expect(edge).toBeDefined();
        expect(unique).toBeDefined();
      });
    });

    // ============================================================
    // Raw Query Execution (optional)
    // ============================================================

    if (!skipRawQueries) {
      describe("Query Execution", () => {
        it("executes raw compiled queries", async () => {
          await backend.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-1",
            props: { name: "Alice" },
          });

          await backend.insertNode({
            graphId: "test_graph",
            kind: "Person",
            id: "person-2",
            props: { name: "Bob" },
          });

          const query = sql`SELECT id, kind FROM typegraph_nodes WHERE graph_id = ${"test_graph"} AND kind = ${"Person"} AND deleted_at IS NULL`;
          const results = await backend.execute<{ id: string; kind: string }>(
            query,
          );

          expect(results).toHaveLength(2);
          expect(results.map((r) => r.id).toSorted()).toEqual([
            "person-1",
            "person-2",
          ]);
        });
      });
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    describe("Lifecycle", () => {
      it("closes without error", async () => {
        await expect(backend.close()).resolves.not.toThrow();
      });
    });
  });
}
