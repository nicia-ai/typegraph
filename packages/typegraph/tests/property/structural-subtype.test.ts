/**
 * Property-based tests for the structural subtyping predicate.
 *
 * Uses `comparableSchemaArb` / `tightenArb` from `./arbitraries.ts` — shared
 * there (per the lead's ruling) so the C.1 lane's child/parent-agreement
 * property test can reuse the same generators rather than re-deriving them.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isObjectSchema } from "../../src/schema/migration";
import { isStructuralSubtype } from "../../src/schema/structural-subtype";
import { type JsonSchema } from "../../src/schema/types";
import { comparableSchemaArb, tightenArb } from "./arbitraries";

// A property name guaranteed absent from every schema `comparableSchemaArb`
// generates (its object fields are drawn only from "fieldA"/"fieldB"/"fieldC").
const FRESH_PROPERTY_NAME = "freshRequiredField";

function objectSchemaArb(): fc.Arbitrary<JsonSchema> {
  return comparableSchemaArb.filter((schema) => isObjectSchema(schema));
}

function objectSchemaWithRequiredPropertyArb(): fc.Arbitrary<JsonSchema> {
  return comparableSchemaArb.filter(
    (schema) => isObjectSchema(schema) && (schema.required?.length ?? 0) > 0,
  );
}

describe("structural subtyping properties", () => {
  it("P1: reflexivity — every comparable schema is a subtype of itself", () => {
    fc.assert(
      fc.property(comparableSchemaArb, (schema) => {
        expect(isStructuralSubtype(schema, schema)).toEqual({
          verdict: "subtype",
        });
      }),
    );
  });

  it("P2: tightening is subtyping — tighten(p) is always a subtype of p", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb.chain((parent) =>
          tightenArb(parent).map((child) => [child, parent] as const),
        ),
        ([child, parent]) => {
          expect(isStructuralSubtype(child, parent)).toEqual({
            verdict: "subtype",
          });
        },
      ),
    );
  });

  it("P3: transitivity over tightening chains — tighten(tighten(p)) is still a subtype of p", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb.chain((parent) =>
          tightenArb(parent).chain((intermediate) =>
            tightenArb(intermediate).map((child) => [child, parent] as const),
          ),
        ),
        ([child, parent]) => {
          const result = isStructuralSubtype(child, parent);
          if (result.verdict !== "subtype") {
            // Per the plan: a P3 counterexample is a design defect in the
            // rule set, not a test problem — surface the triple rather than
            // weakening the property.
            throw new Error(
              `Transitivity failed for child=${JSON.stringify(child)} parent=${JSON.stringify(
                parent,
              )}: got ${JSON.stringify(result)}`,
            );
          }
          expect(result).toEqual({ verdict: "subtype" });
        },
      ),
    );
  });

  it("P4: a child adding a required field is a subtype, and the reverse direction is not", () => {
    fc.assert(
      fc.property(
        objectSchemaArb(),
        comparableSchemaArb,
        (parent, newPropertySchema) => {
          const parentProps = parent.properties ?? {};
          fc.pre(!Object.hasOwn(parentProps, FRESH_PROPERTY_NAME));

          const child: JsonSchema = {
            ...parent,
            properties: {
              ...parentProps,
              [FRESH_PROPERTY_NAME]: newPropertySchema,
            },
            required: [...(parent.required ?? []), FRESH_PROPERTY_NAME],
          };

          expect(isStructuralSubtype(child, parent)).toEqual({
            verdict: "subtype",
          });

          const reverse = isStructuralSubtype(parent, child);
          expect(reverse).toMatchObject({
            verdict: "not-subtype",
            reason: "missing-required-property",
          });
        },
      ),
    );
  });

  it("P5: relaxing a required field to optional is not subtyping", () => {
    fc.assert(
      fc.property(objectSchemaWithRequiredPropertyArb(), (parent) => {
        const parentRequired = parent.required ?? [];
        fc.pre(parentRequired.length > 0);
        const [droppedName] = parentRequired;

        const child: JsonSchema = {
          ...parent,
          required: parentRequired.filter((name) => name !== droppedName),
        };

        const result = isStructuralSubtype(child, parent);
        expect(result).toMatchObject({
          verdict: "not-subtype",
          reason: "optional-in-child-required-in-parent",
        });
      }),
    );
  });

  it("P6: the verdict is always total and well-shaped, and never throws", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb,
        comparableSchemaArb,
        (schemaA, schemaB) => {
          const result = isStructuralSubtype(schemaA, schemaB);
          const isWellShaped =
            result.verdict === "subtype" ?
              Object.keys(result).length === 1
            : typeof result.reason === "string" && Array.isArray(result.path);
          expect(isWellShaped).toBe(true);
        },
      ),
    );
  });
});
