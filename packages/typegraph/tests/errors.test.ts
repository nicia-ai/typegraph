/**
 * Unit tests for TypeGraph error classes.
 */
import { describe, expect, it } from "vitest";

import {
  CardinalityError,
  ConfigurationError,
  DisjointError,
  EdgeNotFoundError,
  EndpointError,
  EndpointNotFoundError,
  getErrorSuggestion,
  isConstraintError,
  isSystemError,
  isTypeGraphError,
  isUserRecoverable,
  KindNotFoundError,
  MigrationError,
  NodeNotFoundError,
  RestrictedDeleteError,
  SchemaMismatchError,
  TypeGraphError,
  UniquenessError,
  UnsupportedPredicateError,
  ValidationError,
  VersionConflictError,
} from "../src/errors";

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
    expect(error.message).toBe("Node kind not found: User");
    expect(error.code).toBe("KIND_NOT_FOUND");
    expect(error.name).toBe("KindNotFoundError");
    expect(error.category).toBe("user");
  });

  it("formats message for edge kind", () => {
    const error = new KindNotFoundError("Follows", "edge");
    expect(error.message).toBe("Edge kind not found: Follows");
  });

  it("stores kind and type", () => {
    const error = new KindNotFoundError("Post", "node");
    expect(error.details).toEqual({ kind: "Post", type: "node" });
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
