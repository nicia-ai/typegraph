import { type z } from "zod";

/**
 * The schema wrappers whose input is their inner schema's input and whose
 * output is their inner schema's output (or a value the wrapper states, of
 * the same type: a default, a catch value).
 */
const TRANSPARENT_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

type WrapperDef = Readonly<{
  innerType?: z.ZodType;
  checks?: readonly Readonly<{
    _zod: Readonly<{ def: Readonly<{ check: string }> }>;
  }>[];
}>;

/**
 * Whether a schema carries an `.overwrite()` check: one that replaces the
 * value on every parse, so neither its input nor its output is stated by the
 * schema's structure.
 */
export function hasOverwriteCheck(schema: z.ZodType): boolean {
  const checks = (schema.def as WrapperDef).checks ?? [];
  return checks.some((check) => check._zod.def.check === "overwrite");
}

/**
 * `schema` with every transparent wrapper (`.optional()`, `.nullable()`,
 * `.default()`, `.prefault()`, `.catch()`, `.readonly()`, `.nonoptional()`)
 * peeled off.
 */
export function unwrapTransparentWrappers(schema: z.ZodType): z.ZodType {
  const inner = (schema.def as WrapperDef).innerType;
  return TRANSPARENT_WRAPPER_TYPES.has(schema.type) && inner !== undefined ?
      unwrapTransparentWrappers(inner)
    : schema;
}
