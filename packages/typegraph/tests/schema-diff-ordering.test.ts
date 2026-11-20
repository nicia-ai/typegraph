/**
 * Restating a kind with its members declared in a different order is a
 * semantic no-op and must not read as a schema change.
 *
 * `required`, `enum`, and edge endpoint lists are all *sets* — reordering
 * them changes nothing a validator or a stored row can observe. Before this
 * was normalized, a reordered declaration reported kinds as `modified` (a
 * reordered `enum` was even classified `breaking`), which forced callers into
 * a privileged migration for a schema that had not actually changed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import {
  computeSchemaDiff,
  computeSchemaHash,
  type SerializedSchema,
  serializeSchema,
} from "../src/schema";

function nodeGraph(schema: z.ZodObject<z.ZodRawShape>): SerializedSchema {
  const Thing = defineNode("Thing", { schema });
  return serializeSchema(
    defineGraph({
      id: "diff_ordering",
      nodes: { Thing: { type: Thing } },
      edges: {},
    }),
    1,
  );
}

function edgeGraph(reversed: boolean): SerializedSchema {
  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const Company = defineNode("Company", {
    schema: z.object({ name: z.string() }),
  });
  const linked = defineEdge("linked", { schema: z.object({}) });
  return serializeSchema(
    defineGraph({
      id: "diff_ordering",
      nodes: { Person: { type: Person }, Company: { type: Company } },
      edges: {
        linked:
          reversed ?
            { type: linked, from: [Company, Person], to: [Person, Company] }
          : { type: linked, from: [Person, Company], to: [Company, Person] },
      },
    }),
    1,
  );
}

function sameShape(): z.ZodObject<z.ZodRawShape> {
  return z.object({ name: z.string(), age: z.number() });
}

describe("reordering is not a schema change", () => {
  it("ignores the order properties are declared in", () => {
    const diff = computeSchemaDiff(
      nodeGraph(z.object({ name: z.string(), age: z.number() })),
      nodeGraph(z.object({ age: z.number(), name: z.string() })),
    );

    expect(diff.hasChanges).toBe(false);
    expect(diff.nodes).toHaveLength(0);
  });

  it("ignores the order of enum members", () => {
    const diff = computeSchemaDiff(
      nodeGraph(z.object({ tier: z.enum(["gold", "silver", "bronze"]) })),
      nodeGraph(z.object({ tier: z.enum(["bronze", "gold", "silver"]) })),
    );

    // Previously reported as *breaking*, forcing a destructive migration
    // decision for a pure reordering.
    expect(diff.hasChanges).toBe(false);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it("ignores the order of edge endpoint kinds", () => {
    const diff = computeSchemaDiff(edgeGraph(false), edgeGraph(true));

    expect(diff.hasChanges).toBe(false);
    expect(diff.edges).toHaveLength(0);
  });

  it("still reports an identical restatement as unchanged", () => {
    const diff = computeSchemaDiff(
      nodeGraph(sameShape()),
      nodeGraph(sameShape()),
    );

    expect(diff.hasChanges).toBe(false);
  });
});

describe("real changes are still detected", () => {
  it("flags an added required property as breaking", () => {
    const diff = computeSchemaDiff(
      nodeGraph(z.object({ name: z.string() })),
      nodeGraph(z.object({ age: z.number(), name: z.string() })),
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.hasBreakingChanges).toBe(true);
  });

  it("flags a removed property as breaking", () => {
    const diff = computeSchemaDiff(
      nodeGraph(z.object({ name: z.string(), age: z.number() })),
      nodeGraph(z.object({ name: z.string() })),
    );

    expect(diff.hasBreakingChanges).toBe(true);
  });

  it("flags an added optional property as additive", () => {
    const diff = computeSchemaDiff(
      nodeGraph(z.object({ name: z.string() })),
      nodeGraph(
        z.object({ name: z.string(), nickname: z.string().optional() }),
      ),
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it("flags changed enum members — not just reordered ones", () => {
    const diff = computeSchemaDiff(
      nodeGraph(z.object({ tier: z.enum(["gold", "silver"]) })),
      nodeGraph(z.object({ tier: z.enum(["silver", "platinum"]) })),
    );

    expect(diff.hasChanges).toBe(true);
    expect(diff.hasBreakingChanges).toBe(true);
  });

  it("flags genuinely different edge endpoints", () => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const Company = defineNode("Company", {
      schema: z.object({ name: z.string() }),
    });
    const linked = defineEdge("linked", { schema: z.object({}) });
    const build = (
      from: readonly [typeof Person] | readonly [typeof Person, typeof Company],
    ) =>
      serializeSchema(
        defineGraph({
          id: "diff_ordering",
          nodes: { Person: { type: Person }, Company: { type: Company } },
          edges: { linked: { type: linked, from: [...from], to: [Company] } },
        }),
        1,
      );

    const diff = computeSchemaDiff(build([Person]), build([Person, Company]));
    expect(diff.hasChanges).toBe(true);
  });
});

// `default`, `const`, and `enum` members hold user values, not subschemas. A
// key named `required` or `enum` inside one carries no schema meaning, so
// normalizing it would hide a real change to the stored value.
function withDefault(order: readonly string[]): SerializedSchema {
  return nodeGraph(
    z.object({
      config: z
        .object({ required: z.array(z.string()) })
        .default({ required: [...order] }),
    }),
  );
}

// A user field can be *named* like a keyword. `properties` keys are names, not
// keywords, so the subschema under one still has to be normalized.
function keywordNamedField(reversed: boolean): SerializedSchema {
  return nodeGraph(
    z.object({
      default:
        reversed ?
          z.object({ b: z.string(), a: z.string() })
        : z.object({ a: z.string(), b: z.string() }),
    }),
  );
}

function defaultedShape(reversed: boolean): SerializedSchema {
  return nodeGraph(
    reversed ?
      z.object({ b: z.string(), a: z.string().default("x") })
    : z.object({ a: z.string().default("x"), b: z.string() }),
  );
}

describe("instance data is not normalized as schema", () => {
  it("detects a reordered array inside a default value", () => {
    const diff = computeSchemaDiff(
      withDefault(["a", "b"]),
      withDefault(["b", "a"]),
    );

    expect(diff.hasChanges).toBe(true);
  });

  it("still treats an unchanged default as unchanged", () => {
    const diff = computeSchemaDiff(
      withDefault(["a", "b"]),
      withDefault(["a", "b"]),
    );

    expect(diff.hasChanges).toBe(false);
  });

  it("normalizes a subschema under a field named like a keyword", () => {
    expect(
      computeSchemaDiff(keywordNamedField(false), keywordNamedField(true))
        .hasChanges,
    ).toBe(false);
  });

  it("normalizes the schema's own required list even when a default is present", () => {
    // The declaration order changed; the default did not.
    expect(
      computeSchemaDiff(defaultedShape(false), defaultedShape(true)).hasChanges,
    ).toBe(false);
  });
});

// Zod's `.meta()` merges arbitrary keys straight into the generated JSON
// Schema, so an unrecognized keyword can hold user data shaped like a schema.
function withExtensionKeyword(order: readonly string[]): SerializedSchema {
  return nodeGraph(
    z.object({
      field: z.string().meta({ "x-config": { required: [...order] } }),
    }),
  );
}

function withDependentRequired(order: readonly string[]): SerializedSchema {
  return nodeGraph(
    z.object({ a: z.string(), b: z.string() }).meta({
      dependentRequired: { a: [...order] },
    }),
  );
}

describe("recursion is limited to known schema keywords", () => {
  it("detects a change inside an unknown extension keyword", () => {
    // `x-config` is not a schema keyword — its contents are user data, so a
    // reordering inside it is a real change and must not be normalized away.
    const diff = computeSchemaDiff(
      withExtensionKeyword(["a", "b"]),
      withExtensionKeyword(["b", "a"]),
    );

    expect(diff.hasChanges).toBe(true);
  });

  it("normalizes dependentRequired name sets", () => {
    const diff = computeSchemaDiff(
      withDependentRequired(["x", "y"]),
      withDependentRequired(["y", "x"]),
    );

    expect(diff.hasChanges).toBe(false);
  });
});

describe("the committed schema hash is unaffected", () => {
  it("still hashes a reordered declaration differently", async () => {
    // The order-normalization is scoped to diff comparison on purpose: the
    // canonical form also feeds `computeSchemaHash`, and normalizing there
    // would change the hash of every schema already committed to a database.
    const [before, after] = await Promise.all([
      computeSchemaHash(
        nodeGraph(z.object({ name: z.string(), age: z.number() })),
      ),
      computeSchemaHash(
        nodeGraph(z.object({ age: z.number(), name: z.string() })),
      ),
    ]);

    expect(before).not.toBe(after);

    // ...while the diff correctly reports no change, so the mismatched hash
    // falls through to a diff that finds nothing rather than a forced migration.
    const diff = computeSchemaDiff(
      nodeGraph(z.object({ name: z.string(), age: z.number() })),
      nodeGraph(z.object({ age: z.number(), name: z.string() })),
    );
    expect(diff.hasChanges).toBe(false);
  });
});
