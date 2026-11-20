/**
 * Contextual Validation Utilities
 *
 * Provides Zod validation wrappers that include full context about
 * which entity (node/edge) and operation (create/update) failed.
 *
 * @example
 * ```typescript
 * const props = validateNodeProps(schema, input, {
 *   kind: "Person",
 *   operation: "create",
 * });
 * ```
 */

import { type ZodError, type ZodType } from "zod";

import type { KindEntity } from "../core/types";
import { ValidationError, type ValidationIssue } from "./index";

// ============================================================
// Types
// ============================================================

/**
 * Context for validation operations.
 */
export type ValidationContext = Readonly<{
  /** Type of entity being validated */
  entityType: KindEntity;
  /** Kind/type name of the entity */
  kind: string;
  /** Operation being performed */
  operation: "create" | "update";
  /** Entity ID (for updates) */
  id?: string;
}>;

// ============================================================
// Validation Functions
// ============================================================

/**
 * The code an option object's unrecognized key is reported under — Zod's
 * own code for the same fault, so a caller routing on `issue.code` reads one
 * spelling whether the refusal came from a schema or an option surface.
 */
const UNRECOGNIZED_OPTION_KEY_CODE = "unrecognized_keys";

/**
 * THE issue list for an option object's keys that `acceptedKeys` does not
 * name, one issue per key at `${path}.${key}`. Every option surface that
 * refuses rather than ignores an unknown key (a composition attachment, a
 * `reparent`, `parts()` / `wholes()`, `subgraph({ composition })`) builds its
 * `ValidationError` from this, so a typo is reported the same way on each.
 */
export function unrecognizedOptionKeyIssues(
  value: Readonly<Record<string, unknown>>,
  path: string,
  acceptedKeys: readonly string[],
): readonly ValidationIssue[] {
  return Object.keys(value)
    .filter((key) => !acceptedKeys.includes(key))
    .map((key) => ({
      path: `${path}.${key}`,
      message: `Unknown key. Accepted keys: ${acceptedKeys.join(", ")}.`,
      code: UNRECOGNIZED_OPTION_KEY_CODE,
    }));
}

/**
 * Converts Zod issues to ValidationIssue format.
 */
export function zodIssuesToValidationIssues(
  error: ZodError,
): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Builds a descriptive location string for error messages.
 */
function buildLocationString(context: ValidationContext): string {
  if (context.id) {
    return `${context.kind}/${context.id}`;
  }
  return `new ${context.kind}`;
}

/**
 * Validates props with full context for error messages.
 *
 * @param schema - Zod schema to validate against
 * @param props - Properties to validate
 * @param context - Context about the entity and operation
 * @returns Validated and transformed props
 * @throws ValidationError with full context if validation fails
 *
 * @example
 * ```typescript
 * const validatedProps = validateProps(personSchema, input, {
 *   entityType: "node",
 *   kind: "Person",
 *   operation: "create",
 * });
 * ```
 */
export function validateProps<T>(
  schema: ZodType<T>,
  props: unknown,
  context: ValidationContext,
): T {
  const result = schema.safeParse(props);

  if (result.success) {
    return result.data;
  }

  const issues = zodIssuesToValidationIssues(result.error);
  const location = buildLocationString(context);

  throw new ValidationError(
    `Invalid ${context.entityType} props for ${location}: ${result.error.message}`,
    {
      entityType: context.entityType,
      kind: context.kind,
      operation: context.operation,
      ...(context.id !== undefined && { id: context.id }),
      issues,
    },
    { cause: result.error },
  );
}

/**
 * Validates node props with full context.
 *
 * Convenience wrapper around validateProps for node operations.
 *
 * @example
 * ```typescript
 * const props = validateNodeProps(schema, input, {
 *   kind: "Person",
 *   operation: "create",
 * });
 * ```
 */
export function validateNodeProps<T>(
  schema: ZodType<T>,
  props: unknown,
  context: Readonly<{
    kind: string;
    operation: "create" | "update";
    id?: string;
  }>,
): T {
  return validateProps(schema, props, {
    entityType: "node",
    ...context,
  });
}

/**
 * Validates edge props with full context.
 *
 * Convenience wrapper around validateProps for edge operations.
 *
 * @example
 * ```typescript
 * const props = validateEdgeProps(schema, input, {
 *   kind: "worksAt",
 *   operation: "create",
 * });
 * ```
 */
export function validateEdgeProps<T>(
  schema: ZodType<T>,
  props: unknown,
  context: Readonly<{
    kind: string;
    operation: "create" | "update";
    id?: string;
  }>,
): T {
  return validateProps(schema, props, {
    entityType: "edge",
    ...context,
  });
}

/**
 * Wraps a Zod error with TypeGraph context.
 *
 * Use this when you've already caught a ZodError and want to
 * convert it to a ValidationError with context.
 *
 * @example
 * ```typescript
 * try {
 *   schema.parse(input);
 * } catch (error) {
 *   if (error instanceof ZodError) {
 *     throw wrapZodError(error, {
 *       entityType: "node",
 *       kind: "Person",
 *       operation: "create",
 *     });
 *   }
 *   throw error;
 * }
 * ```
 */
export function wrapZodError(
  error: ZodError,
  context: ValidationContext,
): ValidationError {
  const issues = zodIssuesToValidationIssues(error);
  const location = buildLocationString(context);

  return new ValidationError(
    `Validation failed for ${context.entityType} ${location}: ${error.message}`,
    {
      entityType: context.entityType,
      kind: context.kind,
      operation: context.operation,
      ...(context.id !== undefined && { id: context.id }),
      issues,
    },
    { cause: error },
  );
}

/**
 * Creates a simple ValidationError without Zod context.
 *
 * Use this for custom validation rules that aren't part of a Zod schema.
 *
 * @example
 * ```typescript
 * if (startDate > endDate) {
 *   throw createValidationError(
 *     "Start date must be before end date",
 *     [{ path: "startDate", message: "Must be before endDate" }],
 *     { entityType: "edge", kind: "employment", operation: "create" }
 *   );
 * }
 * ```
 */
export function createValidationError(
  message: string,
  issues: ValidationIssue[],
  context?: Partial<ValidationContext>,
): ValidationError {
  return new ValidationError(message, {
    ...(context?.entityType !== undefined && {
      entityType: context.entityType,
    }),
    ...(context?.kind !== undefined && { kind: context.kind }),
    ...(context?.operation !== undefined && { operation: context.operation }),
    ...(context?.id !== undefined && { id: context.id }),
    issues,
  });
}
