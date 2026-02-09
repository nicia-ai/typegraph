/**
 * Schema Serialization Tests
 *
 * TypeGraph supports homoiconic storage - schemas are serialized to JSON
 * and stored alongside the data. This enables:
 *   - Runtime schema introspection
 *   - Schema migrations with diff computation
 *   - Portable schema definitions
 *
 * Key functions:
 *   - serializeSchema(graph, version) - Converts a GraphDef to JSON
 *   - computeSchemaHash(serialized) - Content hash for change detection
 *   - computeSchemaDiff(old, new) - Computes migration actions
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  computeSchemaDiff,
  computeSchemaHash,
  defineEdge,
  defineGraph,
  defineNode,
  deserializeWherePredicate,
  serializeSchema,
  subClassOf,
} from "../src";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number().int(),
  }),
  description: "A person entity",
});

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
    taxId: z.string().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    taxId: z.string().optional(),
    ticker: z.string().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
  description: "Employment relationship",
});

describe("serializeSchema", () => {
  it("serializes a graph definition to JSON", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: {
        Person: { type: Person },
      },
      edges: {},
    });

    const serialized = serializeSchema(graph, 1);

    expect(serialized.graphId).toBe("test_graph");
    expect(serialized.version).toBe(1);
    expect(serialized.nodes.Person).toBeDefined();
    expect(serialized.nodes.Person?.name).toBe("Person");
  });

  it("includes node descriptions", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const serialized = serializeSchema(graph, 1);

    expect(serialized.nodes.Person?.description).toBe("A person entity");
  });

  it("serializes node properties to JSON Schema", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const serialized = serializeSchema(graph, 1);
    const properties = serialized.nodes.Person?.properties;

    expect(properties).toHaveProperty("type", "object");
  });

  it("serializes edge definitions with endpoints", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
      },
      edges: {
        worksAt: {
          type: worksAt,
          from: [Person],
          to: [Organization],
        },
      },
    });

    const serialized = serializeSchema(graph, 1);

    expect(serialized.edges.worksAt?.fromKinds).toEqual(["Person"]);
    expect(serialized.edges.worksAt?.toKinds).toEqual(["Organization"]);
    expect(serialized.edges.worksAt?.cardinality).toBe("many");
  });

  it("serializes ontology relations and computes closures", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: {
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [subClassOf(Company, Organization)],
    });

    const serialized = serializeSchema(graph, 1);

    expect(serialized.ontology.relations).toHaveLength(1);
    expect(serialized.ontology.relations[0]?.metaEdge).toBe("subClassOf");
    expect(serialized.ontology.relations[0]?.from).toBe("Company");
    expect(serialized.ontology.relations[0]?.to).toBe("Organization");

    expect(serialized.ontology.closures.subClassAncestors.Company).toContain(
      "Organization",
    );
  });

  it("serializes uniqueness constraints", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: {
        Person: {
          type: Person,
          unique: [
            {
              name: "unique_name",
              fields: ["name"],
              scope: "kind",
              collation: "binary",
            },
          ],
        },
      },
      edges: {},
    });

    const serialized = serializeSchema(graph, 1);

    expect(serialized.nodes.Person?.uniqueConstraints).toHaveLength(1);
    expect(serialized.nodes.Person?.uniqueConstraints[0]?.name).toBe(
      "unique_name",
    );
    expect(serialized.nodes.Person?.uniqueConstraints[0]?.fields).toEqual([
      "name",
    ]);
  });

  it("serializes uniqueness constraint where predicates", () => {
    const UserNode = defineNode("User", {
      schema: z.object({
        name: z.string(),
        deletedAt: z.string().optional(),
      }),
    });

    const graph = defineGraph({
      id: "test_graph",
      nodes: {
        User: {
          type: UserNode,
          unique: [
            {
              name: "active_name_unique",
              fields: ["name"],
              scope: "kind",
              collation: "caseInsensitive",
              where: (props) => props.deletedAt!.isNull(),
            },
          ],
        },
      },
      edges: {},
    });

    const serialized = serializeSchema(graph, 1);
    const constraint = serialized.nodes.User?.uniqueConstraints[0];

    expect(constraint?.where).toBeDefined();
    expect(constraint?.where).not.toBe("[predicate]");

    // Verify it's valid JSON that captures the predicate structure
    const parsed = JSON.parse(constraint!.where!);
    expect(parsed.field).toBe("deletedAt");
    expect(parsed.op).toBe("isNull");
  });

  it("serializes isNotNull where predicates", () => {
    const ItemNode = defineNode("Item", {
      schema: z.object({
        sku: z.string(),
        archivedAt: z.string().optional(),
      }),
    });

    const graph = defineGraph({
      id: "test_graph",
      nodes: {
        Item: {
          type: ItemNode,
          unique: [
            {
              name: "archived_sku_unique",
              fields: ["sku"],
              scope: "kind",
              collation: "binary",
              where: (props) => props.archivedAt!.isNotNull(),
            },
          ],
        },
      },
      edges: {},
    });

    const serialized = serializeSchema(graph, 1);
    const constraint = serialized.nodes.Item?.uniqueConstraints[0];

    const parsed = JSON.parse(constraint!.where!);
    expect(parsed.field).toBe("archivedAt");
    expect(parsed.op).toBe("isNotNull");
  });

  it("deserializes where predicates back to functions", () => {
    const serialized = JSON.stringify({ field: "status", op: "isNull" });
    const deserializedWhere = deserializeWherePredicate(serialized);

    // Create a mock builder and call the deserialized function
    const mockBuilder = {
      status: {
        isNull: () => ({
          __type: "unique_predicate" as const,
          field: "status",
          op: "isNull" as const,
        }),
        isNotNull: () => ({
          __type: "unique_predicate" as const,
          field: "status",
          op: "isNotNull" as const,
        }),
      },
    };

    const result = deserializedWhere(mockBuilder);
    expect(result.field).toBe("status");
    expect(result.op).toBe("isNull");
  });

  it("serializes graph defaults", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
      defaults: {
        onNodeDelete: "cascade",
        temporalMode: "includeEnded",
      },
    });

    const serialized = serializeSchema(graph, 1);

    expect(serialized.defaults.onNodeDelete).toBe("cascade");
    expect(serialized.defaults.temporalMode).toBe("includeEnded");
  });
});

describe("computeSchemaHash", () => {
  it("produces consistent hashes for the same schema", async () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const serialized1 = serializeSchema(graph, 1);
    const serialized2 = serializeSchema(graph, 1);

    const hash1 = await computeSchemaHash(serialized1);
    const hash2 = await computeSchemaHash(serialized2);

    expect(hash1).toBe(hash2);
  });

  it("ignores version and generatedAt for hashing", async () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const serialized1 = serializeSchema(graph, 1);
    const serialized2 = serializeSchema(graph, 2);

    const hash1 = await computeSchemaHash(serialized1);
    const hash2 = await computeSchemaHash(serialized2);

    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different schemas", async () => {
    const graph1 = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const graph2 = defineGraph({
      id: "test_graph",
      nodes: { Organization: { type: Organization } },
      edges: {},
    });

    const hash1 = await computeSchemaHash(serializeSchema(graph1, 1));
    const hash2 = await computeSchemaHash(serializeSchema(graph2, 1));

    expect(hash1).not.toBe(hash2);
  });
});

describe("computeSchemaDiff", () => {
  it("detects added node kinds", () => {
    const oldGraph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const newGraph = defineGraph({
      id: "test_graph",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
      },
      edges: {},
    });

    const oldSchema = serializeSchema(oldGraph, 1);
    const newSchema = serializeSchema(newGraph, 2);
    const diff = computeSchemaDiff(oldSchema, newSchema);

    const addedNodes = diff.nodes.filter((n) => n.type === "added");
    expect(addedNodes.map((n) => n.name)).toContain("Organization");
  });

  it("detects removed node kinds", () => {
    const oldGraph = defineGraph({
      id: "test_graph",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
      },
      edges: {},
    });

    const newGraph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const diff = computeSchemaDiff(
      serializeSchema(oldGraph, 1),
      serializeSchema(newGraph, 2),
    );

    const removedNodes = diff.nodes.filter((n) => n.type === "removed");
    expect(removedNodes.map((n) => n.name)).toContain("Organization");
  });

  it("detects added edge kinds", () => {
    const oldGraph = defineGraph({
      id: "test_graph",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
      },
      edges: {},
    });

    const newGraph = defineGraph({
      id: "test_graph",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
      },
      edges: {
        worksAt: {
          type: worksAt,
          from: [Person],
          to: [Organization],
        },
      },
    });

    const diff = computeSchemaDiff(
      serializeSchema(oldGraph, 1),
      serializeSchema(newGraph, 2),
    );

    const addedEdges = diff.edges.filter((edge) => edge.type === "added");
    expect(addedEdges.map((edge) => edge.name)).toContain("worksAt");
  });

  it("detects when schemas are identical", () => {
    const graph = defineGraph({
      id: "test_graph",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const schema1 = serializeSchema(graph, 1);
    const schema2 = serializeSchema(graph, 2);
    const diff = computeSchemaDiff(schema1, schema2);

    expect(diff.hasChanges).toBe(false);
  });

  it("detects ontology changes", () => {
    const oldGraph = defineGraph({
      id: "test_graph",
      nodes: {
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
    });

    const newGraph = defineGraph({
      id: "test_graph",
      nodes: {
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [subClassOf(Company, Organization)],
    });

    const diff = computeSchemaDiff(
      serializeSchema(oldGraph, 1),
      serializeSchema(newGraph, 2),
    );

    // Adding subClassOf relation adds both the meta-edge and the relation
    const addedItems = diff.ontology.filter((o) => o.type === "added");
    expect(addedItems.length).toBeGreaterThanOrEqual(1);
    expect(addedItems.some((o) => o.entity === "relation")).toBe(true);
  });
});
