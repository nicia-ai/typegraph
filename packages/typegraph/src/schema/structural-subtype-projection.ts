/**
 * The projection a live graph's structural-subsumption check compares: the
 * kind's persisted JSON Schema projection, plus a marker wherever the Zod
 * schema constrains values in a way that projection cannot state.
 *
 * `z.toJSONSchema` drops eleven such facts, each of which can make
 * `isStructuralSubtype` answer `subtype` for a pair whose child admits a value
 * its parent refuses:
 *
 * - A regex's flags, on whichever check carries the pattern (`.regex()`,
 *   `z.stringFormat()`, `z.email({ pattern })`). `/^abc$/i` and `/^abc$/` both
 *   project as `pattern: "^abc$"`. Only `g`, which `RegExp.prototype.test` semantics
 *   under Zod do not depend on, is harmless.
 * - A `.refine()` / `.superRefine()` / `.check()` refinement, which projects
 *   as its base schema. On a CHILD it only narrows, which the verdict may
 *   ignore; on a PARENT it is a constraint the child is never compared with.
 * - A strict object (`z.strictObject`, `.strict()`). It projects exactly like
 *   a stripping `z.object()`, but refuses a key the child may add.
 * - A `.meta()` key spelled like a constraining keyword. It is merged into
 *   the projection as if it were one, though it constrains nothing.
 * - A string format a later format replaced. Only the last `format` is kept,
 *   so `z.url().startsWith("https://")` loses its URL check.
 * - An overwrite (`.trim()`, `.toLowerCase()`, `.toUpperCase()`,
 *   `.normalize()`, `.overwrite()`), which projects nothing, though the
 *   checks after it judge the transformed value and the node stores it.
 * - A literal `NaN` or `±Infinity`, which projects as `null`.
 * - A pipe's input side (`.pipe()`, `z.preprocess()`, `z.codec()`): only the
 *   output side projects, so a bound on the input, or a function that
 *   rewrites the value first, is lost. Marked on the parent side unless the
 *   pipe carries no transform and its input is `z.unknown()`/`z.any()` or a
 *   check-free primitive of the output's own type, which the output then
 *   judges in full.
 * - Which keys an object stores and which it requires: Zod decides both
 *   from each property's `optin`/`optout`, which the projection's single
 *   `required` does not follow in either direction (an exhaustive record
 *   whose values are optional lists keys it may leave out;
 *   `z.unknown().pipe(z.string().optional())` refuses a missing key it does
 *   not list), so each property's are recorded.
 * - A `.default()` / `.catch()` value wrapped by another one: only the
 *   outermost reaches `default`, though each is stored unvalidated, so all
 *   are listed under {@link STORED_FALLBACKS_KEYWORD}.
 * - A schema that is itself a check (`z.int64()`, `z.uint64()`): its bound
 *   sits on its own definition, not among its chained checks, so it is never
 *   read as a plain unconvertible node.
 *
 * The persisted projection itself is not changed: it is the schema document
 * and its hash, and none of these facts was ever part of it. The markers live
 * only in this comparison input, so a stored document's own registry (which
 * has no Zod schema) never refuses what a live graph accepts — the live check
 * is the stricter of the two, and every commit path, `createStore` and the
 * `getSchemaChanges` pre-flight build it.
 *
 * A marker's value names the Zod instance that carries the fact, so a child
 * that reuses its parent's schema (or a field schema they share) still
 * compares equal under rule 2 of `isStructuralSubtype`, while two different
 * refinements never do.
 *
 * A node `z.toJSONSchema` has no spelling for at all (`embedding()` and any
 * other `z.custom()`, `z.date()`, `z.set()`, `z.map()`, `z.bigint()`, a
 * `.transform()`) makes the persisted projection give up on the whole kind,
 * which projects as the unprojectable placeholder. Here an `embedding()` is
 * written as the fixed-length number array it validates
 * (`embeddingProjection`), and every other such node is replaced by
 * {@link UNPROJECTABLE_NODE_KEYWORD} instead, carrying the
 * node's identity (`stampUnprojectableIdentity`), so every other field of
 * the kind is still compared. `isStructuralSubtype` accepts such a node only
 * under a parent node that admits every value, or beside a node of the same
 * identity. A node Zod converts only in part (a dynamic `.catch()`
 * keeps its `type`) is marked as carrying a Zod-only constraint instead. The
 * persisted placeholder is kept when this projection cannot do better: a
 * conversion that fails for another reason.
 */
