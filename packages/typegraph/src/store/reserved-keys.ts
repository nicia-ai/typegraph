/**
 * Reserved Keys for Store Entities
 *
 * Structural keys that cannot be overwritten by user-defined properties.
 * Shared across row-mappers, subgraph projection, and schema validation.
 */
import { ConfigurationError } from "../errors";

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
 * name. Covers both the structural keys (`id`, `kind`, etc.) and the
 * `$`-prefix accessor namespace. Throws a single `ConfigurationError`
 * per conflict class so the user sees all collisions in one pass.
 */
export function assertSchemaKeysAreFree(
  entityKind: "Node" | "Edge",
  name: string,
  keys: readonly string[],
  reservedStructuralKeys: ReadonlySet<string>,
): void {
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
  entityType: "node" | "edge",
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
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!reservedKeys.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}
