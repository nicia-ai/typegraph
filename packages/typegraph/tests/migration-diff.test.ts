/**
 * Unit tests for schema migration diff computation.
 *
 * Tests the core diff logic in migration.ts directly using
 * SerializedSchema objects, separate from the integration tests.
 */
import { describe, expect, it } from "vitest";

import {
  computeSchemaDiff,
  getMigrationActions,
  isBackwardsCompatible,
} from "../src/schema/migration";
import {
  type SerializedOntology,
  type SerializedSchema,
} from "../src/schema/types";

// ============================================================
// Test Helpers
// ============================================================

/**
 * Creates a minimal empty ontology for testing.
 */
function emptyOntology(): SerializedOntology {
  return {
    metaEdges: {},
    relations: [],
    closures: {
      subClassAncestors: {},
      subClassDescendants: {},
      broaderClosure: {},
      narrowerClosure: {},
      equivalenceSets: {},
      disjointPairs: [],
      partOfClosure: {},
      hasPartClosure: {},
      iriToKind: {},
      edgeInverses: {},
      edgeImplicationsClosure: {},
      edgeImplyingClosure: {},
    },
  };
}

/**
 * Creates a base schema for testing.
 */
function createSchema(
  overrides: Partial<SerializedSchema> = {},
): SerializedSchema {
  return {
    graphId: "test",
    version: 1,
    generatedAt: "2024-01-01T00:00:00Z",
    nodes: {},
    edges: {},
    ontology: emptyOntology(),
    defaults: {
      onNodeDelete: "restrict",
      temporalMode: "current",
    },
    ...overrides,
  };
}

// ============================================================
// computeSchemaDiff - Empty/No Changes
// ============================================================

