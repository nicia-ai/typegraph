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
  embedding,
  exists,
  expr,
  field,
  havingGt,
  inSubquery,
  max,
  min,
  searchable,
  sum,
} from "../src";
import type {
  FulltextMatchPredicate,
  PredicateExpression,
  QueryAst,
} from "../src/query/ast";
import { createQueryBuilder } from "../src/query/builder";
import {
  type CompileQueryOptions,
  compileQueryWithSqlNames,
} from "../src/query/compiler";
import { vectorSlotKey } from "../src/query/compiler/schema";
import { findSqlNameIssues } from "../src/query/compiler/sql-name-registry";
import {
  fts5Strategy,
  tsvectorStrategy,
} from "../src/query/dialect/fulltext-strategy";
import { pgvectorStrategy } from "../src/query/dialect/vector/pgvector-strategy";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
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
/** A node with a full-text field and an embedding, for the search statements. */
const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    rating: z.number().optional(),
    embedding: embedding(3),
  }),
});
const graph = defineGraph({
  id: "sql_column_read_gate",
  nodes: { Person: { type: Person }, Document: { type: Document } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

/** The strategies a search statement compiles with, per dialect. */
function searchOptions(
  dialect: "sqlite" | "postgres",
): Omit<CompileQueryOptions, "dialect"> {
  return {
    fulltextStrategy: dialect === "sqlite" ? fts5Strategy : tsvectorStrategy,
    vectorStrategy: dialect === "sqlite" ? sqliteVecStrategy : pgvectorStrategy,
    vectorSlots: new Map([
      [
        vectorSlotKey("Document", "embedding"),
        {
          dimensions: 3,
          metric: "cosine" as const,
          indexType: "hnsw" as const,
        },
      ],
    ]),
  };
}

/** A full-text match on `alias`, as `$fulltext.matches()` builds it. */
function fulltextMatch(alias: string): FulltextMatchPredicate {
  return {
    __type: "fulltext_match",
    field: fieldRef(alias, ["$fulltext"]),
    query: "graph refactor",
    mode: "websearch",
    limit: 10,
  };
}

/** `ast` with a full-text match on `alias` added to its predicates. */
function withFulltextMatch(ast: QueryAst, alias: string): QueryAst {
  return {
    ...ast,
    predicates: [
      ...ast.predicates,
      { targetAlias: alias, expression: fulltextMatch(alias) },
    ],
  };
}

/** Documents searched under `alias`, grouped by id, with HAVING on that id. */
function searchedDocuments(
  alias: "d" | "node",
  search: "fulltext" | "vector" | "hybrid",
  approximate = false,
): QueryAst {
  const base = builder()
    .from("Document", alias)
    .whereNode(alias, (document) =>
      search === "fulltext" ?
        document.rating.gt(0)
      : document.embedding.similarTo([0.1, 0.2, 0.3], 5, { approximate }),
    )
    .groupByNode(alias)
    .having(comparison(ID(alias), "neq", ID(alias)))
    .aggregate({ id: field(alias, "id"), documents: count(alias) })
    .toAst();
  return search === "vector" ? base : withFulltextMatch(base, alias);
}
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
  /** Whether the statement needs the full-text and vector strategies. */
  search?: true;
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
  {
    label: "a full-text search with HAVING on the searched alias's id",
    ast: searchedDocuments("d", "fulltext"),
    search: true,
  },
  {
    label: "an exact vector search with HAVING on the searched alias's id",
    ast: searchedDocuments("d", "vector"),
    search: true,
  },
  {
    label: "an approximate vector search (the strategy's own search SQL)",
    ast: searchedDocuments("d", "vector", true),
    search: true,
  },
  {
    label: "a hybrid search with HAVING on the searched alias's id",
    ast: searchedDocuments("d", "hybrid"),
    search: true,
  },
  {
    label: "a full-text selection ordered by relevance",
    ast: withFulltextMatch(
      builder()
        .from("Document", "d")
        .select((ctx) => ({ id: ctx.d.id, title: ctx.d.title }))
        .toAst(),
      "d",
    ),
    search: true,
  },
];

describe("column reads recorded by the emitter equal the references its SQL makes", () => {
  for (const { label, ast, search } of COLUMN_READ_GATE_DOMAIN) {
    for (const dialect of ["sqlite", "postgres"] as const) {
      it(`${label} / ${dialect}`, () => {
        const { compiled, names } = compileQueryWithSqlNames(
          ast,
          graph.id,
          search === true ? { dialect, ...searchOptions(dialect) } : dialect,
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
    const [having, aggregate] = COLUMN_READ_GATE_DOMAIN.slice(0, 2).map(
      (entry) =>
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

describe("the columns of the full-text, vector and hybrid CTEs", () => {
  for (const search of ["fulltext", "vector", "hybrid"] as const) {
    it(`refuses an unqualified HAVING read of \`node_id\` beside the ${search} CTE when the searched alias is \`node\``, () => {
      const verdicts = (["node", "d"] as const).map((alias) =>
        findSqlNameIssues(
          requireDefined(
            compileQueryWithSqlNames(
              searchedDocuments(alias, search),
              graph.id,
              {
                dialect: "sqlite",
                ...searchOptions("sqlite"),
              },
            ).names,
          ),
          "decoded",
        ).map((issue) => issue.message),
      );
      const relevanceCte =
        search === "vector" ? "cte_embeddings"
        : search === "fulltext" ? "cte_fulltext"
        : "cte_relevance_candidates";
      expect(verdicts).toEqual([
        [
          `"node_id" is read without naming its relation, and both cte_node and ${relevanceCte} have a column by that name, which PostgreSQL clips to 63 bytes and the engines compare without regard to letter case.`,
        ],
        [],
      ]);
    });
  }
});
