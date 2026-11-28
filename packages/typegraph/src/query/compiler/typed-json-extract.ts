import { type SelectiveField } from "../ast";
import { getDialect } from "../dialect";
import { type DialectAdapter, type SqlDialect } from "../dialect/types";
import { type ExpressionDateRead } from "../expression-date-read";
import { type DateOrigin } from "../expressions";
import { type JsonPointer, jsonPointer } from "../json-pointer";
import { type SqlFragment } from "../sql-fragment";

type JsonExtractFallback = "json" | "text";

type TypedJsonExtractInput = Readonly<{
  column: SqlFragment;
  dialect: DialectAdapter;
  fallback?: JsonExtractFallback;
  pointer: JsonPointer;
  valueType: string | undefined;
}>;

export function compileTypedJsonExtract(
  input: TypedJsonExtractInput,
): SqlFragment {
  const { column, dialect, pointer, valueType } = input;
  const fallback = input.fallback ?? "json";

  switch (valueType) {
    case "string": {
      return dialect.jsonExtractText(column, pointer);
    }
    case "number": {
      return dialect.jsonExtractNumber(column, pointer);
    }
    case "boolean": {
      return dialect.jsonExtractBoolean(column, pointer);
    }
    case "date": {
      return dialect.jsonExtractDate(column, pointer);
    }
    case "array":
    case "object":
    case "embedding":
    case "unknown":
    case undefined: {
      return fallback === "text" ?
          dialect.jsonExtractText(column, pointer)
        : dialect.jsonExtract(column, pointer);
    }
    default: {
      return fallback === "text" ?
          dialect.jsonExtractText(column, pointer)
        : dialect.jsonExtract(column, pointer);
    }
  }
}

/**
 * Extracts a single top-level selective-projection field from a JSON props
 * column, typed by the field's declared value type.
 *
 * Shared by both projection shapes: the standard emitter pushes this extraction
 * into a CTE synthetic column, while the recursive emitter applies it in the
 * outer SELECT over the props carried through the recursive CTE. The two SQL
 * shapes differ by design, but they must extract identically — centralizing the
 * pointer/valueType wiring here keeps their extraction semantics from drifting.
 */
export function compileSelectivePropsExtraction(
  field: SelectiveField,
  column: SqlFragment,
  dialect: DialectAdapter,
): SqlFragment {
  return compileTypedJsonExtract({
    column,
    dialect,
    pointer: jsonPointer([field.field]),
    valueType: field.valueType,
  });
}

/**
 * The origin of a top-level scalar date column the compiler emits for
 * `dialect`, given the origin of the expression it compiles: a date the caller
 * stated stays `"stated"`; any other date is read from stored props by
 * {@link DialectAdapter.jsonExtractDate}, so it carries what that extraction
 * yields (`DialectAdapter.jsonExtractDateOrigin`) — `"engine"` where it casts
 * to the engine's timestamp type, through a composition, aggregate, derived
 * relation or subquery alike, and `undefined` (stored text) where it does not.
 * The one place a result column's date origin is decided; every terminal
 * decodes the column with what this returns (`decodeExpressionDate`). A date
 * the compiler collects into JSON (an `expr.collect` element or record field)
 * or a nested date position is JSON text, not a result column, and is not
 * typed here.
 */
export function resultDateOrigin(
  expressionOrigin: ExpressionDateRead["dateOrigin"],
  dialect: SqlDialect,
): DateOrigin | undefined {
  return expressionOrigin ?? getDialect(dialect).jsonExtractDateOrigin;
}
