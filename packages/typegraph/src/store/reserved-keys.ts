/**
 * Reserved Keys for Store Entities
 *
 * Structural keys that cannot be overwritten by user-defined properties.
 * Shared across row-mappers, subgraph projection, and schema validation.
 */
import { z } from "zod";

import type { KindEntity } from "../core/types";
import { ConfigurationError } from "../errors";
import { createDataKeyedBag, isPlainObject } from "../utils/object";

export const RESERVED_NODE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "meta",
]);

export const RESERVED_EDGE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "meta",
  "fromKind",
  "fromId",
  "toKind",
  "toId",
]);

const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * The property name the SCHEMA LAYER cannot carry, and the single owner of that
 * question — every authoring path asks here rather than re-spelling the literal.
 *
 * Zod accepts `__proto__` in a shape but drops it from every parse result, and
 * reports success even when the field is required, so a value written to such a
 * field is silently lost. A declaration naming it is therefore refused rather
 * than accepted as a field the storage layer can never honor.
 *
 * TWO authoring paths ask, and they stay separate walkers by necessity — one
 * traverses Zod schemas (`defineNode` / `defineEdge`, below), the other JSON
 * property descriptors (`validateGraphExtension`, in
 * ./../graph-extension/validation.ts) — but the VERDICT and the reason they give
 * for it are shared from here, because a name unstorable on one path is
 * unstorable on the other: both compile to the same `z.object(...)`.
 */
const UNSTORABLE_PROPERTY_NAME = "__proto__";

/**
 * The shared explanation both authoring paths give when they refuse
 * {@link UNSTORABLE_PROPERTY_NAME}, so the two refusals read as one rule.
 */
export const UNSTORABLE_PROPERTY_NAME_REASON =
  "schema validation cannot carry it";

/** See {@link UNSTORABLE_PROPERTY_NAME}. */
export function isUnstorablePropertyName(name: string): boolean {
  return name === UNSTORABLE_PROPERTY_NAME;
}

/**
 * Renders a nested property path for a refusal message: object field names
 * joined by `.`, with the wrappers between them (optional, array, union, …)
 * contributing no segment because they name nothing.
 */
function formatSchemaPath(segments: readonly string[]): string {
  return segments.join(".");
}

/** How a refusal names a location that is the schema itself, not a field. */
const SCHEMA_ROOT_PATH_LABEL = "(schema root)";

/**
 * Every schema reachable one step down from `value` — a schema, an array of
 * them, or a plain object holding them.
 *
 * Deliberately STRUCTURAL rather than a per-Zod-type enumeration: every
 * composite (`array`, `record`, `map`, `set`, `tuple`, `union`, `intersection`,
 * `pipe`) and every wrapper (`optional`, `nullable`, `default`, `prefault`,
 * `catch`, `readonly`, `nonoptional`, `promise`) stores its inner schemas as
 * ordinary values of the public {@link z.ZodType.def} record, so one walk covers
 * all of them — including any Zod adds later. An enumeration would silently
 * stop covering the type it forgot, which is precisely how this defect class
 * survived a depth-0-only fix.
 */
function collectNestedSchemas(value: unknown, found: z.ZodType[]): void {
  if (value instanceof z.ZodType) {
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNestedSchemas(item, found);
    return;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) {
      collectNestedSchemas(nested, found);
    }
  }
}

/** A `z.lazy` whose getter could not run, and where in the schema it sits. */
type UnresolvableLazy = Readonly<{ path: string; cause: unknown }>;

/** What one walk of a schema found. */
type SchemaFindings = Readonly<{
  unstorable: string[];
  unresolvableLazy: UnresolvableLazy[];
}>;

