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

The report partitions facts relative to the retracted source:

- `died`: every fact whose currency this transition closed
- `survivedVia`: affected facts that still have a firing justification
- `unaffected`: previously believed facts outside the source's provenance

`died` names every close, including the one case where the fact was not
believed to begin with: a fact found live but ALREADY unsupported when the
transition reaches it loses its currency here and is reported here. Only writes
outside the store's own paths produce that state — a direct backend write, a
custom port, a bypassed import — and `store.verifyConstraintFences()` reports
it while it lasts. A tombstone the report cannot mention would be invisible
data loss, so the pass that writes the tombstones and the report that names them
read one set of rows.

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
