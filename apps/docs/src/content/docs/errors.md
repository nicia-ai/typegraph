---
title: Errors
description: Error types and handling in TypeGraph
---

TypeGraph uses typed errors to communicate specific failure conditions. All errors extend the base
`TypeGraphError` class and include categorization, contextual details, and actionable suggestions.

## Error Categories

Every error is categorized to help determine the appropriate response:

| Category | Description | Typical Response |
|----------|-------------|------------------|
| `user` | Invalid input or misuse of API | Fix the input and retry |
| `constraint` | Graph constraint violated | Handle as business logic violation |
| `system` | Internal or infrastructure error | Log, alert, potentially retry |

```typescript
import { isUserRecoverable, isConstraintError, isSystemError } from "@nicia-ai/typegraph";

try {
  await store.nodes.Person.create(data);
} catch (error) {
  if (isUserRecoverable(error)) {
    // Show validation errors to user
    return { error: error.toUserMessage() };
  }
  if (isConstraintError(error)) {
    // Handle business rule violation
    return { error: "This operation violates a constraint" };
  }
  if (isSystemError(error)) {
    // Log and alert
    console.error(error.toLogString());
    throw error;
  }
}
```

## Base Error

### `TypeGraphError`

Base error class for all TypeGraph errors.

```typescript
class TypeGraphError extends Error {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly details: Readonly<Record<string, unknown>>;
  readonly suggestion?: string;

  // Format error for end users (includes suggestion if available)
  toUserMessage(): string;

  // Format error for logging (includes code, category, and details)
  toLogString(): string;
}

type ErrorCategory = "user" | "constraint" | "system";
```

**Properties:**

| Property | Type | Description |
|----------|------|-------------|
| `code` | `string` | Machine-readable error code |
| `category` | `ErrorCategory` | Error classification for handling |
| `details` | `Record<string, unknown>` | Additional context about the error |
| `suggestion` | `string \| undefined` | Actionable guidance for resolution |

**Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `toUserMessage()` | `string` | Human-readable message with suggestion |
| `toLogString()` | `string` | Detailed string for logging/debugging |

## Validation Errors

### `ValidationError`

Thrown when schema validation fails during node or edge creation/update. Includes structured issue
details with context about which entity failed.

```typescript
interface ValidationErrorDetails {
  readonly issues: readonly ValidationIssue[];
  readonly entityType?: "node" | "edge";
  readonly kind?: string;
  readonly operation?: "create" | "update";
  readonly id?: string;
}

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}
```

**Example:**

```typescript
try {
  await store.nodes.Person.create({ name: "" }); // Empty name fails min(1)
} catch (error) {
  if (error instanceof ValidationError) {
    console.log(error.category);     // "user"
    console.log(error.details.kind); // "Person"
    console.log(error.details.operation); // "create"
    console.log(error.details.issues);
    // [{ path: "name", message: "String must contain at least 1 character(s)" }]
    console.log(error.toUserMessage());
    // "Validation failed for Person create: name - String must contain at least 1 character(s)
    //
    // Suggestion: Check the data you're providing matches the schema..."
  }
}
```

### `DisjointError`

Thrown when attempting to create a node that violates a disjointness constraint.

```typescript
// If Person and Organization are disjoint:
await store.nodes.Person.create({ name: "Alice" }, { id: "entity-1" });

try {
  // Same ID, different disjoint type
  await store.nodes.Organization.create({ name: "Acme" }, { id: "entity-1" });
} catch (error) {
  if (error instanceof DisjointError) {
    console.log(error.category); // "constraint"
    console.log(error.details);
    // { nodeId: "entity-1", attemptedKind: "Organization", conflictingKind: "Person" }
    console.log(error.suggestion);
    // "Use a different ID for the new node, or delete the existing node first..."
  }
}
```

### `EndpointError`

Thrown when an edge is created with invalid endpoint types.

```typescript
// If worksAt only allows Person -> Company:
try {
  await store.edges.worksAt.create(company, person, {}); // Wrong direction
} catch (error) {
  if (error instanceof EndpointError) {
    console.log(error.category); // "user"
    console.log(error.suggestion);
    // "Check the edge definition to see which node types are allowed..."
  }
}
```

### `CardinalityError`

Thrown when a cardinality constraint is violated.

```typescript
// If worksAt has cardinality: "one" (person can only work at one company):
await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

try {
  await store.edges.worksAt.create(alice, otherCompany, { role: "Consultant" });
} catch (error) {
  if (error instanceof CardinalityError) {
    console.log(error.category); // "constraint"
    console.log(error.details);
    // { edgeKind: "worksAt", fromKind: "Person", fromId: "<alice-id>", cardinality: "one", existingCount: 1 }
    console.log(error.suggestion);
    // "Remove the existing edge before creating a new one, or update the existing edge..."
  }
}
```

