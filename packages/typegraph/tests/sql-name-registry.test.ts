/**
 * The SQL-name registry of the standard compile path: its comparison rules,
 * and a walk over emitted SQL proving every alias-derived name the standard
 * emitter writes is one it registered. Backend behaviour (refusal parity,
 * rows) lives in the shared integration suite
 * (`tests/backends/integration/sql-identifier-identity.ts`).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { count, defineEdge, defineGraph, defineNode, field } from "../src";
import {
  SQL_IDENTIFIER_COLLISION_CODE,
  SQL_IDENTIFIER_TOO_LONG_CODE,
} from "../src/errors";
import type { QueryAst, SelectiveField } from "../src/query/ast";
import { createQueryBuilder } from "../src/query/builder";
import { compileQueryWithSqlNames } from "../src/query/compiler";
import {
  createSqlStatementNames,
  declareAliasColumn,
  declareAliasCte,
  declareResultColumn,
  findSqlNameIssues,
  refuseCaseInsensitiveOutputKeys,
} from "../src/query/compiler/sql-name-registry";
import { buildKindRegistry } from "../src/registry";
import { requireDefined } from "../src/utils/presence";
import { toSqlWithParams } from "./sql-test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ since: z.string().optional() }),
});
const graph = defineGraph({
  id: "sql_name_registry",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});
const registry = buildKindRegistry(graph);

function builder() {
  return createQueryBuilder<typeof graph>(graph.id, registry);
}

describe("SQL name registry comparison", () => {
  it("compares WITH names after clipping to 63 bytes and folding ASCII case", () => {
    const names = createSqlStatementNames();
    declareAliasCte(names, "item");
    declareAliasCte(names, "Item");
    declareAliasCte(names, `${"a".repeat(59)}1`);
    declareAliasCte(names, `${"a".repeat(59)}2`);
    declareAliasCte(names, `${"a".repeat(58)}3x`);
    expect(
      findSqlNameIssues(names, "decoded").map((issue) => issue.code),
    ).toEqual([SQL_IDENTIFIER_COLLISION_CODE, SQL_IDENTIFIER_COLLISION_CODE]);
  });

  it("counts a CTE column collision only when the statement refers to that name in that CTE", () => {
    const names = createSqlStatementNames();
    const columns = names.relationColumns("cte_p");
    const alias = "x".repeat(57);
    declareAliasColumn(columns, alias, "valid_from");
    declareAliasColumn(columns, alias, "valid_to");
    declareAliasColumn(columns, alias, "id");
    columns.reference(`${alias}_id`);
    // A reference to the same name in another relation does not count here.
    names.relationColumns("cte_q").reference(`${alias}_valid_to`);
    expect(findSqlNameIssues(names, "decoded")).toEqual([]);
    columns.reference(`${alias}_valid_to`);
    expect(
      findSqlNameIssues(names, "decoded").map((issue) => issue.code),
    ).toEqual([SQL_IDENTIFIER_COLLISION_CODE]);
  });

  it("counts every column collision in a CTE the statement reads with SELECT *", () => {
    const names = createSqlStatementNames();
    const columns = names.relationColumns("cte_friend");
    declareAliasColumn(columns, "k", "id");
    declareAliasColumn(columns, "K", "id");
    expect(findSqlNameIssues(names, "decoded")).toEqual([]);
    columns.referenceEvery();
    expect(
      findSqlNameIssues(names, "decoded").map((issue) => issue.code),
    ).toEqual([SQL_IDENTIFIER_COLLISION_CODE]);
  });

  it("compares result columns by exact spelling and limits decoded names to 63 bytes", () => {
    const names = createSqlStatementNames();
    declareResultColumn(names, "k_id", "id of alias k");
    declareResultColumn(names, "K_id", "id of alias K");
    declareResultColumn(names, "é".repeat(32), "a 64-byte key");
    expect(
      findSqlNameIssues(names, "decoded").map((issue) => issue.code),
    ).toEqual([SQL_IDENTIFIER_TOO_LONG_CODE]);
    expect(findSqlNameIssues(names, "embedded")).toEqual([]);
  });

  it("compares result columns without regard to case only when a wrapping statement reads them by name", () => {
    const names = createSqlStatementNames();
    declareResultColumn(names, "k_id", "id of alias k");
    declareResultColumn(names, "K_id", "id of alias K");
    expect(findSqlNameIssues(names, "decoded")).toEqual([]);
    expect(findSqlNameIssues(names, "embedded")).toEqual([]);
    expect(
      findSqlNameIssues(names, "wrapped").map((issue) => issue.code),
    ).toEqual([SQL_IDENTIFIER_COLLISION_CODE]);
  });

  it("refuses declared output keys that are equal without regard to letter case, naming both", () => {
    expect(() => {
      refuseCaseInsensitiveOutputKeys(["team", "total", "Total"], "aggregate");
    }).toThrow(
      'The aggregate() keys "total" and "Total" differ only by letter case',
    );
    expect(() => {
      refuseCaseInsensitiveOutputKeys(
        ["total", "totals", "`Total`"],
        "project",
      );
    }).not.toThrow();
  });

  it("refuses an unqualified read whose name two relations of its FROM declare", () => {
    const names = createSqlStatementNames();
    declareAliasColumn(names.relationColumns("cte_p"), "p", "id");
    declareAliasColumn(names.relationColumns("cte_q"), "p", "id");
    const read = {
      name: "p_id",
      qualified: false,
      scope: undefined,
    } as const;
    names.recordColumnReads([{ ...read, relations: ["cte_p"] }]);
    expect(findSqlNameIssues(names, "decoded")).toEqual([]);
    names.recordColumnReads([{ ...read, relations: ["cte_p", "cte_q"] }]);
    expect(
      findSqlNameIssues(names, "decoded").map((issue) => issue.code),
    ).toEqual([SQL_IDENTIFIER_COLLISION_CODE]);
  });
});

// ============================================================
// Identifier walk: every alias-derived name in emitted SQL is registered
// ============================================================

/**
 * Aliases start with `q` and one more letter so their derived names are easy to
 * find in SQL text: `cte_qa`, `qa_id`, `cte_qb_counts`, `qe_count`, and the
 * selectively extracted property columns `__tg_<len>:<alias>:<len>:<field>`.
 */
