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

/**
 * Resolves an orderable physical system column, or `undefined` when `field`
 * names a user property. Both fluent builder stages consume this decision so
 * a newly orderable system column cannot compile through one stage and fall
 * back to `props` JSON through the other.
 */
export function resolveSystemOrderField(
  alias: string,
  field: string,
  isEdge: boolean,
): FieldRef | undefined {
  const valueType =
    COMMON_SYSTEM_ORDER_FIELDS.get(field) ??
    (isEdge ? EDGE_SYSTEM_ORDER_FIELDS.get(field) : undefined);
  return valueType === undefined ? undefined : (
      fieldRef(alias, [field], { valueType })
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
      }),
    direction,
  };
}
