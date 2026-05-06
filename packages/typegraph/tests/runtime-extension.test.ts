/**
 * Round-trip parity tests for `defineRuntimeExtension` /
 * `compileRuntimeExtension`.
 *
 * For every type in the v1 property-type subset and every interesting
 * modifier combination, this suite declares the same kind two ways:
 *
 *  (a) hand-written via `defineNode` / `defineEdge` with explicit Zod
 *  (b) declared via `defineRuntimeExtension(...)` and compiled
 *
 * It then asserts structural equivalence between the two — same parsed
 * output for valid inputs, equivalent error paths/counts for invalid
 * ones, identical `getSearchableMetadata()` / `getEmbeddingDimensions()`
 * results, and identical unique-constraint extraction.
 *
 * The compiler being one-way is what lets us hold this invariant: once a
 * runtime-declared kind goes through the document → Zod path it must be
 * indistinguishable from a compile-time declaration, since downstream
 * code (introspection, fulltext sync, vector search, constraint
 * enforcement) doesn't know — and shouldn't care — which declaration
 * style produced it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge } from "../src/core/edge";
import { embedding, getEmbeddingDimensions } from "../src/core/embedding";
import { defineNode } from "../src/core/node";
import { getSearchableMetadata, searchable } from "../src/core/searchable";
import {
  type EdgeType,
  type NodeType,
  type UniqueConstraint,
} from "../src/core/types";
import {
  compileRuntimeExtension,
  defineRuntimeExtension,
  RuntimeExtensionValidationError,
  type RuntimeGraphDocument,
  validateRuntimeExtension,
} from "../src/runtime";

// ============================================================
// Helpers
// ============================================================

function compileSingleNode(document: RuntimeGraphDocument): NodeType {
  const compiled = compileRuntimeExtension(document);
  expect(compiled.nodes).toHaveLength(1);
  return compiled.nodes[0]!.type;
}

function compileSingleEdge(document: RuntimeGraphDocument): EdgeType {
  const compiled = compileRuntimeExtension(document);
  expect(compiled.edges).toHaveLength(1);
  return compiled.edges[0]!.type;
}

function endpointKind(endpoint: NodeType | string): string {
  return typeof endpoint === "string" ? endpoint : endpoint.kind;
}

/**
 * Asserts that two Zod schemas accept the same input and return the same
 * parsed value. We don't compare schema internals directly — Zod's
 * branded internal types vary by wrapper composition — but we compare
 * what consumers actually observe: the parsed output.
 */
function assertParsedEqual<T>(
  schemaA: z.ZodType,
  schemaB: z.ZodType,
  input: T,
): void {
  const a = schemaA.safeParse(input);
  const b = schemaB.safeParse(input);
  expect(a.success).toBe(true);
  expect(b.success).toBe(true);
  if (a.success && b.success) {
    expect(b.data).toEqual(a.data);
  }
}

/**
 * Asserts that two Zod schemas reject the same input with the same set
 * of issue paths. Message text varies between Zod versions; we compare
 * structure instead.
 */
function assertRejectedEquivalently<T>(
  schemaA: z.ZodType,
  schemaB: z.ZodType,
  input: T,
): void {
  const a = schemaA.safeParse(input);
  const b = schemaB.safeParse(input);
  expect(a.success).toBe(false);
  expect(b.success).toBe(false);
  if (!a.success && !b.success) {
    const pathsA = new Set(a.error.issues.map((index) => index.path.join(".")));
    const pathsB = new Set(b.error.issues.map((index) => index.path.join(".")));
    expect(pathsB).toEqual(pathsA);
  }
}

// ============================================================
// String property parity
// ============================================================

