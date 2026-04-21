/**
 * Shared `CompileQueryOptions` construction for the executable query,
 * aggregate query, and unionable query builders. Keeps one source of
 * truth for which config fields are propagated to the compiler.
 */
import { type CompileQueryOptions } from "../compiler/index";
import { type QueryBuilderConfig } from "./types";

export function buildCompileOptions(
  config: QueryBuilderConfig,
): CompileQueryOptions {
  const fulltextStrategy = config.backend?.fulltextStrategy;
  return {
    dialect: config.dialect ?? "sqlite",
    schema: config.schema,
    ...(fulltextStrategy === undefined ? {} : { fulltextStrategy }),
  };
}
