---
title: Graph Interchange
description: Import and export graph data for backups, migrations, and external integrations
---

TypeGraph provides a standardized interchange format for importing and exporting
graph data. Use it for:

- Backing up and restoring graph data
- Migrating data between environments
- Exchanging data with external systems

## Quick Start

```typescript
import { importGraph, exportGraph, GraphDataSchema } from "@nicia-ai/typegraph/interchange";

// Export your graph
const backup = await exportGraph(store);

// Import into another store
const result = await importGraph(targetStore, backup, {
  onConflict: "update",
  onUnknownProperty: "strip",
});

console.log(`Imported ${result.nodes.created} nodes, ${result.edges.created} edges`);
```

## Interchange Format

The interchange format is a JSON structure validated by Zod schemas. You can use
`GraphDataSchema` to validate data before import, or export the schema as JSON
Schema for API documentation.

```typescript
import { GraphDataSchema } from "@nicia-ai/typegraph/interchange";

// Validate incoming data
const validated = GraphDataSchema.parse(jsonData);

// Export as JSON Schema for API docs
import { toJSONSchema } from "zod";
const jsonSchema = toJSONSchema(GraphDataSchema);
```

### Format Structure

```typescript
interface GraphData {
  formatVersion: "2.0";
  exportedAt: string; // ISO datetime
  source: {
    type: "typegraph-export" | "external";
    // Additional source-specific fields
  };
  nodes: Array<{
    kind: string;
    id: string;
    properties: Record<string, unknown>;
    validFrom?: string | null;
    validTo?: string;
    meta?: {
      version?: number;
      createdAt?: string;
      updatedAt?: string;
    };
  }>;
  edges: Array<{
    kind: string;
    id: string;
    from: { kind: string; id: string };
    to: { kind: string; id: string };
    properties: Record<string, unknown>;
    validFrom?: string | null;
    validTo?: string;
    meta?: {
      createdAt?: string;
      updatedAt?: string;
    };
  }>;
  identity?: {
    profile: "typegraph-identity-v1";
    mode: "state" | "archival";
    assertions: Array<{
      id: string;
      relation: "same" | "different";
      a: { kind: string; id: string };
      b: { kind: string; id: string };
      validFrom: string;
      validTo?: string;
    }>;
  };
}
```

`validFrom` has three states: the key **absent** means it wasn't requested
(`includeTemporal: false`, the default) — import defaults it to the
import's own creation timestamp, unless the record also states a `validTo`
at or before that instant, in which case it is imported with no lower bound
("ended at T, start unknown") rather than one past its own end. An
**explicit `null`** means the source row is confirmed to have no lower bound
(open-left validity) — import preserves that instead of re-stamping it. A
**string** is an explicit value, carried through unchanged.

### Format Version Compatibility

Exports always write `formatVersion: "2.0"`. The read side — both
`importGraph`/`importGraphStream` and `GraphDataSchema.parse` — additionally
accepts `"1.0"`. A 1.0 document is structurally a valid 2.0 document: the only
2.0 change is the additive optional `identity` section, so pre-existing 1.0
exports validate and import unchanged. You never need to rewrite the version
field of an older backup; validation and import handle both.

## Exporting Data

Use `exportGraph` to serialize your graph data:

```typescript
import { exportGraph } from "@nicia-ai/typegraph/interchange";

// Export everything
const fullExport = await exportGraph(store);

// Export specific node kinds
const peopleOnly = await exportGraph(store, {
  nodeKinds: ["Person", "Organization"],
});

// Export specific edge kinds
const relationshipsOnly = await exportGraph(store, {
  edgeKinds: ["worksAt", "knows"],
});

// Include metadata (version, timestamps)
const withMeta = await exportGraph(store, {
  includeMeta: true,
});

// Include temporal fields (validFrom, validTo)
const withTemporal = await exportGraph(store, {
  includeTemporal: true,
});

// Include soft-deleted records
const withDeleted = await exportGraph(store, {
  includeDeleted: true,
});

// Identity-enabled graphs export current assertions by default.
// Include ended assertion history explicitly:
const archival = await exportGraph(store, {
  identityMode: "archival",
});

// A self-contained archive pairs archival identity with includeDeleted:
const selfContainedArchive = await exportGraph(store, {
  identityMode: "archival",
  includeDeleted: true,
});
```

