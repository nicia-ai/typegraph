import { describe, expect, it } from "vitest";

import type { FieldRef, OrderSpec } from "../src/query/ast";
import { compileDatabaseExpression } from "../src/query/compiler/database-expressions";
import {
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "../src/query/compiler/predicates";
import { DEFAULT_SQL_SCHEMA } from "../src/query/compiler/schema";
import { postgresDialect } from "../src/query/dialect/postgres";
import { sqliteDialect } from "../src/query/dialect/sqlite";
import { createFieldExpression, expr } from "../src/query/expressions";
import { resolveSystemOrderField } from "../src/query/builder/order-by-field";
import { type CursorData } from "../src/query/cursor";
import { buildCursorPredicate } from "../src/query/execution/pagination";
import { sql } from "../src/query/sql-fragment";
import { toSqlString, toSqlWithParams } from "./sql-test-utils";

const SCOPE = Symbol("array and cursor expression test");
const ARRAY_FIELD = {
  __type: "field_ref",
  alias: "document",
  elementType: "string",
  path: ["props"],
  valueType: "array",
} satisfies FieldRef<readonly string[] | undefined>;
const CANDIDATE_FIELD = {
  __type: "field_ref",
  alias: "candidate",
  path: ["props"],
  valueType: "string",
} satisfies FieldRef<string>;
const ID_FIELD = {
  __type: "field_ref",
  alias: "item",
  nullable: false,
  path: ["id"],
  valueType: "string",
} satisfies FieldRef<string>;
const KIND_FIELD = {
  __type: "field_ref",
  alias: "item",
  nullable: false,
  path: ["kind"],
  valueType: "string",
} satisfies FieldRef<string>;
const CURSOR: CursorData = {
  cols: ["item.id", "item.kind"],
  d: "f",
  v: 1,
  vals: ["item-2", "Record"],
};

function context(
  dialect: PredicateCompilerContext["dialect"],
): PredicateCompilerContext {
  return {
    compileQuery: () => sql`SELECT 1`,
    dialect,
    orderedAggregates: true,
    schema: DEFAULT_SQL_SCHEMA,
    windowFunctions: true,
  };
}

function orderedFields(
  options: Readonly<{
    direction?: "asc" | "desc";
    nulls?: "first" | "last";
  }> = {},
): readonly OrderSpec[] {
  return [
    {
      direction: options.direction ?? "asc",
      field: ID_FIELD,
      ...(options.nulls === undefined ? {} : { nulls: options.nulls }),
    },
    {
      direction: options.direction ?? "asc",
      field: KIND_FIELD,
      ...(options.nulls === undefined ? {} : { nulls: options.nulls }),
    },
  ];
}

describe("expression array membership", () => {
  it("compiles candidate expressions through each dialect seam", () => {
    const expression = expr.arrayContains(
      createFieldExpression(ARRAY_FIELD, SCOPE, true),
      createFieldExpression(CANDIDATE_FIELD, SCOPE, false),
    );
    const sqlite = toSqlString(
      compileDatabaseExpression(expression, { dialect: sqliteDialect }),
    );
    const postgres = toSqlString(
      compileDatabaseExpression(expression, { dialect: postgresDialect }),
      "postgres",
    );

    expect(sqlite).toContain("json_each(document_props)");
    expect(sqlite).toContain("candidate_props");
    expect(postgres).toContain("jsonb_array_elements(document_props)");
    expect(postgres).toContain("to_jsonb(CAST(candidate_props AS text))");
  });
});

describe("cursor tuple comparisons", () => {
  it("uses a native tuple comparison with cursor values in key order", () => {
    const predicate = buildCursorPredicate(
      CURSOR,
      orderedFields(),
      "forward",
      "item",
    );
    expect(predicate.expression.__type).toBe("tuple_comparison");

    const compiled = compilePredicateExpression(
      predicate.expression,
      context(sqliteDialect),
    );
    expect(toSqlWithParams(compiled)).toEqual({
      params: ["item-2", "Record"],
      sql: "(item_id, item_kind) > (?, ?)",
    });
  });

  it("keeps the OR ladder for explicit null ordering, nullable keys, and mixed directions", () => {
    const explicitNulls = buildCursorPredicate(
      CURSOR,
      orderedFields({ nulls: "last" }),
      "forward",
      "item",
    );
    const mixedDirections = buildCursorPredicate(
      CURSOR,
      [
        { direction: "asc", field: ID_FIELD },
        { direction: "desc", field: KIND_FIELD },
      ],
      "forward",
      "item",
    );
    const nullableKey = buildCursorPredicate(
      CURSOR,
      [
        { direction: "asc", field: { ...ID_FIELD, nullable: true } },
        { direction: "asc", field: KIND_FIELD },
      ],
      "forward",
      "item",
    );

    expect(explicitNulls.expression.__type).toBe("or");
    expect(mixedDirections.expression.__type).toBe("or");
    expect(nullableKey.expression.__type).toBe("or");
    expect(
      toSqlString(
        compilePredicateExpression(
          explicitNulls.expression,
          context(sqliteDialect),
        ),
      ),
    ).toContain(" OR ");
  });

  it("keeps nullable temporal system columns out of native tuple comparisons", () => {
    for (const fieldName of ["valid_from", "valid_to", "deleted_at"] as const) {
      const temporalEndField = resolveSystemOrderField(
        "item",
        fieldName,
        false,
        false,
      );
      expect(temporalEndField?.nullable).toBe(true);
      if (temporalEndField === undefined)
        throw new Error(
          `Expected ${fieldName} to be an orderable system field`,
        );
      const predicate = buildCursorPredicate(
        CURSOR,
        [
          { direction: "asc", field: temporalEndField },
          { direction: "asc", field: ID_FIELD },
        ],
        "forward",
        "item",
      );
      expect(predicate.expression.__type).toBe("or");
    }
  });
});
