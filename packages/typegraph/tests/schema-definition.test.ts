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
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  getEdgeKinds,
  getNodeKinds,
  subClassOf,
} from "../src";
import { type DefineEdgeOptions } from "../src/core/edge";
import { type DefineNodeOptions } from "../src/core/node";

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

  it("accepts consumer-owned annotations", () => {
    const Incident = defineNode("Incident", {
      schema: z.object({ title: z.string() }),
      annotations: {
        ui: { titleField: "title", icon: "alert-triangle" },
        audit: { pii: false },
      },
    });

    expect(Incident.annotations).toEqual({
      ui: { titleField: "title", icon: "alert-triangle" },
      audit: { pii: false },
    });
  });

  describe("annotations JSON validation", () => {
    const baseSchema = z.object({ name: z.string() });

    it("rejects bigint values", () => {
      expect(() =>
        defineNode("Bad", badNodeOptions({ audit: { version: 1n } })),
      ).toThrow(ConfigurationError);
    });

    it("rejects function values", () => {
      expect(() =>
        defineNode("Bad", badNodeOptions({ onClick: noop })),
      ).toThrow(ConfigurationError);
    });

    it("rejects symbol values", () => {
      expect(() =>
        defineNode("Bad", badNodeOptions({ tag: Symbol("x") })),
      ).toThrow(ConfigurationError);
    });

    it("rejects explicit undefined values", () => {
      expect(() =>
        defineNode("Bad", badNodeOptions({ value: undefined })),
      ).toThrow(ConfigurationError);
    });

    it("rejects Date instances", () => {
      expect(() =>
        defineNode("Bad", badNodeOptions({ createdAt: new Date() })),
      ).toThrow(ConfigurationError);
    });

    it("rejects Set and other class instances", () => {
      expect(() =>
        defineNode("Bad", badNodeOptions({ tags: new Set(["a"]) })),
      ).toThrow(ConfigurationError);
    });

    it("rejects non-JSON values nested inside arrays", () => {
      expect(() =>
        defineNode("Bad", badNodeOptions({ items: [1, noop] })),
      ).toThrow(ConfigurationError);
    });

    it("rejects NaN, Infinity, and -Infinity", () => {
      // JSON.stringify silently coerces these to "null", which would
      // change the canonical hash without the consumer noticing.
      expect(() =>
        defineNode("Bad", badNodeOptions({ score: Number.NaN })),
      ).toThrow(/NaN/);
      expect(() =>
        defineNode("Bad", badNodeOptions({ score: Number.POSITIVE_INFINITY })),
      ).toThrow(/Infinity/);
      expect(() =>
        defineNode("Bad", badNodeOptions({ score: Number.NEGATIVE_INFINITY })),
      ).toThrow(/-Infinity/);
      expect(() =>
        defineNode("Bad", badNodeOptions({ stats: { mean: Number.NaN } })),
      ).toThrow(/annotations\.stats\.mean.*NaN/s);
    });

    it("error message includes the offending path and node kind", () => {
      expect(() =>
        defineNode("Incident", badNodeOptions({ audit: { version: 1n } })),
      ).toThrow(/Node "Incident".*annotations\.audit\.version.*bigint/s);
    });

    it("accepts null, nested arrays, and deep plain objects", () => {
      expect(() =>
        defineNode("Good", {
          schema: baseSchema,
          annotations: {
            // eslint-disable-next-line unicorn/no-null -- valid JSON value
            placeholder: null,
            tags: ["a", "b", ["nested"]],
            nested: { deeper: { value: 42 } },
          },
        }),
      ).not.toThrow();
    });
  });
});

// Helpers hoisted outside any describe so they aren't recreated per test —
// silences unicorn/consistent-function-scoping. Casts simulate untyped JS
// callers or `as any` escape hatches that reach the runtime guard.
function noop(): number {
  return 0;
}

function badNodeOptions(
  annotations: unknown,
): DefineNodeOptions<z.ZodObject<{ name: z.ZodString }>> {
  return {
    schema: z.object({ name: z.string() }),
    annotations,
  } as unknown as DefineNodeOptions<z.ZodObject<{ name: z.ZodString }>>;
}

function badEdgeOptions(
  annotations: unknown,
): DefineEdgeOptions<z.ZodObject<z.ZodRawShape>> {
  return { annotations } as unknown as DefineEdgeOptions<
    z.ZodObject<z.ZodRawShape>
  >;
}

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

  it("accepts consumer-owned annotations", () => {
    const reportedBy = defineEdge("reportedBy", {
      annotations: {
        ui: { showInTimeline: true },
      },
    });

    expect(reportedBy.annotations).toEqual({
      ui: { showInTimeline: true },
    });
  });

  describe("annotations JSON validation", () => {
    it("rejects bigint values", () => {
      expect(() => defineEdge("bad", badEdgeOptions({ count: 99n }))).toThrow(
        ConfigurationError,
      );
    });

    it("rejects function values", () => {
      expect(() =>
        defineEdge("bad", badEdgeOptions({ handler: noop })),
      ).toThrow(ConfigurationError);
    });

    it("error message includes the offending path and edge kind", () => {
      expect(() =>
        defineEdge("reportedBy", badEdgeOptions({ ui: { onTap: noop } })),
      ).toThrow(/Edge "reportedBy".*annotations\.ui\.onTap.*function/s);
    });
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
    expect(graph.ontology[0].metaEdge.name).toBe("subClassOf");
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
    expect(constraint.name).toBe("person_name_unique");
    expect(constraint.fields).toEqual(["name"]);
  });
});
