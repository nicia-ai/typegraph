/**
 * The registry-build-time structural subsumption check (C.2, roadmap D2).
 *
 * C.1 (`src/ontology/core-meta-edges.ts`) is a compile-time FILTER: it
 * catches every incompatibility TypeScript's structural assignability over
 * `z.infer` can see, but a value-level constraint (`z.string().min(3)`
 * tightening a bare `z.string()`) is invisible to it. This module is the
 * AUTHORITATIVE check — it runs against the projected JSON Schema, which
 * does carry those constraints, for every `subClassOf` and `equivalentTo`
 * pair the registry's transitive closure can produce, regardless of which of
 * the three authoring routes (compile-time `GraphDef`, `evolve()`-authored
 * extension, or a deserialized persisted document) produced it.
 *
 * **The pair set is `subClassAncestors`, not the declared relations.** Item
 * B folds every `equivalentTo` class into `subClassAncestors` /
 * `subClassDescendants` before the transitive closure
 * (`src/registry/kind-registry.ts`), so walking `subClassAncestors` alone
 * already covers:
 *
 * - every declared `subClassOf(child, parent)` (`parent ∈
 *   ancestors(child)`);
 * - every `equivalentTo(A, B)` in BOTH directions (the fold is symmetric);
 * - every TRANSITIVE consequence of either.
 *
 * This is exactly the set `isAssignableTo` answers `true` for, and
 * `isAssignableTo` is what the write path, edge endpoints,
 * `expandSubClasses`, `includeSubClasses`, and the `kindWithSubClasses`
 * claim axis all consume — binding the guarantee to the CLOSURE rather than
 * to the declaration syntax is what makes it load-bearing:
 * `isAssignableTo(A, B)` must imply every A row satisfies B's schema.
 *
 * Iteration is in `compareCodePoints` order over kinds and over each kind's
 * ancestors, so the first violation `buildValidatedKindRegistry` reports is
 * stable across runs and engines.
 *
 * A pair where either side has no projected property schema — an
 * unregistered parent kind (a supported pattern; see the doc example at
 * `src/registry/builders.ts`) or an external IRI — is skipped: subsumption
 * does not apply to a kind this registry does not know the shape of.
 *
 * `evolve()` re-declaring an existing kind needs no special path: the
 * registry is rebuilt from the merged graph and this module walks the WHOLE
 * closure every time, so a redeclared kind is re-checked against its
 * parents, its children, and its equivalents in one pass. Do not add a
 * second, narrower re-check for the `evolve()` case.
 */
import {
  isStructuralSubtype,
  type StructuralIncomparableReason,
  type StructuralSubtypeReason,
} from "../schema/structural-subtype";
import { type JsonSchema } from "../schema/types";
import { compareCodePoints } from "../utils/compare";
import { type KindRegistry } from "./kind-registry";

// ============================================================
// Public Types
// ============================================================

/** One `subClassOf`/`equivalentTo` pair whose child does not structurally
 * extend its parent — either verdict `isStructuralSubtype` can return that
 * is not `"subtype"`. */
export type StructuralSubsumptionViolation = Readonly<{
  childKind: string;
  parentKind: string;
  /** Whether this pair is (also) held equivalent, for the caller's error-code choice. */
  viaEquivalence: boolean;
  /** A directly declared relation, vs a transitive consequence of one or more declared relations. */
  declared: boolean;
  verdict: "not-subtype" | "incomparable";
  reason: StructuralSubtypeReason | StructuralIncomparableReason;
  path: readonly string[];
}>;

/**
 * Whether `first, second` (in that order) is a directly DECLARED relation —
 * a `subClassOf(first, second)`, or an `equivalentTo`/`sameAs` pair in
 * either order (equivalence is inherently bidirectional; both directions are
 * "declared", never transitive-only).
 */
export type DeclaredSubsumptionPair = (
  first: string,
  second: string,
) => boolean;

// ============================================================
// The check
// ============================================================

/**
 * Every `(child, parent)` pair in `closures.subClassAncestors`'s transitive
 * closure whose projected schemas are NOT a structural subtype, in stable
 * `compareCodePoints` order. Empty when every pair the closure produces is
 * either a genuine subtype or unregistered (skipped).
 */
export function findStructuralSubsumptionViolations(
  closures: Pick<KindRegistry, "subClassAncestors">,
  equivalence: (a: string, b: string) => boolean,
  propertySchemaOf: (kind: string) => JsonSchema | undefined,
  declared: DeclaredSubsumptionPair,
): readonly StructuralSubsumptionViolation[] {
  const violations: StructuralSubsumptionViolation[] = [];
  const childKinds = [...closures.subClassAncestors.keys()].toSorted(
    (left, right) => compareCodePoints(left, right),
  );

  for (const childKind of childKinds) {
    const ancestors = closures.subClassAncestors.get(childKind) ?? new Set();
    const parentKinds = [...ancestors].toSorted((left, right) =>
      compareCodePoints(left, right),
    );

    for (const parentKind of parentKinds) {
      if (childKind === parentKind) continue;

      const childSchema = propertySchemaOf(childKind);
      const parentSchema = propertySchemaOf(parentKind);
      // Unregistered kind (external IRI, or a parent this document only
      // references) — subsumption does not apply; skip, do not throw.
      if (childSchema === undefined || parentSchema === undefined) continue;

      const result = isStructuralSubtype(childSchema, parentSchema);
      if (result.verdict === "subtype") continue;

      violations.push({
        childKind,
        parentKind,
        viaEquivalence: equivalence(childKind, parentKind),
        declared: declared(childKind, parentKind),
        verdict: result.verdict,
        reason: result.reason,
        path: result.path,
      });
    }
  }

  return violations;
}
