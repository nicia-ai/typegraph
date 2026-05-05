/**
 * Tests for serialized schema parse validation.
 *
 * Verifies that the Zod schema (serializedSchemaZod) correctly rejects
 * malformed, truncated, and structurally wrong schema documents that
 * could be read from a corrupted or incompatible database.
 */
import { describe, expect, it } from "vitest";

import { serializedSchemaZod } from "../src/schema/types";

// ============================================================
// Helpers
// ============================================================

/** Minimal valid schema document that passes validation. */
function createValidSchemaDocument() {
  return {
    graphId: "test",
    version: 1,
    generatedAt: "2025-01-01T00:00:00.000Z",
    nodes: {},
    edges: {},
    ontology: {
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
    },
    defaults: {
      onNodeDelete: "restrict",
      temporalMode: "includeEnded",
    },
  };
}

// ============================================================
// Tests
// ============================================================

describe("serializedSchemaZod", () => {
  describe("valid schemas", () => {
    it("accepts a minimal valid schema", () => {
      const result = serializedSchemaZod.safeParse(createValidSchemaDocument());
      expect(result.success).toBe(true);
    });

    it("accepts a schema with node and edge definitions", () => {
      const document = createValidSchemaDocument();
      const withDefs = {
        ...document,
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
            annotations: {
              ui: { titleField: "name" },
            },
          },
        },
        edges: {
          knows: {
            kind: "knows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: { type: "object" },
            cardinality: "many",
            endpointExistence: "notDeleted",
            description: undefined,
            annotations: {
              ui: { showInTimeline: true },
            },
          },
        },
      };

      const result = serializedSchemaZod.safeParse(withDefs);
      expect(result.success).toBe(true);
    });

    it("accepts extra fields on nested objects (forward compatibility)", () => {
      const document = createValidSchemaDocument();
      const withExtra = {
        ...document,
        nodes: {
          Person: {
            kind: "Person",
            properties: {},
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
            futureField: "from-newer-version",
          },
        },
      };

      const result = serializedSchemaZod.safeParse(withExtra);
      expect(result.success).toBe(true);
    });
  });

  describe("invalid JSON shapes", () => {
    it("rejects null", () => {
      // eslint-disable-next-line unicorn/no-null -- testing null input from DB
      const result = serializedSchemaZod.safeParse(null);
      expect(result.success).toBe(false);
    });

    it("rejects a string", () => {
      const result = serializedSchemaZod.safeParse("not-an-object");
      expect(result.success).toBe(false);
    });

    it("rejects an array", () => {
      const result = serializedSchemaZod.safeParse([1, 2, 3]);
      expect(result.success).toBe(false);
    });

    it("rejects an empty object with error details", () => {
      const result = serializedSchemaZod.safeParse({});
      expect(result.success).toBe(false);
      expect(result.error?.issues.length).toBeGreaterThan(0);
    });
  });

  describe("missing top-level fields", () => {
    it("rejects missing graphId", () => {
      const { graphId: _, ...document } = createValidSchemaDocument();
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects missing version", () => {
      const { version: _, ...document } = createValidSchemaDocument();
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects missing nodes", () => {
      const { nodes: _, ...document } = createValidSchemaDocument();
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects missing edges", () => {
      const { edges: _, ...document } = createValidSchemaDocument();
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects missing ontology", () => {
      const { ontology: _, ...document } = createValidSchemaDocument();
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects missing defaults", () => {
      const { defaults: _, ...document } = createValidSchemaDocument();
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });
  });

  describe("wrong types in top-level fields", () => {
    it("rejects graphId as number", () => {
      const document = { ...createValidSchemaDocument(), graphId: 123 };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects version as string", () => {
      const document = { ...createValidSchemaDocument(), version: "1" };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects nodes as array", () => {
      const document = { ...createValidSchemaDocument(), nodes: [] };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });
  });

  describe("wrong nested shapes", () => {
    it("rejects node definition missing kind", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            // kind is missing
            properties: {},
            uniqueConstraints: [],
            onDelete: "restrict",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects edge definition missing fromKinds", () => {
      const document = {
        ...createValidSchemaDocument(),
        edges: {
          knows: {
            kind: "knows",
            // fromKinds is missing
            toKinds: ["Person"],
            properties: {},
            cardinality: "many",
            endpointExistence: "notDeleted",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects ontology missing closures", () => {
      const document = {
        ...createValidSchemaDocument(),
        ontology: {
          metaEdges: {},
          relations: [],
          // closures is missing
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects defaults missing temporalMode", () => {
      const document = {
        ...createValidSchemaDocument(),
        defaults: {
          onNodeDelete: "restrict",
          // temporalMode is missing
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects closures missing required fields", () => {
      const document = {
        ...createValidSchemaDocument(),
        ontology: {
          metaEdges: {},
          relations: [],
          closures: {
            subClassAncestors: {},
            // all other fields missing
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects unique constraint missing name", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: "Person",
            properties: {},
            uniqueConstraints: [
              {
                // name is missing
                fields: ["email"],
                scope: "kind",
                collation: "binary",
              },
            ],
            onDelete: "restrict",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });
  });

  describe("error quality", () => {
    it("provides path information in error issues", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: 42, // wrong type
            properties: {},
            uniqueConstraints: [],
            onDelete: "restrict",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
      const kindIssue = result.error?.issues.find(
        (issue) => issue.path.join(".") === "nodes.Person.kind",
      );
      expect(kindIssue).toBeDefined();
    });
  });

  describe("enum field validation", () => {
    it("rejects unknown temporalMode value", () => {
      const document = {
        ...createValidSchemaDocument(),
        defaults: {
          onNodeDelete: "restrict",
          temporalMode: "futureMode",
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects unknown deleteBehavior value on node", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: "Person",
            properties: {},
            uniqueConstraints: [],
            onDelete: "softPurge",
            description: undefined,
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects unknown cardinality value on edge", () => {
      const document = {
        ...createValidSchemaDocument(),
        edges: {
          knows: {
            kind: "knows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: {},
            cardinality: "exactlyTwo",
            endpointExistence: "notDeleted",
            description: undefined,
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects unknown collation in unique constraint", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: "Person",
            properties: {},
            uniqueConstraints: [
              {
                name: "email_unique",
                fields: ["email"],
                scope: "kind",
                collation: "unicodeCI",
              },
            ],
            onDelete: "restrict",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("accepts all known enum values", () => {
      const document = {
        ...createValidSchemaDocument(),
        defaults: {
          onNodeDelete: "cascade",
          temporalMode: "asOf",
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(true);
    });
  });

  describe("record key/value consistency", () => {
    it("rejects node where record key does not match kind", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: "Company",
            properties: {},
            uniqueConstraints: [],
            onDelete: "restrict",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("Person");
      expect(result.error?.issues[0]?.message).toContain("Company");
    });

    it("rejects edge where record key does not match kind", () => {
      const document = {
        ...createValidSchemaDocument(),
        edges: {
          knows: {
            kind: "worksAt",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: {},
            cardinality: "many",
            endpointExistence: "notDeleted",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("knows");
      expect(result.error?.issues[0]?.message).toContain("worksAt");
    });

    it("rejects metaEdge where record key does not match name", () => {
      const document = createValidSchemaDocument();
      const withMismatch = {
        ...document,
        ontology: {
          ...document.ontology,
          metaEdges: {
            subClassOf: {
              name: "broader",
              transitive: true,
              symmetric: false,
              reflexive: false,
              inference: "subsumption",
            },
          },
        },
      };
      const result = serializedSchemaZod.safeParse(withMismatch);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("subClassOf");
      expect(result.error?.issues[0]?.message).toContain("broader");
    });

    it("accepts when record keys match embedded identifiers", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: "Person",
            properties: {},
            uniqueConstraints: [],
            onDelete: "restrict",
          },
        },
        edges: {
          knows: {
            kind: "knows",
            fromKinds: ["Person"],
            toKinds: ["Person"],
            properties: {},
            cardinality: "many",
            endpointExistence: "notDeleted",
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(true);
    });
  });

  describe("annotations JSON validation", () => {
    it("accepts annotations containing nested plain JSON values", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: "Person",
            properties: {},
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
            annotations: {
              ui: { titleField: "name", icon: "user" },
              audit: { pii: false, retentionDays: 365 },
              // eslint-disable-next-line unicorn/no-null -- valid JSON value
              tags: ["a", "b", null],
            },
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(true);
    });

    it("rejects annotations containing non-JSON values at the parse boundary", () => {
      const document = {
        ...createValidSchemaDocument(),
        nodes: {
          Person: {
            kind: "Person",
            properties: {},
            uniqueConstraints: [],
            onDelete: "restrict",
            description: undefined,
            annotations: {
              audit: { handler: () => 1 },
            },
          },
        },
      };
      const result = serializedSchemaZod.safeParse(document);
      expect(result.success).toBe(false);
    });

    it("rejects annotations containing non-finite numbers at the parse boundary", () => {
      for (const badValue of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      ]) {
        const document = {
          ...createValidSchemaDocument(),
          nodes: {
            Person: {
              kind: "Person",
              properties: {},
              uniqueConstraints: [],
              onDelete: "restrict",
              description: undefined,
              annotations: { stats: { mean: badValue } },
            },
          },
        };
        expect(serializedSchemaZod.safeParse(document).success).toBe(false);
      }
    });
  });
});