import { z } from "zod";

import { EMBEDDING_DIMENSIONS_KEY, isEmbeddingSchema } from "../core/embedding";
import {
  isUnprojectableSchemaProjection,
  serializeSchemaProperties,
} from "./serializer";
import {
  COMPARABLE_KEYWORDS,
  KEY_OPTIONALITY_KEYWORD,
  type KeyOptionality,
  STORED_FALLBACKS_KEYWORD,
  UNMODELED_CONSTRAINING_KEYWORDS,
  UNPROJECTABLE_NODE_KEYWORD,
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
  pattern?: RegExp;
  values?: readonly unknown[];
  checks?: readonly Readonly<{ _zod: Readonly<{ def: ZodCheckDef }> }>[];
  catchall?: Readonly<{ _zod: Readonly<{ def: Readonly<{ type?: string }> }> }>;
  in?: z.core.$ZodTypes;
  out?: z.core.$ZodTypes;
  valueType?: z.ZodType;
  shape?: Readonly<Record<string, z.ZodType>>;
  transform?: unknown;
}>;

const CUSTOM_CHECK = "custom";
const OVERWRITE_CHECK = "overwrite";
const STRING_FORMAT_CHECK = "string_format";
const LITERAL_NODE_TYPE = "literal";

/**
 * A node's checks in the order Zod runs them. A schema that is itself a
 * check (`z.email()`, `z.url()`, `z.int()`) runs its own check before the
 * checks chained onto it.
 */
function checksInRunOrder(zodSchema: z.core.$ZodTypes): readonly ZodCheckDef[] {
  const def = zodSchema._zod.def as ZodNodeDef;
  const chained = (def.checks ?? []).map((check) => check._zod.def);
  return zodSchema._zod.traits.has("$ZodCheck") ? [def, ...chained] : chained;
}

/**
 * Whether a node states more than one string format. `z.toJSONSchema` keeps
 * only the last one, so `z.url().startsWith("https://")` projects as a
 * `starts_with` format and loses the URL check entirely.
 */
function overwritesFormat(checks: readonly ZodCheckDef[]): boolean {
  return (
    checks.filter((check) => check.check === STRING_FORMAT_CHECK).length > 1
  );
}

type OverwritePlacement = Readonly<{
  /** An overwrite runs before a check, which then judges the new value. */
  beforeCheck: boolean;
  /** An overwrite runs after a check, so the output may fail that check. */
  afterCheck: boolean;
}>;

/**
 * Where a node's `overwrite` checks (`.trim()`, `.toLowerCase()`,
 * `.toUpperCase()`, `.normalize()`, `.overwrite()`) run relative to the
 * checks the projection states. None projects anything. A refinement is
 * left out: it is marked on its own, and only a parent's matters.
 */
function overwritePlacement(
  checks: readonly ZodCheckDef[],
): OverwritePlacement {
  const overwrites: number[] = [];
  const stated: number[] = [];
  for (const [index, check] of checks.entries()) {
    if (check.check === OVERWRITE_CHECK) overwrites.push(index);
    else if (check.check !== CUSTOM_CHECK) stated.push(index);
  }
  if (overwrites.length === 0 || stated.length === 0) {
    return { beforeCheck: false, afterCheck: false };
  }
  return {
    beforeCheck: Math.min(...overwrites) < Math.max(...stated),
    afterCheck: Math.min(...stated) < Math.max(...overwrites),
  };
}

/**
 * Whether a literal holds a value JSON cannot carry: the projection writes
 * `NaN` and `±Infinity` as `null`.
 */
function hasNonJsonLiteralValue(def: ZodNodeDef): boolean {
  return (
    def.type === LITERAL_NODE_TYPE &&
    (def.values ?? []).some(
      (value) => typeof value === "number" && !Number.isFinite(value),
    )
  );
}

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