/**
 * The inner schema of a `z.lazy`, or the reason its getter could not run.
 *
 * `z.lazy` is the one shape the structural walk cannot see — its inner schema
 * hangs off a `getter` FUNCTION rather than a `def` value — so it is unwrapped
 * through the public `unwrap()`, which RUNS that getter. Running it is the only
 * way to inspect what it wraps, and the `visited` set in the caller makes the
 * resulting recursion safe for a self-referential schema.
 *
 * The failure is REPORTED rather than swallowed, and that is the whole contract
 * of this function. `unwrap()` throws when the getter names a binding still in
 * its temporal dead zone — a mutually recursive pair whose second `z.object`
 * const is declared AFTER the `defineNode` call that walks the first. Returning
 * `undefined` there made the walk fail OPEN: the subtree was never judged, and
 * because a definition is validated exactly once, it was never judged later
 * either — so a nested `__proto__` under that subtree was accepted at
 * definition time and then silently dropped by every parse, which is the exact
 * defect this validation exists to prevent. A branch that cannot be looked at
 * is refused, not waved through.
 */
function resolveLazySchema(schema: z.ZodLazy<z.core.SomeType>):
  | Readonly<{ resolved: true; inner: unknown }>
  | Readonly<{
      resolved: false;
      cause: unknown;
    }> {
  try {
    return { resolved: true, inner: schema.unwrap() };
  } catch (cause) {
    return { resolved: false, cause };
  }
}

/**
 * The schemas nested directly inside `schema`, recording an unrunnable `z.lazy`
 * getter in `findings` instead of quietly yielding nothing for it.
 */
function nestedSchemasOf(
  schema: z.ZodType,
  path: readonly string[],
  findings: SchemaFindings,
): readonly z.ZodType[] {
  const found: z.ZodType[] = [];
  if (schema instanceof z.ZodLazy) {
    const resolution = resolveLazySchema(schema);
    if (!resolution.resolved) {
      findings.unresolvableLazy.push({
        path: formatSchemaPath(path),
        cause: resolution.cause,
      });
      return found;
    }
    collectNestedSchemas(resolution.inner, found);
    return found;
  }
  collectNestedSchemas(Object.values(schema.def), found);
  return found;
}

/**
 * Collects the path of every property named {@link UNSTORABLE_PROPERTY_NAME}
 * anywhere in `schema`, at any depth and behind any wrapper — and the path of
 * every `z.lazy` that stopped the walk from getting there.
 *
 * `visited` both terminates recursive schemas and keeps a schema reused under
 * several fields from being re-walked; a name is reported once, which is enough
 * to refuse the definition.
 */
function collectSchemaFindings(
  schema: z.ZodType,
  path: readonly string[],
  visited: Set<z.ZodType>,
  findings: SchemaFindings,
): void {
  if (visited.has(schema)) return;
  visited.add(schema);

  if (schema instanceof z.ZodObject) {
    // A ZodObject is the only schema that NAMES anything, so its fields are
    // walked here, by name, rather than through the structural pass below.
    for (const [propertyName, field] of Object.entries(schema.shape)) {
      const fieldPath = [...path, propertyName];
      if (isUnstorablePropertyName(propertyName)) {
        findings.unstorable.push(formatSchemaPath(fieldPath));
      }
      if (field instanceof z.ZodType) {
        collectSchemaFindings(field, fieldPath, visited, findings);
      }
    }
  }

  // Runs for a ZodObject too, so its `catchall` is covered; the shape schemas it
  // re-reaches are already in `visited` and cost one set lookup each.
  for (const nested of nestedSchemasOf(schema, path, findings)) {
    collectSchemaFindings(nested, path, visited, findings);
  }
}

/**
 * Properties starting with `$` are reserved for TypeGraph-owned accessors
 * on the query-builder node/edge proxies (today: `$fulltext`). Reserving
 * the whole prefix — not just the currently-used names — keeps future
 * accessors (e.g. `$vector`, `$json`) from colliding with user fields.
 */
const RESERVED_PROPERTY_PREFIX = "$";

/**
 * True if a user-defined field name is reserved by TypeGraph's accessor
 * namespace. `defineNode` / `defineEdge` call this against schema keys so
 * the collision fails fast at graph-definition time rather than silently
 * at query time.
 */
