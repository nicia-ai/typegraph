/**
 * Structural gate: for every standard statement in the domain, the by-name
 * column references its SQL text makes EQUAL the read set the SQL-name
 * registry recorded for it, per relation (`tests/column-read-gate.ts`). Not a
 * subset in either direction: a missed read (a reference the guard cannot
 * see) and a phantom read (a reference the guard counts that the SQL never
 * makes) both fail. The compile-golden corpus runs the same gate over every
 * statement it compiles.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  avg,
  count,
  countDistinct,
  defineEdge,
  defineGraph,
  defineNode,
  exists,
  expr,
  field,
  havingGt,
  inSubquery,
  max,
  min,
  sum,
} from "../src";
import type { PredicateExpression, QueryAst } from "../src/query/ast";
import { createQueryBuilder } from "../src/query/builder";
import { compileQueryWithSqlNames } from "../src/query/compiler";
import { fieldRef } from "../src/query/predicates";
import { buildKindRegistry } from "../src/registry";
import { requireDefined } from "../src/utils/presence";
import {
  recordedColumnReferences,
  textColumnReferences,
} from "./column-read-gate";
import { toSqlWithParams } from "./sql-test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ since: z.string().optional() }),
});
const graph = defineGraph({
  id: "sql_column_read_gate",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});
const registry = buildKindRegistry(graph);

function builder() {
  return createQueryBuilder<typeof graph>(graph.id, registry);
}

/** Edge `e` beside a target alias `e_from`: both spell a column `e_from_id`. */
function edgeBesideFrom() {
  return builder()
    .from("Person", "p")
    .traverse("knows", "e")
    .to("Person", "e_from");
}

function comparison(
  left: ReturnType<typeof fieldRef>,
  op: "eq" | "neq" | "gt",
  right: ReturnType<typeof fieldRef>,
): PredicateExpression {
  return { __type: "comparison", op, left, right };
}

const NAME = (alias: string) =>
  fieldRef(alias, ["props", "name"], { valueType: "string" });
const ID = (alias: string) => fieldRef(alias, ["id"], { valueType: "string" });

