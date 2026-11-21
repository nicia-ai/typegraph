---
title: Provenance and Retraction
description: Track source lineage for derived facts, retract bad sources, and use recorded time to replay what the graph believed before and after the transition.
---

Provenance and Retraction is the TypeGraph subpath for source lineage and
belief transitions. It maps your ordinary graph kinds onto four roles:

- one or more retractable source node kinds with a boolean `retracted` flag
- a justification node that represents an AND support rule
- one or more derived fact node kinds
- two typed edges: premises point to justifications, and justifications derive facts

The API lives at `@nicia-ai/typegraph/provenance`:

```typescript
import { createRetractionCapability } from "@nicia-ai/typegraph/provenance";

const provenance = createRetractionCapability(store, {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
});
```

Use `source: { kinds: [...] }` when different source node kinds share the same
boolean retraction field:

```typescript
const provenance = createRetractionCapability(store, {
  source: { kinds: ["ScannerSource", "VendorSource"] },
  justification: { kind: "Justification" },
  fact: { kinds: ["Vulnerability", "DeployDecision"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
});
```

`store` must be created with `{ history: true }`. Retraction mutates graph row
currency, so TypeGraph-managed recorded capture is required:

```typescript
const [store] = await createStoreWithSchema(graph, backend, {
  history: true,
});
```

For a complete runnable version, see
[Provenance Retraction](/examples/provenance-retraction).

## Graph shape

Define the roles as normal TypeGraph nodes and edges.

```typescript
const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Fact = defineNode("Fact", {
  schema: z.object({ label: z.string() }),
});

const TerminalFact = defineNode("TerminalFact", {
  schema: z.object({ label: z.string() }),
});

const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});

const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "claims",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    TerminalFact: { type: TerminalFact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact, TerminalFact] },
  },
});
```

A justification fires when all of its premise nodes are in the well-founded
support set. Sources are in support unless their `retracted` flag is true. Facts
enter support when at least one firing justification derives them.

Fact kinds only need to appear in `premiseOf.from` if they can support another
justification. Terminal facts can be listed in `fact.kinds` and `derives.to`
without being valid premise endpoints.

## Retraction

`retract(source)` sets the source flag, recomputes support from the current
provenance graph, and makes unsupported facts non-current. A transition only
touches facts reachable from the flipped sources, and closing a fact is a
belief-status change, not a domain delete: none of the fact's edges are
deleted (its `onDelete` behavior is not enforced), so `unRetract` restores the
fact exactly as it was.

```typescript
const before = await store.recordedNow();
const report = await provenance.retract({ kind: "Source", id: sourceId });
const after = await store.recordedNow();

const previous = before ? store.asOfRecorded(before) : undefined;
const current = after ? store.asOfRecorded(after) : undefined;
```

Every retraction verb also takes a polymorphic query row, such as one a
supertype query over the source kinds returns, whose `kind` is `string`. The
row's actual kind must be one of the configured source kinds; any other is
refused with `ConfigurationError`.

The report partitions facts relative to the retracted source:

- `died`: every fact whose currency this transition closed
- `survivedVia`: affected facts that still have a firing justification
- `unaffected`: previously believed facts outside the source's provenance

`died` names every close, including a fact that was not believed to begin with.
A live fact is unsupported whenever no justification of it fires, and a
transition that reaches such a fact closes it and reports it. Ordinary store
calls reach that state: a justification with two premises, one of them a source
created with its retracted flag already set, leaves the fact it derives live and
unsupported from the moment it is linked, with no constraint violated and
nothing for `store.verifyConstraintFences()` to report. The composition case is
narrower — a required part whose whole was tombstoned outside the store's own
paths — and that one the fence audit does report. Either way a tombstone the
report cannot mention would be invisible data loss, so the pass that writes the
tombstones and the report that names them read one set of rows.

`unRetract(source)` clears the source flag, recomputes support, and reopens
facts that regain support.

## Composition and retraction