**Archival identity and soft-deleted endpoints:** `identityMode: "archival"`
also exports *ended* assertions, and an ended assertion can reference an
endpoint that was later soft-deleted. A default export (`includeDeleted:
false`) joins every assertion against its endpoints' live rows, so an
assertion touching a soft-deleted endpoint is silently **dropped from the
export** — not carried with a dangling reference. This is silent archive
loss, not a dangling-endpoint problem. When the archive must stand alone
(backup, cold storage), pair it with `includeDeleted: true` so those
assertions and their endpoints travel with it.

That pairing has its own honest trade-off: the interchange format has no
`deletedAt` field, so a node included only because of `includeDeleted: true`
carries no record that it was deleted. Re-importing that archive resurrects
the node as **live**. Choose deliberately: without `includeDeleted`, a
backup silently loses soft-deleted endpoints and the assertions referencing
them; with it, those nodes come back alive on restore.

On import, every ended assertion's endpoints must exist as node rows in the
target (soft-deleted rows qualify) — historical reads conduct identity
through ended assertions, so an endpoint that never existed would become a
phantom bridge joining real nodes at past coordinates. The store's own
exports satisfy this by construction; a hand-built document that fails it is
recorded as an `entityType: "identity"` entry in `result.errors`.

### Export Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `nodeKinds` | `string[]` | all | Filter to specific node types |
| `edgeKinds` | `string[]` | all | Filter to specific edge types |
| `includeMeta` | `boolean` | `false` | Include version and timestamps |
| `includeTemporal` | `boolean` | `false` | Include validFrom/validTo fields |
| `includeDeleted` | `boolean` | `false` | Include soft-deleted records |
| `identityMode` | `"state" \| "archival"` | `"state"` | Export current identity assertions, or current plus ended assertions |
| `signal` | `AbortSignal` | none | Cancel the export: roll its snapshot transaction back and release the connection. See [Cancelling an export](#cancelling-an-export) |

`exportGraphStream` also accepts `idleTimeoutMs`, a positive integer with no
default. It bounds how long a delivered chunk may remain unacknowledged before
the stream settles itself. The clock stops as soon as the consumer requests the
next chunk, so a slow database read does not count as consumer idleness.

**Round-trip caveat:** with the default `includeTemporal: false`, exported
records carry no `validFrom`/`validTo`. On import, an omitted `validFrom`
defaults to the *import's own* creation timestamp (a born-already-ended record
is the exception noted above, and keeps no lower bound) — so a plain
`exportGraph` + `importGraph` round trip does **not** reproduce the
source's original valid-time window; every imported record becomes valid
from import time forward. Pass `includeTemporal: true` on export when the
clone needs to match the source's `asOf` behavior exactly (this is what
`branch()` does internally).

Identity-enabled graphs are the exception: their exports default temporal
fields on, because assertion windows cannot be validated against endpoints
without the endpoint bounds. Explicit `includeTemporal: false` is refused for
those graphs.