function isReservedPropertyName(name: string): boolean {
  return name.startsWith(RESERVED_PROPERTY_PREFIX);
}

/**
 * Validates that a node or edge schema does not use any reserved property
 * name. Covers the unstorable name (at ANY depth), the structural keys (`id`,
 * `kind`, etc.) and the `$`-prefix accessor namespace. Throws a single
 * `ConfigurationError` per conflict class so the user sees all collisions in
 * one pass.
 *
 * A FOURTH class is refused here, and it is about the verdict rather than about
 * a name: a `z.lazy` whose getter cannot run yet. The walk must be able to see
 * the whole schema to answer at all, this is the only moment it ever runs, and
 * a branch it could not enter is a branch nothing will ever check. Refusing is
 * the fail-CLOSED reading of "cannot judge"; returning a clean verdict for a
 * subtree that was never looked at is the fail-open one.
 *
 * Takes the SCHEMA rather than its top-level key list: the unstorable-name
 * check is recursive, and a caller that could only hand over `Object.keys(
 * schema.shape)` could not express that.
 *
 * The structural and `$`-prefix classes stay top-level-only, and that is a
 * decision rather than an omission: both are about names TypeGraph itself
 * occupies on the node/edge OBJECT it hands back (`id`, `kind`, `meta`,
 * `$fulltext`), and nothing is projected onto a nested object, so a nested
 * field may legitimately be called `id`. Only unstorability is a property of
 * the schema layer at every depth.
 */
export function assertSchemaKeysAreFree(
  entityKind: "Node" | "Edge",
  name: string,
  schema: z.ZodObject<z.ZodRawShape>,
  reservedStructuralKeys: ReadonlySet<string>,
): void {
  // A field named `__proto__` is UNSTORABLE, not merely reserved: Zod accepts
  // it in a shape but drops it from every parse result — and reports success
  // even when the field is required — so a write to it is silently lost.
  //
  // `validateGraphExtension` already refuses exactly this declaration for a
  // kind authored as a JSON document (`RESERVED_PROPERTY_NAME`), AT ANY DEPTH.
  // Checking only the top-level shape here left the two authoring paths
  // disagreeing again one level down: `z.object({ payload: z.object({
  // ["__proto__"]: z.string() }) })` was accepted, and the nested write was
  // dropped at parse exactly as the top-level one had been.
  //
  // Reachable only through a COMPUTED key — `z.object({ __proto__: … })`
  // written literally sets the shape object's prototype instead of creating
  // the entry — but `z.object({ ["__proto__"]: z.string() })` yields a shape
  // whose `Object.keys` really does contain it.
  const findings: SchemaFindings = { unstorable: [], unresolvableLazy: [] };
  collectSchemaFindings(schema, [], new Set(), findings);

  // Refused FIRST, because it is the reason the rest of the verdict may be
  // incomplete: an unrunnable `z.lazy` getter hides everything beneath it, and
  // a definition is validated exactly once, so "judge it later" is not on
  // offer. See `resolveLazySchema`.
  if (findings.unresolvableLazy.length > 0) {
    const label = entityKind.toLowerCase();
    const locations = findings.unresolvableLazy.map((lazy) =>
      lazy.path === "" ? SCHEMA_ROOT_PATH_LABEL : lazy.path,
    );
    throw new ConfigurationError(
      `${entityKind} "${name}" schema contains a z.lazy() whose schema is not available yet at ${label}-definition time: ${locations.join(", ")}`,
      {
        [`${label}Type`]: name,
        conflicts: locations,
      },
      {
        cause: findings.unresolvableLazy[0]?.cause,
        suggestion:
          `Declare every schema the lazy getter references BEFORE this ` +
          `define${entityKind} call — a mutually recursive pair works when ` +
          `both z.object() consts are initialized first, and the getters then ` +
          `resolve. TypeGraph must read through the whole schema at definition ` +
          `time to refuse property names it cannot store, and a getter that ` +
          `throws leaves that subtree unchecked forever.`,
      },
    );
  }

  const unstorableConflicts = findings.unstorable;
  if (unstorableConflicts.length > 0) {
    const label = entityKind.toLowerCase();
    throw new ConfigurationError(
      `${entityKind} "${name}" schema declares a property named "${UNSTORABLE_PROPERTY_NAME}", which ${UNSTORABLE_PROPERTY_NAME_REASON}: ${unstorableConflicts.join(", ")}`,
      {
        [`${label}Type`]: name,
        conflicts: unstorableConflicts,
      },
      {
        suggestion: `Rename the property at ${unstorableConflicts.join(", ")}. Zod drops "${UNSTORABLE_PROPERTY_NAME}" from every parse result, so a value written to it would be silently lost.`,
      },
    );
  }

  const keys = Object.keys(schema.shape);
  const structuralConflicts = keys.filter((key) =>
    reservedStructuralKeys.has(key),
  );
  if (structuralConflicts.length > 0) {
    const label = entityKind.toLowerCase();
    throw new ConfigurationError(
      `${entityKind} "${name}" schema contains reserved property names: ${structuralConflicts.join(", ")}`,
      {
        [`${label}Type`]: name,
        conflicts: structuralConflicts,
        reservedKeys: [...reservedStructuralKeys],
      },
      {
        suggestion: `Rename the conflicting properties. Reserved names (${[...reservedStructuralKeys].join(", ")}) are added automatically to all ${label}s.`,
      },
    );
  }

  const prefixConflicts = keys.filter((key) => isReservedPropertyName(key));
  if (prefixConflicts.length > 0) {
    const label = entityKind.toLowerCase();
    throw new ConfigurationError(
      `${entityKind} "${name}" schema uses the reserved "${RESERVED_PROPERTY_PREFIX}" prefix on: ${prefixConflicts.join(", ")}`,
      {
        [`${label}Type`]: name,
        conflicts: prefixConflicts,
        reservedPrefix: RESERVED_PROPERTY_PREFIX,
      },
      {
        suggestion: `Property names starting with "${RESERVED_PROPERTY_PREFIX}" are reserved for TypeGraph accessors (e.g. $fulltext). Rename each field.`,
      },
    );
  }
}

