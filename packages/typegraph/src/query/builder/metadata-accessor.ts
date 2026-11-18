import { isInteropProbeKey } from "../../utils/object";
import { dateField, fieldRef, numberField, stringField } from "../predicates";
import {
  refuseUnknownMetadataField,
  type SystemMetadataField,
  systemMetadataFields,
} from "./order-by-field";
import type { EdgeMetadataAccessor, NodeMetadataAccessor } from "./types";

function metadataFieldAccessor(
  alias: string,
  field: SystemMetadataField,
): unknown {
  const reference = fieldRef(alias, [field.column], {
    valueType: field.timestamp ? "date" : field.valueType,
    nullable: field.nullable,
  });
  if (field.timestamp) return dateField(reference);
  return field.valueType === "number" ?
      numberField(reference)
    : stringField(reference);
}

/**
 * Builds `alias.$meta` for a predicate accessor: one field accessor per
 * metadata column the alias stores, comparing the column on the alias's own
 * scan. A name the alias does not store is refused, so an untyped caller
 * cannot reach `$meta.version` on an edge either.
 */
export function createMetadataAccessor(
  alias: string,
  isEdge: true,
): EdgeMetadataAccessor;
export function createMetadataAccessor(
  alias: string,
  isEdge: false,
): NodeMetadataAccessor;
export function createMetadataAccessor(
  alias: string,
  isEdge: boolean,
): EdgeMetadataAccessor | NodeMetadataAccessor {
  const accessors = new Map(
    systemMetadataFields(isEdge).map((field) => [
      field.name,
      metadataFieldAccessor(alias, field),
    ]),
  );
  return new Proxy({} as NodeMetadataAccessor, {
    get(_target, property) {
      if (typeof property === "symbol" || isInteropProbeKey(property)) return;
      if (!accessors.has(property))
        refuseUnknownMetadataField(alias, property, isEdge);
      return accessors.get(property);
    },
  });
}
