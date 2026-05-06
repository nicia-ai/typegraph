/**
 * TypeGraph Error Hierarchy
 *
 * All errors extend TypeGraphError with:
 * - `code`: Machine-readable error code for programmatic handling
 * - `category`: Classification for error handling strategies
 * - `suggestion`: Optional recovery guidance for users
 * - `details`: Structured context about the error
 *
 * @example
 * ```typescript
 * try {
 *   await store.nodes.Person.create({ name: "" });
 * } catch (error) {
 *   if (isTypeGraphError(error)) {
 *     console.error(error.toUserMessage());
 *     if (isUserRecoverable(error)) {
 *       // Show to user for correction
 *     }
 *   }
 * }
 * ```
 */

// Type-only import: `materialize-indexes.ts` value-imports
// `ConfigurationError` from this file, but type-only imports are erased
// at runtime so this back-edge does not create a value cycle.
import type { MaterializeIndexesResult } from "../store/materialize-indexes";

// ============================================================
// Types
// ============================================================

/**
 * Error category for programmatic handling.
 *
 * - `user`: Caused by invalid input or incorrect usage. Recoverable by fixing input.
 * - `constraint`: Business rule or schema constraint violation. Recoverable by changing data.
 * - `system`: Internal error or infrastructure issue. May require investigation or retry.
 */
export type ErrorCategory = "user" | "constraint" | "system";

/**
 * Options for TypeGraphError constructor.
 */
export type TypeGraphErrorOptions = Readonly<{
  /** Structured context about the error */
  details?: Record<string, unknown>;
  /** Error category for handling strategies */
  category: ErrorCategory;
  /** Recovery guidance for users */
  suggestion?: string;
  /** Underlying cause of the error */
  cause?: unknown;
}>;

function formatCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.stack ?? cause.message;
  }
  if (typeof cause === "string") {
    return cause;
  }
  if (
    typeof cause === "number" ||
    typeof cause === "boolean" ||
    typeof cause === "bigint"
  ) {
    return String(cause);
  }
  if (typeof cause === "symbol") {
    return cause.description ?? "Symbol";
  }
  if (cause === undefined) {
    return "Unknown cause";
  }

  try {
    return JSON.stringify(cause);
  } catch (error) {
    return `Unserializable cause: ${
      error instanceof Error ? error.message : "Unknown error"
    }`;
  }
}

// ============================================================
// Base Error
// ============================================================

/**
 * Base error class for all TypeGraph errors.
 *
 * Provides structured error information for both programmatic handling
 * and user-friendly messages.
 */
export class TypeGraphError extends Error {
  /** Machine-readable error code (e.g., "VALIDATION_ERROR") */
  readonly code: string;

  /** Error category for handling strategies */
  readonly category: ErrorCategory;

  /** Structured context about the error */
  readonly details: Readonly<Record<string, unknown>>;

  /** Recovery guidance for users */
  readonly suggestion?: string;

  constructor(message: string, code: string, options: TypeGraphErrorOptions) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "TypeGraphError";
    this.code = code;
    this.category = options.category;
    this.details = Object.freeze(options.details ?? {});
    if (options.suggestion !== undefined) {
      this.suggestion = options.suggestion;
    }
  }

  /**
   * Returns a user-friendly error message with suggestion if available.
   */
  toUserMessage(): string {
    if (this.suggestion) {
      return `${this.message}\n\nSuggestion: ${this.suggestion}`;
    }
    return this.message;
  }

  /**
   * Returns a detailed string representation for logging.
   */
  toLogString(): string {
    const lines = [
      `[${this.code}] ${this.message}`,
      `  Category: ${this.category}`,
    ];

    if (this.suggestion) {
      lines.push(`  Suggestion: ${this.suggestion}`);
    }

    const detailKeys = Object.keys(this.details);
    if (detailKeys.length > 0) {
      lines.push(`  Details: ${JSON.stringify(this.details)}`);
    }

    if (this.cause) {
      lines.push(`  Cause: ${formatCause(this.cause)}`);
    }

    return lines.join("\n");
  }
}

// ============================================================
// Validation Errors (category: "user")
// ============================================================

/**
 * Validation issue from Zod or custom validation.
 */
