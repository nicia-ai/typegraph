/**
 * Aggregate and HAVING Helper Functions
 *
 * Provides factory functions for creating aggregate expressions (COUNT, SUM, etc.)
 * and HAVING clause predicates for use in GROUP BY queries.
 */
import {
  type AggregateComparisonPredicate,
  type AggregateExpr,
  type ComparisonOp,
  type FieldRef,
} from "../ast";
import { jsonPointer } from "../json-pointer";

// ============================================================
// Aggregate Helpers
// ============================================================

/**
 * Creates a COUNT aggregate expression.
 *
 * @param alias - The node alias to count
 * @param field - Optional field to count (defaults to counting nodes by ID)
 *
 * @example
 * ```typescript
 * // COUNT all persons
 * count("p")
 *
 * // COUNT persons with email field
 * count("p", "email")
 * ```
 */
export function count(alias: string, field?: string): AggregateExpr {
  return {
    __type: "aggregate",
    function: "count",
    field: {
      __type: "field_ref",
      alias,
      path: field ? ["props"] : ["id"],
      jsonPointer: field ? jsonPointer([field]) : undefined,
      valueType: field ? undefined : "string",
    },
  };
}

/**
 * Creates a COUNT DISTINCT aggregate expression.
 *
 * @param alias - The node alias to count
 * @param field - Optional field to count distinct values of
 */
export function countDistinct(alias: string, field?: string): AggregateExpr {
  return {
    __type: "aggregate",
    function: "countDistinct",
    field: {
      __type: "field_ref",
      alias,
      path: field ? ["props"] : ["id"],
      jsonPointer: field ? jsonPointer([field]) : undefined,
      valueType: field ? undefined : "string",
    },
  };
}

/**
 * Creates a SUM aggregate expression.
 *
 * @param alias - The node alias
 * @param field - The numeric field to sum
 */
export function sum(alias: string, field: string): AggregateExpr {
  return {
    __type: "aggregate",
    function: "sum",
    field: {
      __type: "field_ref",
      alias,
      path: ["props"],
      jsonPointer: jsonPointer([field]),
      valueType: "number",
    },
  };
}

/**
 * Creates an AVG aggregate expression.
 *
 * @param alias - The node alias
 * @param field - The numeric field to average
 */
export function avg(alias: string, field: string): AggregateExpr {
  return {
    __type: "aggregate",
    function: "avg",
    field: {
      __type: "field_ref",
      alias,
      path: ["props"],
      jsonPointer: jsonPointer([field]),
      valueType: "number",
    },
  };
}

/**
 * Creates a MIN aggregate expression.
 *
 * @param alias - The node alias
 * @param field - The field to find minimum of
 */
export function min(alias: string, field: string): AggregateExpr {
  return {
    __type: "aggregate",
    function: "min",
    field: {
      __type: "field_ref",
      alias,
      path: ["props"],
      jsonPointer: jsonPointer([field]),
      valueType: "number",
    },
  };
}

/**
 * Creates a MAX aggregate expression.
 *
 * @param alias - The node alias
 * @param field - The field to find maximum of
 */
export function max(alias: string, field: string): AggregateExpr {
  return {
    __type: "aggregate",
    function: "max",
    field: {
      __type: "field_ref",
      alias,
      path: ["props"],
      jsonPointer: jsonPointer([field]),
      valueType: "number",
    },
  };
}

/**
 * Creates a field reference for use in aggregate.
 *
 * @param alias - The node alias
 * @param path - Path to the field. Use "id" for node ID, "kind" for node kind,
 *               or the property name directly (e.g., "title", "year").
 *
 * @example
 * ```typescript
 * field("p", "id")      // Node ID
 * field("p", "kind")    // Node kind
 * field("p", "title")   // Property field
 * field("p", "nested", "field")  // Nested property
 * ```
 */
export function field(alias: string, ...path: string[]): FieldRef {
  if (path.length === 0 || path[0] === "id") {
    return {
      __type: "field_ref",
      alias,
      path: ["id"],
      valueType: "string",
    };
  }
  if (path[0] === "kind") {
    return {
      __type: "field_ref",
      alias,
      path: ["kind"],
      valueType: "string",
    };
  }
  if (path[0] === "props") {
    throw new Error(
      `field(): Do not include "props" in the path. Use field("${alias}", ${path
        .slice(1)
        .map((p) => `"${p}"`)
        .join(", ")}) instead.`,
    );
  }
  return {
    __type: "field_ref",
    alias,
    path: ["props"],
    jsonPointer: jsonPointer(path),
  };
}

// ============================================================
// HAVING Helpers
// ============================================================

/**
 * Creates a HAVING predicate that compares an aggregate to a value.
 *
 * @param aggregate - The aggregate expression (count, sum, avg, etc.)
 * @param op - The comparison operator
 * @param value - The value to compare against
 *
 * @example
 * ```typescript
 * // HAVING COUNT(*) > 10
 * having(count("p"), "gt", 10)
 *
 * // HAVING AVG(salary) >= 50000
 * having(avg("p", "salary"), "gte", 50000)
 * ```
 */
export function having(
  aggregate: AggregateExpr,
  op: ComparisonOp,
  value: number | string | boolean,
): AggregateComparisonPredicate {
  return {
    __type: "aggregate_comparison",
    op,
    aggregate,
    value: {
      __type: "literal",
      value,
      valueType: typeof value === "number" ? "number" : "string",
    },
  };
}

/**
 * Creates a HAVING predicate: aggregate > value
 */
export function havingGt(
  aggregate: AggregateExpr,
  value: number,
): AggregateComparisonPredicate {
  return having(aggregate, "gt", value);
}

/**
 * Creates a HAVING predicate: aggregate >= value
 */
export function havingGte(
  aggregate: AggregateExpr,
  value: number,
): AggregateComparisonPredicate {
  return having(aggregate, "gte", value);
}

/**
 * Creates a HAVING predicate: aggregate < value
 */
export function havingLt(
  aggregate: AggregateExpr,
  value: number,
): AggregateComparisonPredicate {
  return having(aggregate, "lt", value);
}

/**
 * Creates a HAVING predicate: aggregate <= value
 */
export function havingLte(
  aggregate: AggregateExpr,
  value: number,
): AggregateComparisonPredicate {
  return having(aggregate, "lte", value);
}

/**
 * Creates a HAVING predicate: aggregate = value
 */
export function havingEq(
  aggregate: AggregateExpr,
  value: number,
): AggregateComparisonPredicate {
  return having(aggregate, "eq", value);
}
