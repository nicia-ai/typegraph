/**
 * The projection a live graph's structural-subsumption check compares: the
 * kind's persisted JSON Schema projection, plus a marker wherever the Zod
 * schema constrains values in a way that projection cannot state.
 *
 * `z.toJSONSchema` drops seven such facts, each of which can make
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
  const isPlain =
    def.type === nodeType &&
    PLAIN_UNPROJECTABLE_NODE_TYPES.has(nodeType) &&
    (def.checks ?? []).length === 0;
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