/**
 * Validates that a projection field name is safe to assign onto a result object.
 * Rejects reserved structural keys and prototype-pollution vectors.
 *
 * @throws ConfigurationError if the field is reserved or dangerous
 */
export function validateProjectionField(
  field: string,
  entityType: KindEntity,
  kind: string,
): void {
  const reserved =
    entityType === "node" ? RESERVED_NODE_KEYS : RESERVED_EDGE_KEYS;

  if (reserved.has(field)) {
    throw new ConfigurationError(
      `Projection field "${field}" on ${entityType} kind "${kind}" conflicts with a reserved structural key`,
      { field, kind, entityType, reservedKeys: [...reserved] },
      {
        suggestion: `Remove "${field}" from the projection. Structural fields (${[...reserved].join(", ")}) are included automatically when relevant.`,
      },
    );
  }

  if (PROTOTYPE_POLLUTION_KEYS.has(field)) {
    throw new ConfigurationError(
      `Projection field "${field}" on ${entityType} kind "${kind}" is not allowed`,
      { field, kind, entityType },
      {
        suggestion: `"${field}" cannot be used as a projection field name.`,
      },
    );
  }
}

/**
 * Filters out reserved keys from a props object to prevent runtime collisions.
 */
export function filterReservedKeys(
  props: Record<string, unknown>,
  reservedKeys: ReadonlySet<string>,
): Record<string, unknown> {
  // Props keys are DATA (a trusted import writes a caller's bag verbatim, and
  // `JSON.parse` yields `__proto__` as an own key), so the accumulator must be
  // null-prototype — a `{}` literal would answer `filtered["__proto__"] = v`
  // with the prototype setter and silently drop the value.
  const filtered = createDataKeyedBag<unknown>();
  for (const [key, value] of Object.entries(props)) {
    if (!reservedKeys.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
