import { expectTypeOf, test } from "vitest";

import type { FieldRef } from "../src/query/ast";
import {
  createFieldExpression,
  type DatabaseExpression,
  expr,
} from "../src/query/expressions";

const scopeIdentity = Symbol("type test");
const numberField = createFieldExpression<number, "person">(
  {
    __type: "field_ref",
    alias: "person",
    path: ["props", "age"],
    valueType: "number",
  } satisfies FieldRef<number>,
  scopeIdentity,
  false,
);
const nullableStringField = createFieldExpression<string | undefined, "person">(
  {
    __type: "field_ref",
    alias: "person",
    path: ["props", "name"],
    valueType: "string",
  } satisfies FieldRef<string | undefined>,
  scopeIdentity,
  true,
);

test("expression result types include SQL null where applicable", () => {
  expectTypeOf(expr.add(numberField, expr.literal(2))).toEqualTypeOf<
    DatabaseExpression<number, "person">
  >();
  // eslint-disable-next-line unicorn/no-null -- JSON null decodes as SQL undefined.
  expectTypeOf(expr.literal(null)).toEqualTypeOf<
    DatabaseExpression<undefined, never>
  >();
  expectTypeOf(expr.count(numberField)).toEqualTypeOf<
    DatabaseExpression<number, "person">
  >();
  expectTypeOf(expr.divide(numberField, expr.literal(2))).toEqualTypeOf<
    DatabaseExpression<number | undefined, "person">
  >();
  expectTypeOf(expr.eq(nullableStringField, expr.literal("Ada"))).toEqualTypeOf<
    DatabaseExpression<boolean | undefined, "person">
  >();
  expectTypeOf(expr.eq(numberField, expr.literal(2))).toEqualTypeOf<
    DatabaseExpression<boolean, "person">
  >();
  expectTypeOf(
    expr.coalesce(nullableStringField, expr.literal("unknown")),
  ).toEqualTypeOf<DatabaseExpression<string, "person">>();
});

function invalidOperands(): void {
  // @ts-expect-error arithmetic accepts numeric expressions only
  expr.add(nullableStringField, nullableStringField);
  // @ts-expect-error comparisons require compatible value types
  expr.eq(numberField, expr.literal("old"));
  // @ts-expect-error numeric conversion accepts only strings and numbers
  expr.toNumber(expr.literal(true));
  // @ts-expect-error Boolean composition accepts Boolean expressions only
  expr.and(numberField);
  // @ts-expect-error Boolean values cannot be ordered with MIN
  expr.min(expr.literal(true));
  // @ts-expect-error COUNT DISTINCT rejects structured values
  expr.countDistinct(expr.literal({ key: "value" }));
}

test("invalid expression operands fail type checking", () => {
  expectTypeOf(invalidOperands).toEqualTypeOf<() => void>();
});
