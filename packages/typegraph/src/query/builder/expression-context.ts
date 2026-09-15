import type { z } from "zod";

import type { GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
import type { FieldRef } from "../ast";
import { createFieldExpression, type DatabaseExpression } from "../expressions";
import { jsonPointer } from "../json-pointer";
import type { FieldTypeInfo } from "../schema-introspector";
import { getExpressionScope } from "./expression-scope";
import type { ExpressionSubqueryHelpers } from "./expression-subqueries";
import type { QueryBuilder } from "./query-builder";
import type {
  AliasMap,
  CommonPropertyKeys,
  EdgeAliasMap,
  EmptyAliasMap,
  EmptyEdgeAliasMap,
  EmptyRecursiveAliasMap,
  NodePropsFor,
  QueryBuilderConfig,
  QueryBuilderState,
  QueryCoordinateState,
} from "./types";

type UndefinedWhenNullish<Value> =
  Extract<Value, null | undefined> extends never ? never : undefined;
type UndefinedWhenOptional<Optional extends boolean> =
  Optional extends true ? undefined : never;
type ExpressionObjectChildren<Value, Scope extends string> = {
  readonly [
    Key in Exclude<
      CommonPropertyKeys<NonNullable<Value>>,
      keyof DatabaseExpression | "$get"
    >
  ]-?: ExpressionValue<
    NonNullable<Value>[Key] | UndefinedWhenNullish<Value>,
    Scope
  >;
} & Readonly<{
  $get: <Key extends CommonPropertyKeys<NonNullable<Value>>>(
    key: Key,
  ) => ExpressionValue<
    NonNullable<Value>[Key] | UndefinedWhenNullish<Value>,
    Scope
  >;
}>;

export type ExpressionValue<Value, Scope extends string> = DatabaseExpression<
  Exclude<Value, null> | (null extends Value ? undefined : never),
  Scope
> &
  (NonNullable<Value> extends Date | readonly unknown[] ? unknown
  : NonNullable<Value> extends object ? ExpressionObjectChildren<Value, Scope>
  : unknown);

type ExpressionMetadata<
  Scope extends string,
  Optional extends boolean = false,
> = Readonly<{
  validFrom: DatabaseExpression<string | undefined, Scope>;
  validTo: DatabaseExpression<string | undefined, Scope>;
  createdAt: DatabaseExpression<
    string | UndefinedWhenOptional<Optional>,
    Scope
  >;
  updatedAt: DatabaseExpression<
    string | UndefinedWhenOptional<Optional>,
    Scope
  >;
  deletedAt: DatabaseExpression<string | undefined, Scope>;
}>;

type AliasExpressions<
  Entry extends Readonly<{
    type: Readonly<{ schema: z.ZodType; kind: string }>;
    optional: boolean;
  }>,
  Scope extends string,
> = {
  readonly [
    Property in CommonPropertyKeys<NodePropsFor<Entry["type"]>>
  ]-?: ExpressionValue<
    | NodePropsFor<Entry["type"]>[Property]
    | (Entry["optional"] extends true ? undefined : never),
    Scope
  >;
} & Readonly<{
  id: DatabaseExpression<
    string | (Entry["optional"] extends true ? undefined : never),
    Scope
  >;
  kind: DatabaseExpression<
    | Entry["type"]["kind"]
    | (Entry["optional"] extends true ? undefined : never),
    Scope
  >;
  $meta: ExpressionMetadata<Scope, Entry["optional"]>;
}>;

export type ExpressionAliasContext<
  Aliases extends AliasMap,
  Edges extends EdgeAliasMap,
  Scope extends string = (keyof Aliases | keyof Edges) & string,
> = {
  readonly [Alias in keyof Aliases & string]: AliasExpressions<
    Aliases[Alias],
    Scope
  >;
} & {
  readonly [Alias in keyof Edges & string]: AliasExpressions<
    Edges[Alias],
    Scope
  > &
    Readonly<{
      fromId: DatabaseExpression<
        string | (Edges[Alias]["optional"] extends true ? undefined : never),
        Scope
      >;
      toId: DatabaseExpression<
        string | (Edges[Alias]["optional"] extends true ? undefined : never),
        Scope
      >;
    }>;
};

const METADATA_COLUMNS: Readonly<Record<string, string>> = {
  validFrom: "valid_from",
  validTo: "valid_to",
  createdAt: "created_at",
  updatedAt: "updated_at",
  deletedAt: "deleted_at",
};

const DATABASE_EXPRESSION_KEYS: ReadonlySet<PropertyKey> = new Set([
  "__scope",
  "__type",
  "__value",
  "elementValueType",
  "node",
  "nullable",
  "scopeIdentity",
  "valueType",
]);

/** Builds field expressions from schema evidence; no result callback is probed. */
export function createExpressionAliasContext<
  Aliases extends AliasMap,
  Edges extends EdgeAliasMap,
  Scope extends string = (keyof Aliases | keyof Edges) & string,
>(
  config: QueryBuilderConfig,
  state: QueryBuilderState,
  transform: (expression: DatabaseExpression) => DatabaseExpression = (
    expression,
  ) => expression,
): ExpressionAliasContext<Aliases, Edges, Scope> {
  const scope = getExpressionScope(config);
  function makeField(
    alias: string,
    path: readonly string[],
    info: FieldTypeInfo,
    nullable: boolean,
    property: boolean,
  ): DatabaseExpression {
    const reference: FieldRef = {
      __type: "field_ref",
      alias,
      path: property ? ["props"] : path,
      ...(property ? { jsonPointer: jsonPointer(path) } : {}),
      valueType: info.valueType,
      elementType: info.elementType,
    };
    const expression = transform(
      createFieldExpression(
        reference,
        scope,
        nullable || info.nullable === true,
      ),
    );
    if (info.valueType !== "object") return expression;
    return new Proxy(expression, {
      get(target, key, receiver) {
        if (key === "$get") {
          return (property: string) => {
            const child = info.shape?.[property] ?? info.recordValueType;
            if (child === undefined)
              throw new ConfigurationError(
                `Unknown expression field "${alias}.${[...path, property].join(".")}"`,
              );
            return makeField(
              alias,
              [...path, property],
              child,
              nullable || info.nullable === true,
              true,
            );
          };
        }
        if (
          typeof key !== "string" ||
          key in target ||
          DATABASE_EXPRESSION_KEYS.has(key)
        )
          return Reflect.get(target, key, receiver) as unknown;
        const child = info.shape?.[key] ?? info.recordValueType;
        if (child === undefined)
          throw new ConfigurationError(
            `Unknown expression field "${alias}.${[...path, key].join(".")}"`,
          );
        return makeField(
          alias,
          [...path, key],
          child,
          nullable || info.nullable === true,
          true,
        );
      },
    });
  }
  function aliasContext(alias: string): object {
    const edge = state.traversals.find(
      (traversal) => traversal.edgeAlias === alias,
    );
    const node = state.traversals.find(
      (traversal) => traversal.nodeAlias === alias,
    );
    const kinds =
      edge?.edgeKinds ??
      node?.nodeKinds ??
      (alias === state.startAlias ? state.startKinds : undefined);
    if (kinds === undefined)
      throw new ConfigurationError(`Unknown expression alias "${alias}"`);
    const optional = edge?.optional ?? node?.optional ?? false;
    return new Proxy(
      {},
      {
        get(_target, key) {
          if (typeof key !== "string") return;
          if (key === "$meta")
            return new Proxy(
              {},
              {
                get(_metadata, property) {
                  if (
                    typeof property !== "string" ||
                    METADATA_COLUMNS[property] === undefined
                  )
                    return;
                  return makeField(
                    alias,
                    [METADATA_COLUMNS[property]],
                    { valueType: "string" },
                    optional ||
                      (property !== "createdAt" && property !== "updatedAt"),
                    false,
                  );
                },
              },
            );
          const system =
            key === "id" || key === "kind" ? key
            : edge !== undefined && key === "fromId" ? "from_id"
            : edge !== undefined && key === "toId" ? "to_id"
            : undefined;
          if (system !== undefined)
            return makeField(
              alias,
              [system],
              { valueType: "string" },
              optional,
              false,
            );
          const info =
            edge === undefined ?
              config.schemaIntrospector.getSharedFieldTypeInfo(kinds, key)
            : config.schemaIntrospector.getSharedEdgeFieldTypeInfo(kinds, key);
          if (info === undefined)
            throw new ConfigurationError(
              `Unknown or incompatible expression field "${alias}.${key}"`,
            );
          return makeField(alias, [key], info, optional, true);
        },
      },
    );
  }
  return new Proxy(
    {},
    {
      get(_target, key) {
        return typeof key === "string" ? aliasContext(key) : undefined;
      },
    },
  ) as ExpressionAliasContext<Aliases, Edges, Scope>;
}

export type QueryExpressionContext<
  G extends GraphDef,
  Aliases extends AliasMap,
  Edges extends EdgeAliasMap,
  Coordinate extends QueryCoordinateState,
> = ExpressionAliasContext<Aliases, Edges> &
  ExpressionSubqueryHelpers<
    QueryBuilder<
      G,
      EmptyAliasMap,
      EmptyEdgeAliasMap,
      EmptyRecursiveAliasMap,
      Coordinate
    >,
    ExpressionAliasContext<Aliases, Edges, never>,
    (keyof Aliases | keyof Edges) & string
  >;