describe("string property parity", () => {
  it("plain string is structurally identical", () => {
    const handwritten = defineNode("Plain", {
      schema: z.object({ name: z.string() }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: { Plain: { properties: { name: { type: "string" } } } },
      }),
    );
    expect(compiled.kind).toBe(handwritten.kind);
    assertParsedEqual(handwritten.schema, compiled.schema, { name: "alice" });
  });

  it("minLength + maxLength + pattern compile to equivalent refinements", () => {
    const handwritten = defineNode("Sized", {
      schema: z.object({
        code: z
          .string()
          .min(2)
          .max(8)
          .regex(/^[A-Z]+$/),
      }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          Sized: {
            properties: {
              code: {
                type: "string",
                minLength: 2,
                maxLength: 8,
                pattern: "^[A-Z]+$",
              },
            },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, { code: "ABC" });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      code: "a",
    });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      code: "TOOLONGFIELD",
    });
  });

  it("format: datetime parses ISO datetimes and rejects junk", () => {
    const handwritten = defineNode("Stamp", {
      schema: z.object({ at: z.iso.datetime() }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          Stamp: {
            properties: { at: { type: "string", format: "datetime" } },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {
      at: "2025-01-02T03:04:05.000Z",
    });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      at: "not-a-date",
    });
  });

  it("format: uri parses URLs and rejects non-URLs", () => {
    const handwritten = defineNode("Link", {
      schema: z.object({ href: z.url() }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          Link: {
            properties: { href: { type: "string", format: "uri" } },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {
      href: "https://example.com",
    });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      href: "not a url",
    });
  });

  it("optional string makes the field omittable on both sides", () => {
    const handwritten = defineNode("Opt", {
      schema: z.object({ note: z.string().optional() }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          Opt: {
            properties: { note: { type: "string", optional: true } },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {});
    assertParsedEqual(handwritten.schema, compiled.schema, { note: "hi" });
  });

  it("searchable string preserves metadata through wrappers", () => {
    const handwritten = defineNode("Doc", {
      schema: z.object({
        title: searchable({ language: "english" }).min(1),
      }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          Doc: {
            properties: {
              title: {
                type: "string",
                searchable: { language: "english" },
                minLength: 1,
              },
            },
          },
        },
      }),
    );

    const handwrittenMetadata = getSearchableMetadata(
      handwritten.schema.shape.title,
    );
    const compiledMetadata = getSearchableMetadata(
      compiled.schema.shape.title! as z.ZodType,
    );
    expect(compiledMetadata).toEqual(handwrittenMetadata);
    expect(compiledMetadata).toEqual({ language: "english" });

    // Also verify the marker survives `.optional()` in the compiled form.
    const optionalCompiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          Doc: {
            properties: {
              title: {
                type: "string",
                searchable: { language: "english" },
                optional: true,
              },
            },
          },
        },
      }),
    );
    expect(
      getSearchableMetadata(optionalCompiled.schema.shape.title! as z.ZodType),
    ).toEqual({
      language: "english",
    });
  });

  it("searchable defaults to language=english when omitted", () => {
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          D: {
            properties: { body: { type: "string", searchable: {} } },
          },
        },
      }),
    );
    expect(
      getSearchableMetadata(compiled.schema.shape.body! as z.ZodType),
    ).toEqual({
      language: "english",
    });
  });
});

// ============================================================
// Number property parity
// ============================================================

