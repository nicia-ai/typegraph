/**
 * The compile-time ↔ registry-build agreement.
 *
 * The compile-time rule is the `SubClassOfCheck` conditional type
 * (`src/ontology/types.ts`); `isTypeLevelSubtype` is its runtime
 * prediction, the registry's comparison over each side's `projectTypeVisible`
 * projection. Two things are pinned here:
 *
 * 1. A table of node pairs whose expected verdict the TYPE CHECKER holds to
 *    the real conditional type (`agreementRow`), and the runtime holds to
 *    `isTypeLevelSubtype`. A row whose prediction drifts from the type fails
 *    one side or the other, and a registry-accepted row
 *    (`isStructuralSubtype`) must compile.
 * 2. A property of the comparison engine itself, not of TypeScript:
 *    projecting value-level keywords away never turns a `subtype` verdict
 *    into a refusal, so whatever the registry accepts, the prediction
 *    accepts too. It compares one engine over two views of the same pair,
 *    so it cannot detect a prediction that disagrees with the type checker;
 *    that is what the table is for.
 *
 * The converse does not hold — TypeScript cannot see value-level
 * constraints — and is asserted below as a named counterexample.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { embedding } from "../../src/core/embedding";
import { defineNode } from "../../src/core/node";
import { type NodeType } from "../../src/core/types";
import { type SubClassOfCheck } from "../../src/ontology/types";
import {
  isStructuralSubtype,
  isTypeLevelSubtype,
} from "../../src/schema/structural-subsumption";
import {
  isProjectedSchemaSubtype,
  projectTypeVisible,
} from "../../src/schema/structural-subtype";
import { comparableSchemaArb, tightenArb } from "./arbitraries";

/** Whether `subClassOf(C, P)` compiles: the check resolves to `unknown`. */
type CompilesAsSubclass<C extends NodeType, P extends NodeType> =
  unknown extends SubClassOfCheck<C, P> ? true : false;

type AgreementRow = Readonly<{
  name: string;
  child: NodeType;
  parent: NodeType;
  compiles: boolean;
}>;

/**
 * A row whose `compiles` the type checker verifies: passing `true` where
 * `subClassOf(child, parent)` does not compile, or `false` where it does, is
 * a type error.
 */
function agreementRow<C extends NodeType, P extends NodeType>(
  child: C,
  parent: P,
  compiles: CompilesAsSubclass<C, P>,
): AgreementRow {
  return { name: `${child.kind} ⊑ ${parent.kind}`, child, parent, compiles };
}

