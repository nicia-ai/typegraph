---
title: Refusing a Write Whose Inputs Changed
description: Declare what a long-running computation read, and have the write transaction refuse to commit if any of it changed since an anchor taken before the reads.
---

A caller reads some rows, computes for a while, then writes a result derived
from them. Nothing in an ordinary transaction says "refuse me if anything I
read has changed". The write commits against whatever state is current, even
though the result was computed from older content.

A current-state check does not cover this. When the write runs, every input may
still be current and valid, yet no longer be what the caller read: a node was
edited, or an edge was added to a neighbourhood the computation scanned.

`tx.assertUnchangedSince()` is the scoped form of the commit-time guard that
[Graph Merge](/graph-merge/) applies to a whole graph. You declare the read set,
and the assertion runs inside the write transaction, after the store has taken
its write lock.

## Usage

Capture an anchor with `store.lineageRevisionNow()` **before** reading. Pass it,
with the scopes you read, to `tx.assertUnchangedSince()` at the start of the
write transaction.

```typescript
const anchor = await store.lineageRevisionNow();
if (anchor === undefined) {
  throw new Error("This store has no lineage source");
}

const source = await store.nodes.Source.getById(sourceId);
const fact = await store.nodes.Fact.getById(factId);
const justification = await store.nodes.Justification.getById(justificationId);
if (!source || !fact || !justification) {
  throw new Error("An input is missing");
}

const summary = await computeSummary(source, fact, justification);

try {
  await store.transaction(async (tx) => {
    await tx.assertUnchangedSince(anchor, [
      { node: source },
      { node: fact },
      { edgesAt: justification, direction: "in", kind: "premiseOf" },
    ]);
    await tx.nodes.Summary.create(summary);
  });
} catch (error) {
  if (error instanceof ReadSetChangedError) {
    // Re-read the changed inputs, recompute, and try again.
  }
  throw error;
}
```

The assertion writes nothing. It resolves when no declared scope changed, and
throws otherwise. The transaction's own writes follow it.

## Scopes

Each scope names the smallest region a read depended on.

| Scope | Declares | Catches |
|-------|----------|---------|
| `{ node }` | One node row was read | Any change to that node |
| `{ edge }` | One edge row was read | Any change to that edge |
| `{ edgesAt, direction, kind? }` | A neighbourhood was read | An edge added, changed or removed at that node. `direction` is `"out"`, `"in"` or `"both"`; omit `kind` to cover every edge kind |
| `{ nodeKind }` or `{ edgeKind }` | A listing or query over one exact kind was read | A row of that kind added, changed or removed. Subclasses are not implied |
| `{ graph: true }` | Anything else | Any change to any node or edge |

A node scope does not imply the edges at that node. Many callers legitimately
add edges at a shared node, for example each run adding its own `premiseOf` edge
from one source, and an implied edge scope would make every such pair refuse
each other. Declare `edgesAt` when you read a neighbourhood.

If you read through a query and name only the rows it returned, a new matching
row is invisible to those row scopes. Declare the kind, or the whole graph.
Coarser scopes refuse more often; none misses a change inside it. Any recorded
change counts, including one that was later reversed.

## Outcomes