export type ValidationIssue = Readonly<{
  /** Path to the invalid field (e.g., "address.city") */
  path: string;
  /** Human-readable error message */
  message: string;
  /** Zod error code if from Zod validation */
  code?: string;
}>;

/**
 * Details for ValidationError.
 */
export type ValidationErrorDetails = Readonly<{
  /** Type of entity being validated */
  entityType?: "node" | "edge";
  /** Kind/type name of the entity */
  kind?: string;
  /** Operation being performed */
  operation?: "create" | "update";
  /** Entity ID if updating */
  id?: string;
  /** Individual validation issues */
  issues: readonly ValidationIssue[];
}>;

/**
 * Thrown when schema validation fails during node or edge operations.
 *
 * @example
 * ```typescript
 * try {
 *   await store.nodes.Person.create({ email: "invalid" });
 * } catch (error) {
 *   if (error instanceof ValidationError) {
 *     console.log(error.details.issues);
 *     // [{ path: "email", message: "Invalid email" }]
 *   }
 * }
 * ```
 */
export class ValidationError extends TypeGraphError {
  declare readonly details: ValidationErrorDetails;

  constructor(
    message: string,
    details: ValidationErrorDetails,
    options?: { cause?: unknown; suggestion?: string },
  ) {
    const fieldList =
      details.issues.length > 0 ?
        details.issues.map((index) => index.path || "(root)").join(", ")
      : "unknown";

    super(message, "VALIDATION_ERROR", {
      details,
      category: "user",
      suggestion:
        options?.suggestion ??
        `Check the following fields: ${fieldList}. See error.details.issues for specific validation failures.`,
      cause: options?.cause,
    });
    this.name = "ValidationError";
  }
}

// ============================================================
// Not Found Errors (category: "user")
// ============================================================

/**
 * Thrown when a node is not found.
 *
 * @example
 * ```typescript
 * try {
 *   await store.nodes.Person.get("nonexistent-id");
 * } catch (error) {
 *   if (error instanceof NodeNotFoundError) {
 *     console.log(error.details.kind, error.details.id);
 *   }
 * }
 * ```
 */
export class NodeNotFoundError extends TypeGraphError {
  constructor(kind: string, id: string, options?: { cause?: unknown }) {
    super(`Node not found: ${kind}/${id}`, "NODE_NOT_FOUND", {
      details: { kind, id },
      category: "user",
      suggestion: `Verify the node ID "${id}" exists and has not been deleted.`,
      cause: options?.cause,
    });
    this.name = "NodeNotFoundError";
  }
}

/**
 * Thrown when an edge is not found.
 */
export class EdgeNotFoundError extends TypeGraphError {
  constructor(kind: string, id: string, options?: { cause?: unknown }) {
    super(`Edge not found: ${kind}/${id}`, "EDGE_NOT_FOUND", {
      details: { kind, id },
      category: "user",
      suggestion: `Verify the edge ID "${id}" exists and has not been deleted.`,
      cause: options?.cause,
    });
    this.name = "EdgeNotFoundError";
  }
}

/**
 * Thrown when a kind is not found in the graph registry.
 */
export class KindNotFoundError extends TypeGraphError {
  constructor(
    kind: string,
    type: "node" | "edge",
    options?: { cause?: unknown },
  ) {
    super(
      `${type === "node" ? "Node" : "Edge"} kind not found: ${kind}`,
      "KIND_NOT_FOUND",
      {
        details: { kind, type },
        category: "user",
        suggestion: `Verify "${kind}" is defined in your graph schema and spelled correctly.`,
        cause: options?.cause,
      },
    );
    this.name = "KindNotFoundError";
  }
}

/**
 * Thrown when a uniqueness constraint name is not found on a node kind.
 */
