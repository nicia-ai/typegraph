/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/errors` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  ConfigurationError,
  getErrorSuggestion,
  isTypeGraphError,
  MigrationError,
  NodeNotFoundError,
  UniquenessError,
  ValidationError,
} from "@nicia-ai/typegraph/errors";

export const invalid = new ValidationError("Invalid input", {
  issues: [],
  kind: "Person",
  operation: "create",
});
export const notFound = (
  ...args: ConstructorParameters<typeof NodeNotFoundError>
) => new NodeNotFoundError(...args);
export const duplicate = (
  ...args: ConstructorParameters<typeof UniquenessError>
) => new UniquenessError(...args);
export const misconfigured = new ConfigurationError("Missing backend");
export const suggestion = getErrorSuggestion;
export const classify = (error: unknown) =>
  isTypeGraphError(error) ? error : undefined;

// Needs a load: `ConstraintFenceViolation` is exported by `/store`, not by
// `/errors`, so this inferred return type is nameable only through the root
// the entrypoint loads (which loads `/store`).
export const refusedRows = (error: MigrationError) =>
  "violations" in error.details ? error.details.violations : [];
