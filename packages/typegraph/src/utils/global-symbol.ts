type TypeGraphGlobalSymbolName =
  | "sql-fragment"
  | "sql-placeholder"
  | "sql-intent-registry"
  | "internal-temporary-writes-v1"
  | "external-recorded-read-source-v1"
  | "sql-schema-v1"
  | "store-runtime-v1"
  | "typegraph-recorded-read-source-v1"
  | "transaction-runtime-v1";

/** Returns a process-wide symbol shared across ESM/CJS package instances. */
export function typeGraphGlobalSymbol<TSymbol extends symbol>(
  name: TypeGraphGlobalSymbolName,
): TSymbol {
  return Symbol.for(`@nicia-ai/typegraph/${name}`) as TSymbol;
}