/** The two cases of the second review, then a domain of standard shapes. */
export const COLUMN_READ_GATE_DOMAIN: readonly Readonly<{
  label: string;
  ast: QueryAst;
}>[] = [
  {
    label: "review: HAVING reads `e_from.id` on the right",
    ast: edgeBesideFrom()
      .groupBy("e_from", "name")
      .having(comparison(NAME("e_from"), "neq", ID("e_from")))
      .aggregate({ name: field("e_from", "name"), edges: count("e") })
      .toAst(),
  },
  {
    label: "review: max of `e_from.age` beside an edge `e` filtered on fromId",
    ast: edgeBesideFrom()
      .whereEdge("e", (edge) => edge.fromId.eq("someone"))
      .aggregate({ age: max("e_from", "age") })
      .toAst(),
  },
  {
    label: "HAVING with fields on both sides",
    ast: edgeBesideFrom()
      .groupBy("p", "name")
      .groupBy("e_from", "name")
      .having(comparison(NAME("p"), "neq", NAME("e_from")))
      .aggregate({
        name: field("p", "name"),
        friend: field("e_from", "name"),
        edges: count("e"),
      })
      .toAst(),
  },
  {
    label: "HAVING over a legacy aggregate",
    ast: edgeBesideFrom()
      .groupBy("p", "name")
      .having(havingGt(count("e_from"), 1))
      .aggregate({ name: field("p", "name"), friends: count("e_from") })
      .toAst(),
  },
  {
    label: "every legacy aggregate",
    ast: edgeBesideFrom()
      .groupBy("p", "name")
      .aggregate({
        name: field("p", "name"),
        friends: count("e_from"),
        distinctFriends: countDistinct("e_from"),
        total: sum("e_from", "age"),
        mean: avg("e_from", "age"),
        youngest: min("e_from", "age"),
        oldest: max("e_from", "age"),
      })
      .toAst(),
  },
  {
    label: "an ordered aggregate",
    ast: edgeBesideFrom()
      .groupBy("p", "name")
      .aggregate({ name: field("p", "name"), oldest: max("e_from", "age") })
      .orderBy("oldest", "desc")
      .limit(3)
      .toAst(),
  },
  {
    label: "the count fast path",
    ast: edgeBesideFrom()
      .groupByNode("p")
      .aggregate({ id: field("p", "id"), friends: count("e_from") })
      .toAst(),
  },
  {
    label: "expression aggregates with expression grouping and HAVING",
    ast: edgeBesideFrom()
      .groupBy((fields) => [fields.p.name])
      .having((fields) =>
        expr.gt(expr.count(fields.e_from.id), expr.literal(0)),
      )
      .aggregate((fields) => ({
        name: fields.p.name,
        friends: expr.count(fields.e_from.id),
        oldest: expr.max(fields.e_from.age),
      }))
      .toAst(),
  },
  {
    label: "a whole-row select over two hops",
    ast: builder()
      .from("Person", "p")
      .traverse("knows", "e")
      .to("Person", "q")
      .traverse("knows", "f")
      .to("Person", "r")
      .select((ctx) => ({ p: ctx.p, e: ctx.e, r: ctx.r }))
      .toAst(),
  },
  {
    label: "an optional traversal",
    ast: builder()
      .from("Person", "p")
      .optionalTraverse("knows", "e")
      .to("Person", "q")
      .select((ctx) => ({ p: ctx.p.name, q: ctx.q?.name }))
      .toAst(),
  },
  {
    label: "a selection ordered and paged (late materialization)",
    ast: builder()
      .from("Person", "p")
      .orderBy("p", "name")
      .limit(5)
      .select((ctx) => ({ id: ctx.p.id, age: ctx.p.age }))
      .toAst(),
  },
  {
    label: "a projection reading only the target's name",
    ast: edgeBesideFrom()
      .project((fields) => ({ name: fields.e_from.name }))
      .toAst(),
  },
  {
    label: "a correlated expression subquery",
    ast: builder()
      .from("Person", "p")
      .project((fields) => ({
        id: fields.p.id,
        hasNamesake: fields.$exists((subquery, outer) =>
          subquery
            .from("Person", "other")
            .where((inner) => expr.eq(inner.other.name, outer.p.name))
            .project((inner) => ({ id: inner.other.id }))
            .limit(1),
        ),
      }))
      .toAst(),
  },
  {
    label: "EXISTS and IN subqueries reusing the outer alias",
    ast: builder()
      .from("Person", "p")
      .whereNode("p", () =>
        exists(
          builder()
            .from("Person", "p")
            .aggregate({ id: fieldRef("p", ["id"], { valueType: "string" }) })
            .toAst(),
        ),
      )
      .whereNode("p", () =>
        inSubquery(
          fieldRef("p", ["id"]),
          builder()
            .from("Person", "p")
            .aggregate({ id: fieldRef("p", ["id"], { valueType: "string" }) })
            .toAst(),
        ),
      )
      .select((ctx) => ({ id: ctx.p.id }))
      .toAst(),
  },
  {
    label: "ordering by an expression",
    ast: builder()
      .from("Person", "p")
      .orderBy((fields) => expr.add(fields.p.age, expr.literal(1)), "asc")
      .select((ctx) => ctx.p.name)
      .toAst(),
  },
];

describe("column reads recorded by the emitter equal the references its SQL makes", () => {
  for (const { label, ast } of COLUMN_READ_GATE_DOMAIN) {
    for (const dialect of ["sqlite", "postgres"] as const) {
      it(`${label} / ${dialect}`, () => {
        const { compiled, names } = compileQueryWithSqlNames(
          ast,
          graph.id,
          dialect,
        );
        const statementNames = requireDefined(names);
        const text = toSqlWithParams(compiled, dialect).sql;
        expect(recordedColumnReferences(statementNames)).toEqual(
          textColumnReferences(text, statementNames),
        );
      });
    }
  }

  it("records `e_from_id` as read by HAVING's right operand and not by an aggregate of another column", () => {
    const [having, aggregate] = COLUMN_READ_GATE_DOMAIN.map((entry) =>
      recordedColumnReferences(
        requireDefined(
          compileQueryWithSqlNames(entry.ast, graph.id, "sqlite").names,
        ),
      ),
    );
    expect(having?.unqualified).toContain("e_from_id");
    expect(aggregate?.qualified["cte_e_from"] ?? []).not.toContain("e_from_id");
  });
});
