import { type SelectiveField } from "../ast";
import { type DialectAdapter } from "../dialect/types";
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
