---
title: History
description: Opt-in recorded-time history for node and edge mutations
---

TypeGraph can record the complete prior version of a node or edge every time it changes, captured in the same
transaction as the mutation. Turn it on at store creation and read a per-entity timeline with
`collection.history(id)`: every version that ever stood, the interval it was current for, the operation that
ended it, and an optional audit record of who changed it and why.

This is **opt-in** and off by default. When off, there is zero overhead — no extra tables are written and the
compiled mutation SQL is byte-identical to a store without history.

## Recorded time vs. application time

TypeGraph already tracks **application time** on every row — `validFrom` / `validTo`, the period a fact is
*modeled as true in your domain* (see [Temporal](/queries/temporal)). A contract valid from January to December
carries those dates regardless of when you typed them in.

Recorded-time history tracks something different: **when a row actually changed in the database**. Each history
entry carries a `[recordedFrom, recordedTo)` interval — when a version became current and when a later mutation
superseded it. You set application time; TypeGraph sets recorded time.

| Dimension | Fields | Set by | Answers |
| --- | --- | --- | --- |
| Application (valid) time | `validFrom` / `validTo` | You | "When was this fact true in the domain?" |
| Recorded time | `recordedFrom` / `recordedTo` | TypeGraph | "When did this version exist in the database?" |

The two are independent. A single edit can change a row's application-time window; recorded-time history captures
that edit as one entry, preserving the exact pre-edit image — including its old `validFrom` / `validTo`.

## Enabling history

Pass `{ history: true }` at store creation. It works with both `createStore` and `createStoreWithSchema`:

```typescript
import { createStore } from "@nicia-ai/typegraph";

const store = createStore(graph, backend, { history: true });
```

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

const [store, result] = await createStoreWithSchema(graph, backend, {
  history: true,
});
```

History requires a backend that supports capture (the bundled Drizzle SQLite and Postgres backends). Enabling it
against a backend without capture support throws a `ConfigurationError`.

## Reading history

`store.nodes.<Kind>.history(id)` and `store.edges.<kind>.history(id)` return the entity's prior versions,
**newest first**. The current (open) version is not included — read it with `getById`.

```typescript
const document = await store.nodes.Document.create({ title: "Draft", status: "open" });

await store.nodes.Document.update(document.id, { title: "Reviewed" });
await store.nodes.Document.update(document.id, { status: "closed" });

const versions = await store.nodes.Document.history(document.id);

for (const entry of versions) {
  console.log(entry.op, entry.image.title, entry.recordedFrom, "→", entry.recordedTo);
}
// update  Reviewed  2026-06-10T10:05:00.000Z → 2026-06-10T10:09:00.000Z
// update  Draft     2026-06-10T10:00:00.000Z → 2026-06-10T10:05:00.000Z
```

Each entry is a `NodeHistoryEntry` (or `EdgeHistoryEntry` for edges):

| Field | Type | Description |
| --- | --- | --- |
| `image` | `Node` / `Edge` | The entity exactly as it stood during `[recordedFrom, recordedTo)` — a typed instance with properties and `meta` |
| `recordedFrom` | `string` | When this version became current (ISO timestamp) |
| `recordedTo` | `string` | When a later mutation superseded it (ISO timestamp) |
| `op` | `HistoryOp` | The mutation that ended this version (see below) |
| `schemaVersion` | `number` | The active schema version when this version was current |
| `txId` | `string` | Groups every version captured in the same transaction |
| `meta` | `Record<string, unknown> \| undefined` | The parsed audit record supplied at write time, if any |

`image` is a fully typed entity, so you can read its properties and its application-time metadata directly:

```typescript
const [previous] = await store.nodes.Document.history(document.id);

previous.image.title;          // "Reviewed"
previous.image.meta.validFrom; // application-time window of that version
previous.image.meta.version;   // optimistic-concurrency version number
```

Edges work the same way, keyed by edge id:

```typescript
const edgeVersions = await store.edges.worksAt.history(edgeId);
```

## The operation taxonomy

`create` writes **no** history — the current row is the record of the open interval. Every mutation of an existing
row captures the complete pre-image and records what ended it in `op`:

| `op` | Captured by |
| --- | --- |
| `update` | An `update` to an existing row |
| `restore` | An upsert that revives a soft-deleted row (the revive path) |
| `delete` | A soft delete (`delete()`) |
| `hardDelete` | A permanent delete (`hardDelete()`), including each edge in a node's hard-delete cascade |

Hard delete is the notable case. `hardDelete` preserves the row's prior history **and** captures the final image,
so hard-deleted entities remain visible to `history(id)`. This is precisely what a soft delete cannot do today: a
soft delete hides the row from all history reads. If you need a permanently-removed entity to stay auditable, hard
delete with history on is the path.

```typescript
await store.nodes.Document.hardDelete(document.id);

