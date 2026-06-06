---
title: Graph Merge
description: Branch, reconcile, and merge independently edited TypeGraph stores with deterministic entity resolution.
---

Graph Merge is TypeGraph's reconciliation primitive for workflows where several
writers build graph changes independently and the application needs to fold
those changes back into one canonical graph. It is designed for agent runs,
ETL/import reconciliation, FHIR and CRM deduplication, review queues, and other
cases where "append everything" would create duplicate entities or broken
relationships.

The API ships as a core package subpath:

```typescript
import { branch, merge } from "@nicia-ai/typegraph/graph-merge";
```

## What It Delivers

Graph Merge gives you a deterministic merge pipeline over ordinary TypeGraph
stores:

- **Isolated branches**: `branch()` creates a working-copy store over a backend
  you provide, stamped with the base graph's schema and content version.
- **Entity resolution**: `merge()` can collapse branch-created duplicates by
  exact identity, blocking keys, fulltext similarity, custom scoring, vector
  scoring, or hybrid scoring.
- **Conflict reporting**: property disagreements are returned in a
  `MergeReport`; they are not silently overwritten.
- **Edge repointing**: when nodes are collapsed, edges from every branch are
  repointed to the canonical survivor and deduped.
- **Delete/modify handling**: inherited-row delete/modify conflicts are reported
  and resolved by an explicit policy.
- **Ontology reconciliation**: compatible node kinds can be reconciled through
  TypeGraph's `subClassOf` closure.
- **Provenance**: the report can answer which branches contributed each merged
  node and edge, with optional sidecar persistence.

## Basic Flow

Create a base store, fork one branch per writer, write to the branch stores, and
then merge them back into the target.

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import {
  asBranchId,
  branch,
  isOk,
  merge,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";

const [base] = await createStoreWithSchema(graph, baseBackend);
const makeBranchBackend = async () => createFreshBackend();

const sourceA = unwrap(
  await branch(base, makeBranchBackend, {
    id: asBranchId("source-a"),
  }),
);
const sourceB = unwrap(
  await branch(base, makeBranchBackend, {
    id: asBranchId("source-b"),
  }),
);

await sourceA.store.nodes.Patient.create({
  name: "Anna Rivera",
  birthDate: "1974-03-09",
  mrn: "MRN-001",
});
await sourceB.store.nodes.Patient.create({
  name: "Ana Rivera",
  birthDate: "1974-03-09",
  mrn: "MRN-001",
});

const result = await merge(base, [sourceA, sourceB], {
  resolve: {
    Patient: {
      block: (node) => node.mrn ?? node.birthDate,
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.78,
    },
  },
  onPropertyConflict: "flag",
  branchOrder: [sourceA.id, sourceB.id],
});

if (!isOk(result)) {
  throw result.error;
}

console.log(result.data.resolutions);
console.log(result.data.conflicts);
```

`branch()` is backend-agnostic. The default working-copy strategy clones the
base graph through TypeGraph export/import, so the caller supplies a fresh
backend factory for each branch.

## Entity Resolution

Entity resolution is configured per node kind in `resolve`.

```typescript
const options = {
  resolve: {
    Patient: {
      block: (node) => node.mrn ?? node.birthDate,
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.78,
    },
  },
};
```

Each resolved kind uses three layers:

| Layer | Purpose |
| ----- | ------- |
| `block` | Cheap candidate grouping before similarity, usually a shared ID, birth date, tenant, or normalized key |
| declared `unique` constraints | Exact identity source; shared unique values force a merge candidate |
| `similarity` + `threshold` | Scoring rule for candidate pairs |

Kinds omitted from `resolve` merge by ID only. Their new nodes and edges are
still copied, but fuzzy/entity resolution is skipped.

## Similarity Strategies

Graph Merge supports four strategies:

| Strategy | Needs embedder? | Use case |
| -------- | --------------- | -------- |
| `fulltext` | No | Portable trigram scoring over fields such as `name` |
| `custom` | No | Domain-specific deterministic score function |
| `vector` | Yes | Cosine similarity over one field's embedding text |
| `hybrid` | Yes | Blend vector and fulltext scores |

`fulltext` is an in-memory scorer. It does not query database fulltext indexes,
because branch candidate rows are staged working-copy records, not indexed
search results. This makes the scorer deterministic and backend-independent.

For `vector` or `hybrid`, provide an `embedder`:

```typescript
const result = await merge(base, branches, {
  embedder: async (texts) => texts.map((text) => embedText(text)),
  resolve: {
    Article: {
      similarity: { kind: "hybrid", fields: ["title", "summary"] },
      threshold: 0.84,
    },
  },
});
```

## Conflict Policies

By default, property conflicts are flagged and the canonical value is retained.
The conflict remains visible in the report.

```typescript
const result = await merge(base, branches, {
  onPropertyConflict: "flag",
});
```

Available property policies:

| Policy | Behavior |
| ------ | -------- |
| `flag` | Keep the canonical value and record a conflict |
| `lastWriteWins` | Pick by stable branch/logical ordering, not wall clock |
| `provenanceWeighted` | Pick by configured branch weights |
| function | Delegate resolution to application code |

Base-vs-branch conflicts use `onBasePropertyConflict`, which defaults to
`flag` separately from branch-vs-branch conflicts so committed data is not
accidentally overwritten by a staged policy.

## Merge Report

`merge()` returns a `Result<MergeReport, MergeError>`.

```typescript
type MergeReport = {
  merged: { nodes: number; edges: number };
  resolutions: EntityResolution[];
  conflicts: PropertyConflict[];
  deleteModifyConflicts: DeleteModifyConflict[];
  typeReconciliations: TypeReconciliation[];
  dropped: DroppedItem[];
  baseAmbiguities: BaseAmbiguity[];
  provenance: ProvenanceIndex;
};
```

The report is the application boundary: show conflicts to an operator, write a
review record, persist provenance, or feed a downstream file reconciliation
step.

## Determinism Guarantees

Graph Merge is built to be reproducible. It sorts candidate sets, resolves
clusters by stable keys, and treats `branchOrder` as explicit input when a
policy needs ordering. A merge of the same branches should produce the same
normalized report and committed graph regardless of input branch order.

Use `branchOrder` when you want a stable preference order for conflict policies:

```typescript
const branchOrder = [sourceA.id, sourceB.id, sourceC.id];
const result = await merge(base, [sourceC, sourceA, sourceB], {
  branchOrder,
  onPropertyConflict: "lastWriteWins",
});
```

## Incremental Merge

The primary `merge()` function is a snapshot merge: every branch must have been
forked from the target's current base version. If the target has advanced,
`merge()` returns a `BaseVersionMismatchError`.

For additive workflows where the target may have advanced, use
`mergeIncremental()`. It has a narrower contract: it can absorb additions while
guarding against inherited edits that would clobber newer committed rows.

## Example

See [FHIR Graph Merge](/examples/fhir-graph-merge) for a complete runnable
example that reconciles two independently extracted patient-care branches into
one canonical graph.
