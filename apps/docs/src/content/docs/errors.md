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

#### `INVERTED_VALIDITY_WINDOW`

A `ValidationError` whose issue carries the exported code
`INVERTED_VALIDITY_WINDOW` refused a valid-time window of negative width: the
write's `validTo` precedes the row's effective `validFrom`, so the row would have
stopped being true before it started and no `asOf` coordinate could observe it.
Branch on the code rather than on the message.

```typescript
import { INVERTED_VALIDITY_WINDOW_CODE, ValidationError } from "@nicia-ai/typegraph";

try {
  // The stored validFrom is later than this end.
  await store.edges.worksAt.update(edgeId, {}, { validTo: "2020-01-01T00:00:00.000Z" });
} catch (error) {
  if (
    error instanceof ValidationError &&
    error.details.issues.some((issue) => issue.code === INVERTED_VALIDITY_WINDOW_CODE)
  ) {
    // Supply an explicit validFrom for a historical window, or drop validTo.
  }
}
```

Interchange import records the same refusal as a per-row error prefixed with the
code, so one bad row does not abort the import; trusted import refuses the whole
stream with `TrustedImportError` reason `invalid_stream`. A zero-width window
(`validTo === validFrom`) is legal and never raises this, and so is a create
carrying only a historical `validTo`.

#### `IMMUTABLE_VALIDITY_LOWER_BOUND`

A `ValidationError` whose issue carries the exported code
`IMMUTABLE_VALIDITY_LOWER_BOUND` refused a `validFrom` the write could not apply.
A live row's lower bound is history: an in-place update never rewrites
`valid_from`, so a bound naming a different instant is refused rather than
accepted and silently dropped. The message names both instants — the one stated
and the one the row stores — so you can restate the stored bound without a
second read.

```typescript
import { IMMUTABLE_VALIDITY_LOWER_BOUND_CODE, ValidationError } from "@nicia-ai/typegraph";

try {
  // The row is live and started at some other instant.
  await store.nodes.Person.upsertById(id, props, { validFrom: "2020-01-01T00:00:00.000Z" });
} catch (error) {
  if (
    error instanceof ValidationError &&
    error.details.issues.some(
      (issue) => issue.code === IMMUTABLE_VALIDITY_LOWER_BOUND_CODE,
    )
  ) {
    // Omit validFrom, or restate the bound the row already holds.
  }
}
```

What deliberately does not raise it:

- **Restating the stored bound.** Naming the instant the row already holds is
  accepted; there is nothing to apply and nothing being ignored.
- **A create, or a resurrection.** Both write a fresh window, so a stated
  `validFrom` is stored — that is the way to give a row a different lower bound.
- **`getOrCreateByEndpoints` returning an existing edge.** That branch performs
  no write, so its window options describe the row to create if none is found.

It reaches every path that accepts `validFrom` against a live row: `upsertById`,
`bulkUpsertById` (including a repeated id in one batch, judged against the row
the batch just queued), `getOrCreateByEndpoints` / `bulkGetOrCreateByEndpoints`
with `ifExists: "update"`, and interchange import's `onConflict: "update"` legs —
where, as with the inverted-window refusal, it is recorded as a per-row error
prefixed with the code rather than aborting the import.

#### `ENTITY_ALREADY_EXISTS`

A `ValidationError` whose issue carries the exported code
`ENTITY_ALREADY_EXISTS` refused a create because the id is already taken.
`details.entityType` says whether a node or an edge was refused and
`details.kind` names its kind.

```typescript
import { ENTITY_ALREADY_EXISTS_CODE, ValidationError } from "@nicia-ai/typegraph";

try {
  await store.nodes.Person.create({ name: "Alice" }, { id: takenId });
} catch (error) {
  if (
    error instanceof ValidationError &&
    error.details.issues.some((issue) => issue.code === ENTITY_ALREADY_EXISTS_CODE)
  ) {
    // Use a different id, or update the existing entity.
  }
}
```

