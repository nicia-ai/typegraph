/**
 * The C.1 (compile time) ↔ C.2 (registry build) agreement property.
 *
 * C.1's rule is a TypeScript conditional type and cannot be called at
 * runtime, so it is pinned in two halves, with NO second comparison engine:
 *
 * 1. `isTypeLevelSubtype` (`src/schema/structural-subtype.ts`) —
 *    `isStructuralSubtype` applied to each side's `projectTypeVisible`
 *    projection, which drops exactly the keywords `z.infer` cannot see.
 * 2. This property: for every generated pair `isStructuralSubtype` accepts,
 *    `isTypeLevelSubtype` also accepts it. This is the ONE direction that
 *    can be true — a hierarchy the registry (C.2) accepts must compile
 *    (C.1) — since TypeScript cannot see value-level constraints and so
 *    necessarily accepts strictly MORE than the registry does (roadmap
 *    §1.3). The converse is asserted below as a NAMED counterexample, not
 *    left implicit.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { serializeSchemaProperties } from "../../src/schema/serializer";
import {
  isStructuralSubtype,
  isTypeLevelSubtype,
} from "../../src/schema/structural-subtype";
import { comparableSchemaArb, tightenArb } from "./arbitraries";

describe("C.1 ↔ C.2 agreement", () => {
  it("every structural subtype (C.2 accepts) is also a type-level subtype (C.1 compiles)", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb.chain((parent) =>
          tightenArb(parent).map((child) => [child, parent] as const),
        ),
        ([child, parent]) => {
          const structuralResult = isStructuralSubtype(child, parent);
          if (structuralResult.verdict !== "subtype") return;
          expect(isTypeLevelSubtype(child, parent)).toEqual({
            verdict: "subtype",
          });
        },
      ),
    );
  });

  it("named counterexample: the converse does not hold — C.1 accepts strictly more than C.2", () => {
    // A bare `z.string()` child under a `z.string().min(3)` parent: both
    // erase to the SAME type-visible projection (`{ type: "string" }`), so
    // isTypeLevelSubtype says "subtype" — but the child does not actually
    // guarantee the parent's minLength constraint, so isStructuralSubtype
    // (the authority) correctly refuses it.
    const looseChild = serializeSchemaProperties(z.string());
    const tightParent = serializeSchemaProperties(z.string().min(3));

    expect(isTypeLevelSubtype(looseChild, tightParent)).toEqual({
      verdict: "subtype",
    });
    expect(isStructuralSubtype(looseChild, tightParent).verdict).toBe(
      "not-subtype",
    );
  });

  it("fixture table: a representative row set the compile-time contract must agree with", () => {
    const rows: readonly {
      readonly name: string;
      readonly child: z.ZodType;
      readonly parent: z.ZodType;
      readonly expected: "subtype" | "not-subtype" | "incomparable";
    }[] = [
      {
        name: "identical string",
        child: z.string(),
        parent: z.string(),
        expected: "subtype",
      },
      {
        name: "width subtyping — child adds a property",
        child: z.object({ a: z.string(), b: z.string() }),
        parent: z.object({ a: z.string() }),
        expected: "subtype",
      },
      {
        name: "child missing a required parent property",
        child: z.object({ a: z.string() }),
        parent: z.object({ a: z.string(), b: z.string() }),
        expected: "not-subtype",
      },
      {
        name: "child narrows an enum to a literal",
        child: z.literal("active"),
        parent: z.enum(["active", "inactive"]),
        expected: "subtype",
      },
    ];

    for (const row of rows) {
      const childSchema = serializeSchemaProperties(row.child);
      const parentSchema = serializeSchemaProperties(row.parent);
      expect(
        isTypeLevelSubtype(childSchema, parentSchema).verdict,
        `type-level: ${row.name}`,
      ).toBe(row.expected === "subtype" ? "subtype" : row.expected);
    }
  });

  /**
   * Mutation check performed manually and recorded in
   * lane-C13-load-bearing.md: adding `"minLength"` to
   * `TYPE_VISIBLE_KEYWORDS` in `src/schema/structural-subtype.ts` (so the
   * projection stops erasing it) makes the "named counterexample" test above
   * fail — with `minLength` visible, `isTypeLevelSubtype` no longer misreads
   * a bare `z.string()` as a subtype of a `z.string().min(3)` parent, which
   * is exactly the erasure gap that test pins. (`comparableSchemaArb` /
   * `tightenArb` never generate `pattern`, so mutating that keyword instead
   * — the plan's original suggestion — exercises no generated schema and is
   * not a usable mutation target for this generator.)
   */
});