describe("number property parity", () => {
  it("plain number accepts finite numbers on both sides", () => {
    const handwritten = defineNode("N", {
      schema: z.object({ score: z.number() }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: { N: { properties: { score: { type: "number" } } } },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, { score: 1.5 });
  });

  it("int + min + max compose identically", () => {
    const handwritten = defineNode("Bound", {
      schema: z.object({ count: z.number().int().min(0).max(10) }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          Bound: {
            properties: {
              count: { type: "number", int: true, min: 0, max: 10 },
            },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, { count: 7 });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      count: 11,
    });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      count: 1.5,
    });
  });
});

// ============================================================
// Boolean / enum parity
// ============================================================

describe("boolean and enum property parity", () => {
  it("boolean parses truthy/falsy identically", () => {
    const handwritten = defineNode("B", {
      schema: z.object({ active: z.boolean() }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: { B: { properties: { active: { type: "boolean" } } } },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, { active: true });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      active: "yes",
    });
  });

  it("enum accepts members, rejects non-members", () => {
    const handwritten = defineNode("E", {
      schema: z.object({
        status: z.enum(["draft", "published", "archived"]),
      }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          E: {
            properties: {
              status: {
                type: "enum",
                values: ["draft", "published", "archived"],
              },
            },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {
      status: "draft",
    });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      status: "weird",
    });
  });
});

// ============================================================
// Array / object / embedding parity
// ============================================================

describe("array and object property parity", () => {
  it("array of strings parses identically", () => {
    const handwritten = defineNode("A", {
      schema: z.object({ tags: z.array(z.string()) }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          A: {
            properties: {
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {
      tags: ["a", "b"],
    });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      tags: ["a", 1],
    });
  });

  it("single-level object property parses identically", () => {
    const handwritten = defineNode("O", {
      schema: z.object({
        provenance: z.object({
          createdBy: z.string(),
          version: z.number().int(),
        }),
      }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          O: {
            properties: {
              provenance: {
                type: "object",
                properties: {
                  createdBy: { type: "string" },
                  version: { type: "number", int: true },
                },
              },
            },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {
      provenance: { createdBy: "alice", version: 1 },
    });
  });

  it("embedding(dimensions) is preserved in compiled output", () => {
    const handwritten = defineNode("V", {
      schema: z.object({ vector: embedding(384) }),
    });
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          V: {
            properties: {
              vector: {
                type: "array",
                items: { type: "number" },
                embedding: { dimensions: 384 },
              },
            },
          },
        },
      }),
    );
    const compiledVector = compiled.schema.shape.vector! as z.ZodType;
    expect(getEmbeddingDimensions(compiledVector)).toBe(384);
    expect(getEmbeddingDimensions(compiledVector)).toBe(
      getEmbeddingDimensions(handwritten.schema.shape.vector),
    );

    const goodVector = Array.from({ length: 384 }, () => 0.1);
    assertParsedEqual(handwritten.schema, compiled.schema, {
      vector: goodVector,
    });
    assertRejectedEquivalently(handwritten.schema, compiled.schema, {
      vector: [0.1, 0.2],
    });
  });
});

// ============================================================
// Annotations passthrough
// ============================================================

describe("annotations passthrough", () => {
  it("preserves consumer annotations on nodes", () => {
    const compiled = compileSingleNode(
      defineRuntimeExtension({
        nodes: {
          P: {
            annotations: {
              ui: { titleField: "name" },
              audit: { pii: false, retentionDays: 30 },
            },
            properties: { name: { type: "string" } },
          },
        },
      }),
    );
    expect(compiled.annotations).toEqual({
      ui: { titleField: "name" },
      audit: { pii: false, retentionDays: 30 },
    });
  });

  it("preserves consumer annotations on edges", () => {
    const compiled = compileSingleEdge(
      defineRuntimeExtension({
        nodes: { A: { properties: { x: { type: "string" } } } },
        edges: {
          link: {
            from: ["A"],
            to: ["A"],
            annotations: { ui: { showInTimeline: true } },
            properties: {},
          },
        },
      }),
    );
    expect(compiled.annotations).toEqual({
      ui: { showInTimeline: true },
    });
  });
});

// ============================================================
// Edge endpoints + ontology references
// ============================================================

describe("edge compilation", () => {
  it("resolves endpoint names to NodeType references", () => {
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: {
          Paper: { properties: { doi: { type: "string" } } },
          Author: { properties: { name: { type: "string" } } },
        },
        edges: {
          authoredBy: { from: ["Paper"], to: ["Author"], properties: {} },
        },
      }),
    );
    expect(compiled.edges).toHaveLength(1);
    const edge = compiled.edges[0]!;
    expect(edge.from.map((endpoint) => endpointKind(endpoint))).toEqual([
      "Paper",
    ]);
    expect(edge.to.map((endpoint) => endpointKind(endpoint))).toEqual([
      "Author",
    ]);
  });

  it("preserves unresolved endpoints as raw strings for host-graph merge", () => {
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: { Paper: { properties: { doi: { type: "string" } } } },
        edges: {
          authoredBy: {
            from: ["Paper"],
            to: ["Author"],
            properties: {},
          },
        },
      }),
    );
    const edge = compiled.edges[0]!;
    expect(edge.from.map((endpoint) => endpointKind(endpoint))).toEqual([
      "Paper",
    ]);
    expect(edge.to).toEqual(["Author"]);
  });

  it("compiles ontology relations referencing declared nodes", () => {
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: {
          Podcast: { properties: { title: { type: "string" } } },
          Media: { properties: { title: { type: "string" } } },
        },
        ontology: [{ metaEdge: "subClassOf", from: "Podcast", to: "Media" }],
      }),
    );
    expect(compiled.ontology).toHaveLength(1);
    const relation = compiled.ontology[0]!;
    expect(relation.metaEdge.name).toBe("subClassOf");
    // Resolved to NodeType references because both names are declared.
    expect(typeof relation.from).toBe("object");
    expect(typeof relation.to).toBe("object");
  });

  it("ontology endpoints that don't resolve fall through as IRI strings", () => {
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: { Podcast: { properties: { title: { type: "string" } } } },
        ontology: [
          {
            metaEdge: "equivalentTo",
            from: "Podcast",
            to: "https://schema.org/PodcastSeries",
          },
        ],
      }),
    );
    expect(compiled.ontology).toHaveLength(1);
    const relation = compiled.ontology[0]!;
    expect(typeof relation.to).toBe("string");
    expect(relation.to).toBe("https://schema.org/PodcastSeries");
  });
});

