import { isInteropProbeKey } from "../../utils/object";
import type { FieldRef } from "../ast";
import {
  dateField,
  fieldRef,
  isParameterRef,
  numberField,
  stringField,
} from "../predicates";
import {
  assertMetadataOperand,
  refuseUnknownMetadataField,
  type SystemMetadataField,
  systemMetadataFields,
} from "./order-by-field";
import type { EdgeMetadataAccessor, NodeMetadataAccessor } from "./types";

type FieldBuilder = Readonly<Record<string, (...operands: never[]) => unknown>>;

/**
 * Checks one argument of a field-builder method: each literal, including each
 * element of an `in` / `notIn` list, goes through `assertMetadataOperand`.
 * A `param()` is checked when it is bound, by prepared-query validation.
 */
function assertOperandArgument(reference: FieldRef, argument: unknown): void {
  if (isParameterRef(argument)) return;
  if (Array.isArray(argument)) {
    for (const element of argument as readonly unknown[]) {
      if (!isParameterRef(element)) assertMetadataOperand(reference, element);
    }
    return;
  }
  assertMetadataOperand(reference, argument);
}

/**
 * Wraps every operator of a field builder so its literal operands are refused
 * before the predicate is built, rather than reaching an engine that compares
 * them differently from the other.
 */
function withOperandCheck<Builder extends FieldBuilder>(
  reference: FieldRef,
  builder: Builder,
): Builder {
  return Object.fromEntries(
    Object.entries(builder).map(([operator, method]) => [
      operator,
      (...operands: never[]) => {
        for (const operand of operands)
          assertOperandArgument(reference, operand);
        return method(...operands);
      },
    ]),
  ) as Builder;
}

function metadataFieldAccessor(
  alias: string,
  field: SystemMetadataField,
): unknown {
  const reference = fieldRef(alias, [field.column], {
    valueType: field.timestamp ? "date" : field.valueType,
    nullable: field.nullable,
  });
  if (field.timestamp) return withOperandCheck(reference, dateField(reference));
  return field.valueType === "number" ?
      withOperandCheck(reference, numberField(reference))
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