describe("computeSchemaDiff", () => {
  describe("empty and unchanged schemas", () => {
    it("returns no changes for identical empty schemas", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({ version: 2 });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(false);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.isBackwardsCompatible).toBe(true);
      expect(diff.nodes).toHaveLength(0);
      expect(diff.edges).toHaveLength(0);
      expect(diff.ontology).toHaveLength(0);
      expect(diff.summary).toBe("No changes");
    });

    it("tracks version numbers correctly", () => {
      const before = createSchema({ version: 3 });
      const after = createSchema({ version: 7 });

      const diff = computeSchemaDiff(before, after);

      expect(diff.fromVersion).toBe(3);
      expect(diff.toVersion).toBe(7);
    });

    it("returns no changes when schemas are identical", () => {
      const schema = createSchema({
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(schema, schema);

      expect(diff.hasChanges).toBe(false);
    });
  });

  // ============================================================
  // Node Changes
  // ============================================================

  describe("node changes", () => {
    it("detects added node as safe change", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.isBackwardsCompatible).toBe(true);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]).toMatchObject({
        type: "added",
        kind: "Person",
        severity: "safe",
      });
      expect(diff.nodes[0]!.details).toContain("Person");
      expect(diff.nodes[0]!.details).toContain("added");
    });

    it("detects removed node as breaking change", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { name: { type: "string" } },
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({ version: 2 });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(true);
      expect(diff.isBackwardsCompatible).toBe(false);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]).toMatchObject({
        type: "removed",
        kind: "Person",
        severity: "breaking",
      });
      expect(diff.nodes[0]!.before).toBeDefined();
      expect(diff.nodes[0]!.after).toBeUndefined();
    });

    it("detects added optional property as safe change", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
              required: ["name"], // email is optional
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]).toMatchObject({
        type: "modified",
        kind: "Person",
        severity: "safe",
      });
      expect(diff.nodes[0]!.details).toContain("email");
      expect(diff.nodes[0]!.details).toContain("added");
    });

    it("detects removed property as breaking change", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: {
                name: { type: "string" },
                age: { type: "number" },
              },
              required: ["name"],
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(true);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]).toMatchObject({
        type: "modified",
        kind: "Person",
        severity: "breaking",
      });
      expect(diff.nodes[0]!.details).toContain("age");
      expect(diff.nodes[0]!.details).toContain("removed");
    });

    it("detects new required property as breaking change", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
              },
              required: ["name", "email"], // email is now required
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(true);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]).toMatchObject({
        type: "modified",
        kind: "Person",
        severity: "breaking",
      });
      expect(diff.nodes[0]!.details).toContain("email");
      expect(diff.nodes[0]!.details).toContain("required");
    });

    it("detects onDelete change as warning", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "cascade",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]).toMatchObject({
        type: "modified",
        kind: "Person",
        severity: "warning",
      });
      expect(diff.nodes[0]!.details).toContain("onDelete");
      expect(diff.nodes[0]!.details).toContain("restrict");
      expect(diff.nodes[0]!.details).toContain("cascade");
    });

    it("detects unique constraint change as warning", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { email: { type: "string" } },
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { email: { type: "string" } },
            },
            uniqueConstraints: [
              {
                name: "unique_email",
                fields: ["email"],
                where: undefined,
                scope: "kind",
                collation: "binary",
              },
            ],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]).toMatchObject({
        type: "modified",
        kind: "Person",
        severity: "warning",
      });
      expect(diff.nodes[0]!.details).toContain("Unique constraints");
    });

    it("handles multiple node changes", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
          OldNode: {
            kind: "OldNode",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
          NewNode: {
            kind: "NewNode",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.nodes).toHaveLength(2);
      expect(diff.nodes.find((n) => n.kind === "OldNode")?.type).toBe(
        "removed",
      );
      expect(diff.nodes.find((n) => n.kind === "NewNode")?.type).toBe("added");
    });

    it("detects property type change as modification", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { age: { type: "string" } },
              required: [],
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: {
              type: "object",
              properties: { age: { type: "number" } },
              required: [],
            },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.nodes).toHaveLength(1);
      expect(diff.nodes[0]!.type).toBe("modified");
    });
  });

  // ============================================================
  // Edge Changes
  // ============================================================

  describe("edge changes", () => {
    it("detects added edge as safe change", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.edges).toHaveLength(1);
      expect(diff.edges[0]).toMatchObject({
        type: "added",
        kind: "follows",
        severity: "safe",
      });
    });

    it("detects removed edge as breaking change", () => {
      const before = createSchema({
        version: 1,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });
      const after = createSchema({ version: 2 });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(true);
      expect(diff.edges).toHaveLength(1);
      expect(diff.edges[0]).toMatchObject({
        type: "removed",
        kind: "follows",
        severity: "breaking",
      });
    });

    it("detects fromKinds change as warning", () => {
      const before = createSchema({
        version: 1,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person", "Bot"],
            toKinds: ["Person"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.edges).toHaveLength(1);
      expect(diff.edges[0]).toMatchObject({
        type: "modified",
        kind: "follows",
        severity: "warning",
      });
      expect(diff.edges[0]!.details).toContain("fromKinds");
    });

    it("detects toKinds change as warning", () => {
      const before = createSchema({
        version: 1,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person"],
            toKinds: ["Person", "Organization"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.edges).toHaveLength(1);
      expect(diff.edges[0]).toMatchObject({
        type: "modified",
        severity: "warning",
      });
      expect(diff.edges[0]!.details).toContain("toKinds");
    });

    it("detects cardinality change as warning", () => {
      const before = createSchema({
        version: 1,
        edges: {
          worksAt: {
            kind: "worksAt",
            fromKinds: ["Person"],
            toKinds: ["Company"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        edges: {
          worksAt: {
            kind: "worksAt",
            fromKinds: ["Person"],
            toKinds: ["Company"],
            properties: { type: "object", properties: {} },
            cardinality: "one",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.edges).toHaveLength(1);
      expect(diff.edges[0]).toMatchObject({
        type: "modified",
        severity: "warning",
      });
      expect(diff.edges[0]!.details).toContain("Cardinality");
      expect(diff.edges[0]!.details).toContain("many");
      expect(diff.edges[0]!.details).toContain("one");
    });

    it("detects edge property change as safe", () => {
      const before = createSchema({
        version: 1,
        edges: {
          worksAt: {
            kind: "worksAt",
            fromKinds: ["Person"],
            toKinds: ["Company"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        edges: {
          worksAt: {
            kind: "worksAt",
            fromKinds: ["Person"],
            toKinds: ["Company"],
            properties: {
              type: "object",
              properties: { role: { type: "string" } },
            },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.edges).toHaveLength(1);
      expect(diff.edges[0]).toMatchObject({
        type: "modified",
        severity: "safe",
      });
      expect(diff.edges[0]!.details).toContain("Properties");
    });

    it("handles multiple edge changes in single diff", () => {
      const before = createSchema({
        version: 1,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person", "Bot"], // fromKinds changed
            toKinds: ["Person", "Organization"], // toKinds changed
            properties: { type: "object", properties: {} },
            cardinality: "one", // cardinality changed
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      // Should have 3 changes for the same edge
      expect(diff.edges).toHaveLength(3);
      expect(diff.edges.filter((edge) => edge.kind === "follows")).toHaveLength(
        3,
      );
    });
  });

  // ============================================================
  // Ontology Changes
  // ============================================================

  describe("ontology changes", () => {
    it("detects added meta-edge as safe change", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        ontology: {
          ...emptyOntology(),
          metaEdges: {
            subClassOf: {
              name: "subClassOf",
              transitive: true,
              symmetric: false,
              reflexive: false,
              inverse: undefined,
              inference: "none",
              description: undefined,
            },
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.ontology).toHaveLength(1);
      expect(diff.ontology[0]).toMatchObject({
        type: "added",
        entity: "metaEdge",
        name: "subClassOf",
        severity: "safe",
      });
    });

    it("detects removed meta-edge as breaking change", () => {
      const before = createSchema({
        version: 1,
        ontology: {
          ...emptyOntology(),
          metaEdges: {
            subClassOf: {
              name: "subClassOf",
              transitive: true,
              symmetric: false,
              reflexive: false,
              inverse: undefined,
              inference: "none",
              description: undefined,
            },
          },
        },
      });
      const after = createSchema({ version: 2 });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(true);
      expect(diff.ontology).toHaveLength(1);
      expect(diff.ontology[0]).toMatchObject({
        type: "removed",
        entity: "metaEdge",
        name: "subClassOf",
        severity: "breaking",
      });
    });

    it("detects added relation as safe change", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        ontology: {
          ...emptyOntology(),
          relations: [
            { metaEdge: "subClassOf", from: "Employee", to: "Person" },
          ],
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false);
      expect(diff.ontology).toHaveLength(1);
      expect(diff.ontology[0]).toMatchObject({
        type: "added",
        entity: "relation",
        severity: "safe",
      });
      expect(diff.ontology[0]!.details).toContain("subClassOf");
      expect(diff.ontology[0]!.details).toContain("Employee");
      expect(diff.ontology[0]!.details).toContain("Person");
    });

    it("detects removed relation as warning", () => {
      const before = createSchema({
        version: 1,
        ontology: {
          ...emptyOntology(),
          relations: [
            { metaEdge: "subClassOf", from: "Employee", to: "Person" },
          ],
        },
      });
      const after = createSchema({ version: 2 });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasChanges).toBe(true);
      expect(diff.hasBreakingChanges).toBe(false); // Relations are warning, not breaking
      expect(diff.ontology).toHaveLength(1);
      expect(diff.ontology[0]).toMatchObject({
        type: "removed",
        entity: "relation",
        severity: "warning",
      });
    });
  });

  // ============================================================
  // Summary Generation
  // ============================================================

  describe("summary generation", () => {
    it("generates summary for node changes", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
          Company: {
            kind: "Company",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.summary).toContain("Nodes:");
      expect(diff.summary).toContain("2 added");
    });

    it("generates summary for edge changes", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.summary).toContain("Edges:");
      expect(diff.summary).toContain("1 added");
    });

    it("generates summary for ontology changes", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        ontology: {
          ...emptyOntology(),
          metaEdges: {
            subClassOf: {
              name: "subClassOf",
              transitive: true,
              symmetric: false,
              reflexive: false,
              inverse: undefined,
              inference: "none",
              description: undefined,
            },
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.summary).toContain("Ontology:");
      expect(diff.summary).toContain("1 added");
    });

    it("generates combined summary for multiple change types", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          OldNode: {
            kind: "OldNode",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          NewNode: {
            kind: "NewNode",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
        edges: {
          follows: {
            kind: "follows",
            fromKinds: ["NewNode"],
            toKinds: ["NewNode"],
            properties: { type: "object", properties: {} },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.summary).toContain("Nodes:");
      expect(diff.summary).toContain("1 added");
      expect(diff.summary).toContain("1 removed");
      expect(diff.summary).toContain("Edges:");
    });
  });

  // ============================================================
  // hasBreakingChanges Flag
  // ============================================================

  describe("hasBreakingChanges flag", () => {
    it("is false when only safe changes exist", () => {
      const before = createSchema({ version: 1 });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasBreakingChanges).toBe(false);
    });

    it("is false when only warning changes exist", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "cascade",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasBreakingChanges).toBe(false);
    });

    it("is true when any breaking change exists", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({ version: 2 });

      const diff = computeSchemaDiff(before, after);

      expect(diff.hasBreakingChanges).toBe(true);
    });

    it("is true even when mixed with safe changes", () => {
      const before = createSchema({
        version: 1,
        nodes: {
          Person: {
            kind: "Person",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });
      const after = createSchema({
        version: 2,
        nodes: {
          NewSafeNode: {
            kind: "NewSafeNode",
            properties: { type: "object", properties: {} },
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
          },
        },
      });

      const diff = computeSchemaDiff(before, after);

      // Person removed (breaking) + NewSafeNode added (safe)
      expect(diff.hasBreakingChanges).toBe(true);
    });
  });
});

// ============================================================
// isBackwardsCompatible
// ============================================================

describe("isBackwardsCompatible", () => {
  it("returns true when no breaking changes", () => {
    const before = createSchema({ version: 1 });
    const after = createSchema({
      version: 2,
      nodes: {
        Person: {
          kind: "Person",
          properties: { type: "object", properties: {} },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });

    const diff = computeSchemaDiff(before, after);

    expect(isBackwardsCompatible(diff)).toBe(true);
  });

  it("returns false when breaking changes exist", () => {
    const before = createSchema({
      version: 1,
      nodes: {
        Person: {
          kind: "Person",
          properties: { type: "object", properties: {} },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });
    const after = createSchema({ version: 2 });

    const diff = computeSchemaDiff(before, after);

    expect(isBackwardsCompatible(diff)).toBe(false);
  });
});

// ============================================================
// getMigrationActions
// ============================================================

describe("getMigrationActions", () => {
  it("returns empty array when no actions needed", () => {
    const before = createSchema({ version: 1 });
    const after = createSchema({
      version: 2,
      nodes: {
        Person: {
          kind: "Person",
          properties: { type: "object", properties: {} },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });

    const diff = computeSchemaDiff(before, after);
    const actions = getMigrationActions(diff);

    expect(actions).toHaveLength(0);
  });

  it("returns DELETE action for removed node", () => {
    const before = createSchema({
      version: 1,
      nodes: {
        Person: {
          kind: "Person",
          properties: { type: "object", properties: {} },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });
    const after = createSchema({ version: 2 });

    const diff = computeSchemaDiff(before, after);
    const actions = getMigrationActions(diff);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain("DELETE");
    expect(actions[0]).toContain("Person");
  });

  it("returns DELETE action for removed edge", () => {
    const before = createSchema({
      version: 1,
      edges: {
        follows: {
          kind: "follows",
          fromKinds: ["Person"],
          toKinds: ["Person"],
          properties: { type: "object", properties: {} },
          cardinality: "many",
          endpointExistence: "notDeleted",
          description: undefined,
        },
      },
    });
    const after = createSchema({ version: 2 });

    const diff = computeSchemaDiff(before, after);
    const actions = getMigrationActions(diff);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain("DELETE");
    expect(actions[0]).toContain("follows");
  });

  it("returns MIGRATE action for breaking node modification", () => {
    const before = createSchema({
      version: 1,
      nodes: {
        Person: {
          kind: "Person",
          properties: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "number" },
            },
            required: ["name"],
          },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });
    const after = createSchema({
      version: 2,
      nodes: {
        Person: {
          kind: "Person",
          properties: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });

    const diff = computeSchemaDiff(before, after);
    const actions = getMigrationActions(diff);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain("MIGRATE");
    expect(actions[0]).toContain("Person");
  });

  it("returns multiple actions for multiple changes", () => {
    const before = createSchema({
      version: 1,
      nodes: {
        Person: {
          kind: "Person",
          properties: { type: "object", properties: {} },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
        Company: {
          kind: "Company",
          properties: { type: "object", properties: {} },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
      edges: {
        worksAt: {
          kind: "worksAt",
          fromKinds: ["Person"],
          toKinds: ["Company"],
          properties: { type: "object", properties: {} },
          cardinality: "many",
          endpointExistence: "notDeleted",
          description: undefined,
        },
      },
    });
    const after = createSchema({ version: 2 });

    const diff = computeSchemaDiff(before, after);
    const actions = getMigrationActions(diff);

    // 2 nodes removed + 1 edge removed
    expect(actions).toHaveLength(3);
    expect(actions.filter((a) => a.includes("Person"))).toHaveLength(1);
    expect(actions.filter((a) => a.includes("Company"))).toHaveLength(1);
    expect(actions.filter((a) => a.includes("worksAt"))).toHaveLength(1);
  });

  it("does not return action for safe modifications", () => {
    const before = createSchema({
      version: 1,
      nodes: {
        Person: {
          kind: "Person",
          properties: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });
    const after = createSchema({
      version: 2,
      nodes: {
        Person: {
          kind: "Person",
          properties: {
            type: "object",
            properties: {
              name: { type: "string" },
              nickname: { type: "string" }, // optional property added
            },
            required: ["name"],
          },
          uniqueConstraints: [],
          onDelete: "restrict",
          description: undefined,
        },
      },
    });

    const diff = computeSchemaDiff(before, after);
    const actions = getMigrationActions(diff);

    expect(actions).toHaveLength(0);
  });
});
