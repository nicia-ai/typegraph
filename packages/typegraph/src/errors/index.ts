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

import type { KindEntity } from "../core/types";
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
  entityType?: KindEntity;
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
 * Details for NodeNotFoundError.
 */
export type NodeNotFoundErrorDetails = Readonly<{
  kind: string;
  id: string;
}>;

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
  declare readonly details: NodeNotFoundErrorDetails;

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
 * Details for EdgeNotFoundError.
 */
export type EdgeNotFoundErrorDetails = Readonly<{
  kind: string;
  id: string;
}>;

/**
 * Thrown when an edge is not found.
 */
export class EdgeNotFoundError extends TypeGraphError {
  declare readonly details: EdgeNotFoundErrorDetails;

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
 * Details for KindNotFoundError.
 */
export type KindNotFoundErrorDetails = Readonly<{
  kindName: string;
  entity: KindEntity;
  graphId?: string;
}>;

/**
 * Thrown when an operation references a kind that isn't registered on
 * the graph — `getNodeCollectionOrThrow` against an unknown kind, a
 * `materializeIndexes({ kinds })` filter naming a missing kind, an
 * extension referencing an unresolved endpoint, search facade typos,
 * etc. Carries the offending `kindName` and `entity` plus the host
 * `graphId` so logs are unambiguous when multiple stores share a
 * process.
 */
export class KindNotFoundError extends TypeGraphError {
  declare readonly details: KindNotFoundErrorDetails;
  readonly kindName: string;
  readonly entity: KindEntity;

  constructor(
    kindName: string,
    entity: KindEntity,
    options?: Readonly<{
      graphId?: string;
      suggestion?: string;
      cause?: unknown;
    }>,
  ) {
    const where =
      options?.graphId === undefined ? "" : ` on graph "${options.graphId}"`;
    super(
      `${entity === "node" ? "Node" : "Edge"} kind "${kindName}" is not registered${where}.`,
      "KIND_NOT_FOUND",
      {
        details: {
          kindName,
          entity,
          ...(options?.graphId === undefined ?
            {}
          : { graphId: options.graphId }),
        },
        category: "user",
        suggestion:
          options?.suggestion ??
          "Compile-time kinds come from defineGraph; extension kinds appear after store.evolve() returns. Check store.introspect() for the registered set.",
        cause: options?.cause,
      },
    );
    this.name = "KindNotFoundError";
    this.kindName = kindName;
    this.entity = entity;
  }
}

/**
 * Details for NodeConstraintNotFoundError.
 */
export type NodeConstraintNotFoundErrorDetails = Readonly<{
  constraintName: string;
  kind: string;
}>;

/**
 * Thrown when a uniqueness constraint name is not found on a node kind.
 */
export class NodeConstraintNotFoundError extends TypeGraphError {
  declare readonly details: NodeConstraintNotFoundErrorDetails;

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

/**
 * Details for NodeIndexNotFoundError.
 */
export type NodeIndexNotFoundErrorDetails = Readonly<{
  indexName: string;
  kind: string;
}>;

/**
 * Thrown when a declared node index name is not found on a node kind.
 */
export class NodeIndexNotFoundError extends TypeGraphError {
  declare readonly details: NodeIndexNotFoundErrorDetails;

  constructor(indexName: string, kind: string, options?: { cause?: unknown }) {
    super(
      `Index not found: "${indexName}" on node kind "${kind}"`,
      "INDEX_NOT_FOUND",
      {
        details: { indexName, kind },
        category: "user",
        suggestion: `Verify the index name "${indexName}" is declared via defineNodeIndex for "${kind}" and passed to defineGraph({ indexes }).`,
        cause: options?.cause,
      },
    );
    this.name = "NodeIndexNotFoundError";
  }
}

// ============================================================
// Constraint Errors (category: "constraint")
// ============================================================

/**
 * Details for EndpointNotFoundError.
 */
export type EndpointNotFoundErrorDetails = Readonly<{
  edgeKind: string;
  endpoint: "from" | "to";
  nodeKind: string;
  nodeId: string;
}>;

/**
 * Thrown when edge endpoint node does not exist or is deleted.
 */
export class EndpointNotFoundError extends TypeGraphError {
  declare readonly details: EndpointNotFoundErrorDetails;

