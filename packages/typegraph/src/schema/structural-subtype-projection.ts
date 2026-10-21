/**
 * The projection a live graph's structural-subsumption check compares: the
 * kind's persisted JSON Schema projection, plus a marker wherever the Zod
 * schema constrains values in a way that projection cannot state.
 *
 * `z.toJSONSchema` drops four such facts, each of which can make
 * `isStructuralSubtype` answer `subtype` for a pair whose child admits a value
 * its parent refuses:
 *
 * - A regex's flags. `/^abc$/i` and `/^abc$/` both project as
 *   `pattern: "^abc$"`. Only `g`, which `RegExp.prototype.test` semantics
 *   under Zod do not depend on, is harmless.
 * - A `.refine()` / `.superRefine()` / `.check()` refinement, which projects
 *   as its base schema. On a CHILD it only narrows, which the verdict may
 *   ignore; on a PARENT it is a constraint the child is never compared with.
 * - A strict object (`z.strictObject`, `.strict()`). It projects exactly like
 *   a stripping `z.object()`, but refuses a key the child may add.
 * - A `.meta()` key spelled like a constraining keyword. It is merged into
 *   the projection as if it were one, though it constrains nothing.
 *
 * The persisted projection itself is not changed: it is the schema document
 * and its hash, and none of these facts was ever part of it. The markers live
 * only in this comparison input, so a stored document's own registry (which
 * has no Zod schema) never refuses what a live graph accepts — the live check
 * is the stricter of the two, and every commit path builds it first.
 *
 * A marker's value names the Zod instance that carries the fact, so a child
 * that reuses its parent's schema (or a field schema they share) still
 * compares equal under rule 2 of `isStructuralSubtype`, while two different
 * refinements never do.
 */
import { z } from "zod";

import {
  isUnprojectableSchemaProjection,
  serializeSchemaProperties,
} from "./serializer";
import {
  COMPARABLE_KEYWORDS,
  UNMODELED_CONSTRAINING_KEYWORDS,
  ZOD_ONLY_CONSTRAINT_KEYWORD,
  ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
} from "./structural-subtype";
import { type JsonSchema } from "./types";

const PROJECTION_CACHE = new WeakMap<z.ZodType, JsonSchema>();

/** A stable token per Zod object, so equal markers mean the same instance. */
const INSTANCE_TOKENS = new WeakMap<object, string>();
let nextInstanceToken = 0;

function instanceToken(instance: object): string {
  const existing = INSTANCE_TOKENS.get(instance);
  if (existing !== undefined) return existing;
  nextInstanceToken += 1;
  const token = String(nextInstanceToken);
  INSTANCE_TOKENS.set(instance, token);
  return token;
}

/** The parts of Zod's internal check definition this module reads. */
type ZodCheckDef = Readonly<{
  check?: string;
  format?: string;
  pattern?: RegExp;
}>;

type ZodNodeDef = Readonly<{
  type?: string;
  checks?: readonly Readonly<{ _zod: Readonly<{ def: ZodCheckDef }> }>[];
  catchall?: Readonly<{ _zod: Readonly<{ def: Readonly<{ type?: string }> }> }>;
}>;

/** Regex flags that change which strings match. */
function hasSemanticRegexFlags(pattern: RegExp): boolean {
  return pattern.flags.replaceAll("g", "") !== "";
}

function isConstrainingKeyword(key: string): boolean {
  return (
    COMPARABLE_KEYWORDS.has(key) || UNMODELED_CONSTRAINING_KEYWORDS.has(key)
  );
}

function markOpaque(
  jsonSchema: Record<string, unknown>,
  keyword: string,
  token: string,
): void {
  const existing = jsonSchema[keyword];
  jsonSchema[keyword] =
    typeof existing === "string" ? `${existing} ${token}` : token;
}

function markZodOnlyConstraints(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const def = context.zodSchema._zod.def as ZodNodeDef;
  for (const check of def.checks ?? []) {
    const checkDef = check._zod.def;
    if (checkDef.check === "custom") {
      markOpaque(
        context.jsonSchema,
        ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
        `refinement:${instanceToken(check)}`,
      );
    }
    if (
      checkDef.format === "regex" &&
      checkDef.pattern !== undefined &&
      hasSemanticRegexFlags(checkDef.pattern)
    ) {
      markOpaque(
        context.jsonSchema,
        ZOD_ONLY_CONSTRAINT_KEYWORD,
        `flags:${checkDef.pattern.flags}`,
      );
    }
  }
  if (def.type === "object" && def.catchall?._zod.def.type === "never") {
    markOpaque(
      context.jsonSchema,
      ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
      "strict",
    );
  }
  const meta = z.globalRegistry.get(context.zodSchema);
  if (
    meta !== undefined &&
    Object.keys(meta).some((key) => isConstrainingKeyword(key))
  ) {
    markOpaque(
      context.jsonSchema,
      ZOD_ONLY_CONSTRAINT_KEYWORD,
      `meta:${instanceToken(context.zodSchema)}`,
    );
  }
}

/**
 * The comparison projection of `schema` (see the module docblock). The
 * unprojectable placeholder is returned as is, so
 * `isUnprojectableSchemaProjection` still recognizes it. Memoized by schema
 * identity.
 */
export function structuralSubtypeProjection(schema: z.ZodType): JsonSchema {
  const cached = PROJECTION_CACHE.get(schema);
  if (cached !== undefined) return cached;
  const persisted = serializeSchemaProperties(schema);
  const projection =
    isUnprojectableSchemaProjection(persisted) ? persisted : (
      (z.toJSONSchema(schema, {
        override: (context) => {
          markZodOnlyConstraints(context);
        },
      }) as JsonSchema)
    );
  PROJECTION_CACHE.set(schema, projection);
  return projection;
}
