/**
 * Structural subtyping predicate tests.
 *
 * `isStructuralSubtype` answers a different question than
 * `isBreakingPropertyChange` / `computeSchemaDiff` (schema/migration.ts):
 * "is every value satisfying `child` guaranteed to satisfy `parent`", judged
 * purely on the projected JSON Schema. The "divergence from the migration
 * predicate" block below pins the two cases where the two predicates give
 * opposite verdicts over the same pair of schemas.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { searchable } from "../src/core/searchable";
import {
  computeSchemaDiff,
  isStructuralSubtype,
  type StructuralSubtypeResult,
} from "../src/schema";
import { serializeSchemaProperties } from "../src/schema/serializer";
import {
  type JsonSchema,
  type SerializedNodeDef,
  type SerializedOntology,
  type SerializedSchema,
} from "../src/schema/types";
import { requireDefined } from "../src/utils/presence";

// ============================================================
// Test Helpers
// ============================================================

function projected(schema: z.ZodType): JsonSchema {
  return serializeSchemaProperties(schema);
}

function verdict(child: z.ZodType, parent: z.ZodType): StructuralSubtypeResult {
  return isStructuralSubtype(projected(child), projected(parent));
}

type ExpectedVerdict =
  "subtype" | Readonly<{ reason: string }> | Readonly<{ incomparable: string }>;

function assertVerdict(
  result: StructuralSubtypeResult,
  expected: ExpectedVerdict,
): void {
  if (expected === "subtype") {
    expect(result).toEqual({ verdict: "subtype" });
    return;
  }
  if ("incomparable" in expected) {
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: expected.incomparable,
    });
    return;
  }
  expect(result).toMatchObject({
    verdict: "not-subtype",
    reason: expected.reason,
  });
}

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

function nodeDef(kind: string, schema: z.ZodType): SerializedNodeDef {
  return {
    kind,
    properties: projected(schema),
    uniqueConstraints: [],
    onDelete: "restrict",
    description: undefined,
  };
}

function schemaWith(kind: string, schema: z.ZodType): SerializedSchema {
  return {
    graphId: "test",
    version: 1,
    generatedAt: "2024-01-01T00:00:00Z",
    nodes: { [kind]: nodeDef(kind, schema) },
    edges: {},
    ontology: emptyOntology(),
    defaults: {
      onNodeDelete: "restrict",
      temporalMode: "current",
    },
  };
}

// A nested object schema `depth` levels deep, differing only at the leaf via
// `leafMinLength` — used to force recursion past `MAX_STRUCTURAL_SUBTYPE_DEPTH`
// without the top-level equality fast path short-circuiting the walk.
function nestedObjectSchema(depth: number, leafMinLength: number): JsonSchema {
  if (depth <= 0) {
    return { type: "string", minLength: leafMinLength };
  }
  return {
    type: "object",
    properties: { child: nestedObjectSchema(depth - 1, leafMinLength) },
    required: ["child"],
    additionalProperties: false,
  };
}

// ============================================================
// Object width and depth
// ============================================================

describe("object width and depth", () => {
  const rows: readonly {
    name: string;
    child: z.ZodType;
    parent: z.ZodType;
    expected: ExpectedVerdict;
  }[] = [
    {
      name: "child adds an optional property",
      child: z.object({ name: z.string(), nickname: z.string().optional() }),
      parent: z.object({ name: z.string() }),
      expected: "subtype",
    },
    {
      name: "child adds a required property (the reviewer's case)",
      child: z.object({ name: z.string(), employeeId: z.string() }),
      parent: z.object({ name: z.string() }),
      expected: "subtype",
    },
    {
      name: "child omits an optional parent property",
      child: z.object({ name: z.string() }),
      parent: z.object({ name: z.string(), nickname: z.string().optional() }),
      expected: "subtype",
    },
    {
      name: "child omits a required parent property",
      child: z.object({ name: z.string() }),
      parent: z.object({ name: z.string(), nickname: z.string() }),
      expected: { reason: "missing-required-property" },
    },
    {
      name: "child declares a parent-required property as optional",
      child: z.object({ name: z.string().optional() }),
      parent: z.object({ name: z.string() }),
      expected: { reason: "optional-in-child-required-in-parent" },
    },
    {
      name: "nested object: child tightens a nested property",
      child: z.object({ address: z.object({ zip: z.string().min(5) }) }),
      parent: z.object({ address: z.object({ zip: z.string() }) }),
      expected: "subtype",
    },
    {
      name: "nested object: child loosens a nested property",
      child: z.object({ address: z.object({ zip: z.string() }) }),
      parent: z.object({ address: z.object({ zip: z.string().min(5) }) }),
      expected: { reason: "string-length-not-tighter" },
    },
    {
      name: "child re-declares a parent property with a mismatched type",
      child: z.object({ age: z.string() }),
      parent: z.object({ age: z.number() }),
      expected: { reason: "type-token-mismatch" },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    assertVerdict(verdict(row.child, row.parent), row.expected);
  });

  it('has path ["nickname"] for a missing required property', () => {
    const result = verdict(
      z.object({ name: z.string() }),
      z.object({ name: z.string(), nickname: z.string() }),
    );
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "missing-required-property",
      path: ["nickname"],
    });
  });

  it('has path ["address","zip"] for a loosened nested property', () => {
    const result = verdict(
      z.object({ address: z.object({ zip: z.string() }) }),
      z.object({ address: z.object({ zip: z.string().min(5) }) }),
    );
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "string-length-not-tighter",
      path: ["address", "zip"],
    });
  });

  it("a required child property that the parent leaves optional is a subtype (reverse of the optional-in-child row)", () => {
    // Mirror of "child declares a parent-required property as optional":
    // swap child/parent and expect the reverse (subtype) verdict.
    assertVerdict(
      verdict(
        z.object({ name: z.string() }),
        z.object({ name: z.string().optional() }),
      ),
      "subtype",
    );
  });

  it("reverse of 'child re-declares a parent property with a mismatched type' is also type-token-mismatch", () => {
    assertVerdict(
      verdict(z.object({ age: z.number() }), z.object({ age: z.string() })),
      { reason: "type-token-mismatch" },
    );
  });
});

// ============================================================
// additionalProperties
// ============================================================

describe("additionalProperties", () => {
  it("z.object child adds a field beyond a z.object parent -> subtype (parent's additionalProperties:false not applied)", () => {
    assertVerdict(
      verdict(
        z.object({ a: z.string(), b: z.number() }),
        z.object({ a: z.string() }),
      ),
      "subtype",
    );
  });

  it("parent .catchall(number), child adds a matching extra field -> subtype", () => {
    assertVerdict(
      verdict(
        z.object({ a: z.string(), extra: z.number() }),
        z.object({ a: z.string() }).catchall(z.number()),
      ),
      "subtype",
    );
  });

  it("parent .catchall(number), child adds a mismatched extra field -> type-token-mismatch at extra", () => {
    const result = verdict(
      z.object({ a: z.string(), extra: z.string() }),
      z.object({ a: z.string() }).catchall(z.number()),
    );
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "type-token-mismatch",
      path: ["extra"],
    });
  });

  it("parent .catchall(number), child z.looseObject -> failure at {additionalProperties}", () => {
    const result = verdict(
      z.looseObject({ a: z.string() }),
      z.object({ a: z.string() }).catchall(z.number()),
    );
    expect(result).toMatchObject({
      verdict: "not-subtype",
      path: ["{additionalProperties}"],
    });
  });

  it("parent z.looseObject, child z.object -> subtype (child forbids extras, tighter)", () => {
    assertVerdict(
      verdict(z.object({ a: z.string() }), z.looseObject({ a: z.string() })),
      "subtype",
    );
  });

  // C2-02: an OPEN child does not actually omit a parent-declared property it
  // leaves unnamed — any value satisfying the child could still carry that
  // key, so the child's additional-properties schema must narrow the
  // parent's declared property rather than being skipped. Before the fix,
  // each of these three constructors evaded the parent's typed `b` entirely.
  it("z.looseObject child evading a parent's optional typed property is refused, not accepted", () => {
    const result = verdict(
      z.looseObject({ a: z.string() }),
      z.object({ a: z.string(), b: z.number().optional() }),
    );
    expect(result.verdict).not.toBe("subtype");
    expect(result).toMatchObject({ path: ["b"] });
  });

  it("z.record child evading a parent's optional typed property is refused, not accepted", () => {
    const result = verdict(
      z.record(z.string(), z.string()),
      z.object({ b: z.number().optional() }),
    );
    expect(result.verdict).not.toBe("subtype");
    expect(result).toMatchObject({ path: ["b"] });
  });

  it(".catchall child evading a parent's optional typed property is refused, not accepted", () => {
    const result = verdict(
      z.object({ a: z.string() }).catchall(z.string()),
      z.object({ a: z.string(), b: z.number().optional() }),
    );
    expect(result.verdict).not.toBe("subtype");
    expect(result).toMatchObject({ path: ["b"] });
  });
});

// ============================================================
// records
// ============================================================

describe("records", () => {
  it("record ⊑ record with the same value type -> subtype", () => {
    assertVerdict(
      verdict(
        z.record(z.string(), z.number()),
        z.record(z.string(), z.number()),
      ),
      "subtype",
    );
  });

  it("record ⊑ record with a mismatched value type -> type-token-mismatch", () => {
    const result = verdict(
      z.record(z.string(), z.string()),
      z.record(z.string(), z.number()),
    );
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "type-token-mismatch",
      path: ["{additionalProperties}"],
    });
  });

  it("a closed object whose properties fit the record's value type ⊑ record -> subtype", () => {
    assertVerdict(
      verdict(
        z.object({ a: z.number(), b: z.number() }),
        z.record(z.string(), z.number()),
      ),
      "subtype",
    );
  });

  it("record ⊑ an object requiring a specific field -> missing-required-property (the record does not guarantee it)", () => {
    const result = verdict(
      z.record(z.string(), z.number()),
      z.object({ a: z.number() }),
    );
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "missing-required-property",
    });
  });
});

// ============================================================
// Scalars
// ============================================================

describe("scalars", () => {
  const rows: readonly {
    name: string;
    child: z.ZodType;
    parent: z.ZodType;
    expected: ExpectedVerdict;
  }[] = [
    {
      name: "z.string().min(3) subtype z.string().min(1)",
      child: z.string().min(3),
      parent: z.string().min(1),
      expected: "subtype",
    },
    {
      name: "z.string().min(1) not subtype z.string().min(3)",
      child: z.string().min(1),
      parent: z.string().min(3),
      expected: { reason: "string-length-not-tighter" },
    },
    {
      name: "z.string().max(5) subtype z.string().max(10)",
      child: z.string().max(5),
      parent: z.string().max(10),
      expected: "subtype",
    },
    {
      name: "z.string().max(10) not subtype z.string().max(5)",
      child: z.string().max(10),
      parent: z.string().max(5),
      expected: { reason: "string-length-not-tighter" },
    },
    {
      name: "child adds a pattern the parent lacks -> subtype",
      child: z.string().regex(/^[a-z]+$/),
      parent: z.string(),
      expected: "subtype",
    },
    {
      name: "child changes an existing parent pattern -> pattern-mismatch",
      child: z.string().regex(/^[0-9]+$/),
      parent: z.string().regex(/^[a-z]+$/),
      expected: { reason: "pattern-mismatch" },
    },
    {
      name: "child drops the parent's pattern -> pattern-mismatch",
      child: z.string(),
      parent: z.string().regex(/^[a-z]+$/),
      expected: { reason: "pattern-mismatch" },
    },
    {
      name: "z.email() subtype z.string()",
      child: z.email(),
      parent: z.string(),
      expected: "subtype",
    },
    {
      name: "z.string() not subtype z.email()",
      child: z.string(),
      parent: z.email(),
      expected: { reason: "pattern-mismatch" },
    },
    {
      name: "z.number().min(2).max(8) subtype z.number().min(1).max(10)",
      child: z.number().min(2).max(8),
      parent: z.number().min(1).max(10),
      expected: "subtype",
    },
    {
      name: "z.number().min(0).max(11) not subtype z.number().min(1).max(10) (widened lower)",
      child: z.number().min(0).max(10),
      parent: z.number().min(1).max(10),
      expected: { reason: "numeric-bound-not-tighter" },
    },
    {
      name: "z.number().min(1).max(11) not subtype z.number().min(1).max(10) (widened upper)",
      child: z.number().min(1).max(11),
      parent: z.number().min(1).max(10),
      expected: { reason: "numeric-bound-not-tighter" },
    },
    {
      name: "z.number().gt(1) subtype z.number().min(1) (exclusive tighter at equal value)",
      child: z.number().gt(1),
      parent: z.number().min(1),
      expected: "subtype",
    },
    {
      name: "z.number().min(1) not subtype z.number().gt(1)",
      child: z.number().min(1),
      parent: z.number().gt(1),
      expected: { reason: "numeric-bound-not-tighter" },
    },
    {
      name: "child drops the parent's multipleOf -> multiple-of-mismatch",
      child: z.number(),
      parent: z.number().multipleOf(2),
      expected: { reason: "multiple-of-mismatch" },
    },
    {
      name: "z.enum(['a']) subtype z.enum(['a','b'])",
      child: z.enum(["a"]),
      parent: z.enum(["a", "b"]),
      expected: "subtype",
    },
    {
      name: "z.enum(['a','b']) not subtype z.enum(['a'])",
      child: z.enum(["a", "b"]),
      parent: z.enum(["a"]),
      expected: { reason: "value-set-not-subset" },
    },
    {
      name: "z.literal('a') subtype z.enum(['a','b'])",
      child: z.literal("a"),
      parent: z.enum(["a", "b"]),
      expected: "subtype",
    },
    {
      name: "z.literal('c') not subtype z.enum(['a','b'])",
      child: z.literal("c"),
      parent: z.enum(["a", "b"]),
      expected: { reason: "value-set-not-subset" },
    },
    {
      name: "z.string() not subtype z.enum(['a','b'])",
      child: z.string(),
      parent: z.enum(["a", "b"]),
      expected: { reason: "value-set-not-subset" },
    },
    {
      name: "z.boolean() subtype z.boolean()",
      child: z.boolean(),
      parent: z.boolean(),
      expected: "subtype",
    },
    {
      name: "z.boolean() not subtype z.string()",
      child: z.boolean(),
      parent: z.string(),
      expected: { reason: "type-token-mismatch" },
    },
    {
      name: "z.int() subtype z.number() (D3: integer narrows number)",
      child: z.int(),
      parent: z.number(),
      expected: "subtype",
    },
    // C2-01: `z.url()` and `z.jwt()` project `format` with NO accompanying
    // `pattern` (unlike every other format-bearing construct, e.g.
    // `z.email()`/`z.uuid()`), so `format` must itself be a constraint or a
    // bare `z.string()` is unsoundly accepted as a subtype of either.
    {
      name: "z.url() subtype z.string()",
      child: z.url(),
      parent: z.string(),
      expected: "subtype",
    },
    {
      name: "z.string() not subtype z.url() -> format-mismatch",
      child: z.string(),
      parent: z.url(),
      expected: { reason: "format-mismatch" },
    },
    {
      name: "z.jwt() subtype z.string()",
      child: z.jwt(),
      parent: z.string(),
      expected: "subtype",
    },
    {
      name: "z.string() not subtype z.jwt() -> format-mismatch",
      child: z.string(),
      parent: z.jwt(),
      expected: { reason: "format-mismatch" },
    },
    {
      name: "z.url() not subtype z.jwt() -> format-mismatch (both format-only, no pattern)",
      child: z.url(),
      parent: z.jwt(),
      expected: { reason: "format-mismatch" },
    },
  ];

  it.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
    assertVerdict(verdict(row.child, row.parent), row.expected);
  });

  it("format equal on both sides does not block subtyping", () => {
    const withEmailFormat: JsonSchema = {
      type: "string",
      format: "email",
      pattern: "^a$",
    };
    const withSameFormatLooserPattern: JsonSchema = {
      type: "string",
      format: "email",
    };
    // child (no pattern) is NOT tighter than a parent requiring "^a$", so
    // only the reverse direction is a subtype.
    expect(
      isStructuralSubtype(withEmailFormat, withSameFormatLooserPattern),
    ).toEqual({ verdict: "subtype" });
  });
});

// ============================================================
// Arrays and tuples
// ============================================================

describe("arrays and tuples", () => {
  it("z.array(z.string().min(2)) subtype z.array(z.string())", () => {
    assertVerdict(
      verdict(z.array(z.string().min(2)), z.array(z.string())),
      "subtype",
    );
  });

  it("z.array(z.string()) not subtype z.array(z.string().min(2)) at []", () => {
    const result = verdict(z.array(z.string()), z.array(z.string().min(2)));
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "string-length-not-tighter",
      path: ["[]"],
    });
  });

  it("z.array(z.string()).min(2) subtype z.array(z.string()).min(1)", () => {
    assertVerdict(
      verdict(z.array(z.string()).min(2), z.array(z.string()).min(1)),
      "subtype",
    );
  });

  it("z.array(z.string()).min(1) not subtype z.array(z.string()).min(2)", () => {
    assertVerdict(
      verdict(z.array(z.string()).min(1), z.array(z.string()).min(2)),
      { reason: "array-bounds-not-tighter" },
    );
  });

  it("z.array(z.string()).max(3) subtype z.array(z.string()).max(9)", () => {
    assertVerdict(
      verdict(z.array(z.string()).max(3), z.array(z.string()).max(9)),
      "subtype",
    );
  });

  it("z.array(z.string()).max(9) not subtype z.array(z.string()).max(3)", () => {
    assertVerdict(
      verdict(z.array(z.string()).max(9), z.array(z.string()).max(3)),
      { reason: "array-bounds-not-tighter" },
    );
  });

  it("same-arity tuple with looser members -> subtype", () => {
    assertVerdict(
      verdict(
        z.tuple([z.string().min(3), z.number()]),
        z.tuple([z.string().min(1), z.number()]),
      ),
      "subtype",
    );
  });

  it("different-arity tuples -> tuple-arity-mismatch", () => {
    assertVerdict(
      verdict(z.tuple([z.string()]), z.tuple([z.string(), z.number()])),
      { reason: "tuple-arity-mismatch" },
    );
  });

  // C2-03: a tuple-with-rest child (`z.tuple([...], rest)`) has the SAME
  // `prefixItems` length as a closed parent tuple here, so the arity check
  // above cannot catch it — only checking that the parent is also closed
  // (no `items`) does.
  it("a tuple with a rest element is not a subtype of a same-arity closed tuple", () => {
    const result = verdict(
      z.tuple([z.string()], z.number()),
      z.tuple([z.string()]),
    );
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "tuple-arity-mismatch",
    });
  });

  it("a same-arity closed tuple is still a subtype of an equally closed tuple", () => {
    assertVerdict(
      verdict(z.tuple([z.string()]), z.tuple([z.string()])),
      "subtype",
    );
  });

  it("z.tuple([z.string()]) subtype z.array(z.string())", () => {
    assertVerdict(
      verdict(z.tuple([z.string()]), z.array(z.string())),
      "subtype",
    );
  });
});

// ============================================================
// Unions and nullability
// ============================================================

describe("unions and nullability", () => {
  it("z.string() subtype z.union([z.string(), z.number()])", () => {
    assertVerdict(
      verdict(z.string(), z.union([z.string(), z.number()])),
      "subtype",
    );
  });

  it("z.union([z.string(), z.number()]) not subtype z.string() at anyOf[1]", () => {
    const result = verdict(z.union([z.string(), z.number()]), z.string());
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "no-matching-union-member",
      path: ["anyOf[1]"],
    });
  });

  it("z.string() subtype z.string().nullable()", () => {
    assertVerdict(verdict(z.string(), z.string().nullable()), "subtype");
  });

  it("z.string().nullable() not subtype z.string()", () => {
    assertVerdict(verdict(z.string().nullable(), z.string()), {
      reason: "no-matching-union-member",
    });
  });

  it("z.string().nullable() subtype z.string().nullish() (projection collapses both to the same anyOf)", () => {
    assertVerdict(
      verdict(z.string().nullable(), z.string().nullish()),
      "subtype",
    );
  });

  it("a discriminated-union child whose members are a subset of the parent's oneOf -> subtype", () => {
    const parent = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), a: z.string() }),
      z.object({ type: z.literal("b"), b: z.number() }),
    ]);
    const child = z.discriminatedUnion("type", [
      z.object({ type: z.literal("a"), a: z.string() }),
    ]);
    assertVerdict(verdict(child, parent), "subtype");
  });

  it("a union member that is itself incomparable propagates incomparable, not no-matching-union-member", () => {
    const result = verdict(z.union([z.string(), z.never()]), z.string());
    expect(result.verdict).toBe("incomparable");
  });

  // C2-05: a hand-written schema carrying both `type` and `anyOf` must still
  // be read as a union — `propertyTypeSignature` (migration's construct
  // SELECTOR, not a union detector) would read `type` first and hide the
  // `anyOf` entirely, silently dropping the parent's union constraint.
  it("a parent carrying both type and anyOf still enforces the union (C2-05)", () => {
    const child: JsonSchema = { type: "string" };
    const parent: JsonSchema = {
      type: "string",
      anyOf: [{ const: "a" }, { const: "b" }],
    };
    const result = isStructuralSubtype(child, parent);
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "no-matching-union-member",
      // C2-10: the child isn't itself a union, so no `anyOf[i]` segment is
      // synthesized onto a path the child schema doesn't actually have.
      path: [],
    });
  });
});

// ============================================================
// Incomparable constructs
// ============================================================

describe("incomparable constructs", () => {
  // A self-recursive schema's `$ref` sits at a nested position
  // (`properties.children.items`), not at the schema's own top level, and an
  // identical pair short-circuits through the equality fast path before ever
  // visiting it (rule 5) — so the partner here must share the "children"
  // shape but differ in its element type, forcing real recursion down to the
  // `$ref` node instead of exercising a path that never reaches it.
  function recursiveListSchema(): z.ZodType {
    interface Recursive {
      readonly children: readonly Recursive[];
    }
    const recursive: z.ZodType<Recursive> = z.lazy(() =>
      z.object({ children: z.array(recursive) }),
    );
    return recursive;
  }
  const nonRecursiveListSchema = z.object({ children: z.array(z.string()) });

  it("a self-recursive schema is incomparable via schema-reference (child position)", () => {
    const result = isStructuralSubtype(
      projected(recursiveListSchema()),
      projected(nonRecursiveListSchema),
    );
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: "schema-reference",
    });
  });

  it("a self-recursive schema is incomparable via schema-reference (parent position)", () => {
    const result = isStructuralSubtype(
      projected(nonRecursiveListSchema),
      projected(recursiveListSchema()),
    );
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: "schema-reference",
    });
  });

  it("z.never() is incomparable via unsupported-keyword", () => {
    const result = verdict(z.never(), z.string());
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: "unsupported-keyword",
    });
  });

  it("z.intersection(...) is incomparable via unsupported-keyword (D4)", () => {
    const result = verdict(
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })),
      z.object({ a: z.string() }),
    );
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: "unsupported-keyword",
    });
  });

  it("z.file() is incomparable via unsupported-keyword", () => {
    const result = verdict(z.file(), z.string());
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: "unsupported-keyword",
    });
  });

  it('a hand-written type:["string","null"] is incomparable via type-token-array', () => {
    const child: JsonSchema = { type: ["string", "null"] };
    const parent: JsonSchema = { type: "string" };
    const result = isStructuralSubtype(child, parent);
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: "type-token-array",
    });
  });

  it("a hand-written schema nested past MAX_STRUCTURAL_SUBTYPE_DEPTH is incomparable via max-depth-exceeded", () => {
    const child = nestedObjectSchema(70, 2);
    const parent = nestedObjectSchema(70, 1);
    const result = isStructuralSubtype(child, parent);
    expect(result).toMatchObject({
      verdict: "incomparable",
      reason: "max-depth-exceeded",
    });
  });

  it("a searchable() field does not make a pair incomparable (D1; src/core/searchable.ts:120)", () => {
    // Built from the real `searchable()` tag (not a hand-written literal) so
    // this test ratchets against a change to `SEARCHABLE_FIELD_KEY` or to the
    // tag's projected shape.
    const withSearchable = projected(searchable());
    assertVerdict(
      isStructuralSubtype(withSearchable, withSearchable),
      "subtype",
    );
    assertVerdict(
      isStructuralSubtype(withSearchable, projected(z.string())),
      "subtype",
    );
  });

  it("an arbitrary .meta() key does not make a pair incomparable (D1: unknown keywords are ignored for subtyping)", () => {
    const child = z.object({ a: z.string().meta({ myKey: 1 }) });
    const parent = z.object({ a: z.string() });
    assertVerdict(verdict(child, parent), "subtype");
    assertVerdict(verdict(parent, child), "subtype");
  });

  // C2-06: standard JSON Schema 2020-12 vocabulary keywords this predicate's
  // rule set does not model must refuse rather than silently accept, even
  // though the Zod projection never emits them — the public
  // `isStructuralSubtype` surface takes an arbitrary hand-written schema.
  it.each([
    [
      "uniqueItems",
      { type: "array", items: { type: "string" }, uniqueItems: true },
    ],
    ["minProperties", { type: "object", minProperties: 3 }],
    [
      "patternProperties",
      { type: "object", patternProperties: { "^x": { type: "string" } } },
    ],
  ] as const)(
    "a parent carrying an unmodeled %s keyword is incomparable",
    (_label, parent) => {
      const child: JsonSchema =
        parent.type === "array" ?
          { type: "array", items: { type: "string" } }
        : { type: "object" };
      const result = isStructuralSubtype(child, parent);
      expect(result).toMatchObject({
        verdict: "incomparable",
        reason: "unsupported-keyword",
      });
    },
  );
});

// ============================================================
// Divergence from the migration predicate
// ============================================================

describe("divergence from the migration predicate", () => {
  it("accepts a child adding a required field that computeSchemaDiff calls breaking", () => {
    const parent = z.object({ name: z.string() });
    const child = z.object({ name: z.string(), employeeId: z.string() });

    // migration's question: "do rows valid before stay valid after?" -> no
    const diff = computeSchemaDiff(
      schemaWith("Person", parent),
      schemaWith("Person", child),
    );
    const change = requireDefined(
      diff.nodes.find((entry) => entry.kind === "Person"),
    );
    expect(change.severity).toBe("breaking");

    // C.2's question: "is every child value a valid parent value?" -> yes
    expect(isStructuralSubtype(projected(child), projected(parent))).toEqual({
      verdict: "subtype",
    });
  });

  it("accepts a child making a required parent field optional, which computeSchemaDiff calls safe", () => {
    const parent = z.object({ name: z.string(), nickname: z.string() });
    const child = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });

    // migration's question: existing rows (nickname present) still validate -> safe
    const diff = computeSchemaDiff(
      schemaWith("Person", parent),
      schemaWith("Person", child),
    );
    const change = requireDefined(
      diff.nodes.find((entry) => entry.kind === "Person"),
    );
    expect(change.severity).toBe("safe");

    // C.2's question: the parent's guarantee that `nickname` is present no
    // longer holds for every child value -> not a subtype
    const result = isStructuralSubtype(projected(child), projected(parent));
    expect(result).toMatchObject({
      verdict: "not-subtype",
      reason: "optional-in-child-required-in-parent",
    });
  });
});

// ============================================================
// Projection coverage (ratchet against a future Zod upgrade)
// ============================================================

describe("projection coverage", () => {
  // Every schema here must be reflexive (subtype of itself) once projected.
  // If a future Zod upgrade starts emitting a keyword outside
  // COMPARABLE_KEYWORDS for one of these constructs, this list is where it
  // will fail first — add the keyword to COMPARABLE_KEYWORDS (if it is a
  // constraint this predicate should model) or to UNMODELED_CONSTRAINING_KEYWORDS
  // (if it constrains but is out of scope) in structural-subtype.ts, and only
  // then update this test.
  const PROJECTION_CASES: readonly [string, z.ZodType][] = [
    ["z.string()", z.string()],
    ["z.string().min(1)", z.string().min(1)],
    ["z.string().max(10)", z.string().max(10)],
    ["z.string().regex(...)", z.string().regex(/^[a-z]+$/)],
    ["z.email()", z.email()],
    ["z.uuid()", z.uuid()],
    ["z.url()", z.url()],
    ["z.jwt()", z.jwt()],
    ["z.iso.date()", z.iso.date()],
    ["z.templateLiteral", z.templateLiteral(["a", z.string()])],
    ["z.string().startsWith", z.string().startsWith("x")],
    ["z.string().includes", z.string().includes("x")],
    ["z.string().nonempty()", z.string().nonempty()],
    ["z.number()", z.number()],
    ["z.number().min(1).max(10)", z.number().min(1).max(10)],
    ["z.number().gt(1).lt(10)", z.number().gt(1).lt(10)],
    ["z.number().multipleOf(2)", z.number().multipleOf(2)],
    ["z.int()", z.int()],
    ["z.boolean()", z.boolean()],
    ["z.literal(scalar)", z.literal("x")],
    // eslint-disable-next-line unicorn/no-null -- z.literal(null) is a real JSON Schema `const: null` construct under test
    ["z.literal(null)", z.literal(null)],
    ["z.enum homogeneous", z.enum(["a", "b"])],
    ["z.literal([...]) mixed", z.literal(["a", 1])],
    ["z.object", z.object({ a: z.string() })],
    ["z.looseObject", z.looseObject({ a: z.string() })],
    ["z.object.catchall", z.object({ a: z.string() }).catchall(z.number())],
    ["z.record", z.record(z.string(), z.number())],
    ["z.array", z.array(z.string())],
    ["z.array bounded", z.array(z.string()).min(1).max(10)],
    ["z.tuple no rest", z.tuple([z.string(), z.number()])],
    ["z.tuple with rest", z.tuple([z.string()], z.number())],
    ["z.union", z.union([z.string(), z.number()])],
    ["z.string().nullable()", z.string().nullable()],
    ["z.string().nullish()", z.string().nullish()],
    [
      "z.discriminatedUnion",
      z.discriminatedUnion("t", [z.object({ t: z.literal("a") })]),
    ],
    ["z.any()", z.any()],
    ["z.unknown()", z.unknown()],
    ["z.string().readonly()", z.string().readonly()],
    [
      "z.string() with .meta title/description",
      z.string().meta({ title: "T", description: "D" }),
    ],
    ["z.string().default('x')", z.string().default("x")],
    ["z.string().catch('x')", z.string().catch("x")],
  ];

  it.each(PROJECTION_CASES)("%s is reflexive", (_label, schema) => {
    const schemaProjection = projected(schema);
    expect(isStructuralSubtype(schemaProjection, schemaProjection)).toEqual({
      verdict: "subtype",
    });
  });

  // Each entry supplies its own [child, parent] pair rather than a single
  // self-compared schema: a self-recursive schema compared to an IDENTICAL
  // copy of itself hits the equality fast path (rule 5) before the walk ever
  // reaches the nested `$ref`, so that specific construct needs a partner
  // that differs enough to force real recursion (see the `schema-reference`
  // tests above for why).
  const INCOMPARABLE_BY_DESIGN: readonly [
    string,
    () => readonly [JsonSchema, JsonSchema],
  ][] = [
    [
      "self-recursive object vs. a same-shape non-recursive schema",
      () => {
        interface Recursive {
          readonly children: readonly Recursive[];
        }
        const recursive: z.ZodType<Recursive> = z.lazy(() =>
          z.object({ children: z.array(recursive) }),
        );
        const nonRecursive = z.object({ children: z.array(z.string()) });
        return [projected(recursive), projected(nonRecursive)];
      },
    ],
    [
      "z.never()",
      () => {
        const schema = projected(z.never());
        return [schema, schema];
      },
    ],
    [
      "z.intersection",
      () => {
        const schema = projected(
          z.intersection(
            z.object({ a: z.string() }),
            z.object({ b: z.number() }),
          ),
        );
        return [schema, schema];
      },
    ],
    [
      "z.file()",
      () => {
        const schema = projected(z.file());
        return [schema, schema];
      },
    ],
  ];

  it.each(INCOMPARABLE_BY_DESIGN)("%s is incomparable", (_label, buildPair) => {
    const [child, parent] = buildPair();
    const result = isStructuralSubtype(child, parent);
    expect(result.verdict).toBe("incomparable");
  });
});