A [required composition part](/ontology#composition) cannot exist without a
live whole, so its belief status follows its whole's. Support treats the
dependency as part of the fact's grounding: a required part is supported only
while the whole it currently hangs from is itself supported (a whole that is
also a fact kind) or live (any other whole, including a plain node that carries
no belief status at all).

Closing a whole therefore closes its required parts in the same transition,
transitively through a part that is itself a whole, and the report names every
one of them in `died`. Reopening the whole reopens the parts that are otherwise
supported, because a reopen is driven by support rather than by a ledger of
what a close closed: a part whose own justification no longer fires stays
closed. A required part is closed even when a different source supports it —
the existence dependency dominates its own grounding.

An optional part is untouched. It can exist with no whole, so it keeps both its
attachment to the closed whole and its own belief status; the composition claim
still stops a second whole from taking it.

No edge is deleted by any of this, so `store.verifyConstraintFences()`'s
`compositionExistence` family reports nothing after a close: a closed required
part is tombstoned, not an orphan.

A whole that is not a fact is held to the same liveness the write path holds an
attachment's whole to: present and not tombstoned. A closed validity window does
not make it dead, because the write path would still accept it as a whole. A
whole that IS tombstoned leaves its live required parts unsupported, which is
also what the `compositionExistence` audit reports for that state. A transition
that reaches such a part closes it and names it in `died`, even though the part
was already unbelieved when the transition began.

Each closed fact fires its own `delete` operation hook, parts included — unlike
the delete cascade, which emits one event for the whole. A belief close has no
cascade to report: every part reaching the close is a fact of its own, closed by
its own support verdict, so its hook is its own too.

A configuration that cannot reach a required part is refused when the capability
is created. If a fact kind is the whole of an `existence: "required"` pair whose
part kind is not itself in `fact.kinds`, `createRetractionCapability` throws
`ConfigurationError` (`PROVENANCE_REQUIRED_PART_NOT_A_FACT`) naming both kinds —
closing such a whole would leave a live required part hanging from it, and no
transition could fix that.

Use `retractMany(sources)` or `unRetractMany(sources)` to change several source
flags in one recorded transaction:

```typescript
const report = await provenance.retractMany([
  { kind: "ScannerSource", id: scannerId },
  { kind: "VendorSource", id: vendorId },
]);
```

### Retracting inside your own transaction

Every retraction verb takes an optional transaction as its last argument:
`retract(source, tx)`, `retractMany(sources, tx)`, `unRetract(source, tx)`
and `unRetractMany(sources, tx)`. With it, the transition runs on your
transaction instead of opening one, so a retraction and the writes that depend
on it commit or roll back together. Without it, each verb opens, commits and
reports exactly as before.

```typescript
await store.transaction(async (tx) => {
  const report = await provenance.retract({ kind: "Source", id: sourceId }, tx);
  await tx.nodes.Decision.update(decisionId, { status: "withdrawn" });
  await provenance.assertHolds(tx, [{ kind: "Fact", id: remainingFactId }]);
});
```

On your transaction the verb neither commits nor rolls back. Its writes are
part of that transaction exactly as any other write on it:

- Your transaction's later reads, `holding(tx)` and `assertHolds(tx, …)` see
  them, and a later verb on the same transaction transitions from them.
- Their hooks follow the hook contract of the context you pass. In
  `store.transaction()` and `transactionWithReceipt()`, `onOperationEnd` fires
  when your transaction commits, and not at all when it rolls back. In an
  adopted context from `withRecordedTransaction()` or
  `withEvolvedTransaction()`, hooks run as each write completes, before your
  native transaction commits, so `onOperationEnd` can report a source flag or
  a fact close that your native rollback then undoes. An audit or cache
  consumer of those hooks must treat them as provisional until the native
  commit succeeds.
- A [transaction receipt](/schemas-stores#transaction-receipts) and a
  `tx.measure` scope count each source flag and each fact close or reopen as
  one write of its kind.
- They are recorded at your transaction's one recorded revision, alongside
  your own writes.

The report, and the order `retractMany` and `unRetractMany` apply their
sources in, are the same with and without your transaction.

The verb refuses a transaction from another store or graph, or one kept past
its callback, before any statement, with `ConfigurationError`
(`PROVENANCE_TRANSACTION_NOT_OWNED`, naming the verb), as `holding(tx)` and
`assertHolds` do. Unlike those two, the four verbs always write, so they also
refuse a transaction opened with `accessMode: "read_only"` before any
statement, with `UnsupportedBackendCapabilityError`, after which the
transaction is still usable. `holding(tx)` answers in a read-only transaction,
and `assertHolds(tx, [])` returns an empty result there; `assertHolds` with
facts to judge is refused like the verbs. A store handle whose schema version
is no longer the active one throws `StaleVersionError`.

The verbs, `assertHolds` and `holding(tx)` in a transaction that can write
decide from the support they read under the graph write lock, so those reads
must see every write committed before the lock was granted. On PostgreSQL that
needs read committed isolation: a `REPEATABLE READ` or `SERIALIZABLE`
transaction keeps the snapshot it took at its first statement, which can
predate another session's retraction that the lock then waited for. The
isolation is read from the lock statement's own result on your transaction's
session, not from the option you passed, and any other answer is refused with
`UnsupportedBackendCapabilityError` (capability
`observedReadCommittedIsolation`) before the first support read, leaving the
transaction usable. History capture owned by TypeGraph already requires read
committed for every write transaction; the check matters for a backend with
engine-native recorded time, which accepts other isolation levels. A verb
called without a transaction opens its own at read committed, whatever the
server's default.

Whether the check applies follows from the backend's declared write fence
(`capabilities.writeFence`), not from its dialect:

| Write fence | Can another writer commit after your snapshot, before the lock? | What is required |
| --- | --- | --- |
| `engine-serialized` (SQLite's default) | No: the write transaction takes the engine's single writer slot (`BEGIN IMMEDIATE`) before its first read | Nothing |
| `caller-serialized` | No: the deployment runs every write unit alone, and adopted transactions are refused | Nothing |
| `advisory` (PostgreSQL's default) | Yes, at a snapshot isolation level | Read committed, observed on the lock statement |
| `row` | Yes, unless the session reads per statement | Read committed, observed on the fence-row statement; a fence that cannot report its session's isolation is refused, as the store already refuses an edge-acyclicity probe on it |

The verbs, `assertHolds` and `holding(tx)` share this rule.
`tx.assertUnchangedSince()` and a merge plan applied in your transaction keep
their own, stricter rule: they also refuse a `caller-serialized` fence, which
yields no lock evidence to judge.

A second argument that is not a transaction context at all is refused with
`ConfigurationError` (`PROVENANCE_TRANSACTION_ARGUMENT_INVALID`), naming what
was received. The usual cause is handing a verb directly to an array method:
`sources.map(provenance.retract)` passes each element's index as the
transaction. Pass a function instead, or retract the sources together:

```typescript
await Promise.all(sources.map((source) => provenance.retract(source)));
// or, as one transition with one report:
await provenance.retractMany(sources);
```

A failure inside the verb on your transaction takes no savepoint, so it follows
the rule for any call that fails inside `store.transaction()` and is caught.
A refusal before the verb's first write — the transaction refusals above, a
source of a kind outside the configured source kinds, a source with no current
row — leaves nothing behind. A failure after a write keeps the writes the verb
already made: an `unRetract` that clears a source's flag and then cannot reopen
a fact, because a live fact now holds that fact's unique key, leaves the flag
cleared and the fact closed, and a commit keeps that state. To discard a
partial transition, let the error leave the callback so the whole transaction
rolls back.

In `withRecordedTransaction()` and `withEvolvedTransaction()`, an error that
leaves the callback rejects the adoption call and reaches your native
transaction, and TypeGraph cannot roll that back for you: you must. If you
catch the error and commit the native transaction instead, the writes the
callback made before the error, a retraction's source flag and fact closes
included, commit to the live rows, and under `withEvolvedTransaction()` the
schema change commits too. Under TypeGraph-owned history capture they are also
left out of recorded time, because capture flushes only when the callback
resolves: `asOfRecorded()` and the other recorded-time reads keep showing the
state before them, and no recorded revision is allocated for them. This
limitation is tracked as issue #930 in the TypeGraph repository. A backend with
[engine-native recorded time](/queries/temporal#engine-native-recorded-time)
records committed writes itself, independently of that flush, so there the
writes are recorded; they are still the partial writes of a failed callback,
which only the native rollback discards.

Await the verb before starting other calls on the same transaction. Its locks
exclude other transactions, not other calls on yours, so a write that overlaps
it can land between the transition's support read and its writes.

## Recorded time

Retraction uses TypeGraph-managed writes, so before and after states are visible
through recorded-time reads. On PostgreSQL, provenance transitions serialize
with TypeGraph-managed history writes on the same graph before computing and
applying fact currency. Capture is scoped to TypeGraph-managed writes; it does
not claim to observe out-of-band database mutations.

```typescript
const factBefore = before ? await store.asOfRecorded(before).nodes.Fact.getById(factId) : undefined;
const factAfter = after ? await store.asOfRecorded(after).nodes.Fact.getById(factId) : undefined;
```

Use `holding()` when you only need the current well-founded believed facts:

```typescript
const facts = await provenance.holding();
```

`holding()` waits for a transition or history write in flight on the same
graph, so its multi-statement read never sees half of one, and it writes
nothing: on PostgreSQL it takes the graph's advisory lock and no row, so it
runs in a read-only transaction or under a `SELECT`-only role. On a standby
the lock excludes nothing, since the primary's writers do not hold it there.

## Guarding a derivation at commit time

`retract` reconciles the facts reachable from the sources it names. A fact
written afterwards is not revisited until a later call names its source, so a
write that derives a fact from an already-retracted source, or from a fact that
is live but unsupported, commits as an ordinary live row. `holding()` excludes
that fact, but it opens its own transaction, so using it as a guard leaves a
race between the check and the write.

`assertHolds(tx, facts)` runs inside your own write transaction, after your
writes, and refuses the commit when a named fact is not believed:

```typescript
await store.transaction(async (tx) => {
  const justification = await tx.nodes.Justification.create({ label: "summarize" });
  const summary = await tx.nodes.Fact.create({ label: "summary" });
  await tx.edges.premiseOf.create(source, justification, {});
  await tx.edges.derives.create(justification, summary, {});

  const [held] = await provenance.assertHolds(tx, [summary]);
  // held.via: the justifications currently firing for `summary`
});
// throws FactNotHoldingError; the transaction rolls back
```

A fact holds when it is believed: supported and a live row. That is the same
definition `holding()` uses, composition included, so a required part whose
whole is missing or unsupported does not hold. `assertHolds(tx, facts)` is
defined as "every named fact is in `holding(tx)`".

The call:

- dedupes the named facts; an empty list is checked for transaction ownership
  only, then returns an empty result without a lock or a read, so it is not
  refused in a read-only transaction
- reads rows written earlier in the same transaction
- returns one `{ fact, via }` entry per distinct fact, in the order each was
  first named, where `via` is the justifications firing for it, the same shape
  as `survivedVia` in a retraction report
- throws one [`FactNotHoldingError`](/errors#factnotholdingerror) listing every
  failure, and closes or reconciles nothing; the throw aborts your transaction
- refuses a transaction that does not belong to a running callback of the
  capability's store, and a fact whose kind is not in `fact.kinds`, with
  `ConfigurationError`

### Checking your own intent with `via`

`assertHolds` checks that the fact is believed, not that the justification you
just wrote is the reason. A fact that already holds through another
justification passes even when your new justification does not fire. `via`
names the justifications that do fire, so compare it with what you wrote:

```typescript
const [held] = await provenance.assertHolds(tx, [summary]);
const mine = held.via.some((entry) => entry.id === justification.id);
if (!mine) throw new Error("the new justification does not fire");
```

### Justifications with no premises

A justification with no `premiseOf` edges fires. That is the support rule, and
`assertHolds` does not change it: a fact derived by a premise-less justification
holds, and that justification appears in `via`. Use such a justification for an
axiom, and check that a derivation which should have premises actually has
them.

### Reading the believed set inside a transaction

`holding(tx)` runs the same believed-set computation on the transaction you
pass, so it sees the rows that transaction wrote:

```typescript
await store.transaction(async (tx) => {
  const believed = await provenance.holding(tx);
});
```

`holding()` with no argument is a point-in-time answer, not a write guard. The
facts it returns can stop holding before your next statement runs, because it
reads in its own transaction.

### Locking and transactions

- `assertHolds` is a write guard and needs a read-write transaction. A
  transaction opened with `accessMode: "read_only"` is refused with
  `UnsupportedBackendCapabilityError` before any statement. On
  PostgreSQL it takes the schema-version fence and then the graph write lock, in
  the store's canonical order, before it reads, so it is safe to call before or
  after your first write. A `retract` that overlaps the transaction either is
  seen by the assert, which refuses, or commits after it and closes the new
  fact and names it in `died`; the fact never ends up live and unsupported.
- `holding(tx)` writes nothing. In a read-write transaction it takes the same
  locks as `assertHolds`, the schema-version fence and then the graph write
  lock, so it is safe to call before or after your writes and `assertHolds`.
  Two consequences: on a store handle whose schema version is no longer the
  active one it throws `StaleVersionError`, and a role that may only `SELECT`
  gets the database's own permission error, because the schema fence is a row
  lock.
- In a transaction opened with `accessMode: "read_only"`, `holding(tx)` takes
  the graph write lock alone, so it runs under a `SELECT`-only role. At a
  snapshot isolation level it answers as of that transaction's snapshot, which
  is consistent but can predate writes committed before the lock was granted;
  a read-only transaction decides no write, so it is not refused. In a
  read-only transaction, use `holding(tx)` rather than `assertHolds`.
- In a transaction that can write, `holding(tx)` and `assertHolds` on a keyed
  write fence (PostgreSQL's default) need read committed isolation, observed on
  the lock statement, as the retraction verbs do; see
  [Retracting inside your own transaction](#retracting-inside-your-own-transaction).
- A `SELECT`-only role reads the believed set with `holding()`, or with
  `holding(tx)` in a transaction opened read-only.
- `holding(tx)` holds the graph write lock until your transaction ends, so a
  long transaction that calls it early blocks every other writer of that graph
  for as long as it runs. Call it late, or keep the transaction short.
- Inside a transaction, use `holding(tx)`, not `holding()`. The no-argument
  form opens its own transaction and waits for a graph lock that yours already
  holds.
- `retract`, `retractMany`, `unRetract` and `unRetractMany` run in a
  transaction of their own, or in yours when you pass it, and take the
  schema-version fence and then the graph write lock before their first read,
  so they are safe to call before or after your own writes. On a store handle
  whose schema version is no longer the active one they throw
  `StaleVersionError`, even when the call would have changed nothing or would
  have reported a missing source.
- Inside a transaction, pass it to the retraction verbs. Without it a verb
  opens a second transaction, which commits independently of yours and waits
  for the graph lock if yours already holds it.
- Reacquiring a lock the transaction already holds reuses it.
- `assertHolds` reads only what is behind the named facts, not the whole
  provenance graph, so its cost follows the size of their derivations.

Plain node and edge writes stay unchecked: only a transaction that calls
`assertHolds` carries the guarantee. A guard on the current state also does not
protect a run that read its premises earlier and writes later; a premise that
was retracted and then restored, or edited in place, passes.