  constructor(
    details: EndpointNotFoundErrorDetails,
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
 * Details for EndpointError.
 */
export type EndpointErrorDetails = Readonly<{
  edgeKind: string;
  endpoint: "from" | "to";
  actualKind: string;
  expectedKinds: readonly string[];
}>;

/**
 * Thrown when edge endpoint has wrong node type.
 */
export class EndpointError extends TypeGraphError {
  declare readonly details: EndpointErrorDetails;

  constructor(details: EndpointErrorDetails, options?: { cause?: unknown }) {
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
 * Details for UniquenessError.
 */
export type UniquenessErrorDetails = Readonly<{
  constraintName: string;
  kind: string;
  existingId: string;
  newId: string;
  fields: readonly string[];
}>;

/**
 * Thrown when uniqueness constraint is violated.
 */
export class UniquenessError extends TypeGraphError {
  declare readonly details: UniquenessErrorDetails;

  constructor(details: UniquenessErrorDetails, options?: { cause?: unknown }) {
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
 * Details for CardinalityError.
 */
export type CardinalityErrorDetails = Readonly<{
  edgeKind: string;
  fromKind: string;
  fromId: string;
  cardinality: string;
  existingCount: number;
}>;

/**
 * Thrown when cardinality constraint is violated.
 */
export class CardinalityError extends TypeGraphError {
  declare readonly details: CardinalityErrorDetails;

  constructor(details: CardinalityErrorDetails, options?: { cause?: unknown }) {
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
 * Details for DisjointError.
 */
export type DisjointErrorDetails = Readonly<{
  nodeId: string;
  attemptedKind: string;
  conflictingKind: string;
}>;

/**
 * Thrown when disjointness constraint is violated.
 *
 * Disjoint types cannot share the same ID - a node cannot be both
 * a Person and an Organization if they are declared disjoint.
 */
export class DisjointError extends TypeGraphError {
  declare readonly details: DisjointErrorDetails;

  constructor(details: DisjointErrorDetails, options?: { cause?: unknown }) {
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
 * Details for RestrictedDeleteError.
 */
export type RestrictedDeleteErrorDetails = Readonly<{
  nodeKind: string;
  nodeId: string;
  edgeCount: number;
  edgeKinds: readonly string[];
}>;

/**
 * Thrown when deletion is blocked due to existing edges (restrict behavior).
 */
export class RestrictedDeleteError extends TypeGraphError {
  declare readonly details: RestrictedDeleteErrorDetails;

  constructor(
    details: RestrictedDeleteErrorDetails,
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
 * Details for VersionConflictError.
 */
export type VersionConflictErrorDetails = Readonly<{
  kind: string;
  id: string;
  expectedVersion: number;
  actualVersion: number;
}>;

/**
 * Thrown when optimistic locking detects a concurrent modification.
 *
 * This occurs when two operations try to update the same entity simultaneously.
 * The operation with the stale version fails.
 */
export class VersionConflictError extends TypeGraphError {
  declare readonly details: VersionConflictErrorDetails;

  constructor(
    details: VersionConflictErrorDetails,
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
 * Details for SchemaMismatchError.
 */
export type SchemaMismatchErrorDetails = Readonly<{
  graphId: string;
  expectedHash: string;
  actualHash: string;
}>;

/**
 * Thrown when the schema in code doesn't match the schema in the database.
 */
export class SchemaMismatchError extends TypeGraphError {
  declare readonly details: SchemaMismatchErrorDetails;

  constructor(
    details: SchemaMismatchErrorDetails,
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
 * Details for MigrationError.
 */
export type MigrationErrorDetails = Readonly<{
  graphId: string;
  fromVersion: number;
  toVersion: number;
  reason?: string;
}>;

/**
 * Thrown when schema migration fails.
 */
export class MigrationError extends TypeGraphError {
  declare readonly details: MigrationErrorDetails;

  constructor(
    message: string,
    details: MigrationErrorDetails,
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
 * Details for EagerMaterializationError.
 */
export type EagerMaterializationErrorDetails = Readonly<{
  graphId: string;
  failedIndexNames: readonly string[];
}>;

/**
 * Thrown by `Store.evolve(extension, { eager })` when the schema
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
 *   await store.evolve(extension, { ref, eager: {} });
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
  declare readonly details: EagerMaterializationErrorDetails;

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
 * Details for StaleVersionError. `actual` is `0` when no active version
 * exists yet (initial-commit race where another writer initialized first).
 */
export type StaleVersionErrorDetails = Readonly<{
  graphId: string;
  expected: number;
  actual: number;
}>;

/**
 * Thrown by `commitSchemaVersion` and `setActiveVersion` when the
 * caller's view of the active schema version is out of date — another
 * writer has already advanced it.
 *
 * Recovery: re-read the active version with `getActiveSchema(graphId)`,
 * recompute against the new baseline, and retry. This is a routine
 * concurrency signal, not a bug.
 */
export class StaleVersionError extends TypeGraphError {
  declare readonly details: StaleVersionErrorDetails;

  constructor(
    details: StaleVersionErrorDetails,
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
 * Details for SchemaContentConflictError.
 */
export type SchemaContentConflictErrorDetails = Readonly<{
  graphId: string;
  version: number;
  existingHash: string;
  incomingHash: string;
}>;

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
  declare readonly details: SchemaContentConflictErrorDetails;

  constructor(
    details: SchemaContentConflictErrorDetails,
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

/**
 * The stable `details.code` values raised by the recorded-capture guards on a
 * history- or revision-tracked store. These are the sanctioned branch points
 * for a portable caller that must pick a transaction strategy without
 * substring-matching {@link ConfigurationError} messages.
 *
 * - `RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION`: `store.withTransaction`
 *   was called on a history-enabled store, which has no flush point before the
 *   caller commits — use `store.withRecordedTransaction` instead.
 * - `RECORDED_CAPTURE_RAW_SQL_DISABLED`: a raw SQL escape (`tx.sql`,
 *   `backend.executeStatement`/`executeDdl`) was reached on a history-enabled
 *   store, where it would bypass recorded-time capture.
 * - `REVISION_TRACKING_RAW_SQL_DISABLED`: the same raw SQL escape on a
 *   revision-tracked store, where it would bypass the revision anchor.
 *
 * @see isRecordedCaptureGuardError
 */
export const RECORDED_CAPTURE_GUARD_CODES = [
  "RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION",
  "RECORDED_CAPTURE_RAW_SQL_DISABLED",
  "REVISION_TRACKING_RAW_SQL_DISABLED",
] as const;

/** A stable, branchable code raised by a recorded-capture guard. */
export type RecordedCaptureGuardCode =
  (typeof RECORDED_CAPTURE_GUARD_CODES)[number];

/**
 * A {@link ConfigurationError} narrowed to carry a {@link RecordedCaptureGuardCode}
 * in `details.code` — the shape {@link isRecordedCaptureGuardError} guarantees.
 * `C` narrows `details.code` to a single code when the guard was called with a
 * specific one; it defaults to the full union.
 */
export type RecordedCaptureGuardError<
  C extends RecordedCaptureGuardCode = RecordedCaptureGuardCode,
> = ConfigurationError & Readonly<{ details: Readonly<{ code: C }> }>;

function isRecordedCaptureGuardCode(
  value: unknown,
): value is RecordedCaptureGuardCode {
  // Widen the readonly tuple so `includes` accepts an `unknown` needle.
  return (RECORDED_CAPTURE_GUARD_CODES as readonly unknown[]).includes(value);
}

/**
 * Type guard for the recorded-capture guard errors, so a portable caller can
 * branch on the invariant a store enforced instead of substring-matching the
 * message. Pass `code` to narrow to a single guard; omit it to match any.
 *
 * Distinguishes "history capture forbids raw SQL here" from "this backend has
 * no transactions" (the latter carries no guard code — see
 * `TransactionContext.sqlAvailability` for the capability discriminant).
 *
 * Passing `code` also narrows `details.code` to that literal on the guarded
 * branch, so a caller can read the payload without re-checking.
 *
 * @example
 * ```typescript
 * // `withTransaction` is a compile error on a history-enabled store, so widen
 * // to the base Store surface to reach the runtime guard this branches on.
 * const store: Store<typeof graph> = historyStore;
 * try {
 *   store.withTransaction(externalTx);
 * } catch (error) {
 *   if (
 *     isRecordedCaptureGuardError(
 *       error,
 *       "RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION",
 *     )
 *   ) {
 *     // error.details.code is now the literal, not the union.
 *     await historyStore.withRecordedTransaction(externalTx, run);
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 */
export function isRecordedCaptureGuardError<C extends RecordedCaptureGuardCode>(
  error: unknown,
  code: C,
): error is RecordedCaptureGuardError<C>;
export function isRecordedCaptureGuardError(
  error: unknown,
): error is RecordedCaptureGuardError;
export function isRecordedCaptureGuardError(
  error: unknown,
  code?: RecordedCaptureGuardCode,
): error is RecordedCaptureGuardError {
  if (!(error instanceof ConfigurationError)) return false;
  const actual = error.details.code;
  if (!isRecordedCaptureGuardCode(actual)) return false;
  return code === undefined || actual === code;
}

/**
 * Why a store's strategy-owned storage is not usable on the current
 * connection. Drives the {@link StoreNotInitializedError} message and
 * is surfaced in `details.reason` for programmatic handling.
 *
 * - `missing`: no durable materialization marker exists — the database
 *   was never initialized for this graph's runtime contributions.
 * - `stale`: a marker exists but its recorded signature no longer
 *   matches the resolved contribution DDL (strategy swap or DDL drift).
 *   The hot path refuses rather than silently re-materializing.
 * - `failed`: the most recent boot-time materialization attempt
 *   recorded an error. Boot may retry; the hot path refuses.
 */
export type StoreNotInitializedReason = "missing" | "stale" | "failed";

const STORE_NOT_INITIALIZED_REASON_PHRASE: Readonly<
  Record<StoreNotInitializedReason, string>
> = {
  missing: "is not initialized",
  stale: "is stale (recorded materialization signature no longer matches)",
  failed: "failed its last initialization attempt",
};

/**
 * Details for StoreNotInitializedError. `graphId`/`reason` are always
 * present; callers may merge additional context (e.g. `logicalName`) via
 * `options.details`.
 */
export type StoreNotInitializedErrorDetails = Readonly<{
  graphId: string;
  reason: StoreNotInitializedReason;
}> &
  Readonly<Record<string, unknown>>;

/**
 * Thrown when a fulltext- or vector-dependent operation runs against a
 * connection whose strategy-owned storage has not been durably materialized.
 *
 * `createStore()` is a synchronous, zero-I/O attach: it never creates
 * tables, repairs DDL, or writes materialization markers. The durable
 * marker is written exclusively by the async boot path
 * (`createStoreWithSchema`). When a fulltext or embedding read/write — or
 * an adopted/business transaction — observes no valid marker, it refuses
 * loudly here instead of lazily emitting DDL on the hot path.
 */
export class StoreNotInitializedError extends TypeGraphError {
  declare readonly details: StoreNotInitializedErrorDetails;

  // `graphId`/`reason` are positional and required: both are
  // load-bearing for the message and for programmatic handling via
  // `details.reason`. Caller `details` merge underneath — spread first
  // so `graphId`/`reason` win and can't be clobbered by an
  // accidentally-colliding extra key.
  constructor(
    graphId: string,
    reason: StoreNotInitializedReason,
    options?: {
      cause?: unknown;
      details?: Readonly<Record<string, unknown>> &
        Readonly<{ graphId?: never; reason?: never }>;
    },
  ) {
    super(
      `${storageLabelFromLogicalName(options?.details?.logicalName)} for ` +
        `graph "${graphId}" ${STORE_NOT_INITIALIZED_REASON_PHRASE[reason]}. ` +
        `Run createStoreWithSchema(graph, backend) during application boot, ` +
        `outside request handlers and adopted transactions, before using createStore().`,
      "STORE_NOT_INITIALIZED",
      {
        details: { ...options?.details, graphId, reason },
        category: "user",
        suggestion:
          "Call createStoreWithSchema(graph, backend) once at application " +
          "startup. createStore() attaches to an already-initialized " +
          "database and does not materialize storage itself.",
        cause: options?.cause,
      },
    );
    this.name = "StoreNotInitializedError";
  }
}

/**
 * Human label for the un-materialized storage, derived from the
 * contribution `logicalName`: fulltext keeps "fulltext storage"; a vector
 * slot ("vector:&lt;kind&gt;.&lt;field&gt;") reads as `vector storage
 * "&lt;kind&gt;.&lt;field&gt;"` so the message names the exact embedding
 * field. Falls back to a neutral phrase when no logical name is supplied.
 */
function storageLabelFromLogicalName(logicalName: unknown): string {
  if (typeof logicalName !== "string") return "runtime storage";
  const VECTOR_PREFIX = "vector:";
  if (logicalName.startsWith(VECTOR_PREFIX)) {
    return `vector storage "${logicalName.slice(VECTOR_PREFIX.length)}"`;
  }
  if (logicalName === "fulltext") return "fulltext storage";
  return `"${logicalName}" storage`;
}

// ============================================================
// Database Errors (category: "system")
// ============================================================

/**
 * Details for DatabaseOperationError.
 */
export type DatabaseOperationErrorDetails = Readonly<{
  operation: string;
  entity: string;
}>;

/**
 * Thrown when a database operation fails unexpectedly.
 *
 * This indicates a system-level failure in the database backend,
 * not a user-recoverable error.
 */
export class DatabaseOperationError extends TypeGraphError {
  declare readonly details: DatabaseOperationErrorDetails;

  constructor(
    message: string,
    details: DatabaseOperationErrorDetails,
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
// Vector / Embedding Errors (category: "user")
// ============================================================

/**
 * Details for EmbeddingDimensionChangedError.
 */
export type EmbeddingDimensionChangedErrorDetails = Readonly<{
  kind: string;
  fieldPath: string;
  declaredDimensions?: number;
  storedDimensions?: number;
}>;

/**
 * Thrown when an embedding field's declared dimension no longer matches the
 * dimension of its materialized per-field storage — i.e. a field's
 * `embedding(N)` was changed to `embedding(M)`. The stored vectors are invalid
 * under the new dimension and cannot be converted, only recomputed, so this is
 * a deliberate app-driven migration: call
 * `store.reembedVectorField(kind, fieldPath, ...)` to recreate the storage at
 * the new dimension and re-embed existing rows.
 */
export class EmbeddingDimensionChangedError extends TypeGraphError {
  declare readonly details: EmbeddingDimensionChangedErrorDetails;

  constructor(
    message: string,
    details: EmbeddingDimensionChangedErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, "EMBEDDING_DIMENSION_CHANGED", {
      details,
      category: "user",
      suggestion: `Run store.reembedVectorField("${details.kind}", "${details.fieldPath}", { embed }) to recreate the field's storage at the new dimension and re-embed existing rows.`,
      cause: options?.cause,
    });
    this.name = "EmbeddingDimensionChangedError";
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

/**
 * Thrown when a statement is issued on a transaction-scoped backend after
 * its transaction boundary has already returned.
 *
 * The usual source is a callback that lets work escape it. `Promise.all`
 * rejects on its first rejection while its siblings keep running, so
 *
 * ```typescript
 * await store.transaction(async (tx) => {
 *   await Promise.all([tx.nodes.Doc.create(a), tx.nodes.Doc.create(b)]);
 * });
 * ```
 *
 * leaves `b`'s remaining statements in flight when `a` fails. Those
 * statements have nowhere safe to go: the driver is about to emit `ROLLBACK`
 * on the same pinned connection and then hand it back to the pool, where a
 * late arrival would execute inside somebody else's transaction. TypeGraph
 * refuses them here instead.
 *
 * The error is normally invisible — `Promise.all` has already rejected with
 * the original failure, and discards this one.
 */
export class TransactionClosedError extends TypeGraphError {
  constructor(options?: { cause?: unknown }) {
    super(
      "Statement issued on a transaction-scoped backend after its transaction " +
        "boundary returned. The connection has been released; the statement was not run.",
      "TRANSACTION_CLOSED",
      {
        category: "user",
        suggestion:
          "Await every write started inside store.transaction(...) before the " +
          "callback returns. Prefer awaiting a Promise.allSettled(...) over a " +
          "Promise.all(...) whose rejection would orphan its siblings.",
        cause: options?.cause,
      },
    );
    this.name = "TransactionClosedError";
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