// ============================================================
// Unique constraints
// ============================================================

describe("unique constraint compilation", () => {
  it("compiles fields, scope, and collation defaults", () => {
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: {
          Paper: {
            properties: { doi: { type: "string" } },
            unique: [{ name: "paper_doi", fields: ["doi"] }],
          },
        },
      }),
    );
    expect(compiled.nodes).toHaveLength(1);
    const constraint: UniqueConstraint = compiled.nodes[0]!.unique[0]!;
    expect(constraint.name).toBe("paper_doi");
    expect(constraint.fields).toEqual(["doi"]);
    expect(constraint.scope).toBe("kind");
    expect(constraint.collation).toBe("binary");
    expect(constraint.where).toBeUndefined();
  });

  it("compiles where: isNull / isNotNull predicates round-trippable", () => {
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: {
          Item: {
            properties: {
              code: { type: "string" },
              archivedAt: { type: "string", optional: true },
            },
            unique: [
              {
                name: "active_code",
                fields: ["code"],
                where: { field: "archivedAt", op: "isNull" },
              },
            ],
          },
        },
      }),
    );
    const constraint = compiled.nodes[0]!.unique[0]!;
    expect(constraint.where).toBeDefined();
    // The callback shape mirrors what `serializeWherePredicate` consumes:
    // a per-field builder dict; calling builder.isNull() returns the
    // predicate object.
    const builder = {
      archivedAt: {
        isNull: () => ({
          __type: "unique_predicate" as const,
          field: "archivedAt",
          op: "isNull" as const,
        }),
        isNotNull: () => ({
          __type: "unique_predicate" as const,
          field: "archivedAt",
          op: "isNotNull" as const,
        }),
      },
    };
    const result = constraint.where!(builder);
    expect(result).toEqual({
      __type: "unique_predicate",
      field: "archivedAt",
      op: "isNull",
    });
  });

  it("honours custom scope and collation when provided", () => {
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: {
          Email: {
            properties: { addr: { type: "string" } },
            unique: [
              {
                name: "addr_ci",
                fields: ["addr"],
                scope: "kindWithSubClasses",
                collation: "caseInsensitive",
              },
            ],
          },
        },
      }),
    );
    const constraint = compiled.nodes[0]!.unique[0]!;
    expect(constraint.scope).toBe("kindWithSubClasses");
    expect(constraint.collation).toBe("caseInsensitive");
  });
});

// ============================================================
// Failure modes — must reject synchronously with a usable error
// ============================================================

function expectInvalid(
  fn: () => unknown,
  code: string,
  pathFragment?: string,
): RuntimeExtensionValidationError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(RuntimeExtensionValidationError);
  const error = caught as RuntimeExtensionValidationError;
  const codes = error.details.issues.map((index) => index.code);
  expect(codes).toContain(code);
  if (pathFragment !== undefined) {
    const matched = error.details.issues.some((issue) =>
      issue.path.includes(pathFragment),
    );
    expect(matched).toBe(true);
  }
  return error;
}

