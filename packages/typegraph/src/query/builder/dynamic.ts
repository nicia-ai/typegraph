/**
 * Dynamic query builder types.
 *
 * Backs `fromDynamic` / `traverseDynamic` / `optionalTraverseDynamic`
 * / `toDynamic` — the string-keyed sibling methods on `QueryBuilder`
 * and `TraversalBuilder` that admit runtime-declared kinds. Same SQL
 * compiler under the hood; only the alias-level surface types differ.
 *
 * Aliases declared via the dynamic methods carry `DynamicNodeType` /
 * `DynamicEdgeType` brands. `NodeAccessor<N>` / `EdgeAccessor<E>` /
 * `SelectableNode<N>` / `SelectableEdge<E>` branch on those brands so a
 * single query can mix typed and dynamic aliases — a typed alias keeps
 * `StringFieldAccessor`, etc., while a dynamic alias gets
 * `DynamicNodeAccessor` with a `.field(name)` discriminator.
 */
import {
  type AnyEdgeType,
  type KindEntity,
  type NodeType,
} from "../../core/types";
import { jsonPointer } from "../json-pointer";
import {
  buildFieldBuilderForTypeInfo,
  fieldRef,
  type FulltextAccessor,
} from "../predicates";
import {
  type FieldTypeInfo,
  type SchemaIntrospector,
} from "../schema-introspector";
import {
  type ArrayFieldAccessor,
  type BaseFieldAccessor,
  type DateFieldAccessor,
  type EmbeddingFieldAccessor,
  type NumberFieldAccessor,
  type ObjectFieldAccessor,
  type SelectableEdgeMeta,
  type SelectableNodeMeta,
  type StringFieldAccessor,
} from "./types";

declare const DYNAMIC_NODE_BRAND: unique symbol;
declare const DYNAMIC_EDGE_BRAND: unique symbol;

export type DynamicNodeType = NodeType &
  Readonly<{ [DYNAMIC_NODE_BRAND]: true }>;

export type DynamicEdgeType = AnyEdgeType &
  Readonly<{ [DYNAMIC_EDGE_BRAND]: true }>;

export type IsDynamicNodeType<N> =
  N extends Readonly<{ [DYNAMIC_NODE_BRAND]: true }> ? true : false;

export type IsDynamicEdgeType<E> =
  E extends Readonly<{ [DYNAMIC_EDGE_BRAND]: true }> ? true : false;

/**
 * Type-discriminated field builder for runtime-typed properties.
 *
 * `BaseFieldAccessor` methods (`eq`, `isNull`, etc.) are available
 * directly. Type-specific methods (`gte`, `contains`, `similarTo`, …)
 * sit behind a discriminator method that asserts the field's type:
 *
 * ```ts
 * (n) => n.field("year").number().gte(2020)
 * ```
 *
 * The discriminator validates against the registered Zod schema at
 * query-build time and throws `TypeError` on mismatch — the user can't
 * accidentally call `.between(...)` on a string field. The discriminator
 * is a type assertion *and* a runtime check.
 */
export type DynamicFieldBuilder = BaseFieldAccessor &
  Readonly<{
    string: () => StringFieldAccessor;
    number: () => NumberFieldAccessor;
    date: () => DateFieldAccessor;
    array: () => ArrayFieldAccessor<unknown>;
    object: () => ObjectFieldAccessor<Readonly<Record<string, unknown>>>;
    embedding: () => EmbeddingFieldAccessor;
  }>;

/**
 * Predicate accessor for a runtime-kind alias.
 *
 * System fields keep their narrow types. Schema properties are reached
 * through `.field(name)` — `.field()` validates the property exists on
 * the registered Zod schema and throws if it doesn't.
 */
export type DynamicNodeAccessor = Readonly<{
  id: StringFieldAccessor;
  kind: StringFieldAccessor;
  $fulltext: FulltextAccessor;
  field: (name: string) => DynamicFieldBuilder;
}>;

export type DynamicEdgeAccessor = Readonly<{
  id: StringFieldAccessor;
  kind: StringFieldAccessor;
  fromId: StringFieldAccessor;
  toId: StringFieldAccessor;
  field: (name: string) => DynamicFieldBuilder;
}>;

export type DynamicSelectableNode = Readonly<{
  id: string;
  kind: string;
  meta: SelectableNodeMeta;
}> &
  Readonly<Record<string, unknown>>;

export type DynamicSelectableEdge = Readonly<{
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  meta: SelectableEdgeMeta;
}> &
  Readonly<Record<string, unknown>>;

/**
 * Renders a kind-context string for error messages — `node kind "Paper"`
 * or `edge kinds "knows" | "follows"`.
 */
function describeKindContext(
  entity: KindEntity,
  kindNames: readonly string[] | undefined,
): string {
  if (kindNames === undefined || kindNames.length === 0) {
    return `${entity} (kind unresolved)`;
  }
  const list = kindNames.map((k) => `"${k}"`).join(" | ");
  return `${entity} kind${kindNames.length > 1 ? "s" : ""} ${list}`;
}

/**
 * Shared dynamic-field-builder factory. Returns a `DynamicFieldBuilder`
 * (typed as `BaseFieldAccessor` at the runtime boundary): the property
 * is validated against the registered Zod schema, and each
 * `.string()` / `.number()` / … discriminator throws `TypeError` on
 * type mismatch.
 *
 * Used by `QueryBuilder.#createNodeAccessor` for node aliases and by
 * `TraversalBuilder.#createEdgeAccessor` for edge aliases — they only
 * differ in which introspector method to call.
 */
export function createDynamicFieldBuilder(
  introspector: SchemaIntrospector,
  alias: string,
  name: string,
  kindNames: readonly string[] | undefined,
  entity: KindEntity,
): BaseFieldAccessor {
  const typeInfo =
    kindNames === undefined ? undefined
    : entity === "node" ? introspector.getSharedFieldTypeInfo(kindNames, name)
    : introspector.getSharedEdgeFieldTypeInfo(kindNames, name);

  const where = describeKindContext(entity, kindNames);
  if (typeInfo === undefined) {
    throw new Error(`Property "${name}" is not declared on ${where}.`);
  }

  const ref = fieldRef(alias, ["props"], {
    jsonPointer: jsonPointer([name]),
    valueType: typeInfo.valueType,
    elementType: typeInfo.elementType,
  });
  const base = buildFieldBuilderForTypeInfo(ref, typeInfo);

  const expect = (asserted: FieldTypeInfo["valueType"]): BaseFieldAccessor => {
    if (typeInfo.valueType !== asserted) {
      throw new TypeError(
        `Property "${name}" on ${where} is ${typeInfo.valueType}, not ${asserted}.`,
      );
    }
    return base;
  };

  return {
    ...base,
    string: () => expect("string"),
    number: () => expect("number"),
    date: () => expect("date"),
    array: () => expect("array"),
    object: () => expect("object"),
    embedding: () => expect("embedding"),
  } as BaseFieldAccessor;
}
