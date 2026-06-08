---
title: Incremental Merge
description: Ingest into a live graph in waves — mergeIncremental() folds a new source onto an already-committed graph without creating duplicates, and persists a queryable provenance trail.
---

This example shows TypeGraph's **incremental** merge path. Where the snapshot
[`merge()`](/examples/fhir-graph-merge) reconciles branches that all forked from
the *current* base, `mergeIncremental()` folds a new source's branch into a
`target` that has **already advanced** — re-discovering an entity that was
committed in an earlier wave and merging onto it instead of creating a duplicate.

It is the primitive for **continuous ingestion**: every new feed, crawl, or
agent batch lands on the live graph, deduplicated against what is already there.

:::tip[Just want the code?]
Full source on GitHub:
[`packages/typegraph/examples/19-incremental-merge.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/19-incremental-merge.ts)
:::

## What It Demonstrates

- A `target` graph that already holds one committed `Company` ("Acme Corp").
- A new provider branch (forked from an empty fork-point in this example) that
  re-reports the same company under a different spelling
  ("ACME Corporation", same `acme.com` domain) and adds a genuinely new one
  ("Globex").
- `mergeIncremental()` recalls the committed company via its unique `domain` and
  merges the new spelling **onto** it — the target keeps one Acme, not two.
- The name disagreement is flagged in the report instead of silently overwriting
  the committed value.
- Provenance is persisted to a sidecar graph and queried back: "which canonical
  entities did this provider contribute to?"

## Run It

From the repository root:

```bash
pnpm --filter @nicia-ai/typegraph exec tsx examples/19-incremental-merge.ts
```

Or from `packages/typegraph`:

```bash
npx tsx examples/19-incremental-merge.ts
```

It uses in-memory SQLite backends, so it needs no Docker or external services.

## Sample Output

```text
=== Incremental Graph Merge ===

Target before: [ 'Acme Corp (acme.com)' ]
Target after:  [ 'Acme Corp (acme.com)', 'Globex (globex.io)' ]

No duplicate was created: the provider's "ACME Corporation" merged onto the
committed "Acme Corp" via the shared domain.

Merged nodes: 2
Entity resolutions: 1
Conflict on Company.name @ acme: provider-crunchbase="ACME Corporation"

Provenance persisted: 3 row(s) in sidecar "company_kb::merge-provenance"

Provenance — canonical entities this provider contributed to:
  - Company "cb-globex" (from source "cb-globex")
  - Company "acme" (from source "cb-acme")
```

## How It Works

```typescript
const result = await mergeIncremental({
  forkPoint, // the frozen ancestor the provider branch forked from
  target, // the live committed graph (already holds "Acme Corp")
  branches: [provider],
  options: {
    resolve: {
      Company: {
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.9,
      },
    },
    onPropertyConflict: "flag",
    onBasePropertyConflict: "flag", // required by mergeIncremental (keep-base)
    branchOrder: [PROVIDER],
    persistProvenance: true,
  },
});
```

Two ideas do the work:

1. **Unique `domain` as definitional identity.** The `Company` kind declares a
   unique constraint on `domain`. The new-vs-base recall queries the target for
   committed companies that share a staged company's domain, so "ACME
   Corporation" (`acme.com`) is matched to the committed "Acme Corp" regardless
   of the name spelling — no similarity threshold needs to be cleared.
2. **Keep-base conflict handling.** `onBasePropertyConflict: "flag"` guarantees
   a stale branch value can never overwrite a newer committed one: the committed
   `name` is kept and the provider's spelling is recorded as a conflict for
   review.

The genuinely-new "Globex" has no committed match, so it is created. After the
commit, `persistProvenance` writes one row per contribution to a sidecar graph
on the target's backend, which `readProvenance` reads back later.

## Why This Matters

Real ingestion is never one-shot. Feeds arrive continuously, crawls re-run, and
agents produce overlapping batches. Append-only ingestion turns that into a pile
of duplicates; a full re-merge from scratch does not scale.

`mergeIncremental()` gives you a **steady-state ingestion loop**:

1. Take each new source as a branch off a known fork-point.
2. Merge it into the live target; already-known entities are recalled and
   updated in place, inherited modifications/deletions propagate, and new ones
   are created.
3. Keep concurrently changed committed data authoritative
   (`onBasePropertyConflict: "flag"`).
4. Persist provenance so every canonical entity carries the trail of which
   source contributed it.

See [Graph Merge](/graph-merge) for the full API reference, and
[FHIR Graph Merge](/examples/fhir-graph-merge) for the snapshot-merge
counterpart.
