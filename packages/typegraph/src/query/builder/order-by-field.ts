import { ConfigurationError } from "../../errors";
import { type FieldRef, type OrderSpec, type SortDirection } from "../ast";
import { jsonPointer } from "../json-pointer";
import { fieldRef } from "../predicates";
import { type FieldTypeInfo } from "../schema-introspector";

const COMMON_SYSTEM_ORDER_FIELDS = new Map<
  string,
  NonNullable<FieldRef["valueType"]>
>([
  ["id", "string"],
  ["kind", "string"],
  ["valid_from", "string"],
  ["valid_to", "string"],
  ["created_at", "string"],
  ["updated_at", "string"],
  ["deleted_at", "string"],
]);

const EDGE_SYSTEM_ORDER_FIELDS = new Map<
  string,
  NonNullable<FieldRef["valueType"]>
>([
  ["from_id", "string"],
  ["to_id", "string"],
]);

const DECLARED_PROPERTY_SHADOWABLE_SYSTEM_ORDER_FIELDS = new Set([
  "valid_from",
  "valid_to",
  "created_at",
  "updated_at",
  "deleted_at",
]);
const NULLABLE_SYSTEM_ORDER_FIELDS = new Set([
  "deleted_at",
  "valid_from",
  "valid_to",
]);

/**
 * Resolves an orderable physical system column, or `undefined` when `field`
 * names a user property. Declared properties retain precedence over temporal
 * metadata with the same name, keeping `where*` and `orderBy` semantics
 * aligned. Structural identity fields remain unconditionally system-owned.
 * Both fluent builder stages consume this decision so they cannot drift.
 */
export function resolveSystemOrderField(
  alias: string,
  field: string,
  isEdge: boolean,
  hasDeclaredProperty: boolean,
): FieldRef | undefined {
  if (
    hasDeclaredProperty &&
    DECLARED_PROPERTY_SHADOWABLE_SYSTEM_ORDER_FIELDS.has(field)
  ) {
    return undefined;
  }
  const valueType =
    COMMON_SYSTEM_ORDER_FIELDS.get(field) ??
    (isEdge ? EDGE_SYSTEM_ORDER_FIELDS.get(field) : undefined);
  return valueType === undefined ? undefined : (
      fieldRef(alias, [field], {
        nullable: NULLABLE_SYSTEM_ORDER_FIELDS.has(field),
        valueType,
      })
    );
}

/** Builds the shared system-column-or-property order expression. */
export function buildOrderSpec(
  alias: string,
  field: string,
  direction: SortDirection,
  systemField: FieldRef | undefined,
  typeInfo: FieldTypeInfo | undefined,
): OrderSpec {
  return {
    field:
      systemField ??
      fieldRef(alias, ["props"], {
        jsonPointer: jsonPointer([field]),
        valueType: typeInfo?.valueType,
        elementType: typeInfo?.elementType,
        ...(typeInfo === undefined ?
          {}
        : { nullable: typeInfo.nullable === true }),
      }),
    direction,
  };
}

/** Refuses property operations that lack schema agreement across node kinds. */
export function assertSharedNodeField(
  kindNames: readonly string[] | undefined,
  field: string,
  typeInfo: FieldTypeInfo | undefined,
): void {
  if (
    kindNames !== undefined &&
    kindNames.length > 1 &&
    typeInfo === undefined
  ) {
    throw new ConfigurationError(
      `Unknown or incompatible shared node field "${field}".`,
    );
  }
}