function markSemanticRegexFlags(
  jsonSchema: Record<string, unknown>,
  pattern: RegExp | undefined,
): void {
  if (pattern === undefined || !hasSemanticRegexFlags(pattern)) return;
  markOpaque(jsonSchema, ZOD_ONLY_CONSTRAINT_KEYWORD, `flags:${pattern.flags}`);
}

/**
 * Marks the checks `z.toJSONSchema` drops without trace: a string format a
 * later format replaced, an overwrite, and a literal value JSON cannot carry.
 *
 * A replaced format only matters on a parent: the child's projection then
 * states less than the child checks, which can only cost a refusal. A
 * literal `NaN` or `±Infinity` matters on both sides, since its projection
 * names a different value set altogether.
 *
 * An overwrite matters on a parent when a stated check runs after it, since
 * that check judges the transformed value, not the child's. It matters on a
 * child when a stated check runs before it, since the child then stores a
 * value that check never saw: `z.string().min(2).trim()` stores `"a"`. A
 * child whose overwrites all run first stores only values its stated checks
 * accepted, so it stays comparable.
 */
function markLostChecks(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const checks = checksInRunOrder(context.zodSchema);
  const token = instanceToken(context.zodSchema);
  if (overwritesFormat(checks)) {
    markOpaque(
      context.jsonSchema,
      ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
      `formats:${token}`,
    );
  }
  const overwrites = overwritePlacement(checks);
  if (overwrites.afterCheck) {
    markOpaque(
      context.jsonSchema,
      ZOD_ONLY_CONSTRAINT_KEYWORD,
      `overwrite:${token}`,
    );
  }
  if (overwrites.beforeCheck) {
    markOpaque(
      context.jsonSchema,
      ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
      `overwrite:${token}`,
    );
  }
  if (hasNonJsonLiteralValue(context.zodSchema._zod.def as ZodNodeDef)) {
    markOpaque(
      context.jsonSchema,
      ZOD_ONLY_CONSTRAINT_KEYWORD,
      `literal:${token}`,
    );
  }
}

/**
 * Input nodes a pipe can hand to its output without the projection losing
 * anything: one that admits every value, or a check-free primitive of the
 * output's own type, which the output then judges in full.
 */
const PASS_THROUGH_PIPE_INPUT_TYPES: ReadonlySet<string> = new Set([
  "unknown",
  "any",
]);
const PASS_THROUGH_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "null",
]);

function passesInputThrough(
  input: z.core.$ZodTypes,
  output: z.core.$ZodTypes,
): boolean {
  const inputType = input._zod.def.type;
  if (PASS_THROUGH_PIPE_INPUT_TYPES.has(inputType)) return true;
  return (
    PASS_THROUGH_PRIMITIVE_TYPES.has(inputType) &&
    inputType === output._zod.def.type &&
    checksInRunOrder(input).length === 0
  );
}

/**
 * A pipe (`.pipe()`, `z.preprocess()`, `z.codec()`) projects as its output
 * side alone, so whatever its input side requires — a bound, a format, a
 * preprocessing function that rewrites the value before the output judges
 * it — is lost. On a parent that is a constraint the child is never compared
 * with. A child's pipe stores only what its output side admits, so the
 * output projection states it in full.
 */
function markLossyPipe(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const def = context.zodSchema._zod.def as ZodNodeDef;
  if (def.type !== "pipe" || def.in === undefined || def.out === undefined) {
    return;
  }
  // A codec's decode function rewrites the value between the two sides.
  if (def.transform === undefined && passesInputThrough(def.in, def.out)) {
    return;
  }
  markOpaque(
    context.jsonSchema,
    ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
    `pipe:${instanceToken(context.zodSchema)}`,
  );
}

type ZodOptionality = Readonly<{
  optin?: "optional" | "defaulted";
  optout?: "optional";
}>;

function zodOptionality(schema: z.core.$ZodType): ZodOptionality {
  const { optin, optout } = schema._zod as unknown as ZodOptionality;
  return {
    ...(optin === undefined ? {} : { optin }),
    ...(optout === undefined ? {} : { optout }),
  };
}

/** Node types whose output may be `undefined` whatever their optionality. */
const UNDEFINED_YIELDING_TYPES: ReadonlySet<string> = new Set([
  "unknown",
  "any",
  "undefined",
  "void",
  "custom",
  "transform",
  "lazy",
]);
const INNER_DECIDED_TYPES: ReadonlySet<string> = new Set([
  "nullable",
  "readonly",
  "prefault",
]);