describe("compile-time ↔ registry-build agreement", () => {
  it("erasing the value-level keywords never turns an accepted pair into a refused one", () => {
    fc.assert(
      fc.property(
        comparableSchemaArb.chain((parent) =>
          tightenArb(parent).map((child) => [child, parent] as const),
        ),
        ([child, parent]) => {
          const structuralResult = isProjectedSchemaSubtype(child, parent);
          if (structuralResult.verdict !== "subtype") return;
          expect(
            isProjectedSchemaSubtype(
              projectTypeVisible(child),
              projectTypeVisible(parent),
            ),
          ).toEqual({ verdict: "subtype" });
        },
      ),
    );
  });

  it("named counterexample: the converse does not hold — the compile-time check accepts strictly more than the registry", () => {
    // A bare `z.string()` child under a `z.string().min(3)` parent: both
    // erase to the SAME type-visible projection (`{ type: "string" }`), so
    // isTypeLevelSubtype says "subtype" — but the child does not actually
    // guarantee the parent's minLength constraint, so isStructuralSubtype
    // (the registry's verdict) correctly refuses it.
    const looseChild = z.string();
    const tightParent = z.string().min(3);

    expect(isTypeLevelSubtype(looseChild, tightParent)).toEqual({
      verdict: "subtype",
    });
    expect(isStructuralSubtype(looseChild, tightParent).verdict).toBe(
      "not-subtype",
    );
  });

  it("agrees with the compile-time check itself on a table of node pairs", () => {
    // Each row's `compiles` is checked by the type checker against the real
    // `SubClassOfCheck` conditional type (`agreementRow`'s third parameter),
    // and at runtime against `isTypeLevelSubtype` over the same pair's
    // projection — the two predictions this file exists to keep in step.
    const rows: readonly AgreementRow[] = [
      agreementRow(
        defineNode("AgreeSameChild", { schema: z.object({ a: z.string() }) }),
        defineNode("AgreeSameParent", { schema: z.object({ a: z.string() }) }),
        true,
      ),
      agreementRow(
        defineNode("AgreeWidthChild", {
          schema: z.object({ a: z.string(), b: z.number() }),
        }),
        defineNode("AgreeWidthParent", { schema: z.object({ a: z.string() }) }),
        true,
      ),
      agreementRow(
        defineNode("AgreeMissingChild", {
          schema: z.object({ a: z.string() }),
        }),
        defineNode("AgreeMissingParent", {
          schema: z.object({ a: z.string(), b: z.string() }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeTypeChild", { schema: z.object({ a: z.number() }) }),
        defineNode("AgreeTypeParent", { schema: z.object({ a: z.string() }) }),
        false,
      ),
      agreementRow(
        defineNode("AgreeOptionalChild", {
          schema: z.object({ a: z.string().optional() }),
        }),
        defineNode("AgreeOptionalParent", {
          schema: z.object({ a: z.string() }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeRequiredChild", {
          schema: z.object({ a: z.string() }),
        }),
        defineNode("AgreeRequiredParent", {
          schema: z.object({ a: z.string().optional() }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeLiteralChild", {
          schema: z.object({ a: z.literal("active") }),
        }),
        defineNode("AgreeLiteralParent", {
          schema: z.object({ a: z.enum(["active", "inactive"]) }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeEnumChild", {
          schema: z.object({ a: z.enum(["active", "inactive"]) }),
        }),
        defineNode("AgreeEnumParent", {
          schema: z.object({ a: z.literal("active") }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeBoundChild", { schema: z.object({ a: z.string() }) }),
        defineNode("AgreeBoundParent", {
          schema: z.object({ a: z.string().min(3) }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeNullableChild", {
          schema: z.object({ a: z.string().nullable() }),
        }),
        defineNode("AgreeNullableParent", {
          schema: z.object({ a: z.string() }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeArrayChild", {
          schema: z.object({ a: z.array(z.number()) }),
        }),
        defineNode("AgreeArrayParent", {
          schema: z.object({ a: z.array(z.string()) }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeNestedChild", {
          schema: z.object({ a: z.object({ b: z.string(), c: z.number() }) }),
        }),
        defineNode("AgreeNestedParent", {
          schema: z.object({ a: z.object({ b: z.string() }) }),
        }),
        true,
      ),
      // Type-only facts with no runtime trace: a parent `.brand()`, a child
      // `.readonly()`, the `embedding()` marker. The registry accepts each,
      // so each must compile.
      agreementRow(
        defineNode("AgreeUnbrandedChild", {
          schema: z.object({ a: z.string() }),
        }),
        defineNode("AgreeBrandedParent", {
          schema: z.object({ a: z.string().brand<"Email">() }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeReadonlyChild", {
          schema: z.object({ a: z.array(z.string()).readonly() }),
        }),
        defineNode("AgreeMutableParent", {
          schema: z.object({ a: z.array(z.string()) }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeNestedReadonlyChild", {
          schema: z.object({
            a: z.object({ tags: z.array(z.string()).readonly() }),
          }),
        }),
        defineNode("AgreeNestedBrandedParent", {
          schema: z.object({
            a: z.object({ tags: z.array(z.string().brand<"Tag">()) }),
          }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeEmbeddingChild", {
          schema: z.object({ a: embedding(3) }),
        }),
        defineNode("AgreeNumberArrayParent", {
          schema: z.object({ a: z.array(z.number()) }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeFixedArrayChild", {
          schema: z.object({ a: z.array(z.number()).length(3) }),
        }),
        defineNode("AgreeEmbeddingParent", {
          schema: z.object({ a: embedding(3) }),
        }),
        true,
      ),
      agreementRow(
        defineNode("AgreeBrandedLiteralChild", {
          schema: z.object({ a: z.string() }),
        }),
        defineNode("AgreeBrandedLiteralParent", {
          schema: z.object({ a: z.literal("x").brand<"X">() }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeOptionalUnderBrandChild", {
          schema: z.object({ a: z.string().optional() }),
        }),
        defineNode("AgreeOptionalUnderBrandParent", {
          schema: z.object({ a: z.string().brand<"Email">() }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeStringUnderDateChild", {
          schema: z.object({ a: z.string() }),
        }),
        defineNode("AgreeStringUnderDateParent", {
          schema: z.object({ a: z.date() }),
        }),
        false,
      ),
      agreementRow(
        defineNode("AgreeDateChild", { schema: z.object({ a: z.date() }) }),
        defineNode("AgreeDateParent", { schema: z.object({ a: z.date() }) }),
        true,
      ),
    ];

    for (const row of rows) {
      const child = row.child.schema;
      const parent = row.parent.schema;
      expect({
        row: row.name,
        compiles: isTypeLevelSubtype(child, parent).verdict === "subtype",
      }).toEqual({ row: row.name, compiles: row.compiles });
      const registryAccepts =
        isStructuralSubtype(child, parent).verdict === "subtype";
      expect({
        row: row.name,
        compiles: row.compiles || !registryAccepts,
      }).toEqual({ row: row.name, compiles: true });
    }
  });

  /**
   * MUTATION CHECK (verified): adding `"minLength"` to
   * `TYPE_VISIBLE_KEYWORDS` in `src/schema/structural-subtype.ts` (so the
   * projection stops erasing it) fails the named counterexample and the
   * table's bounded-string row; dropping `"required"` from it fails the
   * table's optional-field row. Flipping any row's `compiles` literal is a
   * type error in this file.
   */
});
