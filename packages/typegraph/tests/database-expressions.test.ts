import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../src";
import { UnsupportedPredicateError } from "../src/errors";
import type { FieldRef } from "../src/query/ast";
import { decodeExpressionValue } from "../src/query/builder/executable-projection-query";
import { compileDatabaseExpression } from "../src/query/compiler/database-expressions";
import { sqliteDialect } from "../src/query/dialect/sqlite";
import {
  collectOperandExpressions,
  createFieldExpression,
  type DatabaseExpression,
  expr,
  isCollectRecordOperand,
} from "../src/query/expressions";
import { createTestBackend } from "./test-utils";

function field<T>(
  alias: string,
  name: string,
  valueType: FieldRef["valueType"],
): FieldRef<T> {
  return { __type: "field_ref", alias, path: ["props", name], valueType };
}

describe("database expressions", () => {
  it("constructs a typed tree and propagates nullability", () => {
    const scopeIdentity = Symbol("person query");
    const age = createFieldExpression<number | undefined, "person">(
      field("person", "age", "number"),
      scopeIdentity,
      true,
    );
    const threshold = expr.literal(18);

    const predicate = expr.gte(expr.add(age, expr.literal(1)), threshold);

    expect(predicate).toMatchObject({
      __type: "database_expression",
      node: { kind: "comparison", operator: "gte" },
      nullable: true,
      scopeIdentity,
      valueType: "boolean",
    });
  });

  it("models SQL null, aggregate, division, and conversion semantics", () => {
    const scopeIdentity = Symbol("person query");
    const score = createFieldExpression<number, "person">(
      field("person", "score", "number"),
      scopeIdentity,
      false,
    );

    expect(expr.divide(score, expr.literal(0)).nullable).toBe(true);
    expect(expr.toNumber(expr.literal("12.5"))).toMatchObject({
      nullable: true,
      valueType: "number",
    });
    expect(expr.count(score)).toMatchObject({
      nullable: false,
      valueType: "number",
    });
    expect(expr.sum(score)).toMatchObject({
      nullable: true,
      valueType: "number",
    });
    expect(expr.isNull(score)).toMatchObject({
      nullable: false,
      valueType: "boolean",
    });
    expect(expr.literal(undefined)).toMatchObject({
      nullable: true,
      valueType: "unknown",
    });
    // eslint-disable-next-line unicorn/no-null -- JSON null is the case under test.
    expect(expr.literal(null)).toMatchObject({
      nullable: true,
      valueType: "unknown",
    });
    expect(expr.literal(new Date("2025-01-01T00:00:00.000Z")).valueType).toBe(
      "date",
    );
  });

  it("uses distinct public AST shapes for collection and scalar aggregates", () => {
    const operand = expr.literal("Ada");
    const order = expr.literal(1);
    const filter = expr.literal(true);
    const collection = expr.collect(operand, {
      filter,
      orderBy: [{ expression: order, direction: "desc", nulls: "first" }],
    });
    const aggregate = expr.sum(order);

    expect(collection.node).toEqual({
      kind: "collect",
      filter,
      operand,
      orderBy: [{ expression: order, direction: "desc", nulls: "first" }],
    });
    expect(collection.node).not.toHaveProperty("operator");
    expect(aggregate.node).toEqual({
      kind: "aggregate",
      operand: order,
      operator: "sum",
    });
    expect(aggregate.node).not.toHaveProperty("orderBy");
  });

  it("snapshots record fields when constructing a collection", () => {
    const publishedAt = new Date("2024-01-01T00:00:00.000Z");
    const originalValue = expr.literal("original");
    const fields: Record<
      string,
      DatabaseExpression<boolean | Date | number | string | undefined, never>
    > = {
      publishedAt: expr.literal(publishedAt),
      value: originalValue,
    };
    const collection = expr.collect(fields, {
      orderBy: [{ expression: expr.literal(1) }],
    });

    fields["value"] = expr.literal("changed");
    fields["extra"] = expr.literal(true);

    expect(collection.node).toMatchObject({
      kind: "collect",
      operand: {
        kind: "record",
        fields: { publishedAt: fields["publishedAt"], value: originalValue },
      },
    });
    if (
      collection.node.kind !== "collect" ||
      !isCollectRecordOperand(collection.node.operand)
    )
      throw new Error("Expected a record collection operand");
    expect(collection.node.operand.fields).not.toHaveProperty("extra");
    expect(collection.elementFields).toEqual({
      publishedAt: "date",
      value: "string",
    });
    expect(
      decodeExpressionValue(
        '[{"publishedAt":"2024-01-01T00:00:00.000Z","value":"original"}]',
        collection,
      ),
    ).toEqual([{ publishedAt, value: "original" }]);
  });

  it("refuses malformed record operands through the shared field resolver", () => {
    expect(() =>
      collectOperandExpressions({ kind: "record", fields: undefined as never }),
    ).toThrow(UnsupportedPredicateError);
    expect(() =>
      collectOperandExpressions({ kind: "record", fields: {} }),
    ).toThrow(UnsupportedPredicateError);
  });

  it("does not apply collection element decoding to ordinary JSON array fields", () => {
    const tags = createFieldExpression<readonly (string | null)[], "document">(
      {
        __type: "field_ref",
        alias: "document",
        path: ["props", "tags"],
        valueType: "array",
        elementType: "string",
      },
      Symbol("document query"),
      false,
    );

    expect(tags.elementValueType).toBeUndefined();
    expect(decodeExpressionValue('["first",null]', tags)).toEqual([
      "first",
      // eslint-disable-next-line unicorn/no-null -- ordinary JSON null must remain JSON null.
      null,
    ]);
  });

  it("preserves array operand typing through coalesce without adding a decoder", () => {
    const primary = createFieldExpression<
      readonly string[] | undefined,
      "document"
    >(
      {
        __type: "field_ref",
        alias: "document",
        elementType: "string",
        path: ["props", "tags"],
        valueType: "array",
      },
      Symbol("primary array"),
      true,
    );
    const fallback = createFieldExpression<readonly string[], "document">(
      {
        __type: "field_ref",
        alias: "document",
        elementType: "string",
        path: ["props", "fallbackTags"],
        valueType: "array",
      },
      primary.scopeIdentity,
      false,
    );
    const candidate = createFieldExpression<string, "document">(
      field("document", "title", "string"),
      primary.scopeIdentity,
      false,
    );
    const combined = expr.coalesce(primary, fallback);

    expect(combined.arrayElementType).toBe("string");
    expect(combined.elementValueType).toBeUndefined();
    expect(() =>
      compileDatabaseExpression(expr.arrayContains(combined, candidate), {
        dialect: sqliteDialect,
      }),
    ).not.toThrow();
  });

  it("refuses structured array membership elements before SQL compilation", () => {
    const records = createFieldExpression<
      readonly Readonly<Record<string, string>>[],
      "document"
    >(
      {
        __type: "field_ref",
        alias: "document",
        elementType: "object",
        path: ["props", "records"],
        valueType: "array",
      },
      Symbol("structured array"),
      false,
    );

    expect(() =>
      expr.arrayContains(records, expr.literal({ key: "value" })),
    ).toThrow(UnsupportedPredicateError);
  });

  it("keeps reserved expression metadata separate from object fields", () => {
    const Document = defineNode("ExpressionMetadataDocument", {
      schema: z.object({
        metadata: z.object({
          elementFields: z.string(),
          elementValueType: z.string(),
        }),
      }),
    });
    const graph = defineGraph({
      id: "expression-metadata-field",
      nodes: { ExpressionMetadataDocument: { type: Document } },
      edges: {},
    });
    const store = createStore(graph, createTestBackend());

    const query = store
      .query()
      .from("ExpressionMetadataDocument", "document")
      .project((fields) => ({
        explicitSchemaField: fields.document.metadata.$get("elementValueType"),
        explicitElementFields: fields.document.metadata.$get("elementFields"),
        metadata: fields.document.metadata,
      }));

    expect(query.getExpressionProjection()[0]?.expression.node).toMatchObject({
      field: { jsonPointer: "/metadata/elementValueType" },
      kind: "field",
    });
    expect(query.getExpressionProjection()[1]?.expression.node).toMatchObject({
      field: { jsonPointer: "/metadata/elementFields" },
      kind: "field",
    });
    expect(
      query.getExpressionProjection()[2]?.expression.elementValueType,
    ).toBeUndefined();
    expect(
      query.getExpressionProjection()[2]?.expression.elementFields,
    ).toBeUndefined();
  });

  it("rejects invalid runtime operands, types, and mixed scopes", () => {
    const left = createFieldExpression<number, "shared">(
      field("left", "age", "number"),
      Symbol("left query"),
      false,
    );
    const right = createFieldExpression<number, "shared">(
      field("right", "age", "number"),
      Symbol("right query"),
      false,
    );

    expect(() => expr.add(left, right)).toThrow("different query scopes");
    expect(() => expr.param("", "number")).toThrow("cannot be empty");
    expect(() => expr.param("value", "unknown")).toThrow("concrete value type");
    expect(() => expr.and()).toThrow("at least one operand");
  });

  it("requires compatible coalesce and conditional branches", () => {
    expect(() =>
      expr.coalesce(
        expr.literal("name"),
        // Deliberately bypass static checking to exercise the runtime boundary.
        expr.literal(1) as never,
      ),
    ).toThrow("incompatible value types");
    expect(() =>
      expr.when(
        expr.literal(true),
        expr.literal("yes"),
        expr.literal(0) as never,
      ),
    ).toThrow("incompatible value types");
  });

  it("snapshots JSON literals and refuses values databases cannot preserve", () => {
    const payload = { nested: { score: 1 } };
    const expression = expr.literal(payload);
    payload.nested.score = 2;

    expect(expression.node).toMatchObject({
      kind: "literal",
      value: { nested: { score: 1 } },
    });
    expect(() => expr.literal({ score: Number.POSITIVE_INFINITY })).toThrow(
      "must be finite",
    );
    expect(() => expr.literal([Number.NaN])).toThrow("must be finite");
    expect(() => expr.literal([undefined] as never)).toThrow(
      "cannot be undefined",
    );
    expect(() => expr.literal(new Map() as never)).toThrow("plain JSON object");
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => expr.literal(cyclic as never)).toThrow(
      "cannot contain a cycle",
    );
    expect(() => expr.literal(new Date(Number.NaN))).toThrow("valid Date");
  });
});