/**
 * Whether a schema can output `undefined` for an `undefined` input or from a
 * function: an `unknown`, a transform or custom function, or a pipe or codec
 * whose output side can. Decided from the schema's structure; no schema code
 * runs.
 */
function mayYieldUndefined(schema: z.core.$ZodType): boolean {
  const def = schema._zod.def as unknown as Readonly<{
    type?: string;
    transform?: unknown;
    out?: z.core.$ZodType;
    innerType?: z.core.$ZodType;
    options?: readonly z.core.$ZodType[];
  }>;
  const type = def.type ?? "";
  if (UNDEFINED_YIELDING_TYPES.has(type)) return true;
  if (type === "pipe") {
    return (
      def.transform !== undefined ||
      (def.out !== undefined && mayYieldUndefined(def.out))
    );
  }
  if (INNER_DECIDED_TYPES.has(type) && def.innerType !== undefined) {
    return mayYieldUndefined(def.innerType);
  }
  if (type === "union") {
    return (def.options ?? []).some((option) => mayYieldUndefined(option));
  }
  return false;
}

/**
 * Whether an object always stores a property, read off the same
 * `optin`/`optout` Zod's object parser decides it from: a property whose
 * input is required is always present, and a defaulted one is filled in
 * unless its output may be absent or `undefined`. (A transform that returns `undefined`
 * for a present value is the one case this does not see; such a node is
 * unconvertible, so it narrows only a parent field that admits anything.)
 */
function objectStoresProperty(field: z.core.$ZodType): boolean {
  const { optin, optout } = zodOptionality(field);
  if (optin === undefined) return true;
  // A defaulted union runs every member on the missing value, and one that
  // admits `undefined` (`z.union([z.unknown(), x.default(v)])`) supplies it.
  return (
    optin === "defaulted" && optout !== "optional" && !mayYieldUndefined(field)
  );
}

/**
 * Whether an exhaustive record always stores a key. Zod runs the value
 * schema on a missing key's `undefined` and stores what it returns, so the
 * key is stored unless that may be `undefined`.
 */
function recordStoresKey(value: z.core.$ZodType): boolean {
  return (
    zodOptionality(value).optout !== "optional" && !mayYieldUndefined(value)
  );
}

/**
 * Whether a value schema surely admits a missing value: optional on its
 * input and its output, as `.optional()` is. Anything else may refuse it,
 * so a parent record's key is read as required — the stricter reading.
 */
function admitsMissingValue(value: z.core.$ZodType): boolean {
  const { optin, optout } = zodOptionality(value);
  return optin !== undefined && optout === "optional";
}

/**
 * Records, for each property of an object or each key an exhaustive record
 * lists, whether it is always stored and whether its absence is refused
 * (see {@link KEY_OPTIONALITY_KEYWORD}). Read off Zod's own metadata and the
 * schema's structure; no schema code runs. Zod's `required` for an
 * exhaustive record lists every key, so a record's key is read as required
 * unless its value is optional on both sides ({@link admitsMissingValue}).
 */
function recordKeyOptionality(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const def = context.zodSchema._zod.def as ZodNodeDef;
  const { jsonSchema } = context;
  const declared = new Set<unknown>(
    Array.isArray(jsonSchema["required"]) ? jsonSchema["required"] : [],
  );
  if (def.type === "object" && def.shape !== undefined) {
    jsonSchema[KEY_OPTIONALITY_KEYWORD] = Object.fromEntries(
      Object.entries(def.shape).map(([key, field]) => [
        key,
        {
          ...zodOptionality(field),
          stored: objectStoresProperty(field),
          required:
            declared.has(key) || zodOptionality(field).optin === undefined,
        } satisfies KeyOptionality,
      ]),
    );
    return;
  }
  if (def.type === "record" && def.valueType !== undefined) {
    const entry = {
      ...zodOptionality(def.valueType),
      stored: recordStoresKey(def.valueType),
      required: !admitsMissingValue(def.valueType),
    } satisfies KeyOptionality;
    jsonSchema[KEY_OPTIONALITY_KEYWORD] = Object.fromEntries(
      [...declared].map((key) => [String(key), entry]),
    );
  }
}

