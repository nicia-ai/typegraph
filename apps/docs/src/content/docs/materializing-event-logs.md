---
title: Materializing External Event Logs
description: How to project at-least-once event streams into TypeGraph without making TypeGraph an event-log product
---

External logs are the transport. TypeGraph is the typed, entity-resolved
materialization and merge layer.

Use this pattern when agents or integration runtimes already run on an event log
or stream: Electric Durable Streams, database changefeeds, message queues, or a
custom append-only feed. The log owns delivery, ordering, replay, and offsets.
TypeGraph owns the current graph, valid-time facts, recorded-time history, and
mergeable working copies. The sibling
[`agent-stream-graph`](https://github.com/nicia-ai/agent-stream-graph) package is
the reference implementation of this posture.

## The Shape of the Problem

External log consumers usually have three properties:

- **At-least-once delivery.** A change can be delivered more than once, especially
  after a crash or reconnect.
- **Resume from a cursor.** The consumer persists the last source offset it has
  safely processed.
- **Replay.** Reprocessing old events is normal: for recovery, backfills, or
  rebuilding a derived graph.

That means a projector must be idempotent. Re-delivering the same source change
should converge on the same graph state, not create duplicates.

## Idempotent Projectors

Use stable source ids as TypeGraph ids whenever the source has them. For nodes,
that usually means `upsertById`. For edges, prefer `getOrCreateByEndpoints`.
Avoid `create` in a log projector unless the source event itself carries a
unique id you pass as the TypeGraph id.

```typescript
async function projectChange(
  tx: TransactionContext<typeof graph>,
  change: Change,
) {
  const issue = await tx.nodes.Issue.upsertById(change.issueId, {
    title: change.title,
    state: change.state,
  });

  const actor = await tx.nodes.Actor.upsertById(change.actorId, {
    name: change.actorName,
  });

  await tx.edges.changedBy.getOrCreateByEndpoints(issue, actor, {
    action: change.action,
  });
}
```

The important rule is that the second delivery of the same change takes the same
code path and reaches the same row identities.

### `matchOn` widens the identity key — don't reach for it by default

`getOrCreateByEndpoints` matches on the endpoints `(from, to)` alone unless you
pass `matchOn`. Endpoints-only is the **more** idempotent choice and is right for
most projectors: a re-delivered edge between the same two nodes converges on the
one existing edge regardless of how its properties drifted between deliveries.

`matchOn` adds the named property fields to the match key, so it *widens*
identity — two edges between the same endpoints are now distinct if they differ
on a matched field. Use it only when the relationship model genuinely allows
several parallel edges between one pair (say, one `changedBy` edge per distinct
`action`), and know the footgun: if a re-delivered change carries a **changed**
value in a matched field, it no longer matches the earlier edge and you get a
**second** edge instead of convergence. Reach for `matchOn` when the domain
needs the extra edges, not as a reflex.

## Cursor Bookkeeping

A cursor is application state: the last source offset you have safely processed.
It should advance only at a source offset boundary, after every change in that
batch has been projected. Where the cursor lives — a row in your own relational
table, or a node in the graph — decides which guarantees you can get.

### Exactly-once with an adopted transaction

To commit the projected batch **and** the cursor as one unit, let the caller own
the transaction and adopt it with
[`store.withRecordedTransaction(externalTx, fn)`](/schemas-stores/#transaction-receipts).
The graph writes and your own cursor write land on the same connection inside the
same commit: either both persist or neither does, so the cursor can never advance
past a batch the graph did not durably record.

Two constraints make this the *only* sanctioned transactional recipe on a store
created with `createAdapterStore` or `createAdapterStoreWithSchema` and
`{ history: true }` — which the Transaction Receipts and Bitemporal sections
below both require:

- **Write your own tables through the external handle you passed in**, never
  through `tx.sql`. Under history capture the typed transaction context omits
  `sql` (raw SQL would bypass recorded-time capture); suppressed access reaches
  a runtime guard and raises a
  [`ConfigurationError`](/errors/#recorded-capture-guard-codes). The external
  handle *is* the pinned connection, so writing your cursor row through it keeps
  both layers in the one transaction.
- **`store.withTransaction()` — the non-recorded sibling — is a compile error on
  a history store** (its `externalTx` argument is rejected against a message
  type), and its runtime guard throws
  `RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION`. It has no flush point before
  the caller commits, so recorded-time capture could not seal. Use
  `withRecordedTransaction` instead.

**Async drivers (Postgres / libsql)** open the boundary with `db.transaction`:

```typescript
const receipt = await db.transaction(async (dbTx) => {
  const outcome = await store.withRecordedTransaction(dbTx, async (tx) => {
    for (const change of batch.changes) {
      await projectChange(tx, change);
    }
  });

  // The cursor row goes through the external handle, in the same transaction.
  await dbTx
    .insert(streamCursors)
    .values({ sourceId: batch.sourceId, offset: batch.endOffset })
    .onConflictDoUpdate({
      target: streamCursors.sourceId,
      set: { offset: batch.endOffset },
    });

  return outcome.receipt;
}); // one COMMIT / ROLLBACK across both layers
```

**Synchronous `better-sqlite3`** cannot adopt an `async` transaction callback
(its driver rejects a promise-returning `db.transaction`), so the caller frames
the boundary by hand with `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` on the single
connection:

```typescript
await db.run(sql`BEGIN IMMEDIATE`);
try {
  const { receipt } = await store.withRecordedTransaction(db, async (tx) => {
    for (const change of batch.changes) {
      await projectChange(tx, change);
    }
    await db.run(sql`
      INSERT INTO stream_cursor (source_id, offset)
      VALUES (${batch.sourceId}, ${batch.endOffset})
      ON CONFLICT (source_id) DO UPDATE SET offset = excluded.offset
    `);
  });
  await db.run(sql`COMMIT`);
  // persist receipt.recorded as the offset's replay anchor — see below
} catch (error) {
  await db.run(sql`ROLLBACK`); // graph writes and cursor roll back together
  throw error;
}
```

The graph writes and your own statements share the caller's one pinned
connection. TypeGraph serializes the statements its collections issue; sequence
your own raw statements yourself (don't `Promise.all` them with graph writes) so
two queries never race on that connection.

For an adapter-backed materializer that runs against several backends, branch
on capability rather than message-matching: use
[`tx.sqlAvailability`](/recipes/#cross-store-transactions-drizzle--typegraph) to
decide whether raw SQL is usable inside `store.transaction`, and
[`isRecordedCaptureGuardError(error, code?)`](/errors/#recorded-capture-guard-codes)
to recognize a history-store guard when you catch one.

### At-least-once with a separate cursor store

When the runtime already owns checkpointing, or the backend cannot provide atomic
transactions (`backend.capabilities.transactions === false` — Cloudflare D1,
`drizzle-orm/neon-http`), keep the cursor outside the graph transaction. The
pattern is at-least-once plus idempotence: a crash after the graph writes but
before the cursor write replays the batch, which is safe precisely because the
projector converges.

```typescript
await store.transaction(async (tx) => {
  for (const change of batch.changes) {
    await projectChange(tx, change);
  }
});

await cursorStore.save({
  sourceId: batch.sourceId,
  offset: batch.endOffset,
});
```

This at-least-once path plus an idempotent projector is the workload TypeGraph is
built for. It is also the one that churns recorded history the hardest: every
re-delivery of a byte-identical change rewrites its row, allocating a fresh
recorded instant and a new history row per delivery. Enable
[`coalesceUnchangedUpserts: true`](/schemas-stores/#createstoregraph-backend-options)
on the store to suppress that: an `upsertById` whose validated props already
equal the live row performs no write, no history row, and no revision advance,
and resolves with the existing node. See
[Transaction Receipts](#transaction-receipts) for how a coalesced upsert reads on
a receipt.

Transaction boundaries also consume the recorded clock. It is a strict,
millisecond-resolution clock scoped to one graph, and every captured transaction
advances it by at least one millisecond. Sustaining more than 1,000 captured
commits per second pushes recorded time progressively ahead of wall time; that
lead shrinks only when the per-graph commit rate falls below 1,000 per second or
the graph becomes idle. Group changes by their durable replay/checkpoint boundary so one
addressable source position consumes one recorded instant where practical. Cap
transaction size independently: a source may expose one coarse checkpoint for a
very large initial sync, but that does not make an unbounded transaction safe.

Recorded clocks are independent per graph. Sharding a firehose across graphs
multiplies the available clock budget when the belief model and its queries
partition cleanly, but there is no cross-graph `recordedNow()` snapshot. See
[Recorded-clock rate and wall-time lead](/queries/temporal#recorded-clock-rate-and-wall-time-lead)
for the allocator behavior and the valid-time consequence of accumulated lead.

**Coalescing eliminates *re-delivery* churn, not replay cost.** The win is
scoped to re-delivery of the current value — the realistic at-least-once case,
where a change that was already applied arrives again (a crash-window replay, a
duplicate) and is value-identical to the live row. A full **replay-from-zero**
over the current state is different: if the stream contains in-place updates,
replaying `insert a=1 … update a=2` re-applies `a=1` over the live `a=2` — a
genuine backward change that writes — and then `a=2` restores it. Both writes
are correct (the replay faithfully re-walks each historical state), but
"coalescing makes replay free" holds only for streams whose rows never
supersede each other. It also leaves a spurious `a=2 → a=1 → a=2` band in the
live store's recorded history, stamped at replay time. To rebuild without
either cost, replay into a **fresh store** and publish it, rather than
re-applying the log over the current state.

### In-graph cursors and the receipt

A cursor can also live inside the graph as an ordinary node — convenient, and it
travels with the graph. But if you also use the transaction receipt (next
section) to detect a projector that dropped a change, an in-graph cursor
**corrupts that signal**: the receipt counts writes per transaction with no
attribution, so the cursor's own upsert is indistinguishable from the projector's
writes. A projector that drops a change in a transaction that also checkpoints an
in-graph cursor produces `writes.total === 1` from the cursor alone —
`writes.total > 0` no longer means "the projector wrote," the drop goes
undetected, and the cursor advances past the lost event.

Two ways out:

- **Scope the projector with `tx.measure`.** On a receipt-enabled context
  (`transactionWithReceipt` or `withRecordedTransaction`),
  [`tx.measure((scopedTx) => …)`](/schemas-stores/#scoped-receipts-txmeasure)
  hands your callback a **scoped context** and returns a sub-receipt that counts
  exactly the writes made **through that scoped context** (`scopedTx.nodes` /
  `scopedTx.edges`). Run the projector through `scopedTx`; write the cursor
  through the outer `tx` (or your own table). Attribution is by which context you
  write through, not by timing, so the cursor's write counts only in the outer
  receipt and the scope reflects the projector alone. This is what makes an
  in-graph cursor and drop-detection composable; see the full loop below.
- **Keep the cursor in your own relational table.** The
  [exactly-once recipe](#exactly-once-with-an-adopted-transaction) makes that
  atomic anyway, and it keeps the belief graph pristine: an in-graph cursor node
  still lands in every `asOfRecorded` reconstruction of the graph, so a consumer
  that wants recorded-time reads to show only projected facts should keep the
  cursor out of the graph entirely.

## Transaction Receipts

When you need to know what a projector did, use `store.transactionWithReceipt`
(TypeGraph owns the boundary) or `store.withRecordedTransaction` (you adopt an
open transaction); both return a `TransactionOutcome` with a `receipt`.

The receipt carries **two signals that deliberately disagree**, and a
materializer needs both. `receipt.writes.total` counts completed write intents at
the collection surface; `receipt.recorded` (on a `{ history: true }` store) is
the recorded commit instant this transaction allocated, or `undefined` when
nothing was captured. The common, load-bearing case is where they diverge:

| case                                          | `writes.total` | `recorded`      |
| --------------------------------------------- | -------------- | --------------- |
| projector wrote                               | `> 0`          | defined         |
| no-op delete of an absent key (a real intent) | `1`            | **`undefined`** |
| coalesced upsert (value-identical, opt-in)    | `1`            | **`undefined`** |
| projector dropped the change                  | `0`            | `undefined`     |

A no-op delete completes a write *intent* but captures nothing; a
[coalesced upsert](/schemas-stores/#createstoregraph-backend-options) is the same
shape by design. In both, `writes.total` counts (the method resolved) but
`recorded` is `undefined`. **An offset whose transaction reports
`recorded === undefined` must carry the prior anchor forward** — otherwise
replay-by-offset breaks at exactly the offsets where nothing changed.

Two counting rules bite materializers specifically, both worth internalizing
before you read `writes.total` as "the projector did work":

- **Bulk methods count by input length**, so `bulkCreate([])` contributes `0`. A
  projector that filters a batch down to nothing and issues an empty bulk call
  must not read as a writer.
- **A method that rejects counts `0`** — even on SQLite, where a failed statement
  does **not** abort the surrounding transaction. A projector that swallows a
  write error and commits can persist rows the receipt never counted, so do not
  read the receipt as rows-affected in that scenario.

### The full materializer loop

Putting the pieces together: an adopted transaction for exactly-once cursors, a
`tx.measure`-scoped projector so a single dropped change is caught within a
multi-change batch — the outer receipt only tells you the whole batch wrote
nothing, whereas a `measure` scope attributes writes per change by having the
projector write through the scoped context it receives (any cursor written
through the outer `tx` stays out of that count) — `receipt.recorded` as the
per-offset replay anchor, and `writes.total === 0` on a non-delete change as the
drop signal.

`withRecordedTransaction` flushes recorded-time capture and resolves **before**
the caller's commit, so `outcome.receipt.recorded` is already known inside the
`db.transaction` callback. Write the cursor advance **and** its replay anchor
through `dbTx` there, in the same commit as the graph writes. Persisting the
anchor after the commit — as a separate step — would reopen the exactly-once gap
the adopted transaction exists to close: a crash between the commit and the
anchor write leaves the cursor advanced with no anchor, and that offset can never
be replayed.

```typescript
let lastAnchor: RecordedInstant | undefined = await loadLastAnchor(); // on resume

lastAnchor = await db.transaction(async (dbTx) => {
  const outcome = await store.withRecordedTransaction(dbTx, async (tx) => {
    for (const change of batch.changes) {
      // The projector writes through the scoped context, so `projected`
      // counts its writes alone — nothing else in the transaction.
      const projected = await tx.measure((scopedTx) =>
        projectChange(scopedTx, change),
      );

      // A non-delete change that wrote nothing was silently dropped.
      if (
        projected.receipt.writes.total === 0 &&
        change.operation !== "delete"
      ) {
        throw new DroppedChangeError(change); // rolls the whole batch back
      }
    }
  });

  // `recorded` is undefined when the batch captured nothing (all drops, no-op
  // deletes, or coalesced upserts) — carry the prior anchor forward so replay
  // by offset still resolves. Anchor comes from the receipt, never from a
  // post-commit store.recordedNow() (see below).
  const anchor = outcome.receipt.recorded ?? lastAnchor;

  // Cursor and anchor commit atomically with the graph writes: no window where
  // the cursor has advanced past an offset whose anchor was never persisted.
  await dbTx
    .insert(offsetAnchors)
    .values({ sourceId: batch.sourceId, offset: batch.endOffset, recorded: anchor });
  await dbTx
    .insert(streamCursors)
    .values({ sourceId: batch.sourceId, offset: batch.endOffset })
    .onConflictDoUpdate({
      target: streamCursors.sourceId,
      set: { offset: batch.endOffset },
    });

  return anchor; // updates lastAnchor only once the transaction commits
});
```

**Take the replay anchor from `receipt.recorded`, never from a post-commit
`store.recordedNow()`.** `recordedNow()` is the graph-global recorded
high-water mark, advanced by **any** writer to the graph. Between your commit and
your read of it, a concurrent writer can advance it, and `asOfRecorded(that)`
then reconstructs a belief your stream never produced. The receipt hands you the
instant *this* transaction allocated; that is the only anchor that reconstructs
exactly what this offset materialized.

## Bitemporal Mapping

External streams usually carry domain time and delivery time. Keep those
separate:

- **Event time belongs in valid time.** If a source change says a fact became
  true on January 1, pass that timestamp as `validFrom`; if it ended on January
  31, pass `validTo`.
- **Ingest time is recorded time.** TypeGraph records when the graph committed
  the write. Recorded time is allocated by the backend and cannot be backdated.
- **Backfills collapse recorded instants to now.** Replaying historical events
  today writes historical valid-time facts with today's recorded-time anchors.
  That is correct SQL:2011 bitemporal behavior, not a bug.

To replay by source offset, load the anchor you saved for that offset and read a
recorded-time view. The `receipt.recorded` you persisted is a branded
`RecordedInstant`, but round-tripping through your cursor table stores it as a
plain string — re-brand it with `asRecordedInstant` on the way back before
passing it to `asOfRecorded`:

```typescript
import { asRecordedInstant } from "@nicia-ai/typegraph";

const stored = await offsetAnchors.anchorFor(offset); // plain string from storage
const anchor = asRecordedInstant(stored); // validates + re-brands
const graphAtOffset = store.asOfRecorded(anchor);
const issue = await graphAtOffset.nodes.Issue.getById(issueId);
```

That answers "what did the materialized graph know after offset X?" even if
later corrections changed or deleted rows. See
[Recorded time](/queries/temporal/#recorded-time-bitemporal) for the full view
surface.

### Refresh planner statistics after a large replay

A **custom** replay or backfill loop — one built from the projector recipes above
— runs its writes **inside a caller-provided transaction**, which never
auto-refreshes the query planner's table statistics: `ANALYZE` from another
connection cannot see rows that are still uncommitted, so the store deliberately
skips the automatic refresh it does after large autocommit bulk writes. Left
alone, the planner keeps pre-load row estimates and can pick an
order-of-magnitude-slower plan. After a large custom replay, refresh once:

```typescript
await replayEverything();
await store.refreshStatistics(); // once, after the bulk replay commits
```

The interchange path handles this for you: `importGraph` and `importGraphStream`
call `refreshStatistics()` once after the import commits (see
[Bulk Copy Between Stores](#bulk-copy-between-stores)), so a bulk copy needs no
manual refresh.

## Bulk Copy Between Stores

To copy a materialized graph into another store — most often a graph-merge
working copy — stream interchange directly from source to target with
`exportGraphStream` / `importGraphStream`. This is the same path
[graph-merge](/interchange/) uses internally, so a copy produces byte-identical
merge results, conflicts, and provenance to a native branch:

```typescript
import {
  exportGraphStream,
  importGraphStream,
} from "@nicia-ai/typegraph/interchange";

const result = await importGraphStream(
  branch.store,
  exportGraphStream(beliefStore, {
    nodeKinds: ["Belief", "Claim"],
    edgeKinds: ["supports"],
    includeTemporal: true,
  }),
  { onConflict: "update" },
);

if (!result.success) {
  throw new Error(`copy failed with ${result.errors.length} import errors`);
}
```

Two option defaults are exactly right here and worth stating because they are not
obvious:

- **`includeDeleted` defaults to `false`, and the copy clones live state — it
  does not synchronize deletions.** The exporter simply omits soft-deleted rows;
  it cannot round-trip `deletedAt` at all (the wire format carries no deletion
  flag). So a fact deleted on the source is merely *absent* from the stream: on a
  fresh target it never appears, but on a populated target an existing live row
  **stays live** — the copy never deletes it. If the target must reflect
  deletions, apply them through your projector, not the bulk copy.
- **`includeTemporal` must be set to `true`** (it defaults to `false`). It is
  what carries each fact's original `validFrom` / `validTo` across the copy;
  without it the import re-stamps every fact with the *copy's* wall clock,
  destroying valid-time fidelity in the merged branch.

`importGraphStream` preserves ids, routes existing rows through normal
`onConflict` handling, validates edge endpoints (`validateReferences` defaults to
`true`), and refreshes planner statistics once after the import commits.

## Cursor-Based Resumption and Electric

The examples above assume a per-change offset. **Electric does not provide one** —
every change in a `ShapeStream` catch-up batch shares the stream's
`lastOffset`. A cursor keyed on Electric's offset can therefore only advance at a
**batch boundary**, after the whole batch is projected. Advancing mid-batch is
unsafe: Electric's `read(after)` is strictly-after, so resuming from a
mid-batch offset permanently skips that batch's remaining changes. Project the
whole batch, then checkpoint the cursor once at its boundary.