**Repair a legacy graph before exporting it.** A row an older library version
stored with a backwards window (`valid_from > valid_to`) exports as it is stored
and is then refused **per row** on re-import, because the import validates the
stated pair — so an unrepaired graph does not round-trip. Run
[`repairInvertedValidityWindows`](/schema-management#repairing-inverted-validity-windows)
first; it normalizes those rows to the open-left shape import accepts.

**`includeTemporal: true` with `onConflict: "update"`:** an update leg sends the
document's `validTo` and never its `validFrom`, because a live row's lower bound
is history. A document whose `validFrom` names a different instant than the
target row holds is therefore stating a bound the import will not apply, and that
row is reported as a per-row error carrying
[`IMMUTABLE_VALIDITY_LOWER_BOUND`](/errors/#immutable_validity_lower_bound)
rather than updated under a bound it ignored. This is reachable whenever a
temporal export is replayed over rows that were created separately — the same
document imported into a fresh graph creates those rows with their stated bounds
and is unaffected. To update props over existing rows from a temporal export,
either omit `validFrom` from the update document, export with
`includeTemporal: false`, or import into a fresh graph and swap it in.

### Cancelling an export

On a backend reporting `capabilities.transactions`, an export holds one
repeatable-read snapshot transaction for its whole life, and on a
single-connection backend it holds that connection's exclusive
interchange-stream lease with it. (A backend without transactions — SQLite
`transactionMode: "none"`, the session-less HTTP Postgres drivers — opens
neither: its export paginates statement by statement, so a write committed
mid-stream can appear in the pages that follow. That is a declared capability
gap, not something the stream papers over.) Every *cooperative* exit gives both back,
because each one runs the stream's `finally`: `break` or `throw` out of a `for
await`, and an explicit `iterator.return()`.

A consumer that pulls `next()` and then simply **drops the iterator** has no
cooperative exit. Async-generator `finally` blocks do not run on garbage
collection, so that snapshot transaction stays open for the life of the process
— and on a serialized connection every later export and every later import is
then refused for a stream nobody is reading. If you might abandon an iterator,
pass a `signal` or configure an idle timeout:

```typescript
const controller = new AbortController();
const iterator = exportGraphStream(store, {
  batchSize: 1000,
  signal: controller.signal,
  idleTimeoutMs: 30_000,
})[Symbol.asyncIterator]();

try {
  for (;;) {
    const next = await Promise.race([
      iterator.next(),
      deadline(30_000), // resolves to a sentinel, leaving the pull in flight
    ]);
    if (next === TIMED_OUT) {
      // Do NOT just walk away: this is the leak. Aborting rolls the snapshot
      // back and frees the connection.
      controller.abort(new Error("export deadline exceeded"));
      break;
    }
    if (next.done === true) break;
    await write(next.value);
  }
} finally {
  controller.abort();
}
```

Aborting rejects the pull that is in flight — and any later pull from a consumer
that walked away and came back — with
[`ExportStreamCancelledError`](/errors#exportstreamcancellederror), carrying the
signal's own reason as `cause`, so a cancelled export is never mistaken for a
complete one. The message states what was actually settled: a snapshot rolled
back and a connection released on a transactional backend, or merely abandoned
reads on one that never held either. Aborting a signal *before* the first pull refuses the export
outright: no transaction is opened and no lease claimed. Aborting one that has
already finished does nothing, so a single controller can safely span a whole
job. `exportGraph` accepts `signal` too — there it simply makes the call reject
instead of running to completion.

When `idleTimeoutMs` expires, a later pull rejects with
[`ExportStreamIdleTimeoutError`](/errors#exportstreamidletimeouterror), with code
`"INTERCHANGE_EXPORT_STREAM_IDLE_TIMEOUT"`. Its `details.graphId` and
`details.idleTimeoutMs` identify the stream and configured bound. The timeout is
stream-only: `exportGraph` owns and promptly advances its internal consumer, so
it accepts `signal` but not `idleTimeoutMs`. The option has no default because a
stream may intentionally spend an unbounded amount of time processing a chunk;
callers that cannot choose a safe idle bound should retain an `AbortController`
and abort on their own job deadline instead.

There is deliberately no garbage-collection fallback. A `FinalizationRegistry`
cannot close this gap: any cleanup state able to settle an abandoned stream has
to reach the stream's internals, and a registry holds its state strongly, so
doing so would keep the abandoned stream reachable and the finalizer would never
run. Explicit cancellation and the idle timeout are the mechanisms.

## Importing Data

Use `importGraph` to load data into a store:

```typescript
import { importGraph } from "@nicia-ai/typegraph/interchange";

const result = await importGraph(store, data, {
  onConflict: "update",
  onUnknownProperty: "strip",
  validateReferences: true,
  batchSize: 1000,
});

if (result.success) {
  console.log(`Created: ${result.nodes.created} nodes, ${result.edges.created} edges`);
  console.log(`Updated: ${result.nodes.updated} nodes, ${result.edges.updated} edges`);
  console.log(`Skipped: ${result.nodes.skipped} nodes, ${result.edges.skipped} edges`);
  console.log(`Identity: ${result.identity.created} created, ${result.identity.skipped} skipped`);
} else {
  console.error("Import had errors:", result.errors);
}
```

When the document carries an `identity` section, `result.identity` reports
`{ created, skipped }` counts for imported assertions (skipped covers an
exact re-import of an assertion that already exists under the same id).
A rejected assertion — an unknown endpoint, a contradiction against the
target's existing identity truth, or a reused assertion id that names
different truth — is recorded in `result.errors` with `entityType:
"identity"`, `kind` set to the assertion's relation (`"same"` or
`"different"`), and `id` set to the assertion id, mirroring how node/edge
errors carry `kind`/`id`.

**Partial-commit caveat:** identity assertions are applied one at a time, and
a mid-batch failure (a contradiction or id conflict partway through the
`identity.assertions` array) stops the identity import but does not roll back
the assertions already applied before it — they remain committed. They are
**not** reflected in `result.identity.created`, since that count is only
reported on success; the count under-reports rather than invents a number for
committed-but-unaccounted work. The failure that stopped the batch is the one
error entry you see in `result.errors`.

### Import Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onConflict` | `"skip" \| "update" \| "error"` | required | How to handle existing entities |
| `onUnknownProperty` | `"error" \| "strip" \| "allow"` | `"error"` | How to handle extra properties |
| `validateReferences` | `boolean` | `true` | Verify edge endpoints exist |
| `batchSize` | `number` | `1000` | Batch size for database operations. Each batch pays fixed per-round-trip costs, so undersized batches slow client/server imports; inserts are still split by the driver bind budget internally. |

### Trusted initial import

`trustedImportGraph` and `trustedImportGraphStream` are a separate,
intentionally trusted path for loading a fresh dedicated database. They do not
turn off validation on `importGraph`; they bypass the normal store write
pipeline entirely.

```typescript
import {
  trustedImportGraphStream,
  type GraphInterchangeChunk,
} from "@nicia-ai/typegraph/interchange";

async function* chunks(): AsyncIterable<GraphInterchangeChunk> {
  yield { type: "header", header };
  for await (const nodes of readNodeBatches()) {
    yield { type: "nodes", nodes };
  }
  for await (const edges of readEdgeBatches()) {
    yield { type: "edges", edges };
  }
}

const result = await trustedImportGraphStream(store, chunks());
console.log(result); // { nodes: 1000000, edges: 5000000 }
```

The contract is deliberately narrow:

- The TypeGraph node and edge tables must be globally empty. A different graph
  in the same database also makes the database non-empty.
- The caller guarantees property shapes, endpoint existence, edge endpoint
  types, cardinality, and duplicate-free IDs. Only stream ordering and known
  kind names are checked.
- Recorded-time history, revision tracking, node uniqueness constraints,
  `searchable()` fields, and `embedding()` fields are rejected in this first
  version because their sidecar writes would otherwise be skipped.
- Identity-enabled target stores are rejected with
  `details.reason === "identity_unsupported"`; identity-bearing input is
  rejected with `details.reason === "invalid_stream"`. The trusted session
  writes only the node and edge relations, so it cannot persist assertions or
  materialize the derived closure — refusing both cases keeps identity truth
  from being silently dropped. Use `importGraphStream` for an export that
  carries identity.
- Nodes must precede edges. The `meta` timestamps and node version in an
  interchange row are not restored; the import creates new storage metadata.
- The complete stream is one transaction. Data insertion, temporary secondary
  index removal, index rebuilding, and planner statistics either all commit or
  all roll back.
- A schema-managed Store acquires and validates its schema-write fence inside
  that transaction before loading rows. A stale managed import fails before
  row DML; a raw Store remains explicitly outside the schema-fencing guarantee.

Supported native paths are synchronous prepared-statement SQLite
(`better-sqlite3` and Bun SQLite) and transaction-capable PostgreSQL adapters
with raw execution support (including node-postgres, postgres.js, and PGlite).
Remote libSQL/Turso, D1, and HTTP-only PostgreSQL adapters reject the call with
`TrustedImportError` and `details.reason === "backend_unsupported"`.

Use `importGraph`/`importGraphStream` for external or uncertain data, conflict
handling, incremental loads, and any graph with the unsupported features above.
Use collection `bulkInsert` when the data is trusted but the database is not a
fresh dedicated target.

### Conflict Strategies

**`skip`** - Keep existing data, ignore incoming:

```typescript
// Useful for incremental imports where you don't want to overwrite
await importGraph(store, data, { onConflict: "skip" });
```

**`update`** - Merge incoming data into existing:

```typescript
// Useful for syncing updates from an external source
await importGraph(store, data, { onConflict: "update" });
```

**`error`** - Fail if any entity already exists:

```typescript
// Useful for initial imports where duplicates indicate a problem
await importGraph(store, data, { onConflict: "error" });
```

#### An edge id held by a different edge

Edge ids are unique per graph, but the import's existence probe (`getEdge` /
`getEdges`) is keyed on `(graph_id, id)` alone. So a document edge whose id is
already held by a row with a different **immutable identity** — its `kind` or
either of its endpoints — finds that row. That question — *is this the same
edge?* — is prior to *what do we do about the same edge?*, so it is answered
**before** the conflict strategy and all three strategies answer alike: the row
is reported as a per-row entry in `result.errors`, whose `error` message is
prefixed `INTERCHANGE_EDGE_KIND_CONFLICT` and names each component that differs
alongside the value the document stated. The stored row is left untouched.

```typescript
const result = await importGraph(store, data, { onConflict: "update" });
const identityConflicts = result.errors.filter((entry) =>
  entry.error.startsWith("INTERCHANGE_EDGE_KIND_CONFLICT"),
);
```

One prefix covers the whole class rather than a second one for endpoint
mismatches: the condition is a single fact and the recovery is a single action,
and a caller that had to match two prefixes to catch one condition would
eventually match only one. The token still reads `…_KIND_CONFLICT` because it is
the published, branchable string; it now covers every identity component.

`ImportError` carries no `code` field, so the message prefix is the branchable
token — the same `CODE: message` idiom the validity-window import refusals use.
Give the incoming edge a distinct id, or import it under the identity the stored
row already carries.

Previously both non-`error` strategies were silent about this: `update` wrote
the incoming edge's properties onto the *other* row with nothing in
`result.errors`, and `skip` counted the document's edge as already present when
no matching edge existed anywhere — so it was never created and never reported.
Comparing `kind` alone closed only half of it: because endpoints are immutable,
a document naming the incumbent's kind and id but different endpoints still read
as the same edge, so `update` overwrote the incumbent's properties and silently
retained its old endpoints. The update is additionally issued with all five
identity components in the statement's own `WHERE`, so the check cannot be raced
by a concurrent hard-delete-and-recreate; an update that consequently matches no
row is reported as the same per-row error rather than aborting the import.

Nodes were never affected: their probe is `getNode(graphId, kind, id)`, which is
kind-scoped, so a cross-kind id collision simply reads as absent.

#### An update target that changed under the import

`onConflict: "update"` is a read-then-write pair: the import probes the stored
row, validates the document's validity window against that row's `valid_from`,
and then writes. Every part of that verdict is restated in the UPDATE's own
`WHERE` — for edges the five identity components above, and for **both** nodes
and edges the effective validity lower bound, whenever the window check actually
read it. A concurrent hard-delete-and-recreate between the probe and the write
therefore matches no row instead of landing a decision computed for a row that
is gone (which would have ignored a `validFrom` the document stated, or
persisted a `validTo` below the new row's `validFrom`).

The bound is read — and so restated — when the document states a `validFrom` to
compare against it, or a lone `validTo` to check for an inverted window. A
document that states **neither** makes no claim about the row's window, so its
properties update is not fenced on the bound and a concurrent recreate that only
moved the bound does not refuse it. This matches `store.nodes.*.update` exactly:
a write asserts what its decision read, and nothing more.

A write that matches no row is reported per row, so an import whose earlier
rows are already written is not aborted for it:

```typescript
const result = await importGraph(store, data, { onConflict: "update" });
const raced = result.errors.filter(
  (entry) =>
    entry.error.startsWith("INTERCHANGE_NODE_UPDATE_TARGET_CHANGED") ||
    entry.error.startsWith("INTERCHANGE_EDGE_KIND_CONFLICT"),
);
```

`INTERCHANGE_NODE_UPDATE_TARGET_CHANGED` is the node-side prefix;
edges reuse `INTERCHANGE_EDGE_KIND_CONFLICT`, whose message now also names the
validity lower bound. Re-export the source and retry.

A node update refused this way leaves no partial trace, and neither does one
refused for a uniqueness conflict. The row write and the uniqueness transition
are one unit: the new keys are claimed first (the claim is what decides the
conflict), the row write follows, and the old keys are released only once it
lands — with the claims given back if it does not. Fulltext and embedding
sidecars are written only after the row update reports a match. So a row that
`result.errors` reports is a row the import did not change, even though the
transaction around it commits.

### Unknown Property Handling

When importing data that has properties not defined in your schema:

**`error`** - Reject the import (default, safest):

```typescript
await importGraph(store, data, { onUnknownProperty: "error" });
// Throws if data has { name: "Alice", unknownField: "value" }
```

**`strip`** - Remove unknown properties silently:

```typescript
await importGraph(store, data, { onUnknownProperty: "strip" });
// { name: "Alice", unknownField: "value" } becomes { name: "Alice" }
```

**`allow`** - Pass through to storage:

```typescript
await importGraph(store, data, { onUnknownProperty: "allow" });
// Behavior depends on your database and schema strictness
```

## Backup and Restore

### Creating Backups

```typescript
import { exportGraph } from "@nicia-ai/typegraph/interchange";
import fs from "fs/promises";

async function createBackup(store: Store, backupDir: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `backup-${timestamp}.json`;

  const data = await exportGraph(store, {
    includeMeta: true,
    includeTemporal: true,
  });

  await fs.writeFile(
    `${backupDir}/${filename}`,
    JSON.stringify(data, null, 2)
  );

  return filename;
}
```

### Restoring from Backup

```typescript
import { importGraph, GraphDataSchema } from "@nicia-ai/typegraph/interchange";
import fs from "fs/promises";

async function restoreBackup(store: Store, backupPath: string) {
  const json = await fs.readFile(backupPath, "utf-8");
  const data = GraphDataSchema.parse(JSON.parse(json));

  const result = await importGraph(store, data, {
    onConflict: "update", // or "error" for clean restore
    onUnknownProperty: "error",
  });

  if (!result.success) {
    throw new Error(`Restore failed: ${result.errors.map(e => e.error).join(", ")}`);
  }

  return result;
}
```

## Migration Between Environments

Move data from development to staging, or staging to production:

```typescript
import { createStore } from "@nicia-ai/typegraph";
import { exportGraph, importGraph } from "@nicia-ai/typegraph/interchange";
import { graph } from "./schema";

async function migrateData(
  sourceBackend: GraphBackend,
  targetBackend: GraphBackend,
) {
  const sourceStore = createStore(graph, sourceBackend);
  const targetStore = createStore(graph, targetBackend);

  // Export from source
  const data = await exportGraph(sourceStore);

  // Import to target
  const result = await importGraph(targetStore, data, {
    onConflict: "error", // Ensure clean migration
    onUnknownProperty: "error",
    validateReferences: true,
  });

  return result;
}
```

## Building Custom Import Pipelines

For complex import scenarios, you can build pipelines using the Zod schemas:

```typescript
import {
  GraphDataSchema,
  InterchangeNodeSchema,
  InterchangeEdgeSchema,
  type GraphData,
} from "@nicia-ai/typegraph/interchange";

// Transform external data to interchange format
function transformExternalData(externalRecords: ExternalRecord[]): GraphData {
  const nodes = externalRecords.map((record) => ({
    kind: "Document",
    id: record.externalId,
    properties: {
      title: record.name,
      content: record.body,
      source: { system: "external", id: record.externalId },
    },
  }));

  // Validate each node
  const validatedNodes = nodes.map((node) => InterchangeNodeSchema.parse(node));

  return {
    formatVersion: "2.0",
    exportedAt: new Date().toISOString(),
    source: {
      type: "external",
      description: "Imported from external CMS",
    },
    nodes: validatedNodes,
    edges: [],
  };
}
```

## Error Handling

Import returns detailed error information for partial failures:

```typescript
const result = await importGraph(store, data, { onConflict: "error" });

if (!result.success) {
  for (const error of result.errors) {
    console.error(
      `Failed to import ${error.entityType} ${error.kind}:${error.id}: ${error.error}`
    );
  }

  // Decide how to handle partial import
  if (result.nodes.created > 0 || result.edges.created > 0) {
    console.log("Partial import completed, some entities were created");
  }
}
```

### Serialized-connection refusals

Row-level failures are reported in `result.errors`, but one class of failure is
thrown instead: two long-lived interchange streams cannot share a single
serialized database connection, so whichever starts second is refused with a
typed `ConfigurationError`. The lease is exclusive — one stream of any kind per
connection — and every long-lived import claims it, so `importGraph`,
`importGraphStream`, `trustedImportGraph`, and `trustedImportGraphStream` can all
throw it, as can `exportGraphStream` when an import already holds the connection
— there, on the stream's first pull, since the claim begins when the snapshot
transaction opens rather than when the iterable is constructed. The codes (`INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT`,
`INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT`,
`INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS`) and the `details.requested` /
`details.heldBy` pairing they carry are documented in
[Interchange serialized-connection guard codes](/errors#interchange-serialized-connection-guard-codes).

## Best Practices

### Validate Before Import

Always validate external data before importing:

```typescript
import { GraphDataSchema } from "@nicia-ai/typegraph/interchange";

const result = GraphDataSchema.safeParse(untrustedData);
if (!result.success) {
  console.error("Invalid data:", result.error.format());
  return;
}

await importGraph(store, result.data, options);
```

### Use Transactions for Consistency

Import operations use transactions when the backend supports them. When the
Store carries a reconciled schema version, every import batch acquires and
validates the same schema-write fence as collection writes; a stale managed
Store fails before row DML. A raw Store remains outside that guarantee. On a raw
Store without transaction support, consider smaller batch sizes to minimize
partial-failure impact; a managed Store on that backend fails closed on its
first write.

### Test with `onConflict: "error"` First

When setting up a new import pipeline, use `onConflict: "error"` to catch
unexpected duplicates early:

```typescript
// Development/testing
await importGraph(store, data, { onConflict: "error" });

// Production (after validation)
await importGraph(store, data, { onConflict: "update" });
```

### Monitor Import Results

Log import statistics for observability:

```typescript
const result = await importGraph(store, data, options);

logger.info("Import completed", {
  success: result.success,
  nodesCreated: result.nodes.created,
  nodesUpdated: result.nodes.updated,
  nodesSkipped: result.nodes.skipped,
  edgesCreated: result.edges.created,
  edgesUpdated: result.edges.updated,
  edgesSkipped: result.edges.skipped,
  identityCreated: result.identity.created,
  identitySkipped: result.identity.skipped,
  errorCount: result.errors.length,
});
```

## Next Steps

- [Data Sync](/data-sync) - Patterns for keeping external data in sync
- [Schema Migrations](/schema-management) - Managing schema changes over time
- [Integration Patterns](/integration) - Database setup and deployment