const versions = await store.nodes.Document.history(document.id);
versions[0].op; // "hardDelete" — the final image is preserved
```

## Audit metadata: `meta` and `txId`

Wrap mutations in `store.transaction(fn, { meta })` to stamp a "who/why" record on every history row captured in
that transaction. `meta` is a `Record<string, unknown>` — TypeGraph never interprets it, only stores it.

```typescript
await store.transaction(
  async (tx) => {
    await tx.nodes.Document.update(document.id, { status: "approved" });
    await tx.edges.approvedBy.create(document, reviewer);
  },
  { meta: { actor: "reviewer-42", reason: "quarterly review", source: "console" } },
);

const [entry] = await store.nodes.Document.history(document.id);
entry.meta;  // { actor: "reviewer-42", reason: "quarterly review", source: "console" }
entry.txId;  // shared by every version captured in this transaction
```

All captures in one transaction share a `txId`, so a multi-row change groups under one identifier. `txId` is an
opaque string for grouping — it is not an offset and grants no replay semantics.

## Retention: pruning old history

History grows with every mutation. For bulk-ingest or long-lived workloads, trim it with
`store.history.prune({ before })`, which drops every history row whose currency **ended** before the given ISO
timestamp:

```typescript
const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

await store.history.prune({ before: ninetyDaysAgo });
```

Pruning only removes superseded versions whose `recordedTo` is before the cutoff; current rows are never touched.
Append-forever history is a footgun for high-write workloads — decide on a retention window early.

## Capture guarantee: atomic vs. best-effort

`backend.capabilities.history` reports how capture is guaranteed:

- **`"atomic"`** — a history row commits if and only if its mutation commits. The capture rides the mutation's
  transaction (or, on Postgres `neon-http`, a single data-modifying CTE that captures the pre-image and mutates in
  one statement). This is every transactional backend, including Postgres over `neon-http`.
- **`"best-effort"`** — no atomic capture is available (`transactions: false`, i.e. the non-transactional SQLite
  `transactionMode: "none"` profile and Cloudflare D1). The mutation runs first and the history row is written
  second, so a crash between the two **loses a history row but never fabricates a transition** that did not happen:
  missing history, never phantom history.

```typescript
if (backend.capabilities.history === "atomic") {
  // History is transactionally consistent with mutations.
}
```

See the [Backend Setup](/backend-setup#recorded-time-history-capture) parity matrix for the per-driver breakdown.

## History is queried, not replayed

Recorded-time history is **versioned state**, not an event log. You query the current state of the history tables;
there is nothing to replay. There are no offsets, no streams, no replay or subscription API — `history(id)` and
`prune` are the entire surface. The internal row identity of a history row is not exposed; user-visible ordering is
by `(recordedFrom, recordedTo, version)`.

If you need a change *stream* — to drive a cache, a search index, or a downstream service — that belongs to the
host database's change-data-capture, not to TypeGraph. On Postgres, for example, [Electric](https://electric-sql.com)
can sync the TypeGraph tables directly off the WAL.

## Use cases

Recorded-time history fits any workload that needs to answer "what did this row look like before, and who changed
it":

- **Audit trails** — a tamper-evident record of every change, with the actor and reason in `meta`.
- **Debugging "what changed"** — reconstruct the exact pre-image of a row before a bad write, with the `txId`
  grouping the whole transition.
- **Compliance** — retain prior versions for a fixed window, then `prune` past it.
- **Agent memory** — among other uses, an agent's knowledge graph can keep the prior version of a fact it revised,
  with the revising step recorded in `meta`.

## Next Steps

- [Temporal](/queries/temporal) — application-time (`validFrom` / `validTo`) queries
- [Backend Setup](/backend-setup#recorded-time-history-capture) — the per-driver capture guarantee matrix
- [Schemas & Stores](/schemas-stores) — store creation options and transactions