### `UniquenessError`

Thrown when a uniqueness constraint is violated.

```typescript
// If email has a unique constraint:
await store.nodes.Person.create({ name: "Alice", email: "alice@example.com" });

try {
  await store.nodes.Person.create({ name: "Bob", email: "alice@example.com" });
} catch (error) {
  if (error instanceof UniquenessError) {
    console.log(error.category); // "constraint"
    console.log(error.details);
    // { constraintName: "unique_email", kind: "Person", existingId: "<alice-id>", newId: "<bob-id>", fields: ["email"] }
    console.log(error.suggestion);
    // "Use a different value for the unique field, or update the existing record..."
  }
}
```

## Not Found Errors

### `NodeNotFoundError`

Thrown when a referenced node does not exist.

```typescript
try {
  await store.nodes.Person.update("nonexistent-id", { name: "New Name" });
} catch (error) {
  if (error instanceof NodeNotFoundError) {
    console.log(error.category); // "user"
    console.log(error.details); // { kind: "Person", id: "nonexistent-id" }
    console.log(error.suggestion);
    // "Verify the node ID is correct and the node hasn't been deleted..."
  }
}
```

### `EdgeNotFoundError`

Thrown when a referenced edge does not exist.

```typescript
try {
  await store.edges.worksAt.update("nonexistent-edge", { role: "Manager" });
} catch (error) {
  if (error instanceof EdgeNotFoundError) {
    console.log(error.category); // "user"
    console.log(error.details); // { kind: "worksAt", id: "nonexistent-edge" }
    console.log(error.suggestion);
    // "Verify the edge ID is correct and the edge hasn't been deleted..."
  }
}
```

### `KindNotFoundError`

Thrown when referencing a node or edge type that doesn't exist in the graph definition.

```typescript
try {
  await store.query().from("NonExistentType", "n").execute();
} catch (error) {
  if (error instanceof KindNotFoundError) {
    console.log(error.category); // "user"
    console.log(error.details); // { kindName: "NonExistentType", entity: "node" }
    console.log(error.suggestion);
    // "Check the graph definition to see which node and edge types are available..."
  }
}
```

### `EndpointNotFoundError`

Thrown when an edge references a node that doesn't exist.

```typescript
try {
  await store.edges.worksAt.create(
    { kind: "Person", id: "nonexistent" },
    company,
    { role: "Engineer" }
  );
} catch (error) {
  if (error instanceof EndpointNotFoundError) {
    console.log(error.category); // "user"
    console.log(error.details);
    // { edgeKind: "worksAt", endpoint: "from", nodeKind: "Person", nodeId: "nonexistent" }
    console.log(error.suggestion);
    // "Create the referenced node first, or verify the node ID is correct..."
  }
}
```

## Delete Errors

### `RestrictedDeleteError`

Thrown when delete is blocked due to existing edges (when `onDelete: "restrict"`).

```typescript
// If Person has edges and onDelete is "restrict":
try {
  await store.nodes.Person.delete(alice.id);
} catch (error) {
  if (error instanceof RestrictedDeleteError) {
    console.log(error.category); // "constraint"
    console.log(error.details);
    // { nodeKind: "Person", nodeId: "<alice-id>", edgeCount: 3, edgeKinds: ["worksAt", "authored"] }
    console.log(error.suggestion);
    // "Delete all edges connected to this node first, or change the delete behavior..."
  }
}
```

## Configuration Errors

### `ConfigurationError`

Thrown when the store, backend, or schema definition is misconfigured.

```typescript
// Using transactions on D1 (which doesn't support them):
try {
  await store.transaction(async (tx) => {
    // ...
  });
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.log(error.category); // "system"
    console.log(error.suggestion);
    // "Check the backend documentation for supported features..."
  }
}
```

#### Recorded-capture guard codes

`ConfigurationError` is intentionally open-shaped, but the guards that fire on a
`history: true` / `revisionTracking: true` store carry a **stable, branchable
`details.code`** so a portable caller does not have to substring-match the
message. The three codes are exported as a set, `RECORDED_CAPTURE_GUARD_CODES`,
and reachable through the `isRecordedCaptureGuardError` type guard:

| `details.code` | Raised when |
|----------------|-------------|
| `RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION` | `store.withTransaction(externalTx)` on a history-enabled store — it has no flush point before the caller commits. Use `store.withRecordedTransaction(externalTx, fn)`. (Also a compile error on a `HistoryStore`.) |
| `RECORDED_CAPTURE_RAW_SQL_DISABLED` | A raw SQL escape (`tx.sql`, `backend.executeStatement` / `executeDdl`) on a history-enabled store, where it would bypass recorded-time capture. |
| `REVISION_TRACKING_RAW_SQL_DISABLED` | The same raw SQL escape on a revision-tracked store, where it would bypass the revision anchor. |