function inheritedFallbacks(
  jsonSchema: Record<string, unknown>,
): readonly unknown[] {
  const inherited = jsonSchema[STORED_FALLBACKS_KEYWORD] as
    Readonly<{ values?: unknown }> | undefined;
  return Array.isArray(inherited?.values) ? inherited.values : [];
}

/**
 * Lists every value a node stores unvalidated, with the outermost
 * `.default()`/`.catch()` instance that stores them (see
 * {@link STORED_FALLBACKS_KEYWORD}). Zod visits a wrapper after the node it
 * wraps and copies the wrapped result, so each one adds its own value to the
 * list it inherited.
 */
function listStoredFallbacks(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const type = context.zodSchema._zod.def.type;
  if (type !== "default" && type !== "catch") return;
  const { jsonSchema } = context;
  if (!Object.hasOwn(jsonSchema, "default")) return;
  jsonSchema[STORED_FALLBACKS_KEYWORD] = {
    instance: instanceToken(context.zodSchema),
    values: [...inheritedFallbacks(jsonSchema), jsonSchema["default"]],
  };
}

function markZodOnlyConstraints(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const def = context.zodSchema._zod.def as ZodNodeDef;
  // A string-format schema (`z.email()`, `z.stringFormat()`) carries its
  // pattern on its own definition rather than on a check.
  markSemanticRegexFlags(context.jsonSchema, def.pattern);
  for (const check of def.checks ?? []) {
    const checkDef = check._zod.def;
    if (checkDef.check === CUSTOM_CHECK) {
      markOpaque(
        context.jsonSchema,
        ZOD_ONLY_PARENT_CONSTRAINT_KEYWORD,
        `refinement:${instanceToken(check)}`,
      );
    }
    markSemanticRegexFlags(context.jsonSchema, checkDef.pattern);
  }
  markLostChecks(context);
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
 * Zod also reports as unconvertible a fact of a node it otherwise converts (a
 * dynamic `.catch()`, a `multipleOf` of zero, a bigint default) and merges the
 * marker beside the keywords it did write. Accepting that node unjudged would
 * skip the `type` it still states, so the lost fact is marked as a Zod-only
 * constraint instead, which leaves the node comparable only to itself.
 */
function markPartlyConvertedNode(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const { jsonSchema } = context;
  const nodeType = jsonSchema[UNPROJECTABLE_NODE_KEYWORD];
  if (typeof nodeType !== "string") return;
  if (!Object.keys(jsonSchema).some((key) => isConstrainingKeyword(key))) {
    return;
  }
  Reflect.deleteProperty(jsonSchema, UNPROJECTABLE_NODE_KEYWORD);
  markOpaque(
    jsonSchema,
    ZOD_ONLY_CONSTRAINT_KEYWORD,
    `unconvertible:${nodeType}:${instanceToken(context.zodSchema)}`,
  );
}

/**
 * Zod node types whose values an unconvertible node with no checks fully
 * describes: two such nodes of one type admit exactly the same values.
 */
const PLAIN_UNPROJECTABLE_NODE_TYPES: ReadonlySet<string> = new Set([
  "date",
  "bigint",
  "symbol",
  "undefined",
  "void",
  "nan",
]);

/**
 * Wrappers that store exactly what the node they wrap stores, so a node
 * keeps the identity of the one it wraps. Optionality is compared by the
 * enclosing object's `required`.
 */
const IDENTITY_PRESERVING_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "optional",
  "readonly",
  "lazy",
]);

const UNPROJECTABLE_IDENTITY_SEPARATOR = "#";

/**
 * What an `embedding()` validates, as JSON Schema: an array of exactly its
 * dimension count of numbers. Its validator also requires each number to be
 * finite, which every JSON number is and `type: "number"` already states to
 * Zod, and it transforms nothing, so this states exactly what it admits.
 * Its index options (metric, index type) describe how rows are searched,
 * not which values are valid, so they are not part of it. `undefined` for
 * any other node; an `embedding()` refined or described afresh is a new
 * Zod instance without the dimension marker, and stays unprojectable.
 */