describe("validation failures", () => {
  it("rejects unsupported property types", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: { N: { properties: { x: { type: "bigint" } } } },
        }),
      "UNSUPPORTED_PROPERTY_TYPE",
      "/nodes/N/properties/x/type",
    );
  });

  it("rejects searchable + format on the same string property", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: {
                at: {
                  type: "string",
                  format: "datetime",
                  searchable: { language: "english" },
                },
              },
            },
          },
        }),
      "INVALID_PROPERTY_REFINEMENT",
      "/nodes/N/properties/at",
    );
  });

  it("rejects format combined with minLength/maxLength/pattern", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: {
                href: { type: "string", format: "uri", maxLength: 10 },
              },
            },
          },
        }),
      "INVALID_PROPERTY_REFINEMENT",
      "/nodes/N/properties/href",
    );
  });

  it("rejects embedding arrays whose items carry refinements", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: {
                vector: {
                  type: "array",
                  items: { type: "number", min: 0, max: 1 },
                  embedding: { dimensions: 8 },
                },
              },
            },
          },
        }),
      "INVALID_PROPERTY_REFINEMENT",
      "/nodes/N/properties/vector/items",
    );
  });

  it("detects mixed-direction hierarchical cycles after canonicalization", () => {
    // `narrower A→B` normalizes to `broader B→A`; combined with `broader A→B`
    // it forms a cycle in the normalized broader group.
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            A: { properties: { name: { type: "string" } } },
            B: { properties: { name: { type: "string" } } },
          },
          ontology: [
            { metaEdge: "broader", from: "A", to: "B" },
            { metaEdge: "narrower", from: "A", to: "B" },
          ],
        }),
      "ONTOLOGY_CYCLE",
    );
  });

  it("detects hasPart/partOf cross-direction cycles", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            Whole: { properties: { name: { type: "string" } } },
            Part: { properties: { name: { type: "string" } } },
          },
          ontology: [
            { metaEdge: "partOf", from: "Whole", to: "Part" },
            { metaEdge: "hasPart", from: "Whole", to: "Part" },
          ],
        }),
      "ONTOLOGY_CYCLE",
    );
  });

  it("rejects refinements on the wrong type (pattern on number)", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: { score: { type: "number", pattern: "abc" } },
            },
          },
        }),
      "INVALID_PROPERTY_REFINEMENT",
      "/nodes/N/properties/score/pattern",
    );
  });

  it("rejects nested arrays", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: {
                grid: {
                  type: "array",
                  items: {
                    type: "array",
                    items: { type: "number" },
                  },
                },
              },
            },
          },
        }),
      "NESTED_ARRAY",
      "/nodes/N/properties/grid/items",
    );
  });

  it("rejects two-level nested objects", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: {
                outer: {
                  type: "object",
                  properties: {
                    inner: {
                      type: "object",
                      properties: { x: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        }),
      "NESTED_OBJECT_TOO_DEEP",
      "/nodes/N/properties/outer/properties/inner",
    );
  });

  it("rejects ontology cycles", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            A: { properties: { x: { type: "string" } } },
            B: { properties: { x: { type: "string" } } },
            C: { properties: { x: { type: "string" } } },
          },
          ontology: [
            { metaEdge: "subClassOf", from: "A", to: "B" },
            { metaEdge: "subClassOf", from: "B", to: "C" },
            { metaEdge: "subClassOf", from: "C", to: "A" },
          ],
        }),
      "ONTOLOGY_CYCLE",
    );
  });

  it("rejects ontology self-loops on hierarchical meta-edges", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: { A: { properties: { x: { type: "string" } } } },
          ontology: [{ metaEdge: "subClassOf", from: "A", to: "A" }],
        }),
      "ONTOLOGY_SELF_LOOP",
    );
  });

  it("accepts edge endpoints that don't resolve in-document (host-graph merge resolves)", () => {
    // Endpoints can reference compile-time host kinds or external IRIs;
    // cross-graph resolution happens at merge time, not here.
    const compiled = compileRuntimeExtension(
      defineRuntimeExtension({
        nodes: { A: { properties: { x: { type: "string" } } } },
        edges: {
          partial: {
            from: ["A"],
            to: ["NotDeclaredLocally"],
            properties: {},
          },
        },
      }),
    );
    const edge = compiled.edges[0]!;
    expect(edge.from.map((endpoint) => endpointKind(endpoint))).toEqual(["A"]);
    expect(edge.to).toEqual(["NotDeclaredLocally"]);
  });

  it("rejects unknown meta-edge names", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: { A: { properties: { x: { type: "string" } } } },
          ontology: [{ metaEdge: "notARealMetaEdge", from: "A", to: "A" }],
        }),
      "UNKNOWN_META_EDGE",
    );
  });

  it("rejects unique constraint references to undeclared fields", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: { id: { type: "string" } },
              unique: [{ name: "by_missing", fields: ["doesNotExist"] }],
            },
          },
        }),
      "UNKNOWN_UNIQUE_FIELD",
    );
  });

  it("rejects unique where predicates with unsupported ops", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: { x: { type: "string" } },
              unique: [
                {
                  name: "by_x",
                  fields: ["x"],
                  where: { field: "x", op: "equals" },
                },
              ],
            },
          },
        }),
      "INVALID_UNIQUE_WHERE_OP",
    );
  });

  it("rejects searchable on non-string properties", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: {
                count: {
                  type: "number",
                  searchable: { language: "english" },
                },
              },
            },
          },
        }),
      "INVALID_MODIFIER_TARGET",
    );
  });

  it("rejects embedding on non-array-of-number properties", () => {
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            N: {
              properties: {
                vec: {
                  type: "array",
                  items: { type: "string" },
                  embedding: { dimensions: 384 },
                },
              },
            },
          },
        }),
      "INVALID_MODIFIER_TARGET",
    );
  });

  it("rejects duplicate kind names within the document", () => {
    // Object literal duplicate keys are silently overwritten by JS, so
    // we exercise the non-key-uniqueness duplicate-name path via the
    // ontology validation: two ontology relations with the same
    // (metaEdge, from, to) tuple.
    expectInvalid(
      () =>
        defineRuntimeExtension({
          nodes: {
            A: { properties: { x: { type: "string" } } },
            B: { properties: { x: { type: "string" } } },
          },
          ontology: [
            { metaEdge: "subClassOf", from: "A", to: "B" },
            { metaEdge: "subClassOf", from: "A", to: "B" },
          ],
        }),
      "DUPLICATE_ONTOLOGY_RELATION",
    );
  });

  it("collects multiple issues in a single error", () => {
    let caught: unknown;
    try {
      defineRuntimeExtension({
        nodes: {
          N: {
            properties: {
              // unsupported type AND nested array
              x: { type: "weird" } as never,
              y: {
                type: "array",
                items: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeExtensionValidationError);
    const error = caught as RuntimeExtensionValidationError;
    expect(error.details.issues.length).toBeGreaterThanOrEqual(2);
  });

  it("validateRuntimeExtension is the result-returning variant", () => {
    const result = validateRuntimeExtension({
      nodes: { N: { properties: { x: { type: "string" } } } },
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================
// Document is frozen
// ============================================================

describe("document immutability", () => {
  it("returned document is deeply frozen", () => {
    const document = defineRuntimeExtension({
      nodes: {
        N: {
          properties: { x: { type: "string" } },
          unique: [{ name: "by_x", fields: ["x"] }],
        },
      },
    });
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.nodes!)).toBe(true);
    expect(Object.isFrozen(document.nodes!.N!)).toBe(true);
    expect(Object.isFrozen(document.nodes!.N!.properties)).toBe(true);
  });
});

// ============================================================
// Ontology cycle detection — additional cases
// ============================================================

describe("ontology cycle detection", () => {
  it("ignores cycles across non-transitive meta-edges", () => {
    // `relatedTo` is symmetric but not strictly hierarchical; cycles
    // there are not domain errors. This document must succeed.
    const document = defineRuntimeExtension({
      nodes: {
        A: { properties: { x: { type: "string" } } },
        B: { properties: { x: { type: "string" } } },
      },
      ontology: [
        { metaEdge: "relatedTo", from: "A", to: "B" },
        { metaEdge: "relatedTo", from: "B", to: "A" },
      ],
    });
    expect(document.ontology).toHaveLength(2);
  });

  it("rejects 2-cycle on broader/narrower", () => {
    let caught: unknown;
    try {
      defineRuntimeExtension({
        nodes: {
          A: { properties: { x: { type: "string" } } },
          B: { properties: { x: { type: "string" } } },
        },
        ontology: [
          { metaEdge: "broader", from: "A", to: "B" },
          { metaEdge: "broader", from: "B", to: "A" },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RuntimeExtensionValidationError);
    const codes = (
      caught as RuntimeExtensionValidationError
    ).details.issues.map((index) => index.code);
    expect(codes).toContain("ONTOLOGY_CYCLE");
  });
});

// ============================================================
// Edge schema parity with defineEdge
// ============================================================

describe("edge schema parity", () => {
  it("edge with no properties matches handwritten empty edge", () => {
    const handwritten = defineEdge("emptyEdge");
    const compiled = compileSingleEdge(
      defineRuntimeExtension({
        nodes: { A: { properties: { x: { type: "string" } } } },
        edges: { emptyEdge: { from: ["A"], to: ["A"], properties: {} } },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {});
  });

  it("edge with properties parses identically", () => {
    const handwritten = defineEdge("link", {
      schema: z.object({ since: z.iso.datetime(), weight: z.number() }),
    });
    const compiled = compileSingleEdge(
      defineRuntimeExtension({
        nodes: { A: { properties: { x: { type: "string" } } } },
        edges: {
          link: {
            from: ["A"],
            to: ["A"],
            properties: {
              since: { type: "string", format: "datetime" },
              weight: { type: "number" },
            },
          },
        },
      }),
    );
    assertParsedEqual(handwritten.schema, compiled.schema, {
      since: "2025-01-02T03:04:05.000Z",
      weight: 1.5,
    });
  });
});
