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
that usually means `upsertById`. For edges, prefer
`getOrCreateByEndpoints` with a `matchOn` policy for the fields that identify
the relationship. Avoid `create` in a log projector unless the source event
itself carries a unique id you pass as the TypeGraph id.

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

  await tx.edges.changedBy.getOrCreateByEndpoints(
    issue,
    actor,
    {
      sourceChangeId: change.id,
      action: change.action,
    },
    {
      matchOn: ["sourceChangeId"],
    },
  );
}
```

The important rule is that the second delivery of the same change takes the same
code path and reaches the same row identities.

## Cursor Bookkeeping

A cursor is application state: store it as an ordinary graph node or in a
separate application table. The cursor should advance only at a source offset
boundary, after every change in that batch has been projected.

### Same-transaction cursor

When the backend supports transactions, write the cursor row in the same
`store.transaction` callback as the projected batch. On transactional backends,
this gives exactly-once materialization relative to the source offset: either the
batch and cursor commit together, or neither does.

```typescript
await store.transaction(async (tx) => {
  for (const change of batch.changes) {
    await projectChange(tx, change);
  }

  await tx.nodes.Cursor.upsertById(`source:${batch.sourceId}`, {
    offset: batch.endOffset,
    sourceId: batch.sourceId,
  });
});
```

Check `backend.capabilities.transactions` before relying on that atomicity. On
backends where it is `false` (for example Cloudflare D1 or `neon-http`),
`store.transaction` still runs the callback but cannot make the writes atomic.
The guarantee degrades to at-least-once delivery plus idempotence and
partial-failure recovery. Keeping the cursor update at the end of the callback
still preserves ordering, but it does not make the batch atomic.

### Separate cursor store

If the cursor lives outside TypeGraph, the pattern is always at-least-once plus
idempotence. A crash after the graph writes but before the cursor write replays
the batch. That is acceptable only because projector writes converge.

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

Use the same-transaction cursor on transactional backends when the cursor is part
of the graph's source-of-truth state. Use a separate cursor store when the
runtime already owns checkpointing or when the backend cannot provide atomic
transactions.

## Transaction Receipts

When you need to know what a projector did, use `store.transactionWithReceipt`
instead of `store.transaction`:

```typescript
const outcome = await store.transactionWithReceipt(async (tx) => {
  for (const change of batch.changes) {
    await projectChange(tx, change);
  }

  await tx.nodes.Cursor.upsertById(`source:${batch.sourceId}`, {
    offset: batch.endOffset,
    sourceId: batch.sourceId,
  });
});

if (batch.changes.length > 0 && outcome.receipt.writes.total === 0) {
  throw new Error("projector dropped a non-empty batch");
}

if (outcome.receipt.recorded !== undefined) {
  await offsetAnchors.save(batch.endOffset, outcome.receipt.recorded);
}
```

`receipt.writes` counts completed write intents at the TypeGraph collection
surface. It is not a rows-affected count: a successful delete of an absent row
still counts as one completed write intent, and a rejected write counts zero.
Bulk methods count by input length, so `bulkCreate([])` contributes zero.

With `history: true`, `receipt.recorded` is the recorded commit anchor allocated
for the transaction. Persist that anchor beside the source offset when you need
to replay the graph as it looked after processing a specific offset.

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
recorded-time view:

```typescript
const anchor = await offsetAnchors.anchorFor(offset);
const graphAtOffset = store.asOfRecorded(anchor);
const issue = await graphAtOffset.nodes.Issue.getById(issueId);
```

That answers "what did the materialized graph know after offset X?" even if
later corrections changed or deleted rows.

## Bulk Copy Between Stores

Use interchange for bulk copy between stores. The same path powers graph-merge
working copies: export the source subset, create a branch from the target base,
then import with `onConflict: "update"`.

```typescript
import { importGraph, exportGraph } from "@nicia-ai/typegraph/interchange";
import { asBranchId, branch, unwrap } from "@nicia-ai/typegraph/graph-merge";

const data = await exportGraph(sourceStore, {
  nodeKinds: ["Belief", "Claim"],
  edgeKinds: ["supports"],
  includeMeta: true,
});

const fork = unwrap(
  await branch(baseStore, makeBranchBackend, {
    id: asBranchId("source-a"),
  }),
);

const result = await importGraph(fork.store, data, {
  onConflict: "update",
  validateReferences: true,
});

if (!result.success) {
  throw new Error(`copy failed with ${result.errors.length} import errors`);
}
```

This is the preferred bulk path for copying a materialized belief store into a
merge branch. It preserves ids, routes existing rows through normal conflict
handling, validates edge endpoints, and keeps the branch non-history unless you
explicitly create it with history capture.
