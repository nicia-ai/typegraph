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