const ALIAS_DERIVED_NAME =
  /\b(?:cte_q[a-z]\w*|q[a-z]_\w+)\b|__tg_\d+:q[a-z]\w*:\d+:[^"\s]+/gu;

/** The selectively extracted property columns in SQL text. */
const SELECTIVE_PROPS_NAME = /__tg_\d+:q[a-z]\w*:\d+:[^"\s]+/gu;

/**
 * A column the statement names through one of its WITH relations:
 * `cte_qa.qa_id`, `cte_qb."__tg_2:qb:4:name"`, `cte_lm_topk.qa_kind`.
 */
const QUALIFIED_COLUMN =
  /\b(cte_q[a-z]\w*|cte_lm_topk)\.(?:"([^"]+)"|([A-Za-z_]\w*))/gu;

function selective(
  alias: string,
  fieldName: string,
  isSystemField: boolean,
): SelectiveField {
  return {
    alias,
    field: fieldName,
    outputName: `${alias}_${fieldName}`,
    isSystemField,
    ...(isSystemField ? {} : { valueType: "string" as const }),
  };
}

function traversal() {
  return builder()
    .from("Person", "qa")
    .traverse("knows", "qe")
    .to("Person", "qb");
}

const WALK_DOMAIN: readonly Readonly<{ label: string; ast: QueryAst }>[] = [
  {
    label: "a whole node",
    ast: builder()
      .from("Person", "qa")
      .select((ctx) => ctx.qa)
      .toAst(),
  },
  {
    label: "a traversal selecting whole rows",
    ast: traversal()
      .select((ctx) => ({ a: ctx.qa, e: ctx.qe, b: ctx.qb }))
      .toAst(),
  },
  {
    label: "a traversal selecting fields",
    ast: {
      ...traversal()
        .select((ctx) => ({ a: ctx.qa.id, b: ctx.qb.name }))
        .toAst(),
      selectiveFields: [
        selective("qa", "id", true),
        selective("qb", "name", false),
        selective("qe", "id", true),
      ],
    },
  },
  {
    label: "an optional two-hop traversal",
    ast: builder()
      .from("Person", "qa")
      .optionalTraverse("knows", "qe")
      .to("Person", "qb")
      .traverse("knows", "qf")
      .to("Person", "qc")
      .select((ctx) => ({ a: ctx.qa, c: ctx.qc }))
      .toAst(),
  },
  {
    label: "the count fast path",
    ast: traversal()
      .groupByNode("qa")
      .aggregate({ id: field("qa", "id"), friends: count("qb") })
      .toAst(),
  },
  {
    label: "a late-materialized page",
    ast: {
      ...builder()
        .from("Person", "qa")
        .orderBy("qa", "name")
        .limit(5)
        .select((ctx) => ({ id: ctx.qa.id, age: ctx.qa.age }))
        .toAst(),
      selectiveFields: [
        selective("qa", "id", true),
        selective("qa", "name", false),
        selective("qa", "age", false),
      ],
    },
  },
  {
    label: "a projection",
    ast: traversal()
      .project((ctx) => ({ friend: ctx.qb.name }))
      .toAst(),
  },
  {
    label: "a selective ordering",
    ast: {
      ...traversal()
        .orderBy("qb", "name")
        .select((ctx) => ({ a: ctx.qa.id, b: ctx.qb.name }))
        .toAst(),
      selectiveFields: [
        selective("qa", "id", true),
        selective("qb", "name", false),
      ],
    },
  },
  {
    label: "an aggregate ordered by an output key",
    ast: traversal()
      .groupBy("qa", "name")
      .aggregate({ name: field("qa", "name"), friends: count("qb") })
      .orderBy("friends", "desc")
      .toAst(),
  },
];

describe("identifier walk over the standard emitter", () => {
  for (const { label, ast } of WALK_DOMAIN) {
    for (const dialect of ["sqlite", "postgres"] as const) {
      it(`registers every alias-derived name it emits: ${label} / ${dialect}`, () => {
        const { compiled, names } = compileQueryWithSqlNames(
          ast,
          graph.id,
          dialect,
        );
        const statementNames = requireDefined(names);
        const registered = new Set(
          statementNames
            .scopes()
            .flatMap(({ scope }) => scope.entries().map((entry) => entry.name)),
        );
        const emitted = new Set(
          toSqlWithParams(compiled, dialect).sql.match(ALIAS_DERIVED_NAME),
        );
        expect(emitted.size).toBeGreaterThan(0);
        expect([...emitted].filter((name) => !registered.has(name))).toEqual(
          [],
        );
      });

      it(`declares each extracted property column in a CTE and records every by-name column reference in the relation it reads: ${label} / ${dialect}`, () => {
        const { compiled, names } = compileQueryWithSqlNames(
          ast,
          graph.id,
          dialect,
        );
        const statementNames = requireDefined(names);
        const text = toSqlWithParams(compiled, dialect).sql;
        const declaredInCtes = new Set(
          statementNames
            .scopes()
            .filter(({ comparison }) => comparison === "column")
            .flatMap(({ scope }) => scope.entries().map((entry) => entry.name)),
        );
        expect(
          [...new Set(text.match(SELECTIVE_PROPS_NAME))].filter(
            (name) => !declaredInCtes.has(name),
          ),
        ).toEqual([]);
        const unrecorded = [...text.matchAll(QUALIFIED_COLUMN)]
          .map((match) => ({
            relation: requireDefined(match[1]),
            column: requireDefined(match[2] ?? match[3]),
          }))
          .filter(({ relation, column }) => {
            const scope = statementNames.relationColumns(relation);
            return (
              !scope.entries().some((entry) => entry.name === column) ||
              !scope.isReferenced(column)
            );
          });
        expect(unrecorded).toEqual([]);
      });
    }
  }

  it("reaches the same verdict on both dialects", () => {
    const colliding = builder()
      .from("Person", "item")
      .traverse("knows", "e")
      .to("Person", "Item")
      .select((ctx) => ({ a: ctx.item, b: ctx.Item }))
      .toAst();
    const verdicts = (["sqlite", "postgres"] as const).map((dialect) =>
      findSqlNameIssues(
        requireDefined(
          compileQueryWithSqlNames(colliding, graph.id, dialect).names,
        ),
        "decoded",
      ),
    );
    expect(verdicts[0]).toEqual(verdicts[1]);
    expect(verdicts[0]?.length).toBeGreaterThan(0);
  });
});
