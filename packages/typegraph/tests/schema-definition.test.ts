/**
 * Schema Definition Tests
 *
 * These tests demonstrate how to define graph schemas using the TypeGraph DSL.
 * The primary exports are:
 *   - defineNode() - Creates a node kind with a Zod schema
 *   - defineEdge() - Creates an edge kind with optional properties
 *   - defineGraph() - Combines nodes, edges, and ontology into a graph definition
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  getEdgeKinds,
  getNodeKinds,
  subClassOf,
} from "../src";

describe("defineNode()", () => {
  it("creates a node kind with a name and schema", () => {
    const Person = defineNode("Person", {
      schema: z.object({
        name: z.string(),
        email: z.email().optional(),
      }),
    });

    expect(Person.kind).toBe("Person");
    expect(Person.schema).toBeDefined();
  });

  it("accepts an optional description for documentation", () => {
    const Company = defineNode("Company", {
      schema: z.object({ legalName: z.string() }),
      description: "A legal business entity",
    });

    expect(Company.description).toBe("A legal business entity");
  });
});

describe("defineEdge()", () => {
  it("creates an edge kind with just a name (no properties)", () => {
    const knows = defineEdge("knows");

    expect(knows.kind).toBe("knows");
    expect(knows.schema).toBeDefined();
  });

  it("creates an edge kind with properties", () => {
    const worksAt = defineEdge("worksAt", {
      schema: z.object({
        role: z.string(),
        startDate: z.string(),
      }),
      description: "Employment relationship",
    });

    expect(worksAt.kind).toBe("worksAt");
    expect(worksAt.description).toBe("Employment relationship");
  });
});

describe("defineGraph()", () => {
  const Person = defineNode("Person", {
    schema: z.object({
      name: z.string(),
      age: z.number().int().positive(),
    }),
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
    schema: z.object({
      role: z.string(),
    }),
  });

  const knows = defineEdge("knows");

  it("combines nodes, edges, and defaults into a graph definition", () => {
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
        knows: {
          type: knows,
          from: [Person],
          to: [Person],
        },
      },
    });

    expect(graph.id).toBe("test_graph");
    expect(getNodeKinds(graph)).toEqual(["Person", "Organization"]);
    expect(getEdgeKinds(graph)).toEqual(["worksAt", "knows"]);
  });

  it("applies default settings for delete behavior and temporal mode", () => {
    const graph = defineGraph({
      id: "test_defaults",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    expect(graph.defaults.onNodeDelete).toBe("restrict");
    expect(graph.defaults.temporalMode).toBe("current");
  });

  it("allows overriding default settings", () => {
    const graph = defineGraph({
      id: "test_custom_defaults",
      nodes: { Person: { type: Person } },
      edges: {},
      defaults: {
        onNodeDelete: "cascade",
        temporalMode: "includeEnded",
      },
    });

    expect(graph.defaults.onNodeDelete).toBe("cascade");
    expect(graph.defaults.temporalMode).toBe("includeEnded");
  });

  it("supports ontology relations between node kinds", () => {
    const graph = defineGraph({
      id: "test_ontology",
      nodes: {
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [subClassOf(Company, Organization)],
    });

    expect(graph.ontology).toHaveLength(1);
    expect(graph.ontology[0]?.metaEdge.name).toBe("subClassOf");
  });

  it("supports edge cardinality constraints", () => {
    const graph = defineGraph({
      id: "test_cardinality",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
      },
      edges: {
        worksAt: {
          type: worksAt,
          from: [Person],
          to: [Organization],
          cardinality: "one",
        },
      },
    });

    const registration = graph.edges.worksAt;
    expect(registration.cardinality).toBe("one");
  });

  it("supports uniqueness constraints on nodes", () => {
    const graph = defineGraph({
      id: "test_unique",
      nodes: {
        Person: {
          type: Person,
          unique: [
            {
              name: "person_name_unique",
              fields: ["name"],
              scope: "kind",
              collation: "binary",
            },
          ],
        },
      },
      edges: {},
    });

    const registration = graph.nodes.Person;
    expect(registration).toBeDefined();
    expect(registration.unique).toHaveLength(1);
    const constraint = registration.unique[0];
    expect(constraint?.name).toBe("person_name_unique");
    expect(constraint?.fields).toEqual(["name"]);
  });
});
