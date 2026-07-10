/**
 * Unit tests for TypeGraph error classes.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  CardinalityErrorDetails,
  DatabaseOperationErrorDetails,
  DisjointErrorDetails,
  EagerMaterializationErrorDetails,
  EdgeNotFoundErrorDetails,
  EmbeddingDimensionChangedErrorDetails,
  EndpointErrorDetails,
  EndpointNotFoundErrorDetails,
  KindNotFoundErrorDetails,
  MigrationErrorDetails,
  NodeConstraintNotFoundErrorDetails,
  NodeIndexNotFoundErrorDetails,
  NodeNotFoundErrorDetails,
  RestrictedDeleteErrorDetails,
  SchemaContentConflictErrorDetails,
  SchemaMismatchErrorDetails,
  StaleVersionErrorDetails,
  StoreNotInitializedErrorDetails,
  UniquenessErrorDetails,
  VersionConflictErrorDetails,
} from "../src/errors";
import {
  CardinalityError,
  CompilerInvariantError,
  ConfigurationError,
  DatabaseOperationError,
  DisjointError,
  EagerMaterializationError,
  EdgeNotFoundError,
  EmbeddingDimensionChangedError,
  EndpointError,
  EndpointNotFoundError,
  getErrorSuggestion,
  isConstraintError,
  isSystemError,
  isTypeGraphError,
  isUserRecoverable,
  KindNotFoundError,
  MigrationError,
  NodeConstraintNotFoundError,
  NodeIndexNotFoundError,
  NodeNotFoundError,
  RestrictedDeleteError,
  SchemaContentConflictError,
  SchemaMismatchError,
  StaleVersionError,
  StoreNotInitializedError,
  TransactionClosedError,
  TypeGraphError,
  UniquenessError,
  UnsupportedPredicateError,
  ValidationError,
  VersionConflictError,
} from "../src/errors";
import type { MaterializeIndexesResult } from "../src/store/materialize-indexes";

describe("TypeGraphError", () => {
  it("creates error with message, code, and options", () => {
    const error = new TypeGraphError("test message", "TEST_CODE", {
      category: "user",
    });
    expect(error.message).toBe("test message");
    expect(error.code).toBe("TEST_CODE");
    expect(error.name).toBe("TypeGraphError");
    expect(error.category).toBe("user");
  });

  it("stores details object", () => {
    const details = { foo: "bar", count: 42 };
    const error = new TypeGraphError("test", "CODE", {
      category: "system",
      details,
    });
    expect(error.details).toEqual(details);
  });

  it("defaults to empty details", () => {
    const error = new TypeGraphError("test", "CODE", { category: "user" });
    expect(error.details).toEqual({});
  });

  it("supports error cause chain", () => {
    const cause = new Error("root cause");
    const error = new TypeGraphError("wrapper", "CODE", {
      category: "system",
      cause,
    });
    expect(error.cause).toBe(cause);
  });

  it("is instance of Error", () => {
    const error = new TypeGraphError("test", "CODE", { category: "user" });
    expect(error).toBeInstanceOf(Error);
  });

  it("formats user message with suggestion", () => {
    const error = new TypeGraphError("something went wrong", "CODE", {
      category: "user",
      suggestion: "try again later",
    });
    expect(error.toUserMessage()).toBe(
      "something went wrong\n\nSuggestion: try again later",
    );
  });

  it("formats user message without suggestion", () => {
    const error = new TypeGraphError("something went wrong", "CODE", {
      category: "user",
    });
    expect(error.toUserMessage()).toBe("something went wrong");
  });

  it("formats log string", () => {
    const error = new TypeGraphError("something went wrong", "TEST_CODE", {
      category: "user",
      details: { key: "value" },
      suggestion: "fix it",
    });
    const logString = error.toLogString();
    expect(logString).toContain("[TEST_CODE]");
    expect(logString).toContain("something went wrong");
    expect(logString).toContain("Category: user");
    expect(logString).toContain("Suggestion: fix it");
    expect(logString).toContain('"key":"value"');
  });
});

describe("ValidationError", () => {
  it("creates error with VALIDATION_ERROR code", () => {
    const error = new ValidationError("invalid input", {
      issues: [{ path: "name", message: "required" }],
    });
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("invalid input");
    expect(error.category).toBe("user");
  });

  it("stores validation details with issues", () => {
    const error = new ValidationError("invalid", {
      issues: [{ path: "email", message: "invalid format" }],
      kind: "Person",
      operation: "create",
    });
    expect(error.details.issues).toEqual([
      { path: "email", message: "invalid format" },
    ]);
    expect(error.details.kind).toBe("Person");
    expect(error.details.operation).toBe("create");
  });

  it("inherits from TypeGraphError", () => {
    const error = new ValidationError("test", { issues: [] });
    expect(error).toBeInstanceOf(TypeGraphError);
  });

  it("includes suggestion about fields", () => {
    const error = new ValidationError("validation failed", {
      issues: [
        { path: "name", message: "required" },
        { path: "email", message: "invalid" },
      ],
    });
    expect(error.suggestion).toContain("name");
    expect(error.suggestion).toContain("email");
  });
});

describe("NodeNotFoundError", () => {
  it("formats message with kind and id", () => {
    const error = new NodeNotFoundError("User", "user-123");
    expect(error.message).toBe("Node not found: User/user-123");
    expect(error.code).toBe("NODE_NOT_FOUND");
    expect(error.name).toBe("NodeNotFoundError");
    expect(error.category).toBe("user");
  });

  it("stores kind and id in details", () => {
    const error = new NodeNotFoundError("Post", "post-456");
    expect(error.details).toEqual({ kind: "Post", id: "post-456" });
  });

  it("exposes details typed as NodeNotFoundErrorDetails, no cast needed", () => {
    const error = new NodeNotFoundError("Post", "post-456");
    expectTypeOf(error.details).toEqualTypeOf<NodeNotFoundErrorDetails>();
    expectTypeOf(error.details.kind).toBeString();
    expectTypeOf(error.details.id).toBeString();
  });

  it("has suggestion about verifying ID", () => {
    const error = new NodeNotFoundError("User", "user-123");
    expect(error.suggestion).toContain("user-123");
  });
});

describe("EdgeNotFoundError", () => {
  it("formats message with kind and id", () => {
    const error = new EdgeNotFoundError("AuthoredBy", "edge-789");
    expect(error.message).toBe("Edge not found: AuthoredBy/edge-789");
    expect(error.code).toBe("EDGE_NOT_FOUND");
    expect(error.name).toBe("EdgeNotFoundError");
    expect(error.category).toBe("user");
  });

  it("stores kind and id in details", () => {
    const error = new EdgeNotFoundError("Follows", "edge-abc");
    expect(error.details).toEqual({ kind: "Follows", id: "edge-abc" });
  });

  it("exposes details typed as EdgeNotFoundErrorDetails, no cast needed", () => {
    const error = new EdgeNotFoundError("Follows", "edge-abc");
    expectTypeOf(error.details).toEqualTypeOf<EdgeNotFoundErrorDetails>();
    expectTypeOf(error.details.kind).toBeString();
    expectTypeOf(error.details.id).toBeString();
  });
});

describe("EndpointNotFoundError", () => {
  it("formats message with node info", () => {
    const error = new EndpointNotFoundError({
      edgeKind: "AuthoredBy",
      endpoint: "from",
      nodeKind: "User",
      nodeId: "user-123",
    });
    expect(error.message).toContain("User/user-123");
    expect(error.message).toContain("AuthoredBy");
    expect(error.code).toBe("ENDPOINT_NOT_FOUND");
    expect(error.name).toBe("EndpointNotFoundError");
    expect(error.category).toBe("constraint");
  });

  it("stores full details", () => {
    const details = {
      edgeKind: "Follows",
      endpoint: "to" as const,
      nodeKind: "User",
      nodeId: "user-456",
    };
    const error = new EndpointNotFoundError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as EndpointNotFoundErrorDetails, no cast needed", () => {
    const error = new EndpointNotFoundError({
      edgeKind: "Follows",
      endpoint: "to",
      nodeKind: "User",
      nodeId: "user-456",
    });
    expectTypeOf(error.details).toEqualTypeOf<EndpointNotFoundErrorDetails>();
    expectTypeOf(error.details.nodeId).toBeString();
  });
});

describe("VersionConflictError", () => {
  it("formats message with version info", () => {
    const error = new VersionConflictError({
      kind: "User",
      id: "user-123",
      expectedVersion: 5,
      actualVersion: 7,
    });
    expect(error.message).toContain("User/user-123");
    expect(error.message).toContain("5");
    expect(error.message).toContain("7");
    expect(error.code).toBe("VERSION_CONFLICT");
    expect(error.name).toBe("VersionConflictError");
    expect(error.category).toBe("system");
  });

  it("stores version details", () => {
    const details = {
      kind: "Post",
      id: "post-456",
      expectedVersion: 1,
      actualVersion: 2,
    };
    const error = new VersionConflictError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as VersionConflictErrorDetails, no cast needed", () => {
    const error = new VersionConflictError({
      kind: "Post",
      id: "post-456",
      expectedVersion: 1,
      actualVersion: 2,
    });
    expectTypeOf(error.details).toEqualTypeOf<VersionConflictErrorDetails>();
    expectTypeOf(error.details.expectedVersion).toBeNumber();
    expectTypeOf(error.details.actualVersion).toBeNumber();
  });
});

describe("RestrictedDeleteError", () => {
  it("formats message with edge count", () => {
    const error = new RestrictedDeleteError({
      nodeKind: "User",
      nodeId: "user-123",
      edgeCount: 5,
      edgeKinds: ["AuthoredBy", "Follows"],
    });
    expect(error.message).toContain("User/user-123");
    expect(error.message).toContain("5");
    expect(error.code).toBe("RESTRICTED_DELETE");
    expect(error.name).toBe("RestrictedDeleteError");
    expect(error.category).toBe("constraint");
  });

  it("stores deletion context", () => {
    const details = {
      nodeKind: "Post",
      nodeId: "post-456",
      edgeCount: 3,
      edgeKinds: ["HasComment"] as readonly string[],
    };
    const error = new RestrictedDeleteError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as RestrictedDeleteErrorDetails, no cast needed (issue #230)", () => {
    const error = new RestrictedDeleteError({
      nodeKind: "Post",
      nodeId: "post-456",
      edgeCount: 3,
      edgeKinds: ["HasComment"],
    });
    expectTypeOf(error.details).toEqualTypeOf<RestrictedDeleteErrorDetails>();
    expectTypeOf(error.details.edgeCount).toBeNumber();
    expectTypeOf(error.details.edgeKinds).toEqualTypeOf<readonly string[]>();
  });
});

describe("SchemaMismatchError", () => {
  it("formats message with graph id", () => {
    const error = new SchemaMismatchError({
      graphId: "my-graph",
      expectedHash: "abc123",
      actualHash: "def456",
    });
    expect(error.message).toContain("my-graph");
    expect(error.code).toBe("SCHEMA_MISMATCH");
    expect(error.name).toBe("SchemaMismatchError");
    expect(error.category).toBe("system");
  });

  it("stores hash comparison", () => {
    const details = {
      graphId: "test-graph",
      expectedHash: "hash1",
      actualHash: "hash2",
    };
    const error = new SchemaMismatchError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as SchemaMismatchErrorDetails, no cast needed", () => {
    const error = new SchemaMismatchError({
      graphId: "test-graph",
      expectedHash: "hash1",
      actualHash: "hash2",
    });
    expectTypeOf(error.details).toEqualTypeOf<SchemaMismatchErrorDetails>();
    expectTypeOf(error.details.graphId).toBeString();
  });
});

describe("MigrationError", () => {
  it("accepts custom message with migration context", () => {
    const error = new MigrationError("Column type mismatch", {
      graphId: "my-graph",
      fromVersion: 1,
      toVersion: 2,
    });
    expect(error.message).toBe("Column type mismatch");
    expect(error.code).toBe("MIGRATION_ERROR");
    expect(error.name).toBe("MigrationError");
    expect(error.category).toBe("system");
  });

  it("stores migration version info", () => {
    const details = {
      graphId: "test-graph",
      fromVersion: 3,
      toVersion: 5,
    };
    const error = new MigrationError("Migration failed", details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as MigrationErrorDetails, no cast needed", () => {
    const error = new MigrationError("Migration failed", {
      graphId: "test-graph",
      fromVersion: 3,
      toVersion: 5,
    });
    expectTypeOf(error.details).toEqualTypeOf<MigrationErrorDetails>();
    expectTypeOf(error.details.fromVersion).toBeNumber();
  });
});

describe("UnsupportedPredicateError", () => {
  it("creates error with UNSUPPORTED_PREDICATE code", () => {
    const error = new UnsupportedPredicateError("LIKE not supported");
    expect(error.code).toBe("UNSUPPORTED_PREDICATE");
    expect(error.name).toBe("UnsupportedPredicateError");
    expect(error.message).toBe("LIKE not supported");
    expect(error.category).toBe("system");
  });

  it("stores predicate details", () => {
    const error = new UnsupportedPredicateError("Unsupported", {
      predicate: "regex",
      adapter: "sqlite",
    });
    expect(error.details).toEqual({ predicate: "regex", adapter: "sqlite" });
  });
});

describe("DatabaseOperationError", () => {
  it("creates error with DATABASE_OPERATION_ERROR code", () => {
    const error = new DatabaseOperationError("Insert failed", {
      operation: "insert",
      entity: "node",
    });
    expect(error.code).toBe("DATABASE_OPERATION_ERROR");
    expect(error.name).toBe("DatabaseOperationError");
    expect(error.message).toBe("Insert failed");
    expect(error.category).toBe("system");
  });

  it("stores operation and entity in details", () => {
    const error = new DatabaseOperationError("Delete failed", {
      operation: "delete",
      entity: "edge",
    });
    expect(error.details).toEqual({ operation: "delete", entity: "edge" });
  });

  it("supports error cause chain", () => {
    const cause = new Error("connection refused");
    const error = new DatabaseOperationError(
      "Insert failed",
      { operation: "insert", entity: "node" },
      { cause },
    );
    expect(error.cause).toBe(cause);
  });

  it("exposes details typed as DatabaseOperationErrorDetails, no cast needed", () => {
    const error = new DatabaseOperationError("Delete failed", {
      operation: "delete",
      entity: "edge",
    });
    expectTypeOf(error.details).toEqualTypeOf<DatabaseOperationErrorDetails>();
    expectTypeOf(error.details.operation).toBeString();
  });
});

describe("CompilerInvariantError", () => {
  it("creates error with COMPILER_INVARIANT_ERROR code", () => {
    const error = new CompilerInvariantError("Unexpected empty plan");
    expect(error.code).toBe("COMPILER_INVARIANT_ERROR");
    expect(error.name).toBe("CompilerInvariantError");
    expect(error.message).toBe("Unexpected empty plan");
    expect(error.category).toBe("system");
  });

  it("stores arbitrary details", () => {
    const error = new CompilerInvariantError("Missing state", {
      phase: "standard-pass-pipeline",
      component: "emitter",
    });
    expect(error.details).toEqual({
      phase: "standard-pass-pipeline",
      component: "emitter",
    });
  });

  it("defaults to empty details", () => {
    const error = new CompilerInvariantError("invariant violated");
    expect(error.details).toEqual({});
  });

  it("supports error cause chain", () => {
    const cause = new Error("root cause");
    const error = new CompilerInvariantError(
      "invariant violated",
      { phase: "lowering" },
      { cause },
    );
    expect(error.cause).toBe(cause);
  });
});

describe("ConfigurationError", () => {
  it("creates error with CONFIGURATION_ERROR code", () => {
    const error = new ConfigurationError("Invalid config");
    expect(error.code).toBe("CONFIGURATION_ERROR");
    expect(error.name).toBe("ConfigurationError");
    expect(error.message).toBe("Invalid config");
    expect(error.category).toBe("user");
  });

  it("stores configuration details", () => {
    const error = new ConfigurationError("Missing field", { field: "apiKey" });
    expect(error.details).toEqual({ field: "apiKey" });
  });
});

describe("KindNotFoundError", () => {
  it("formats message for node kind", () => {
    const error = new KindNotFoundError("User", "node");
    expect(error.message).toBe('Node kind "User" is not registered.');
    expect(error.code).toBe("KIND_NOT_FOUND");
    expect(error.name).toBe("KindNotFoundError");
    expect(error.category).toBe("user");
    expect(error.kindName).toBe("User");
    expect(error.entity).toBe("node");
  });

  it("formats message for edge kind", () => {
    const error = new KindNotFoundError("Follows", "edge");
    expect(error.message).toBe('Edge kind "Follows" is not registered.');
  });

  it("stores kind and entity in details", () => {
    const error = new KindNotFoundError("Post", "node");
    expect(error.details).toEqual({ kindName: "Post", entity: "node" });
  });

  it("includes graphId in message and details when supplied", () => {
    const error = new KindNotFoundError("Paper", "node", { graphId: "lib" });
    expect(error.message).toBe(
      'Node kind "Paper" is not registered on graph "lib".',
    );
    expect(error.details).toEqual({
      kindName: "Paper",
      entity: "node",
      graphId: "lib",
    });
  });

  it("exposes details typed as KindNotFoundErrorDetails, no cast needed", () => {
    const error = new KindNotFoundError("Paper", "node", { graphId: "lib" });
    expectTypeOf(error.details).toEqualTypeOf<KindNotFoundErrorDetails>();
    expectTypeOf(error.details.kindName).toBeString();
    expectTypeOf(error.details.graphId).toEqualTypeOf<string | undefined>();
  });
});

describe("NodeConstraintNotFoundError", () => {
  it("formats message with constraint name and kind", () => {
    const error = new NodeConstraintNotFoundError("unique_email", "User");
    expect(error.message).toBe(
      'Constraint not found: "unique_email" on node kind "User"',
    );
    expect(error.code).toBe("CONSTRAINT_NOT_FOUND");
    expect(error.name).toBe("NodeConstraintNotFoundError");
    expect(error.category).toBe("user");
  });

  it("stores constraint name and kind in details", () => {
    const error = new NodeConstraintNotFoundError("unique_slug", "Post");
    expect(error.details).toEqual({
      constraintName: "unique_slug",
      kind: "Post",
    });
  });

  it("exposes details typed as NodeConstraintNotFoundErrorDetails, no cast needed", () => {
    const error = new NodeConstraintNotFoundError("unique_slug", "Post");
    expectTypeOf(
      error.details,
    ).toEqualTypeOf<NodeConstraintNotFoundErrorDetails>();
    expectTypeOf(error.details.constraintName).toBeString();
  });
});

describe("NodeIndexNotFoundError", () => {
  it("formats message with index name and kind", () => {
    const error = new NodeIndexNotFoundError("by_email", "User");
    expect(error.message).toBe(
      'Index not found: "by_email" on node kind "User"',
    );
    expect(error.code).toBe("INDEX_NOT_FOUND");
    expect(error.name).toBe("NodeIndexNotFoundError");
    expect(error.category).toBe("user");
  });

  it("stores index name and kind in details", () => {
    const error = new NodeIndexNotFoundError("by_slug", "Post");
    expect(error.details).toEqual({ indexName: "by_slug", kind: "Post" });
  });

  it("exposes details typed as NodeIndexNotFoundErrorDetails, no cast needed", () => {
    const error = new NodeIndexNotFoundError("by_slug", "Post");
    expectTypeOf(error.details).toEqualTypeOf<NodeIndexNotFoundErrorDetails>();
    expectTypeOf(error.details.indexName).toBeString();
  });
});

describe("UniquenessError", () => {
  it("creates error with constraint details", () => {
    const error = new UniquenessError({
      constraintName: "unique_email",
      kind: "User",
      existingId: "user-1",
      newId: "user-2",
      fields: ["email"],
    });
    expect(error.message).toContain("unique_email");
    expect(error.message).toContain("User");
    expect(error.code).toBe("UNIQUENESS_VIOLATION");
    expect(error.name).toBe("UniquenessError");
    expect(error.category).toBe("constraint");
  });

  it("stores constraint violation details", () => {
    const details = {
      constraintName: "unique_slug",
      kind: "Post",
      existingId: "post-1",
      newId: "post-2",
      fields: ["slug"] as readonly string[],
    };
    const error = new UniquenessError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as UniquenessErrorDetails, no cast needed", () => {
    const error = new UniquenessError({
      constraintName: "unique_slug",
      kind: "Post",
      existingId: "post-1",
      newId: "post-2",
      fields: ["slug"],
    });
    expectTypeOf(error.details).toEqualTypeOf<UniquenessErrorDetails>();
    expectTypeOf(error.details.fields).toEqualTypeOf<readonly string[]>();
  });
});

describe("CardinalityError", () => {
  it("creates error with cardinality details", () => {
    const error = new CardinalityError({
      edgeKind: "HasProfile",
      fromKind: "User",
      fromId: "user-1",
      cardinality: "one",
      existingCount: 1,
    });
    expect(error.message).toContain("HasProfile");
    expect(error.message).toContain("User/user-1");
    expect(error.code).toBe("CARDINALITY_ERROR");
    expect(error.name).toBe("CardinalityError");
    expect(error.category).toBe("constraint");
  });

  it("stores cardinality context", () => {
    const details = {
      edgeKind: "BelongsTo",
      fromKind: "Post",
      fromId: "post-1",
      cardinality: "one",
      existingCount: 2,
    };
    const error = new CardinalityError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as CardinalityErrorDetails, no cast needed", () => {
    const error = new CardinalityError({
      edgeKind: "BelongsTo",
      fromKind: "Post",
      fromId: "post-1",
      cardinality: "one",
      existingCount: 2,
    });
    expectTypeOf(error.details).toEqualTypeOf<CardinalityErrorDetails>();
    expectTypeOf(error.details.existingCount).toBeNumber();
  });
});

describe("EndpointError", () => {
  it("creates error with endpoint details", () => {
    const error = new EndpointError({
      edgeKind: "AuthoredBy",
      endpoint: "from",
      actualKind: "Comment",
      expectedKinds: ["Post", "Article"],
    });
    expect(error.message).toContain("AuthoredBy");
    expect(error.message).toContain("Comment");
    expect(error.code).toBe("ENDPOINT_ERROR");
    expect(error.name).toBe("EndpointError");
    expect(error.category).toBe("constraint");
  });

  it("stores endpoint validation context", () => {
    const details = {
      edgeKind: "Follows",
      endpoint: "to" as const,
      actualKind: "Post",
      expectedKinds: ["User"] as readonly string[],
    };
    const error = new EndpointError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as EndpointErrorDetails, no cast needed", () => {
    const error = new EndpointError({
      edgeKind: "Follows",
      endpoint: "to",
      actualKind: "Post",
      expectedKinds: ["User"],
    });
    expectTypeOf(error.details).toEqualTypeOf<EndpointErrorDetails>();
    expectTypeOf(error.details.expectedKinds).toEqualTypeOf<
      readonly string[]
    >();
  });
});

describe("DisjointError", () => {
  it("creates error with disjoint details", () => {
    const error = new DisjointError({
      nodeId: "node-1",
      attemptedKind: "Admin",
      conflictingKind: "Guest",
    });
    expect(error.message).toContain("Admin");
    expect(error.message).toContain("Guest");
    expect(error.message).toContain("node-1");
    expect(error.code).toBe("DISJOINT_ERROR");
    expect(error.name).toBe("DisjointError");
    expect(error.category).toBe("constraint");
  });

  it("stores disjointness violation context", () => {
    const details = {
      nodeId: "user-123",
      attemptedKind: "Employee",
      conflictingKind: "Contractor",
    };
    const error = new DisjointError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as DisjointErrorDetails, no cast needed", () => {
    const error = new DisjointError({
      nodeId: "user-123",
      attemptedKind: "Employee",
      conflictingKind: "Contractor",
    });
    expectTypeOf(error.details).toEqualTypeOf<DisjointErrorDetails>();
    expectTypeOf(error.details.nodeId).toBeString();
  });
});

describe("EmbeddingDimensionChangedError", () => {
  it("formats message and stores field details", () => {
    const error = new EmbeddingDimensionChangedError(
      "Embedding dimension changed",
      {
        kind: "Document",
        fieldPath: "summary",
        declaredDimensions: 768,
        storedDimensions: 384,
      },
    );
    expect(error.message).toBe("Embedding dimension changed");
    expect(error.code).toBe("EMBEDDING_DIMENSION_CHANGED");
    expect(error.name).toBe("EmbeddingDimensionChangedError");
    expect(error.category).toBe("user");
    expect(error.details).toEqual({
      kind: "Document",
      fieldPath: "summary",
      declaredDimensions: 768,
      storedDimensions: 384,
    });
  });

  it("exposes details typed as EmbeddingDimensionChangedErrorDetails, no cast needed", () => {
    const error = new EmbeddingDimensionChangedError("changed", {
      kind: "Document",
      fieldPath: "summary",
    });
    expectTypeOf(
      error.details,
    ).toEqualTypeOf<EmbeddingDimensionChangedErrorDetails>();
    expectTypeOf(error.details.declaredDimensions).toEqualTypeOf<
      number | undefined
    >();
  });
});

describe("StaleVersionError", () => {
  it("formats message with version info", () => {
    const error = new StaleVersionError({
      graphId: "lib",
      expected: 3,
      actual: 4,
    });
    expect(error.message).toContain("lib");
    expect(error.code).toBe("STALE_SCHEMA_VERSION");
    expect(error.name).toBe("StaleVersionError");
    expect(error.category).toBe("system");
  });

  it("stores version details", () => {
    const details = { graphId: "lib", expected: 3, actual: 4 };
    const error = new StaleVersionError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as StaleVersionErrorDetails, no cast needed", () => {
    const error = new StaleVersionError({
      graphId: "lib",
      expected: 3,
      actual: 4,
    });
    expectTypeOf(error.details).toEqualTypeOf<StaleVersionErrorDetails>();
    expectTypeOf(error.details.actual).toBeNumber();
  });
});

describe("SchemaContentConflictError", () => {
  it("formats message with version and hashes", () => {
    const error = new SchemaContentConflictError({
      graphId: "lib",
      version: 2,
      existingHash: "abc",
      incomingHash: "def",
    });
    expect(error.message).toContain("lib");
    expect(error.code).toBe("SCHEMA_CONTENT_CONFLICT");
    expect(error.name).toBe("SchemaContentConflictError");
    expect(error.category).toBe("system");
  });

  it("stores conflict details", () => {
    const details = {
      graphId: "lib",
      version: 2,
      existingHash: "abc",
      incomingHash: "def",
    };
    const error = new SchemaContentConflictError(details);
    expect(error.details).toEqual(details);
  });

  it("exposes details typed as SchemaContentConflictErrorDetails, no cast needed", () => {
    const error = new SchemaContentConflictError({
      graphId: "lib",
      version: 2,
      existingHash: "abc",
      incomingHash: "def",
    });
    expectTypeOf(
      error.details,
    ).toEqualTypeOf<SchemaContentConflictErrorDetails>();
    expectTypeOf(error.details.version).toBeNumber();
  });
});

describe("StoreNotInitializedError", () => {
  it("formats message with graphId and reason", () => {
    const error = new StoreNotInitializedError("lib", "missing");
    expect(error.message).toContain("lib");
    expect(error.code).toBe("STORE_NOT_INITIALIZED");
    expect(error.name).toBe("StoreNotInitializedError");
    expect(error.category).toBe("user");
  });

  it("stores graphId, reason, and merged extra details", () => {
    const error = new StoreNotInitializedError("lib", "stale", {
      details: { logicalName: "vector:summary" },
    });
    expect(error.details).toEqual({
      graphId: "lib",
      reason: "stale",
      logicalName: "vector:summary",
    });
  });

  it("exposes details typed as StoreNotInitializedErrorDetails, no cast needed", () => {
    const error = new StoreNotInitializedError("lib", "missing");
    expectTypeOf(
      error.details,
    ).toEqualTypeOf<StoreNotInitializedErrorDetails>();
    expectTypeOf(error.details.reason).toEqualTypeOf<
      "missing" | "stale" | "failed"
    >();
  });

  it("keeps the constructor's graphId/reason authoritative over colliding extra details", () => {
    const spoofedDetails = {
      graphId: "spoofed",
      reason: "spoofed",
      logicalName: "vector:summary",
    };
    const error = new StoreNotInitializedError(
      "lib",
      "stale",
      // @ts-expect-error graphId/reason are reserved and cannot be overridden via extra details
      { details: spoofedDetails },
    );
    expect(error.details).toEqual({
      graphId: "lib",
      reason: "stale",
      logicalName: "vector:summary",
    });
  });
});

describe("TransactionClosedError", () => {
  it("is a user error naming the released connection and the fix", () => {
    const error = new TransactionClosedError();

    expect(error.code).toBe("TRANSACTION_CLOSED");
    expect(error.name).toBe("TransactionClosedError");
    expect(error.category).toBe("user");
    expect(error.message).toContain("transaction boundary returned");
    expect(error.message).toContain("was not run");
    expect(error.suggestion).toContain("Promise.allSettled");
  });

  it("carries a cause when one is supplied", () => {
    const cause = new Error("original failure");
    expect(new TransactionClosedError({ cause }).cause).toBe(cause);
  });
});

describe("EagerMaterializationError", () => {
  const materialization: MaterializeIndexesResult = {
    results: [
      {
        indexName: "by_email",
        entity: "node",
        kind: "User",
        status: "failed",
      },
      {
        indexName: "by_slug",
        entity: "node",
        kind: "Post",
        status: "created",
      },
    ],
  };

  it("formats message and stores graphId/failedIndexNames in details", () => {
    const error = new EagerMaterializationError(materialization, "lib");
    expect(error.code).toBe("EAGER_MATERIALIZATION_FAILED");
    expect(error.name).toBe("EagerMaterializationError");
    expect(error.category).toBe("system");
    expect(error.details).toEqual({
      graphId: "lib",
      failedIndexNames: ["by_email"],
    });
    expect(error.materialization).toBe(materialization);
    expect(error.failedIndexNames).toEqual(["by_email"]);
  });

  it("exposes details typed as EagerMaterializationErrorDetails, no cast needed", () => {
    const error = new EagerMaterializationError(materialization, "lib");
    expectTypeOf(
      error.details,
    ).toEqualTypeOf<EagerMaterializationErrorDetails>();
    expectTypeOf(error.details.failedIndexNames).toEqualTypeOf<
      readonly string[]
    >();
  });
});

describe("error inheritance chain", () => {
  it("all errors inherit from TypeGraphError", () => {
    const errors = [
      new ValidationError("test", { issues: [] }),
      new NodeNotFoundError("Kind", "id"),
      new EdgeNotFoundError("Kind", "id"),
      new EndpointNotFoundError({
        edgeKind: "E",
        endpoint: "from",
        nodeKind: "N",
        nodeId: "id",
      }),
      new VersionConflictError({
        kind: "K",
        id: "id",
        expectedVersion: 1,
        actualVersion: 2,
      }),
      new RestrictedDeleteError({
        nodeKind: "N",
        nodeId: "id",
        edgeCount: 1,
        edgeKinds: [],
      }),
      new SchemaMismatchError({
        graphId: "g",
        expectedHash: "a",
        actualHash: "b",
      }),
      new MigrationError("test", {
        graphId: "g",
        fromVersion: 1,
        toVersion: 2,
      }),
      new UnsupportedPredicateError("test"),
      new DatabaseOperationError("test", {
        operation: "insert",
        entity: "node",
      }),
      new CompilerInvariantError("test"),
      new ConfigurationError("test"),
      new KindNotFoundError("K", "node"),
      new UniquenessError({
        constraintName: "c",
        kind: "K",
        existingId: "a",
        newId: "b",
        fields: [],
      }),
      new CardinalityError({
        edgeKind: "E",
        fromKind: "K",
        fromId: "id",
        cardinality: "one",
        existingCount: 1,
      }),
      new EndpointError({
        edgeKind: "E",
        endpoint: "from",
        actualKind: "A",
        expectedKinds: [],
      }),
      new DisjointError({
        nodeId: "id",
        attemptedKind: "A",
        conflictingKind: "B",
      }),
      new NodeConstraintNotFoundError("c", "K"),
      new NodeIndexNotFoundError("i", "K"),
      new EmbeddingDimensionChangedError("test", {
        kind: "K",
        fieldPath: "field",
      }),
      new StaleVersionError({ graphId: "g", expected: 1, actual: 2 }),
      new SchemaContentConflictError({
        graphId: "g",
        version: 1,
        existingHash: "a",
        incomingHash: "b",
      }),
      new StoreNotInitializedError("g", "missing"),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(TypeGraphError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe("error utility functions", () => {
  it("isTypeGraphError identifies TypeGraph errors", () => {
    expect(isTypeGraphError(new ValidationError("test", { issues: [] }))).toBe(
      true,
    );
    expect(isTypeGraphError(new Error("test"))).toBe(false);
    expect(isTypeGraphError("not an error")).toBe(false);
    expect(isTypeGraphError(void 0)).toBe(false);
  });

  it("isUserRecoverable identifies user/constraint errors", () => {
    expect(isUserRecoverable(new ValidationError("test", { issues: [] }))).toBe(
      true,
    );
    expect(
      isUserRecoverable(
        new DisjointError({
          nodeId: "id",
          attemptedKind: "A",
          conflictingKind: "B",
        }),
      ),
    ).toBe(true);
    expect(
      isUserRecoverable(
        new VersionConflictError({
          kind: "K",
          id: "id",
          expectedVersion: 1,
          actualVersion: 2,
        }),
      ),
    ).toBe(false);
    expect(isUserRecoverable(new Error("test"))).toBe(false);
  });

  it("isSystemError identifies system errors", () => {
    expect(
      isSystemError(
        new VersionConflictError({
          kind: "K",
          id: "id",
          expectedVersion: 1,
          actualVersion: 2,
        }),
      ),
    ).toBe(true);
    expect(isSystemError(new ValidationError("test", { issues: [] }))).toBe(
      false,
    );
    expect(isSystemError(new Error("test"))).toBe(false);
  });

  it("isConstraintError identifies constraint errors", () => {
    expect(
      isConstraintError(
        new DisjointError({
          nodeId: "id",
          attemptedKind: "A",
          conflictingKind: "B",
        }),
      ),
    ).toBe(true);
    expect(
      isConstraintError(
        new UniquenessError({
          constraintName: "c",
          kind: "K",
          existingId: "a",
          newId: "b",
          fields: [],
        }),
      ),
    ).toBe(true);
    expect(isConstraintError(new ValidationError("test", { issues: [] }))).toBe(
      false,
    );
    expect(isConstraintError(new Error("test"))).toBe(false);
  });

  it("getErrorSuggestion extracts suggestion", () => {
    const error = new NodeNotFoundError("User", "user-123");
    expect(getErrorSuggestion(error)).toContain("user-123");
    expect(getErrorSuggestion(new Error("test"))).toBeUndefined();
    expect(getErrorSuggestion(void 0)).toBeUndefined();
  });
});
