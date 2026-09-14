import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../src";
import { UnsupportedPredicateError } from "../src/errors";
import type { FieldRef } from "../src/query/ast";
import { decodeExpressionValue } from "../src/query/builder/executable-projection-query";
import { compileDatabaseExpression } from "../src/query/compiler/database-expressions";
import { sqliteDialect } from "../src/query/dialect/sqlite";
import type { DatabaseExpression } from "../src/query/expressions";
import { createFieldExpression, expr } from "../src/query/expressions";
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

  it("refuses ordering metadata on non-collection aggregates", () => {
    const aggregate = expr.sum(expr.literal(1));
    const forged = {
      ...aggregate,
      node: { ...aggregate.node, orderBy: [] },
    } as DatabaseExpression;

    expect(() =>
      compileDatabaseExpression(forged, {
        dialect: sqliteDialect,
        orderedAggregates: true,
      }),
    ).toThrow(UnsupportedPredicateError);
    expect(() =>
      compileDatabaseExpression(forged, {
        dialect: sqliteDialect,
        orderedAggregates: true,
      }),
    ).toThrow("SUM does not accept aggregate ordering");
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

  it("keeps reserved expression metadata separate from object fields", () => {
    const Document = defineNode("ExpressionMetadataDocument", {
      schema: z.object({
        metadata: z.object({ elementValueType: z.string() }),
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
        metadata: fields.document.metadata,
      }));

    expect(query.getExpressionProjection()[0]?.expression.node).toMatchObject({
      field: { jsonPointer: "/metadata/elementValueType" },
      kind: "field",
    });
    expect(
      query.getExpressionProjection()[1]?.expression.elementValueType,
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
