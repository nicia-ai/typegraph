/**
 * The public `isStructuralSubtype` (`/schema`) is the registry's verdict,
 * not a second reading of it.
 *
 * Each pair below is one the registry refuses because the Zod schema states
 * a constraint a plain JSON Schema document drops (a strict or refined
 * parent, an overwrite, a regex flag). A JSON-level predicate fed
 * `z.toJSONSchema` output answers `"subtype"` for every one of them, and
 * the witness — a value the child stores and the parent refuses — shows that
 * answer is wrong. The public predicate must agree with `buildKindRegistry`
 * on every pair, refusals and accepts alike.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, subClassOf } from "../src";
import { ConfigurationError } from "../src/errors";
import { buildKindRegistry } from "../src/registry/builders";
import {
  isStructuralSubtype,
  isTypeLevelSubtype,
  type StructuralSubsumptionVerdict,
} from "../src/schema";

type VerdictPair = Readonly<{
  name: string;
  child: z.ZodObject;
  parent: z.ZodObject;
  /** A value the child stores and the parent refuses, for a refused pair. */
  witness?: unknown;
}>;

const REFUSED_PAIRS: readonly VerdictPair[] = [
  {
    name: "a child key under a strict parent",
    child: z.object({ f: z.string(), extra: z.string() }),
    parent: z.object({ f: z.string() }).strict(),
    witness: { f: "a", extra: "b" },
  },
  {
    name: "a refined parent",
    child: z.object({ f: z.string() }),
    parent: z.object({ f: z.string() }).refine((value) => value.f !== "x"),
    witness: { f: "x" },
  },
  {
    name: "a superRefine parent",
    child: z.object({ f: z.number() }),
    parent: z.object({ f: z.number() }).superRefine((value, context) => {
      if (value.f > 10) context.addIssue({ code: "custom", message: "big" });
    }),
    witness: { f: 11 },
  },
  {
    name: "a trimming child under a length bound",
    child: z.object({ f: z.string().min(3).trim() }),
    parent: z.object({ f: z.string().min(3) }),
    witness: { f: "  a  " },
  },
  {
    name: "an upper-casing child under a lower-case pattern",
    child: z.object({
      f: z
        .string()
        .regex(/^[a-z]+$/)
        .toUpperCase(),
    }),
    parent: z.object({ f: z.string().regex(/^[a-z]+$/) }),
    witness: { f: "abc" },
  },
  {
    name: "an overwrite that pads past the parent's bound",
    child: z.object({
      f: z
        .string()
        .max(3)
        .overwrite((value) => `${value}!!!!`),
    }),
    parent: z.object({ f: z.string().max(3) }),
    witness: { f: "ab" },
  },
  {
    name: "a case-insensitive regex under a case-sensitive one",
    child: z.object({ f: z.string().regex(/^abc$/i) }),
    parent: z.object({ f: z.string().regex(/^abc$/) }),
    witness: { f: "ABC" },
  },
  {
    name: "an array under a refined array",
    child: z.object({ f: z.array(z.string()) }),
    parent: z.object({
      f: z
        .array(z.string())
        .refine((items) => new Set(items).size === items.length),
    }),
    witness: { f: ["a", "a"] },
  },
  {
    name: "a nested key under a nested strict object",
    child: z.object({ n: z.object({ a: z.string(), b: z.string() }) }),
    parent: z.object({ n: z.object({ a: z.string() }).strict() }),
    witness: { n: { a: "a", b: "b" } },
  },
  {
    name: "a nested object under a nested refinement",
    child: z.object({ n: z.object({ a: z.number() }) }),
    parent: z.object({
      n: z.object({ a: z.number() }).refine((value) => value.a > 0),
    }),
    witness: { n: { a: -1 } },
  },
];

const ACCEPTED_PAIRS: readonly VerdictPair[] = [
  {
    name: "width subtyping",
    child: z.object({ f: z.string(), extra: z.number() }),
    parent: z.object({ f: z.string() }),
  },
  {
    name: "a bound that tightens",
    child: z.object({ f: z.string().min(5) }),
    parent: z.object({ f: z.string().min(3) }),
  },
  {
    name: "a refined child",
    child: z.object({ f: z.string() }).refine((value) => value.f !== "x"),
    parent: z.object({ f: z.string() }),
  },
  {
    name: "a branded parent field",
    child: z.object({ f: z.string() }),
    parent: z.object({ f: z.string().brand<"Email">() }),
  },
  {
    name: "a readonly child array",
    child: z.object({ f: z.array(z.string()).readonly() }),
    parent: z.object({ f: z.array(z.string()) }),
  },
];

let graphCounter = 0;

/** Whether `buildKindRegistry` accepts `subClassOf(child, parent)`. */
function registryAccepts(pair: VerdictPair): boolean {
  graphCounter += 1;
  const Child = defineNode(`VerdictChild${graphCounter}`, {
    schema: pair.child,
  });
  const Parent = defineNode(`VerdictParent${graphCounter}`, {
    schema: pair.parent,
  });
  // The compile-time check accepts some of these pairs and refuses others;
  // the cast reaches the registry for every one, which is what this pins.
  const relation = subClassOf(Child as never, Parent as never);
  try {
    buildKindRegistry(
      defineGraph({
        id: `public_verdict_${graphCounter}`,
        nodes: {
          [Child.kind]: { type: Child },
          [Parent.kind]: { type: Parent },
        },
        edges: {},
        ontology: [relation],
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConfigurationError) return false;
    throw error;
  }
}

function acceptedByRegistryRule(verdict: StructuralSubsumptionVerdict) {
  return verdict.verdict === "subtype" || verdict.verdict === "unchecked";
}

describe("isStructuralSubtype is the registry's verdict", () => {
  it.each(REFUSED_PAIRS)("refuses $name, as the registry does", (pair) => {
    const verdict = isStructuralSubtype(pair.child, pair.parent);
    console.log(`${pair.name}: ${JSON.stringify(verdict)}`);
    expect(verdict.verdict).not.toBe("subtype");
    expect(acceptedByRegistryRule(verdict)).toBe(registryAccepts(pair));
    expect(pair.parent.safeParse(pair.child.parse(pair.witness)).success).toBe(
      false,
    );
  });

  it.each(ACCEPTED_PAIRS)("accepts $name, as the registry does", (pair) => {
    const verdict = isStructuralSubtype(pair.child, pair.parent);
    expect(verdict).toEqual({ verdict: "subtype" });
    expect(registryAccepts(pair)).toBe(true);
  });

  it("predicts the compile-time check for a pair the registry refuses", () => {
    const tightParent = z.object({ f: z.string().min(3) });
    const looseChild = z.object({ f: z.string() });
    expect(isTypeLevelSubtype(looseChild, tightParent)).toEqual({
      verdict: "subtype",
    });
    expect(isStructuralSubtype(looseChild, tightParent).verdict).toBe(
      "not-subtype",
    );
  });
});
