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

- `died`: facts that were believed before and lost grounded support
- `survivedVia`: affected facts that still have a firing justification
- `unaffected`: previously believed facts outside the source's provenance

`unRetract(source)` clears the source flag, recomputes support, and reopens
facts that regain support.

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
