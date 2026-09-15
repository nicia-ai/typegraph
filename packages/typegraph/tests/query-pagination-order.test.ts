import { describe, expect, it } from "vitest";

import type {
  FieldRef,
  LiteralValue,
  OrderSpec,
  PredicateExpression,
} from "../src/query/ast";
import type { CursorData } from "../src/query/cursor";
import {
  adjustOrderByForDirection,
  buildCursorPredicate,
} from "../src/query/execution/pagination";
import { resolveNullOrdering } from "../src/query/order";

type Row = Readonly<{
  id: string;
  score?: number | undefined;
}>;

type OrderCase = Readonly<{
  name: string;
  direction: "asc" | "desc";
  nulls: "first" | "last";
}>;

const SCORE_FIELD: FieldRef = {
  __type: "field_ref",
  alias: "item",
  path: ["props", "score"],
};
const ID_FIELD: FieldRef = {
  __type: "field_ref",
  alias: "item",
  path: ["id"],
};
const ROWS: readonly Row[] = [
  { id: "a", score: 1 },
  { id: "b" },
  { id: "c", score: 1 },
  { id: "d", score: 2 },
  { id: "e" },
];
const ORDER_CASES: readonly OrderCase[] = [
  { name: "ascending, nulls first", direction: "asc", nulls: "first" },
  { name: "ascending, nulls last", direction: "asc", nulls: "last" },
  { name: "descending, nulls first", direction: "desc", nulls: "first" },
  { name: "descending, nulls last", direction: "desc", nulls: "last" },
];

function fieldValue(row: Row, field: FieldRef): number | string | undefined {
  return field.path.at(-1) === "id" ? row.id : row.score;
}

function isLiteralValue(value: unknown): value is LiteralValue {
  return (
    typeof value === "object" &&
    value !== null &&
    "__type" in value &&
    value.__type === "literal"
  );
}

function evaluatePredicate(expression: PredicateExpression, row: Row): boolean {
  // Cursor predicates only use the expression variants handled below.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (expression.__type) {
    case "and": {
      return expression.predicates.every((predicate) =>
        evaluatePredicate(predicate, row),
      );
    }
    case "or": {
      return expression.predicates.some((predicate) =>
        evaluatePredicate(predicate, row),
      );
    }
    case "comparison": {
      if (!isLiteralValue(expression.right))
        throw new Error("Expected a cursor literal");
      const left = fieldValue(row, expression.left);
      if (left === undefined) return false;
      // Cursor comparisons only emit equality and strict ordering operators.
      // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
      switch (expression.op) {
        case "eq": {
          return left === expression.right.value;
        }
        case "gt": {
          return left > expression.right.value;
        }
        case "lt": {
          return left < expression.right.value;
        }
        default: {
          throw new Error(`Unexpected cursor comparison: ${expression.op}`);
        }
      }
    }
    case "null_check": {
      const isMissing = fieldValue(row, expression.field) === undefined;
      return expression.op === "isNull" ? isMissing : !isMissing;
    }
    default: {
      throw new Error(`Unexpected cursor predicate: ${expression.__type}`);
    }
  }
}

function compareNullableScores(
  left: Row,
  right: Row,
  orderCase: OrderCase,
  idDirection: "asc" | "desc" = "asc",
): number {
  const leftMissing = left.score === undefined;
  const rightMissing = right.score === undefined;
  if (leftMissing !== rightMissing)
    return leftMissing === (orderCase.nulls === "first") ? -1 : 1;
  if (!leftMissing && !rightMissing && left.score !== right.score) {
    const comparison = left.score < right.score ? -1 : 1;
    return orderCase.direction === "asc" ? comparison : -comparison;
  }
  const idComparison = left.id.localeCompare(right.id);
  return idDirection === "asc" ? idComparison : -idComparison;
}

function orderSpecs(orderCase: OrderCase): readonly OrderSpec[] {
  return [
    {
      field: SCORE_FIELD,
      direction: orderCase.direction,
      nulls: orderCase.nulls,
    },
    { field: ID_FIELD, direction: "asc" },
  ];
}

function cursorFor(row: Row): CursorData {
  return {
    v: 1,
    d: "f",
    // eslint-disable-next-line unicorn/no-null -- JSON cursor encoding represents missing values as null.
    vals: [row.score ?? null, row.id],
    cols: ["item.props.score", "item.id"],
  };
}

describe("pagination ordering", () => {
  it("owns the default and explicit null placement", () => {
    expect(resolveNullOrdering({ direction: "asc" })).toBe("last");
    expect(resolveNullOrdering({ direction: "desc" })).toBe("first");
    expect(resolveNullOrdering({ direction: "asc", nulls: "first" })).toBe(
      "first",
    );
    expect(resolveNullOrdering({ direction: "desc", nulls: "last" })).toBe(
      "last",
    );
  });

  for (const orderCase of ORDER_CASES) {
    it(`selects the correct rows around every ${orderCase.name} cursor`, () => {
      const specs = orderSpecs(orderCase);
      const sorted = ROWS.toSorted((left, right) =>
        compareNullableScores(left, right, orderCase),
      );

      for (const [cursorIndex, cursorRow] of sorted.entries()) {
        for (const direction of ["forward", "backward"] as const) {
          const predicate = buildCursorPredicate(
            cursorFor(cursorRow),
            specs,
            direction,
            "item",
          );
          const selected = sorted
            .filter((row) => evaluatePredicate(predicate.expression, row))
            .map((row) => row.id);
          const expected =
            direction === "forward" ?
              sorted.slice(cursorIndex + 1)
            : sorted.slice(0, cursorIndex);

          expect(selected).toEqual(expected.map((row) => row.id));
        }
      }
    });

    it(`reverses the complete ${orderCase.name} ordering`, () => {
      const adjusted = adjustOrderByForDirection(
        orderSpecs(orderCase),
        "backward",
      );
      const adjustedScore = adjusted[0];
      const adjustedId = adjusted[1];
      expect(adjustedScore).toBeDefined();
      expect(adjustedId).toBeDefined();
      if (adjustedScore === undefined || adjustedId === undefined) return;
      const reversedCase: OrderCase = {
        name: "reversed",
        direction: adjustedScore.direction,
        nulls: resolveNullOrdering(adjustedScore),
      };
      const actual = ROWS.toSorted((left, right) =>
        compareNullableScores(left, right, reversedCase, adjustedId.direction),
      ).map((row) => row.id);
      const expected = ROWS.toSorted((left, right) =>
        compareNullableScores(left, right, orderCase),
      )
        .toReversed()
        .map((row) => row.id);

      expect(actual).toEqual(expected);
    });
  }
});
