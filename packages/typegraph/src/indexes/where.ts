import { type IndexWhereExpression } from "./types";

export function andWhere(
  ...predicates: [IndexWhereExpression, ...IndexWhereExpression[]]
): IndexWhereExpression {
  if (predicates.length === 1) {
    return predicates[0];
  }

  return {
    __type: "index_where_and",
    predicates,
  };
}

export function orWhere(
  ...predicates: [IndexWhereExpression, ...IndexWhereExpression[]]
): IndexWhereExpression {
  if (predicates.length === 1) {
    return predicates[0];
  }

  return {
    __type: "index_where_or",
    predicates,
  };
}

export function notWhere(
  predicate: IndexWhereExpression,
): IndexWhereExpression {
  return {
    __type: "index_where_not",
    predicate,
  };
}
