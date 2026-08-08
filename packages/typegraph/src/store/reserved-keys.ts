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

/**
 * The inner schema of a `z.lazy`, or nothing when its getter cannot run yet.
 *
 * `z.lazy` is the one shape the structural walk cannot see — its inner schema
 * hangs off a `getter` FUNCTION rather than a `def` value — so it is unwrapped
 * through the public `unwrap()`, which RUNS that getter. Running it is the only
 * way to inspect what it wraps, and the `visited` set in the caller makes the
 * resulting recursion safe for a self-referential schema.
 *
 * But `unwrap()` is the one part of this walk that can throw for a reason that
 * has nothing to do with unstorable names: a mutually recursive pair declared
 * around a `defineNode` call has the second schema still in its temporal dead
 * zone when the first one's getter runs, and before this validation existed no
 * getter ran at definition time at all. Turning that into a crash would be a
 * worse regression than the defect being fixed, so the branch is skipped: a
 * schema that cannot be looked at cannot be judged, and the parse-time behavior
 * is unchanged either way.
 */
function unwrapLazySchema(schema: z.ZodLazy<z.core.SomeType>): unknown {
  try {
    return schema.unwrap();
  } catch {
    return undefined;
  }
}

/** The schemas nested directly inside `schema`. */
function nestedSchemasOf(schema: z.ZodType): readonly z.ZodType[] {
  const found: z.ZodType[] = [];
  collectNestedSchemas(
    schema instanceof z.ZodLazy ?
      unwrapLazySchema(schema)
    : Object.values(schema.def),
    found,
  );
  return found;
}

/**
 * Collects the path of every property named {@link UNSTORABLE_PROPERTY_NAME}
 * anywhere in `schema`, at any depth and behind any wrapper.
 *
 * `visited` both terminates recursive schemas and keeps a schema reused under
 * several fields from being re-walked; a name is reported once, which is enough
 * to refuse the definition.
 */
function collectUnstorablePropertyPaths(
  schema: z.ZodType,
  path: readonly string[],
  visited: Set<z.ZodType>,
  found: string[],
): void {
  if (visited.has(schema)) return;
  visited.add(schema);

  if (schema instanceof z.ZodObject) {
    // A ZodObject is the only schema that NAMES anything, so its fields are
    // walked here, by name, rather than through the structural pass below.
    for (const [propertyName, field] of Object.entries(schema.shape)) {
      const fieldPath = [...path, propertyName];
      if (isUnstorablePropertyName(propertyName)) {
        found.push(formatSchemaPath(fieldPath));
      }
      if (field instanceof z.ZodType) {
        collectUnstorablePropertyPaths(field, fieldPath, visited, found);
      }
    }
  }

  // Runs for a ZodObject too, so its `catchall` is covered; the shape schemas it
  // re-reaches are already in `visited` and cost one set lookup each.
  for (const nested of nestedSchemasOf(schema)) {
    collectUnstorablePropertyPaths(nested, path, visited, found);
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
  const unstorableConflicts: string[] = [];
  collectUnstorablePropertyPaths(schema, [], new Set(), unstorableConflicts);
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
