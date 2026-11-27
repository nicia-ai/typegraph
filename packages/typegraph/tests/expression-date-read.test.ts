/**
 * An expression's date facts (`ExpressionDateRead`) are carried under a
 * symbol, never as string keys: a structured field expression is a proxy over
 * its schema's nested fields, so every string key an expression owns is a
 * nested field name the proxy would shadow.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode, expr } from "../src";
import { type DatabaseExpression } from "../src/query";
import { dateReadOf } from "../src/query/expression-date-read";
import { createTestBackend } from "./test-utils";

/**
 * The string keys an expression may own: the ones it owned before it carried
 * date facts. A new string key would shadow a nested schema field of that
 * name, so a new fact goes under the symbol instead.
 */
const EXPRESSION_STRING_KEYS: ReadonlySet<string> = new Set([
  "__type",
  "node",
  "valueType",
  "arrayElementType",
  "elementValueType",
  "elementFields",
  "nullable",
  "scopeIdentity",
]);

const STATED = new Date("2024-01-02T03:04:05.678Z");

const Dated = defineNode("Dated", {
  schema: z.object({
    label: z.string(),
    at: z.date(),
    times: z.array(z.date()),
    nested: z.object({ at: z.date(), note: z.string() }),
  }),
});

const graph = defineGraph({
  id: "expression_date_read",
  nodes: { Dated: { type: Dated } },
  edges: {},
});

/** Every kind of expression that carries a date fact, built through the public builders. */
function datedExpressions(): Readonly<Record<string, DatabaseExpression>> {
  const store = createStore(graph, createTestBackend());
  const captured: Record<string, DatabaseExpression> = {};
  store
    .query()
    .from("Dated", "d")
    .project((fields) => {
      Object.assign(captured, {
        structuredField: fields.d.times,
        objectField: fields.d.nested,
        literal: expr.literal(STATED),
        parameter: expr.param("stated", "date"),
        coalesce: expr.coalesce(
          fields.d.times as never,
          fields.d.times as never,
        ),
        when: expr.when(
          expr.eq(fields.d.label, expr.literal("x")),
          expr.literal(STATED),
          expr.literal(STATED),
        ),
        collectScalar: expr.collect(expr.literal(STATED), {
          orderBy: [{ expression: fields.d.label }],
        }),
        collectRecord: expr.collect(
          { at: expr.literal(STATED), stored: fields.d.at },
          { orderBy: [{ expression: fields.d.label }] },
        ),
        extremum: expr.max(expr.literal(STATED)),
        scalarSubquery: fields.$scalar((subquery) =>
          subquery
            .from("Dated", "x")
            .project((inner) => ({ times: inner.x.times }))
            .limit(1),
        ),
      });
      return { label: fields.d.label };
    });
  store
    .query()
    .from("Dated", "d")
    .project((fields) => ({ times: fields.d.times, at: expr.literal(STATED) }))
    .asRelation()
    .project((columns) => {
      Object.assign(captured, {
        relationStructured: columns.times,
        relationStated: columns.at,
      });
      return { times: columns.times };
    });
  return captured;
}

describe("expression date facts", () => {
  it("are carried by every dated expression, under a symbol and never a string key", () => {
    const expressions = datedExpressions();
    expect(Object.keys(expressions)).toHaveLength(12);
    const report = Object.fromEntries(
      Object.entries(expressions).map(([name, expression]) => {
        const facts = Object.keys(dateReadOf(expression));
        const stringKeys = Reflect.ownKeys(expression).filter(
          (key): key is string => typeof key === "string",
        );
        return [
          name,
          {
            // The fact is there: a builder that dropped it would pass the
            // key checks below.
            carriesFacts: facts.length > 0,
            newStringKeys: stringKeys.filter(
              (key) => !EXPRESSION_STRING_KEYS.has(key),
            ),
            factsAsStringKeys: facts.filter((fact) =>
              Object.hasOwn(expression, fact),
            ),
          },
        ];
      }),
    );
    expect(report).toEqual(
      Object.fromEntries(
        Object.keys(expressions).map((name) => [
          name,
          { carriesFacts: true, newStringKeys: [], factsAsStringKeys: [] },
        ]),
      ),
    );
  });

  it("leave every date fact's name free for a nested schema field", () => {
    const expressions = datedExpressions();
    const factKeys = new Set(
      Object.values(expressions).flatMap((expression) =>
        Object.keys(dateReadOf(expression)),
      ),
    );
    expect([...factKeys].toSorted()).toEqual([
      "dateOrigin",
      "elementDateOrigins",
      "readPlan",
    ]);
    const Named = defineNode("Named", {
      schema: z.object({
        info: z.object(
          Object.fromEntries([...factKeys].map((key) => [key, z.string()])),
        ),
      }),
    });
    const store = createStore(
      defineGraph({
        id: "expression_date_read_named",
        nodes: { Named: { type: Named } },
        edges: {},
      }),
      createTestBackend(),
    );
    const compiled = [...factKeys].map((key) => {
      try {
        store
          .query()
          .from("Named", "n")
          .project((fields) => ({
            value: (
              fields.n.info as unknown as Record<string, DatabaseExpression>
            )[key] as never,
          }))
          .compile();
        return [key, "compiled"];
      } catch (error) {
        return [key, error instanceof Error ? error.message : String(error)];
      }
    });
    expect(Object.fromEntries(compiled)).toEqual(
      Object.fromEntries([...factKeys].map((key) => [key, "compiled"])),
    );
  });
});