export class NodeConstraintNotFoundError extends TypeGraphError {
  constructor(
    constraintName: string,
    kind: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Constraint not found: "${constraintName}" on node kind "${kind}"`,
      "CONSTRAINT_NOT_FOUND",
      {
        details: { constraintName, kind },
        category: "user",
        suggestion: `Verify the constraint name "${constraintName}" is defined in the unique constraints for "${kind}".`,
        cause: options?.cause,
      },
    );
    this.name = "NodeConstraintNotFoundError";
  }
}

// ============================================================
// Constraint Errors (category: "constraint")
// ============================================================

/**
 * Thrown when edge endpoint node does not exist or is deleted.
 */
export class EndpointNotFoundError extends TypeGraphError {
  constructor(
    details: Readonly<{
      edgeKind: string;
      endpoint: "from" | "to";
      nodeKind: string;
      nodeId: string;
    }>,
    options?: { cause?: unknown },
  ) {
    super(
      `Endpoint node not found for edge "${details.edgeKind}": ${details.nodeKind}/${details.nodeId} (${details.endpoint})`,
      "ENDPOINT_NOT_FOUND",
      {
        details,
        category: "constraint",
        suggestion: `Ensure the ${details.endpoint} node exists before creating the edge.`,
        cause: options?.cause,
      },
    );
    this.name = "EndpointNotFoundError";
  }
}

/**
 * Thrown when edge endpoint has wrong node type.
 */
export class EndpointError extends TypeGraphError {
  constructor(
    details: Readonly<{
      edgeKind: string;
      endpoint: "from" | "to";
      actualKind: string;
      expectedKinds: readonly string[];
    }>,
    options?: { cause?: unknown },
  ) {
    const expected = details.expectedKinds.join(" | ");
    super(
      `Invalid ${details.endpoint} endpoint for edge "${details.edgeKind}": got "${details.actualKind}", expected ${expected}`,
      "ENDPOINT_ERROR",
      {
        details,
        category: "constraint",
        suggestion: `Use a node of type ${expected} as the ${details.endpoint} endpoint.`,
        cause: options?.cause,
      },
    );
    this.name = "EndpointError";
  }
}

/**
 * Thrown when uniqueness constraint is violated.
 */
export class UniquenessError extends TypeGraphError {
  constructor(
    details: Readonly<{
      constraintName: string;
      kind: string;
      existingId: string;
      newId: string;
      fields: readonly string[];
    }>,
    options?: { cause?: unknown },
  ) {
    const fieldList = details.fields.join(", ");
    super(
      `Uniqueness violation on "${details.kind}": constraint "${details.constraintName}" (fields: ${fieldList}) conflicts with existing node ${details.existingId}`,
      "UNIQUENESS_VIOLATION",
      {
        details,
        category: "constraint",
        suggestion: `Change the values for fields [${fieldList}] to be unique, or update the existing node ${details.existingId} instead.`,
        cause: options?.cause,
      },
    );
    this.name = "UniquenessError";
  }
}

/**
 * Thrown when cardinality constraint is violated.
 */
export class CardinalityError extends TypeGraphError {
  constructor(
    details: Readonly<{
      edgeKind: string;
      fromKind: string;
      fromId: string;
      cardinality: string;
      existingCount: number;
    }>,
    options?: { cause?: unknown },
  ) {
    super(
      `Cardinality violation: "${details.edgeKind}" from ${details.fromKind}/${details.fromId} allows "${details.cardinality}" but ${details.existingCount} edge(s) already exist`,
      "CARDINALITY_ERROR",
      {
        details,
        category: "constraint",
        suggestion:
          details.cardinality === "one" || details.cardinality === "unique" ?
            `Delete the existing edge before creating a new one, or use cardinality "many".`
          : `Check if the cardinality constraint "${details.cardinality}" is correct for your use case.`,
        cause: options?.cause,
      },
    );
    this.name = "CardinalityError";
  }
}

/**
 * Thrown when disjointness constraint is violated.
 *
 * Disjoint types cannot share the same ID - a node cannot be both
 * a Person and an Organization if they are declared disjoint.
 */
export class DisjointError extends TypeGraphError {
  constructor(
    details: Readonly<{
      nodeId: string;
      attemptedKind: string;
      conflictingKind: string;
    }>,
    options?: { cause?: unknown },
  ) {
    super(
      `Disjoint constraint violation: cannot create ${details.attemptedKind} with ID "${details.nodeId}" - conflicts with existing ${details.conflictingKind}`,
      "DISJOINT_ERROR",
      {
        details,
        category: "constraint",
        suggestion: `Use a different ID for the new ${details.attemptedKind} node, or delete the existing ${details.conflictingKind}/${details.nodeId} first.`,
        cause: options?.cause,
      },
    );
    this.name = "DisjointError";
  }
}

/**
 * Thrown when deletion is blocked due to existing edges (restrict behavior).
 */
export class RestrictedDeleteError extends TypeGraphError {
  constructor(
    details: Readonly<{
      nodeKind: string;
      nodeId: string;
      edgeCount: number;
      edgeKinds: readonly string[];
    }>,
    options?: { cause?: unknown },
  ) {
    const edgeList = details.edgeKinds.join(", ");
    super(
      `Cannot delete ${details.nodeKind}/${details.nodeId}: ${details.edgeCount} connected edge(s) exist (${edgeList})`,
      "RESTRICTED_DELETE",
      {
        details,
        category: "constraint",
        suggestion: `Delete the connected edges first, or change onDelete behavior to "cascade" (auto-delete edges) or "disconnect" (soft-delete edges).`,
        cause: options?.cause,
      },
    );
    this.name = "RestrictedDeleteError";
  }
}

// ============================================================
// Concurrency Errors (category: "system")
// ============================================================

/**
 * Thrown when optimistic locking detects a concurrent modification.
 *
 * This occurs when two operations try to update the same entity simultaneously.
 * The operation with the stale version fails.
 */
export class VersionConflictError extends TypeGraphError {
  constructor(
    details: Readonly<{
      kind: string;
      id: string;
      expectedVersion: number;
      actualVersion: number;
    }>,
    options?: { cause?: unknown },
  ) {
    super(
      `Version conflict on ${details.kind}/${details.id}: expected version ${details.expectedVersion}, found ${details.actualVersion}`,
      "VERSION_CONFLICT",
      {
        details,
        category: "system",
        suggestion: `Fetch the latest version of the entity and retry the operation. This error indicates concurrent modification.`,
        cause: options?.cause,
      },
    );
    this.name = "VersionConflictError";
  }
}

// ============================================================
// Schema Errors (category: "system")
// ============================================================

/**
 * Thrown when the schema in code doesn't match the schema in the database.
 */
export class SchemaMismatchError extends TypeGraphError {
  constructor(
    details: Readonly<{
      graphId: string;
      expectedHash: string;
      actualHash: string;
    }>,
    options?: { cause?: unknown },
  ) {
    super(
      `Schema mismatch for graph "${details.graphId}": code schema differs from database schema`,
      "SCHEMA_MISMATCH",
      {
        details,
        category: "system",
        suggestion: `Run schema migration to update the database, or use createStoreWithSchema() for automatic migration.`,
        cause: options?.cause,
      },
    );
    this.name = "SchemaMismatchError";
  }
}

/**
 * Thrown when schema migration fails.
 */
export class MigrationError extends TypeGraphError {
  constructor(
    message: string,
    details: Readonly<{
      graphId: string;
      fromVersion: number;
      toVersion: number;
      reason?: string;
    }>,
    options?: { cause?: unknown },
  ) {
    super(message, "MIGRATION_ERROR", {
      details,
      category: "system",
      suggestion: `Review the schema changes and ensure they are backwards compatible, or implement a data migration.`,
      cause: options?.cause,
    });
    this.name = "MigrationError";
  }
}

/**
 * Thrown by `Store.evolve(extension, { eager: true })` when the schema
 * commit succeeded but the follow-on `materializeIndexes()` produced
 * one or more failed entries.
 *
 * Recovery: the schema commit is NOT rolled back. The new `Store` is
 * fully constructed and (when `options.ref` was supplied) `ref.current`
 * already points to it — the caller can read the new store via the ref
 * and decide how to handle the failed indexes (retry, skip, alert).
 * The full `MaterializeIndexesResult` is attached as `.materialization`.
 *
 * @example
 * ```ts
 * const ref = { current: store };
 * try {
 *   await store.evolve(extension, { ref, eager: true });
 * } catch (error) {
 *   if (error instanceof EagerMaterializationError) {
 *     // schema is committed; ref.current is the new store
 *     log.warn(
 *       { failed: error.failedIndexNames },
 *       "indexes did not materialize; will retry",
 *     );
 *     await ref.current.materializeIndexes();
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 */
export class EagerMaterializationError extends TypeGraphError {
  /**
   * The full materialization result, including successful and failed
   * entries. Same shape as `Store.materializeIndexes()` returns.
   */
  readonly materialization: MaterializeIndexesResult;

  constructor(materialization: MaterializeIndexesResult, graphId: string) {
    const names = collectFailedIndexNames(materialization);
    super(
      `Eager materialization failed for ${names.length} index(es) on graph "${graphId}": ${names.join(", ")}. The schema commit succeeded; the new Store is available via the ref handle (when supplied) and the failed indexes can be retried via store.materializeIndexes().`,
      "EAGER_MATERIALIZATION_FAILED",
      {
        details: { graphId, failedIndexNames: names },
        category: "system",
        suggestion: `Inspect error.materialization for per-index errors. Each failure preserves any prior successful materialization timestamp; the schema is committed regardless.`,
      },
    );
    this.name = "EagerMaterializationError";
    this.materialization = materialization;
  }

  /**
   * Names of just the indexes that failed — derived from
   * `materialization.results` so the two views can never disagree.
   */
  get failedIndexNames(): readonly string[] {
    return collectFailedIndexNames(this.materialization);
  }
}

function collectFailedIndexNames(
  materialization: MaterializeIndexesResult,
): readonly string[] {
  const names: string[] = [];
  for (const entry of materialization.results) {
    if (entry.status === "failed") names.push(entry.indexName);
  }
  return names;
}

/**
 * Thrown by `commitSchemaVersion` and `setActiveVersion` when the
 * caller's view of the active schema version is out of date — another
 * writer has already advanced it.
 *
 * Recovery: re-read the active version with `getActiveSchema(graphId)`,
 * recompute against the new baseline, and retry. This is a routine
 * concurrency signal, not a bug.
 *
 * `actual` is `0` when no active version exists yet (initial-commit race
 * where another writer initialized first).
 */
export class StaleVersionError extends TypeGraphError {
  declare readonly details: Readonly<{
    graphId: string;
    expected: number;
    actual: number;
  }>;

  constructor(
    details: Readonly<{
      graphId: string;
      expected: number;
      actual: number;
    }>,
    options?: { cause?: unknown },
  ) {
    super(
      `Schema version was advanced by another writer for graph "${details.graphId}": expected active version ${details.expected}, actual is ${details.actual}`,
      "STALE_SCHEMA_VERSION",
      {
        details,
        category: "system",
        suggestion: `Re-read the active schema version, recompute the new version against that baseline, and retry the commit.`,
        cause: options?.cause,
      },
    );
    this.name = "StaleVersionError";
  }
}

/**
 * Thrown by `commitSchemaVersion` when a row already exists at the
 * target version with a *different* schema hash — i.e. two writers
 * committed materially different schemas at the same version number.
 *
 * Distinct from `StaleVersionError`: this is not a refetch-and-retry
 * situation, it's a content disagreement that needs operator
 * intervention. Typically caused by inconsistent application
 * deployments writing schemas that hash differently.
 */
export class SchemaContentConflictError extends TypeGraphError {
  declare readonly details: Readonly<{
    graphId: string;
    version: number;
    existingHash: string;
    incomingHash: string;
  }>;

  constructor(
    details: Readonly<{
      graphId: string;
      version: number;
      existingHash: string;
      incomingHash: string;
    }>,
    options?: { cause?: unknown },
  ) {
    super(
      `Schema content conflict for graph "${details.graphId}" at version ${details.version}: existing hash ${details.existingHash} differs from incoming hash ${details.incomingHash}`,
      "SCHEMA_CONTENT_CONFLICT",
      {
        details,
        category: "system",
        suggestion: `Two writers committed different schemas at the same version. Reconcile the application deployments so they produce the same canonical schema, then retry.`,
        cause: options?.cause,
      },
    );
    this.name = "SchemaContentConflictError";
  }
}

// ============================================================
// Configuration Errors (category: "user")
// ============================================================

/**
 * Thrown when graph configuration is invalid.
 *
 * This includes invalid schema definitions, ontology conflicts,
 * and other configuration issues detected at graph creation time.
 */
export class ConfigurationError extends TypeGraphError {
  constructor(
    message: string,
    details: Record<string, unknown> = {},
    options?: { cause?: unknown; suggestion?: string },
  ) {
    super(message, "CONFIGURATION_ERROR", {
      details,
      category: "user",
      suggestion:
        options?.suggestion ?? `Review your graph definition for errors.`,
      cause: options?.cause,
    });
    this.name = "ConfigurationError";
  }
}

// ============================================================
// Database Errors (category: "system")
// ============================================================

/**
 * Thrown when a database operation fails unexpectedly.
 *
 * This indicates a system-level failure in the database backend,
 * not a user-recoverable error.
 */
export class DatabaseOperationError extends TypeGraphError {
  constructor(
    message: string,
    details: Readonly<{ operation: string; entity: string }>,
    options?: { cause?: unknown },
  ) {
    super(message, "DATABASE_OPERATION_ERROR", {
      details,
      category: "system",
      suggestion: `This is a system-level database error. Check the database connection and retry the operation. If the problem persists, investigate the underlying cause.`,
      cause: options?.cause,
    });
    this.name = "DatabaseOperationError";
  }
}

// ============================================================
// Query Errors (category: "system")
// ============================================================

/**
 * Thrown when a query predicate cannot be compiled for the target database.
 */
export class UnsupportedPredicateError extends TypeGraphError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: { cause?: unknown; suggestion?: string },
  ) {
    super(message, "UNSUPPORTED_PREDICATE", {
      details,
      category: "system",
      suggestion:
        options?.suggestion ??
        `This predicate may not be supported by your database backend. Check the documentation for supported predicates.`,
      cause: options?.cause,
    });
    this.name = "UnsupportedPredicateError";
  }
}

// ============================================================
// Compiler Errors (category: "system")
// ============================================================

/**
 * Thrown when a compiler invariant is violated.
 *
 * This indicates a bug in the query compiler — the compiler reached
 * a state that should be unreachable. These errors are not user-recoverable.
 */
export class CompilerInvariantError extends TypeGraphError {
  constructor(
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: { cause?: unknown },
  ) {
    super(message, "COMPILER_INVARIANT_ERROR", {
      details: details ?? {},
      category: "system",
      suggestion: `This is an internal compiler error. Please report it as a bug with the query that triggered it.`,
      cause: options?.cause,
    });
    this.name = "CompilerInvariantError";
  }
}

// ============================================================
// Lifecycle Errors (category: "system")
// ============================================================

/**
 * Thrown when an operation is attempted on a backend that has been disposed.
 *
 * This typically occurs during runtime teardown — for example, when a
 * Cloudflare Workers test runner resets Durable Object storage while
 * the TypeGraph backend still has queued operations.
 */
export class BackendDisposedError extends TypeGraphError {
  constructor(options?: { cause?: unknown }) {
    super(
      "Backend has been disposed — the underlying database connection is no longer available",
      "BACKEND_DISPOSED",
      {
        category: "system",
        suggestion:
          "Ensure all store operations complete before calling backend.close(). " +
          "In test environments, await store teardown before resetting the database.",
        cause: options?.cause,
      },
    );
    this.name = "BackendDisposedError";
  }
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Type guard for TypeGraphError.
 *
 * @example
 * ```typescript
 * try {
 *   await store.nodes.Person.create({});
 * } catch (error) {
 *   if (isTypeGraphError(error)) {
 *     console.log(error.code, error.category);
 *   }
 * }
 * ```
 */
export function isTypeGraphError(error: unknown): error is TypeGraphError {
  return error instanceof TypeGraphError;
}

/**
 * Check if error is recoverable by user action (user or constraint error).
 *
 * User-recoverable errors can typically be resolved by:
 * - Fixing invalid input data
 * - Using different IDs or values
 * - Deleting conflicting data first
 *
 * @example
 * ```typescript
 * if (isUserRecoverable(error)) {
 *   showErrorToUser(error.toUserMessage());
 * } else {
 *   logAndAlertOps(error);
 * }
 * ```
 */
export function isUserRecoverable(error: unknown): boolean {
  if (!isTypeGraphError(error)) return false;
  return error.category === "user" || error.category === "constraint";
}

/**
 * Check if error indicates a system/infrastructure issue.
 *
 * System errors typically require:
 * - Retry logic (for transient failures)
 * - Investigation (for persistent failures)
 * - Ops team notification
 */
export function isSystemError(error: unknown): boolean {
  return isTypeGraphError(error) && error.category === "system";
}

/**
 * Check if error is a constraint violation.
 */
export function isConstraintError(error: unknown): boolean {
  return isTypeGraphError(error) && error.category === "constraint";
}

/**
 * Extract suggestion from error if available.
 */
export function getErrorSuggestion(error: unknown): string | undefined {
  return isTypeGraphError(error) ? error.suggestion : undefined;
}
