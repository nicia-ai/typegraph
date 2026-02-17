import { type SQL } from "drizzle-orm";

import { type DialectAdapter } from "../dialect";
import { type JsonPointer } from "../json-pointer";

type JsonExtractFallback = "json" | "text";

type TypedJsonExtractInput = Readonly<{
  column: SQL;
  dialect: DialectAdapter;
  fallback?: JsonExtractFallback;
  pointer: JsonPointer;
  valueType: string | undefined;
}>;

export function compileTypedJsonExtract(input: TypedJsonExtractInput): SQL {
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