The code is the same whichever layer noticed, on either backend. A node create
finds out from its own existence probe — but the probe and the INSERT are two
statements, and PostgreSQL does not serialize two write transactions under its
default READ COMMITTED isolation, so a concurrent create of the same NEW id can
commit in between and the engine refuses the INSERT instead. (SQLite's
`BEGIN IMMEDIATE` gives the writer slot to one transaction at a time, so its probe
always sees the winner's row.) An edge create has no existence probe at all, so
the engine's refusal is always what reports a taken edge id. All of these raise the
same error, so a caller retrying a generated id needs one branch, not several.

`details.id` names the taken id, and is present for every single-entity create.
It is absent only when the refused statement inserted more than one row: the
engine reports that the statement collided without saying which row did, and its
transaction is already aborted, so there is nothing left to probe. No race is
needed to reach that — a bulk create of edges, whose ids you supplied and which
nothing probes, is refused this way on every backend. Treat `details.id` as
optional if you create in bulk.

This is about identity, not values. A conflict on a declared `unique` constraint
raises `UniquenessError` instead, and a violated `unique: true` index declaration
surfaces as the engine's own failure — neither is reshaped into this error.

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

### `IdentityContradictionError`

Thrown when an identity mutation would make the assertion ledger contradictory —
for example asserting two nodes are the same after they were asserted different,
folding a same-class pair the ontology forbids, or importing an archive whose
assertions conflict with the target graph. Only raised on identity-enabled
graphs.

```typescript
try {
  await tx.identity.assertSame(alice, aliceCopy);
} catch (error) {
  if (error instanceof IdentityContradictionError) {
    console.log(error.code); // "IDENTITY_CONTRADICTION"
    console.log(error.category); // "constraint"
    console.log(error.details);
    // {
    //   operation: "assertSame",       // "assertSame" | "assertDifferent" | "fold" | "import"
    //   a: { kind: "Person", id: "..." },
    //   b: { kind: "Person", id: "..." },
    //   reason: "different-assertion", // "different-assertion" | "same-class" | "disjoint-kinds"
    //   conflictingAssertionId: "...", // present when an existing assertion conflicts
    //   conflictingKinds: ["Person", "Organization"], // present when reason is "disjoint-kinds"
    // }
    console.log(error.suggestion);
    // "Retract the conflicting identity assertion or correct the graph ontology before retrying."
  }
}
```

### `IdentityMergeConflictError`

Detected at merge **plan time** when the branches being merged carry opposing
or otherwise contradictory identity truth: one branch asserts a pair `same`
while another asserts it `different` (directly, or transitively through a
chain of `same` assertions no single branch ever wrote), a branch retracts an
assertion that a different branch reasserts under a new id (a retract/reassert
race — a branch that reasserts a pair it *also* retracted itself is
convergent, not a conflict, and merges cleanly), or a branch asserts an
identity relation over a node another branch deleted. Extends `MergeError`, so
an `instanceof MergeError` catch covers it alongside the other merge failures.

`merge()` and `IdentityMergeConflictError` are both exported from
`@nicia-ai/typegraph/graph-merge`, not the package root. `merge()` takes an
array of branches and never throws a `MergeError` — it **returns** a
`Result<MergeReport, MergeError>`:

```typescript
import { merge, IdentityMergeConflictError, isErr } from "@nicia-ai/typegraph/graph-merge";

const result = await merge(store, [branch]);
if (isErr(result)) {
  if (result.error instanceof IdentityMergeConflictError) {
    console.log(result.error.code); // "GRAPH_MERGE_IDENTITY_CONFLICT"
    console.log(result.error.details);
  }
  throw result.error;
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

#### Definition-time unique-constraint refusals

`defineGraph()` validates every node kind's `unique` constraints when the graph
is defined, rather than leaving a broken `where` clause to surface as odd
behavior on the first write. Two states are refused with `ConfigurationError`:

- A `where` callback that **does not return a predicate** — `details` carries
  `kind` and `constraintName`.
- A predicate naming a **field the kind's schema does not declare** — `details`
  adds `field` and `declaredFields`.

Both carry only the class-level code `CONFIGURATION_ERROR`; match them by class,
not by a `details.code`. The equivalent invariant on the graph-extension
document path does have a stable code, `UNKNOWN_UNIQUE_WHERE_FIELD`.

Because the check evaluates the clause, a `where` callback now runs once at
definition time in addition to its per-write evaluations — keep it pure. The
check applies to node kinds whose schema exposes an object shape; edge `unique`
constraints are not validated here. Statically typed callers were already unable
to name an undeclared field, so this bites untyped or generated definitions.

#### Operational Identity guard codes

Operational Identity lifecycle failures use stable `details.code` values on
`ConfigurationError`:

| `details.code` | Meaning |
| --- | --- |
| `IDENTITY_REQUIRES_ATOMIC_BACKEND` | The selected adapter cannot provide the interactive transaction required by identity writes. |
| `IDENTITY_REQUIRES_STATEMENT_EXECUTION` | The backend cannot execute the raw statements Operational Identity issues internally. |
| `IDENTITY_NOT_ENABLED` | `store.identity`, `tx.identity`, `StoreView.identity`, or an identity-expanded query option was reached on a graph without `identity: { ... }` — normally caught at compile time; this is the runtime guard for a widened or `any`-typed handle. |
| `IDENTITY_STORAGE_MISSING` | An identity relation disappeared after enablement, or exists without this graph's fill. Restore ledgers, or recreate and rebuild the derived closure, before serving traffic. `details.reason: "unfilled"` marks the second case: the separation relation is present but holds no row for this graph while the ledger holds a live `different` assertion across two distinct identity classes — reopen the Store (the open runs the fill) or run `rebuildIdentityClosure(store)`. A Store handle opened while the relation did not exist keeps failing until it is reopened, which is deliberate: the alternative is a confident "not separated" the moment another graph's upgrade creates the shared relation. |
| `IDENTITY_UPGRADE_REQUIRES_ATOMIC_DDL` | The backend cannot publish the derived separation relation's upgrade — the `CREATE` and the fill — as one commit, on a graph that owes rows. `details.missingPorts` names what is absent: `schemaWriteTransaction` / `identityTableDdl` on the fenced path, or `executeSchemaDdl` on the schema-commit path. Refused rather than degraded, because a relation created empty and filled afterwards reads as "nothing is separated" in between. Both bundled Drizzle backends implement all three when transactions are enabled, so this is a custom-backend path. |
| `IDENTITY_ENABLEMENT_PENDING` | First enablement is pending because `autoMigrate` is disabled. |
| `IDENTITY_PROFILE_MIGRATION_PENDING` | A `sameIdAcrossKinds` change (a breaking `fold`↔`ignore` flip, or disabling identity) has not been applied — either it is breaking, or `autoMigrate` is disabled. |
| `IDENTITY_SCHEMA_MIGRATION_PENDING` | An identity-relevant ontology change is pending because `autoMigrate` is disabled. |
| `IDENTITY_SEPARATION_VIOLATION` | The derived separation relation refused a write that would place both endpoints of a current `different` assertion in one identity class. The database-level backstop beneath identity validation; reaching it means an earlier guard let a contradiction through. |
| `IDENTITY_TRANSACTION_NOT_WRITE_FENCED` | SQLite refused an identity write because the enclosing transaction was begun `DEFERRED` and another connection committed before it could take the writer slot. Only reachable through `store.withTransaction(externalTx)` / `store.withRecordedTransaction(externalTx)`, where the caller owns the `BEGIN` — TypeGraph's own transactions open `BEGIN IMMEDIATE` and hold the slot from the start. SQLite cannot upgrade a stale snapshot in place, so roll back and re-run the transaction, opening it with `BEGIN IMMEDIATE`. |
| `IDENTITY_SCHEMA_CONTRADICTION` | Existing nodes or assertions contradict the proposed identity profile or ontology, or the materialized closure disagrees with the assertions it was derived from. Run `rebuildIdentityClosure(store)` to recover from a closure mismatch. |
| `IDENTITY_IMPORT_REQUIRES_PROFILE` | An interchange document carries an `identity` section but the target graph does not have the profile enabled. |
| `IDENTITY_MERGE_REQUIRES_PROFILE` | A branch carries identity changes but the merge target graph does not have the profile enabled. |
| `IDENTITY_IMPORT_ID_CONFLICT` | An imported assertion id already exists in the target ledger identifying different truth (relation, endpoints, or validity window). |
| `RECORDED_IDENTITY_SCHEMA_MISSING` | A `history: true` open of an identity-enabled graph could not find the recorded identity relation. Bundled backends provision it, so this is rare there and more likely on a custom backend. |

When an unapplied migration's **only** breaking change is the identity one, the
specific pending code above wins over the generic `MigrationError` (which is
attached as `cause`); a diff that also breaks nodes, edges, ontology, or
indexes raises the generic `MigrationError` enumerating all of them.

Identity import also raises `ValidationError` with one of these
`details.issues[].code` values when an interchange document's `identity`
section fails shape or integrity checks. Each issue carries the offending
assertion's id structurally in `details.issues[].assertionId`, and
`importGraph`/`importGraphStream` record these failures as
`entityType: "identity"` entries in `result.errors` (a self-assertion —
`IDENTITY_SELF_ASSERTION` — included) rather than throwing:

| Issue `code` | Meaning |
| --- | --- |
| `IDENTITY_IMPORT_UNKNOWN_KIND` | An assertion endpoint names a node kind not in the target graph's registry. |
| `IDENTITY_IMPORT_PAIR_NOT_NORMALIZED` | An assertion's `a`/`b` endpoints are not in code-point order. |
| `IDENTITY_STATE_IMPORT_ENDED_ASSERTION` | A `state`-mode import (the default) contains an already-ended assertion; use `identityMode: "archival"` on export to carry ended assertions. |
| `IDENTITY_IMPORT_FUTURE_VALID_FROM` | An open (current) assertion's `validFrom` is in the future, in either import mode. |
| `IDENTITY_IMPORT_FUTURE_VALID_TO` | An ended assertion's `validTo` is in the future. |
| `IDENTITY_IMPORT_INVALID_WINDOW` | An assertion's `validTo` precedes its `validFrom`. |
| `IDENTITY_IMPORT_ENDED_BY_WITHOUT_END` | An assertion names an `endedBy` cause but carries no `validTo`; only an ended assertion has a cause. |
| `IDENTITY_IMPORT_ENDED_BY_NOT_ENDPOINT` | An assertion's `endedBy` names a node that is not one of its own endpoints; a deletion cascade only ends assertions that touch the deleted node. |
| `IDENTITY_SELF_ASSERTION` | An assertion's `a` and `b` name the same node. |

#### Merge provenance sidecar codes

`persistProvenance: true` writes to a *sidecar* graph beside the merge target,
and `openProvenanceStore` refuses any sidecar graph id it cannot prove it owns.
Both refusals are `ConfigurationError`s with a stable `details.code`, and both
carry `details.graphId` (the sidecar id) and `details.targetGraphId`:

| `details.code` | Meaning |
| --- | --- |
| `GRAPH_MERGE_PROVENANCE_ID_COLLISION` | The sidecar graph id is occupied by something this library did not write. `details.reason` names which state was found, and the suggestion is specific to it. |
| `GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED` | The backend exposes no transactional schema fence (`schemaWriteTransaction`), so the id's emptiness check and its ownership-marker write cannot commit as one unit. Not a collision — the id may well be free. An already-owned sidecar still opens on such a backend, so read-only use of an existing sidecar stays available. |

The five `details.reason` values on `GRAPH_MERGE_PROVENANCE_ID_COLLISION`:

| `details.reason` | The state that was found |
| --- | --- |
| `application-graph` | The id holds rows (in any per-graph table) or a schema that is not the sidecar's, so it belongs to an application. Rename the colliding graph or point the merge elsewhere. |
| `empty-legacy-sidecar` | A pre-marker sidecar with no rows at all, which carries no evidence of authorship and is indistinguishable from an application graph of the same shape. |
| `unupgradeable-legacy-sidecar` | A pre-marker sidecar whose rows do not verify as provenance this library wrote for *this* target, so it cannot be upgraded to an owned sidecar. |
| `unowned-exact-schema-graph` | The current sidecar schema with no ownership marker. Because the marker is written *first*, this library cannot have produced this state; contents are not consulted, so an empty or provenance-shaped occupant is refused too. |
| `corrupt-ownership-marker` | A `ProvenanceOwner` row that is not a valid live claim for this target — soft-deleted, schema-invalid, naming a different target, or stored under a different row id. It is never overwritten or resurrected, because it may be an application's row. |

Under `persistProvenance: true` these arrive wrapped: the sidecar is opened and
claimed **before** the merge commits, and either code refuses the merge as an
`InvalidMergeOptionsError` (`details.option: "persistProvenance"`,
`details.provenanceErrorCode` echoing the code above, the `ConfigurationError`
as `cause`) with the target left unmodified. Only transient row-write failures
after the commit degrade to a `warnings` entry.

#### Interchange serialized-connection guard codes

Two long-lived interchange streams cannot share one serialized database
connection: an export snapshot holds a read transaction for the whole stream and
a streaming import writes a transaction per chunk on that same connection, so
the second one either nests a `BEGIN` or waits for a slot that never frees. The
lease is **exclusive** — one stream of any kind per connection — so all four
pairings refuse with a `ConfigurationError` rather than hanging:

| `details.code` | Raised when |
| --- | --- |
| `INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT` | An export snapshot holds the connection, detected through the shared serialized resource the two backend wrappers were marked with. |
| `INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT` | The same condition, reported by the object-identity detector: one SQLite backend is exporting into itself. Worth telling apart because the fix differs — pass a second backend rather than await whatever else is running. |
| `INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS` | A streaming import holds the connection, in either order of discovery. |

The code names *what holds the connection*; `details.requested` and
`details.heldBy` (each `"export-snapshot"` or `"import-stream"`) name which
pairing was actually refused, so a same-kind refusal is never reported as
something it is not. `details.graphId` names the graph the refused stream was
for.

`"import-stream"` is the kind of every long-lived import, not only
`importGraphStream`: `importGraph` holds the lease for the whole call, and
`trustedImportGraph` / `trustedImportGraphStream` hold it for the whole trusted
session — so those APIs throw this `ConfigurationError` as well as their own
`TrustedImportError`. Connections TypeGraph cannot observe are not refused: two
clients dialed at one server, or two SQLite handles on one file, are genuinely
independent. See
[Scaling branches and interchange](/graph-merge#scaling-branches-and-interchange)
for which drivers are recognized as serialized.

#### `ExportStreamCancelledError`

An export stream whose `signal` fires settles with `ExportStreamCancelledError`
(`code: "INTERCHANGE_EXPORT_STREAM_ABORTED"`) rather than a silent end of stream,
so a consumer never mistakes a cancelled export for a complete one. It is thrown
only *after* the snapshot transaction has been rolled back and the connection's
stream lease released, so receiving it means the connection is already free.
`details.graphId` names the exported graph and `cause` carries the signal's own
`reason` when the caller supplied one. A signal that is already aborted refuses
the export before any transaction is opened. See
[Cancelling an export](/interchange#cancelling-an-export).

#### Recorded-capture guard codes

`ConfigurationError` is intentionally open-shaped, but the guards that fire on a
`history: true` / `revisionTracking: true` store carry a **stable, branchable
`details.code`** so a portable caller does not have to substring-match the
message. The three codes are exported as a set, `RECORDED_CAPTURE_GUARD_CODES`,
and reachable through the `isRecordedCaptureGuardError` type guard:

| `details.code` | Raised when |
|----------------|-------------|
| `RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION` | `store.withTransaction(externalTx)` on a history-enabled store — it has no flush point before the caller commits. Use `store.withRecordedTransaction(externalTx, fn)`. (Also a compile error on an `AdapterHistoryStore`.) |
| `RECORDED_CAPTURE_RAW_SQL_DISABLED` | A raw SQL escape (`tx.sql`, `backend.executeStatement` / `executeDdl`) on a history-enabled store, where it would bypass recorded-time capture. |
| `REVISION_TRACKING_RAW_SQL_DISABLED` | The same raw SQL escape on a revision-tracked store, where it would bypass the revision anchor. |

Typed code cannot call `withTransaction` on an `AdapterHistoryStore`; use
`withRecordedTransaction` directly. The runtime code remains useful at
JavaScript and deliberately untyped boundaries. If one of those boundaries
throws, `isRecordedCaptureGuardError(error,
"RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION")` narrows both the error and
its `details.code` without message matching.

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
| `IDENTITY_CONTRADICTION` | `IdentityContradictionError` | constraint | Identity mutation would make the assertion ledger contradictory |
| `GRAPH_MERGE_IDENTITY_CONFLICT` | `IdentityMergeConflictError` | system | Branches carry opposing identity truth |
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
| `UNSUPPORTED_BACKEND_CAPABILITY` | `UnsupportedBackendCapabilityError` | user | The backend does not advertise a capability the call needs. `details.capability` names it — for example `vector.searchFrontierTuning` for `efSearch` on any SQLite vector or hybrid search, where the engine has no per-search ANN frontier, with `details.reason` naming the limitation |
| `INTERCHANGE_EXPORT_STREAM_ABORTED` | `ExportStreamCancelledError` | user | An export stream's `signal` fired; its snapshot transaction was rolled back and the connection's stream lease released before the error was raised |