| Outcome | Meaning | What to do |
|---------|---------|------------|
| Resolves | No declared scope changed | Write |
| [`ReadSetChangedError`](/errors/#readsetchangederror) | One or more scopes changed; `details.changes` lists each scope with its changed node and edge keys (see [Reported keys](#reported-keys)) | Re-read and retry with a new anchor |
| [`ReadSetUnverifiableError`](/errors/#readsetunverifiableerror) | The lineage source could not prove the span: an unknown anchor, an anchor from before `store.clear()`, or a revision that left no evidence | Retrying with the same anchor cannot succeed. Take a new anchor and re-read |
| `UnsupportedBackendCapabilityError` | The store cannot provide what the fence needs; `details.capability` names it | See below |

The capability refusals, all raised with `operation: "tx.assertUnchangedSince()"`:

- `lineage`: the store has no lineage source.
- `graphWriteFence`: the store's ordinary writers do not take the per-graph write
  fence, so the assertion could not exclude a concurrent writer.
- `observedReadCommittedIsolation`: the transaction could not prove that it
  observes every earlier holder of the fence. `details.isolation` carries what
  the session reported.

A read-only transaction is refused as any other write is, because the assertion
takes the graph write lock. A kind named in a scope that the graph does not
declare raises `KindNotFoundError`. A malformed scope — one that is not an
object, one naming no target or several, carrying a key its target does not take (such as `direction` on a
`{ node }` scope), or with a malformed reference or direction — raises
`ConfigurationError` with `details.code` `READ_SET_SCOPE_INVALID`.

### Reported keys

Each entry in `details.changes` names the scope (`index` is its position in the
list you passed) and the keys that changed in it. The key lists are bounded so a
refusal stays small however much changed: `nodes` and `edges` each hold at most
the first 100 changed keys in `(kind, id)` order, compared by code point, and
`nodesTruncated` or `edgesTruncated` is `true` exactly when more keys changed
than the list holds. Treat a truncated scope as "re-read everything in it". The
bound applies only to what is reported; any change in a scope refuses the write.

## Which stores support it

The store must have a lineage source and take the write fence on its ordinary
writes. In practice that means a store opened with `history: true`, or with
`revisionTracking: true` on a bundled SQL backend whose revision journal is
installed and not disabled with `revisionJournal: false`. A backend that
supplies its own lineage but whose store has neither is refused with
`graphWriteFence`.

- **PostgreSQL** needs the transaction to run at read committed, so that the
  snapshot is taken after the lock. TypeGraph observes the isolation on the
  pinned session rather than assuming it.
- **SQLite** on the bundled backends is serialized by the engine, so the
  evidence is unconditional. A backend whose write fence is declared
  caller-serialized cannot provide the evidence and is refused with
  `observedReadCommittedIsolation`.

A history store answers from its recorded rows in batched reads, a few
statements per relation however many scopes you declare. A `{ node }`, `{ edge }` or `edgesAt` scope is an index
seek. A `{ nodeKind }` or `{ edgeKind }` scope reads that kind's recorded
versions, and `{ graph: true }` the graph's, so their cost grows with that
history. Other lineage sources answer from the key delta since the anchor,
filtered per scope; on those, an `edgesAt` scope is checked at edge-kind
granularity (see [Limits](#limits)).

## Caller contract

- **Capture the anchor before reading.** An anchor taken after the read misses a
  change that lands in between. One taken before can only cause a false refusal.
- **Call the assertion before the transaction's own writes.** On the key journal,
  an earlier write in the same transaction reads as a change, which is a false
  refusal. A history store does not see the transaction's own writes.
- **Declare every read.** The fence checks the scopes you pass, not the reads you
  made. A read you did not declare is not protected.

## Limits

- **Writes that bypass the store.** A raw backend write, an engine-side
  mutation, or a second Store over the same graph opened without `history` or
  `revisionTracking` takes no fence, allocates no revision and leaves no
  evidence. Every writer of the graph must be a history or revision-tracked
  Store. This is the existing limit of `store.changesSince()`.
- **Identity.** The fence covers node and edge rows. An identity assertion that
  changes class membership without changing a row is not covered, and an
  identity write in the span does not refuse the fence, on a history store or a
  `revisionTracking` store alike.
- **Validity expiry.** A row whose validity window closes between the read and
  the commit changes what a current read returns without any write. The fence
  covers writes, not the passage of time.
- **Edge neighbourhoods on the key journal.** The journal records an edge's kind
  and id, not its endpoints, and an edge id can be hard-deleted and reused at
  other endpoints. On a `revisionTracking` store without history, an `edgesAt`
  scope therefore counts every changed edge of its kind, wherever it is. This is
  sound but refuses when an edge of that kind changed at another node. History
  stores answer neighbourhoods exactly.
- **Journal triggers.** A `revisionTracking` store's journal triggers are
  verified when its `lineageRevisionNow()` mints the anchor, not again inside
  the transaction; an anchor minted by another Store over the same graph is not
  verified against this one's journal. Dropping, disabling or partially
  installing the triggers is a change made outside the store, like a write that
  bypasses it.
- **Cost under the write lock.** On a history store, kind and whole-graph scopes
  read the recorded versions they cover, so their cost grows with that history.
  Sources that answer by key delta read every change since the anchor while
  holding the graph write lock, so cost grows with the span, not with the read
  set.