```typescript
import { isRecordedCaptureGuardError, type Store } from "@nicia-ai/typegraph";

// `withTransaction` is a compile error on a history-enabled store (that is the
// point — see below). Widen to the base `Store` surface to reach the runtime
// guard this branch handles.
const store: Store<typeof graph> = historyStore;

try {
  store.withTransaction(externalTx);
} catch (error) {
  if (
    isRecordedCaptureGuardError(
      error,
      "RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION",
    )
  ) {
    // error.details.code is narrowed to the passed literal here.
    await historyStore.withRecordedTransaction(externalTx, run);
  } else {
    throw error;
  }
}
```

Pass a specific code to narrow to one guard, or omit it to match any. The guard
narrows `error` to a `ConfigurationError` whose `details.code` is the passed
`RecordedCaptureGuardCode` (or the full union when no code is given), so no
untyped `details` spelunking is needed.

This composes with
[`tx.sqlAvailability`](/queries/temporal/#raw-sql-under-history-capture): the
discriminant tells a caller *why* `tx.sql` is unusable ahead of time
(`"history"` / `"revisionTracking"` vs. `"unavailable"` for a backend with no
transactions), while the guard code identifies a guard that has already thrown.
Between them, "history capture forbids raw SQL here" and "this backend has no
transactions" (which carries **no** guard code) are cleanly distinguishable
without catching-and-string-matching.

### `SchemaMismatchError`

Thrown when the database schema doesn't match the expected graph definition.

```typescript
try {
  const [store] = await createStoreWithSchema(graph, backend);
} catch (error) {
  if (error instanceof SchemaMismatchError) {
    console.log(error.category); // "system"
    console.log(error.details);
    // { graphId: "my-graph", expectedHash: "<hash>", actualHash: "<hash>" }
    console.log(error.suggestion);
    // "Run migrations to update the database schema..."
  }
}
```

### `MigrationError`

Thrown when schema migration fails due to breaking changes that require manual intervention.

```typescript
try {
  const [store] = await createStoreWithSchema(graph, backend);
} catch (error) {
  if (error instanceof MigrationError) {
    console.log(error.category); // "system"
    console.log(error.details);
    // { graphId: "my-graph", fromVersion: 3, toVersion: 4, reason: "Removed required field 'email' from Person" }
    console.log(error.suggestion);
    // "Review the breaking changes and perform manual migration if needed..."
  }
}
```

## Query Errors

### `UnsupportedPredicateError`

Thrown when using a query predicate that isn't supported by the current backend.

```typescript
// Using vector similarity on a backend without vector support:
try {
  await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.embedding.similarTo(queryVector, 10))
    .execute();
} catch (error) {
  if (error instanceof UnsupportedPredicateError) {
    console.log(error.category); // "system"
    console.log(error.suggestion);
    // "Use a backend that supports this predicate, or rewrite the query..."
  }
}
```

## Transaction Errors

### `TransactionClosedError`

Thrown when a statement reaches a transaction-scoped backend after its
transaction boundary has already returned.

A transaction pins one database connection, which carries one statement at a
time. When `store.transaction(...)` resolves or rejects, the driver emits
`COMMIT` or `ROLLBACK` on that connection and hands it back to the pool. Any
statement still in flight then has nowhere safe to go — it would execute inside
somebody else's transaction — so TypeGraph refuses it.

The usual source is a callback that lets work escape it. `Promise.all` rejects
on its first rejection while its siblings keep running:

```typescript
await store.transaction(async (tx) => {
  // If `a` fails, `b`'s remaining statements are orphaned.
  await Promise.all([tx.nodes.Doc.create(a), tx.nodes.Doc.create(b)]);
});
```

You will normally never see this error: `Promise.all` has already rejected with
the original failure and discards the orphan's. It surfaces only if you await
the orphaned promise yourself. To avoid orphaning writes at all, use
`Promise.allSettled` and inspect the results, or await the writes in sequence.

`adoptTransaction()` never closes its queue — only the caller knows when their
transaction ends — so this error cannot arise there. It remains the caller's
job to await every graph write before committing.

**The serialization covers TypeGraph's own statements, not `tx.sql`.** The raw
Drizzle handle you get for writing your own relational tables in the same
transaction shares the one pinned connection but bypasses the queue. Running a
raw statement concurrently with a graph write — or with another raw statement —
races two queries on that connection (the overlap `pg@9` removes), and the
boundary cannot drain a raw statement it never saw. Await each `tx.sql`
statement before the next write.

## Error Handling Patterns

### Using Error Utilities

TypeGraph provides utility functions for common error handling patterns:

```typescript
import {
  isTypeGraphError,
  isUserRecoverable,
  isConstraintError,
  isSystemError,
  getErrorSuggestion,
} from "@nicia-ai/typegraph";

try {
  await store.nodes.Person.create(data);
} catch (error) {
  if (!isTypeGraphError(error)) {
    // Not a TypeGraph error, handle differently
    throw error;
  }

  // Get suggestion regardless of error type
  const suggestion = getErrorSuggestion(error);

  if (isUserRecoverable(error)) {
    // User can fix this by providing different input
    return {
      error: error.toUserMessage(),
      suggestion,
    };
  }

  if (isConstraintError(error)) {
    // Business rule violation
    return {
      error: "This operation violates a constraint",
      details: error.details,
    };
  }

  if (isSystemError(error)) {
    // Infrastructure/configuration issue
    console.error(error.toLogString());
    throw error;
  }
}
```

### Catch Specific Errors

```typescript
import {
  ValidationError,
  NodeNotFoundError,
  DisjointError,
} from "@nicia-ai/typegraph";

try {
  await store.nodes.Person.create(data);
} catch (error) {
  if (error instanceof ValidationError) {
    // Handle validation failure with contextual details
    return {
      error: "Invalid data",
      issues: error.details.issues,
      entity: error.details.kind,
    };
  }
  if (error instanceof DisjointError) {
    // Handle constraint violation
    return { error: "ID already used by different type" };
  }
  throw error; // Re-throw unexpected errors
}
```

### Check Error Codes

```typescript
try {
  await store.nodes.Person.update(id, data);
} catch (error) {
  if (error instanceof TypeGraphError) {
    switch (error.code) {
      case "NODE_NOT_FOUND":
        return { error: "Person not found" };
      case "VALIDATION_ERROR":
        return { error: "Invalid data", issues: error.details.issues };
      default:
        throw error;
    }
  }
  throw error;
}
```

### Transaction Error Handling

```typescript
try {
  await store.transaction(async (tx) => {
    const person = await tx.nodes.Person.create({ name: "Alice" });
    const company = await tx.nodes.Company.create({ name: "Acme" });
    await tx.edges.worksAt.create(person, company, { role: "Engineer" });
  });
} catch (error) {
  // Transaction is automatically rolled back on any error
  if (error instanceof ValidationError) {
    console.log("Validation failed, transaction rolled back");
    console.log("Failed on:", error.details.kind, error.details.operation);
  }
  throw error;
}
```

## Contextual Validation Utilities

For library authors or advanced use cases, validation utilities are available from the schema sub-export:

```typescript
import {
  validateNodeProps,
  validateEdgeProps,
  wrapZodError,
  createValidationError,
} from "@nicia-ai/typegraph/schema";

// Validate node properties with full context
const validated = validateNodeProps(PersonSchema, inputData, {
  kind: "Person",
  operation: "create",
});

// Wrap a Zod error with TypeGraph context
try {
  schema.parse(data);
} catch (zodError) {
  throw wrapZodError(zodError, {
    entityType: "node",
    kind: "Person",
    operation: "update",
    id: "person-123",
  });
}
```

## Error Codes Reference

| Code | Error Class | Category | Description |
|------|-------------|----------|-------------|
| `VALIDATION_ERROR` | `ValidationError` | user | Schema validation failed |
| `DISJOINT_ERROR` | `DisjointError` | constraint | Disjointness constraint violated |
| `ENDPOINT_ERROR` | `EndpointError` | user | Invalid edge endpoint types |
| `CARDINALITY_ERROR` | `CardinalityError` | constraint | Cardinality constraint violated |
| `UNIQUENESS_VIOLATION` | `UniquenessError` | constraint | Uniqueness constraint violated |
| `NODE_NOT_FOUND` | `NodeNotFoundError` | user | Referenced node doesn't exist |
| `EDGE_NOT_FOUND` | `EdgeNotFoundError` | user | Referenced edge doesn't exist |
| `KIND_NOT_FOUND` | `KindNotFoundError` | user | Unknown node/edge type |
| `ENDPOINT_NOT_FOUND` | `EndpointNotFoundError` | user | Edge endpoint node doesn't exist |
| `RESTRICTED_DELETE` | `RestrictedDeleteError` | constraint | Delete blocked by existing edges |
| `CONFIGURATION_ERROR` | `ConfigurationError` | system | Invalid configuration |
| `SCHEMA_MISMATCH` | `SchemaMismatchError` | system | Database schema mismatch |
| `MIGRATION_ERROR` | `MigrationError` | system | Migration failed |
| `UNSUPPORTED_PREDICATE` | `UnsupportedPredicateError` | system | Predicate not supported |
