import type { DialectAdapter } from "../../query/dialect/types";
import { type JsonPointer, jsonPointer } from "../../query/json-pointer";
import { sql, type SqlFragment } from "../../query/sql-fragment";

/**
 * Where a weighted algorithm reads one edge's weight: the JSON value stored
 * under the top-level `weightProperty` key of the edge alias `e`, addressed
 * at that value's own root. Pass both to any JSON member of the dialect.
 */
export type EdgeWeightOperand = Readonly<{
  value: SqlFragment;
  pointer: JsonPointer;
}>;

const JSON_VALUE_ROOT = jsonPointer([]);

/**
 * The one owner of the weight lookup, shared by the weight audit and the
 * edge expansion so the two can never read different values. The property is
 * looked up as an object key, not as a JSON path: a path would read the name
 * `0` as an array index on SQLite and reject the name `-` outright.
 */
export function compileEdgeWeightOperand(
  dialect: DialectAdapter,
  weightProperty: string,
): EdgeWeightOperand {
  return {
    value: dialect.jsonObjectMember(sql.raw("e.props"), weightProperty),
    pointer: JSON_VALUE_ROOT,
  };
}