function embeddingProjection(
  zodSchema: z.core.$ZodTypes,
): z.core.JSONSchema.JSONSchema | undefined {
  if (!isEmbeddingSchema(zodSchema)) return undefined;
  const dimensions = zodSchema[EMBEDDING_DIMENSIONS_KEY];
  return {
    type: "array",
    items: { type: "number" },
    minItems: dimensions,
    maxItems: dimensions,
  };
}

/**
 * Restates an unconvertible node's marker as what makes two such nodes
 * provably admit the same values (see {@link UNPROJECTABLE_NODE_KEYWORD}):
 *
 * - a plain node — a type of {@link PLAIN_UNPROJECTABLE_NODE_TYPES} with no
 *   check — is its node type alone, so `z.date()` matches any other
 *   `z.date()`;
 * - every other node (a check, refinement, transform, pipe, default or
 *   custom function) is the Zod instance that carries it, so it matches only
 *   a field shared through `.extend()` or a reused schema.
 *
 * Zod visits a wrapper after the node it wraps, with the wrapped marker
 * copied into its own result, so the outermost node's identity is the one
 * that stays.
 */
function stampUnprojectableIdentity(
  context: Readonly<{
    zodSchema: z.core.$ZodTypes;
    jsonSchema: Record<string, unknown>;
  }>,
): void {
  const { jsonSchema, zodSchema } = context;
  const marker = jsonSchema[UNPROJECTABLE_NODE_KEYWORD];
  if (typeof marker !== "string") return;
  const def = zodSchema._zod.def as ZodNodeDef;
  if (
    def.type !== undefined &&
    IDENTITY_PRESERVING_WRAPPER_TYPES.has(def.type)
  ) {
    return;
  }
  const [nodeType = marker] = marker.split(UNPROJECTABLE_IDENTITY_SEPARATOR);
  // A schema that is itself a check (`z.int64()`, `z.uint64()`) carries its
  // bound on its own definition, so its run-order checks decide plainness.
  const isPlain =
    def.type === nodeType &&
    PLAIN_UNPROJECTABLE_NODE_TYPES.has(nodeType) &&
    checksInRunOrder(zodSchema).length === 0;
  jsonSchema[UNPROJECTABLE_NODE_KEYWORD] =
    isPlain ? nodeType : (
      `${nodeType}${UNPROJECTABLE_IDENTITY_SEPARATOR}${instanceToken(zodSchema)}`
    );
}

/**
 * `schema` converted with every Zod-only constraint and every unconvertible
 * node marked, or the persisted placeholder when that conversion cannot
 * replace it (see the module docblock).
 */
function projectForComparison(schema: z.ZodType): JsonSchema {
  const unconvertibleNodeTypes: string[] = [];
  const project = (): JsonSchema =>
    z.toJSONSchema(schema, {
      override: (context) => {
        markZodOnlyConstraints(context);
        markLossyPipe(context);
        recordKeyOptionality(context);
        listStoredFallbacks(context);
        markPartlyConvertedNode(context);
        stampUnprojectableIdentity(context);
      },
      unrepresentable: (context) => {
        const nodeType = context.zodSchema._zod.def.type;
        unconvertibleNodeTypes.push(nodeType);
        return (
          embeddingProjection(context.zodSchema) ?? {
            [UNPROJECTABLE_NODE_KEYWORD]: nodeType,
          }
        );
      },
    }) as JsonSchema;

  const persisted = serializeSchemaProperties(schema);
  if (!isUnprojectableSchemaProjection(persisted)) return project();
  try {
    const projection = project();
    return unconvertibleNodeTypes.length > 0 ? projection : persisted;
  } catch {
    return persisted;
  }
}

/**
 * The comparison projection of `schema` (see the module docblock). Where it
 * falls back to the unprojectable placeholder, the placeholder is returned
 * as is, so `isUnprojectableSchemaProjection` still recognizes it. Memoized
 * by schema identity.
 */
export function structuralSubtypeProjection(schema: z.ZodType): JsonSchema {
  const cached = PROJECTION_CACHE.get(schema);
  if (cached !== undefined) return cached;
  const projection = projectForComparison(schema);
  PROJECTION_CACHE.set(schema, projection);
  return projection;
}
