/**
 * The structural-subsumption decision a `subClassOf` / `equivalentTo` pair
 * faces, exposed under the one owner the registry and public tooling share.
 *
 * {@link judgeStructuralSubsumption} is the registry's per-pair verdict:
 * `findStructuralSubsumptionViolations`
 * (`src/registry/validate-structural-subsumption.ts`) refuses exactly the
 * pairs it does not answer `subtype` or `unchecked` for. The public
 * {@link isStructuralSubtype} feeds it the same comparison projection a live
 * graph's registry build compares (`structuralSubtypeProjection`), so its
 * answer is the registry's answer for that pair of Zod schemas, not an
 * approximation of it. {@link isTypeLevelSubtype} applies the same engine to
 * the type-visible fragment of that projection, predicting the compile-time
 * check instead.
 */
import { type z } from "zod";

import { isUnprojectableSchemaProjection } from "./serializer";
import {
  isProjectedSchemaSubtype,
  projectTypeVisible,
  type StructuralSubtypeResult,
} from "./structural-subtype";
import { structuralSubtypeProjection } from "./structural-subtype-projection";
import { type JsonSchema } from "./types";

/**
 * A structural-subsumption verdict on one pair:
 *
 * - `"subtype"`: every value the child stores satisfies the parent.
 * - `"not-subtype"`: a comparable pair that fails, with the `reason` and the
 *   `path` to the offending field.
 * - `"incomparable"`: the pair cannot be decided (a construct the
 *   comparison cannot judge, such as a parent refinement or a strict
 *   parent object), with its `reason` and `path`. The registry refuses it
 *   like `"not-subtype"`.
 * - `"unchecked"`: a side has no projection at all (its JSON Schema
 *   conversion failed outright), so nothing was compared. The registry
 *   accepts such a pair without judging it; the compile-time check is all
 *   that judged it.
 */
export type StructuralSubsumptionVerdict =
  | StructuralSubtypeResult
  | Readonly<{ verdict: "unchecked"; reason: "unprojectable-schema" }>;

const UNCHECKED: StructuralSubsumptionVerdict = {
  verdict: "unchecked",
  reason: "unprojectable-schema",
};

function compareProjections(
  childProjection: JsonSchema,
  parentProjection: JsonSchema,
  view: (projection: JsonSchema) => JsonSchema,
): StructuralSubsumptionVerdict {
  if (
    isUnprojectableSchemaProjection(childProjection) ||
    isUnprojectableSchemaProjection(parentProjection)
  ) {
    return UNCHECKED;
  }
  return isProjectedSchemaSubtype(
    view(childProjection),
    view(parentProjection),
  );
}

/**
 * The registry's verdict on one (child, parent) property-schema pair, given
 * each side's projection: a live graph's `structuralSubtypeProjection`, or a
 * persisted document's stored projection. A pair with the unprojectable
 * placeholder on either side is `"unchecked"`.
 */
export function judgeStructuralSubsumption(
  childProjection: JsonSchema,
  parentProjection: JsonSchema,
): StructuralSubsumptionVerdict {
  return compareProjections(
    childProjection,
    parentProjection,
    (projection) => projection,
  );
}

/**
 * Does every value `child` stores satisfy `parent`? The registry's own
 * verdict: `subClassOf(child, parent)` between kinds with these schemas
 * (and each direction of an `equivalentTo`) builds exactly when this answers
 * `"subtype"` or `"unchecked"`, and is refused with the `reason` and `path`
 * this returns otherwise.
 *
 * It reads the Zod schemas, so it sees what a JSON Schema document cannot: a
 * refinement or strict object on the parent, a regex flag, an overwrite such
 * as `.trim()`, a pipe's input side. See {@link StructuralSubsumptionVerdict}
 * for the four verdicts.
 */
export function isStructuralSubtype(
  child: z.ZodType,
  parent: z.ZodType,
): StructuralSubsumptionVerdict {
  return judgeStructuralSubsumption(
    structuralSubtypeProjection(child),
    structuralSubtypeProjection(parent),
  );
}

/**
 * Will `subClassOf(child, parent)` between kinds with these schemas compile?
 * The runtime prediction of the compile-time check: the
 * {@link isStructuralSubtype} comparison over only what TypeScript's
 * assignability over `z.infer` can see (shape, optionality and literal value
 * sets, not length bounds, patterns, numeric bounds or refinements).
 *
 * Whatever {@link isStructuralSubtype} accepts, this accepts too: a
 * hierarchy the registry builds always compiles. The converse does not hold:
 * a bare `z.string()` child under a `z.string().min(3)` parent compiles and
 * is refused at registry build. `"unchecked"` means the same as there.
 */
export function isTypeLevelSubtype(
  child: z.ZodType,
  parent: z.ZodType,
): StructuralSubsumptionVerdict {
  return compareProjections(
    structuralSubtypeProjection(child),
    structuralSubtypeProjection(parent),
    (projection) => projectTypeVisible(projection),
  );
}
