---
title: Graph Merge
description: Branch a TypeGraph store, let many writers edit it independently, and fold their work back into one canonical graph with deterministic entity resolution, conflict reporting, edge repointing, and provenance.
---

Graph Merge turns a TypeGraph store into something you can **fork, edit in
parallel, and reconcile** — the way you already fork, branch, and merge code.
Several writers (agents, importers, reviewers, background workers) each build
graph changes in isolation, and a single deterministic step folds them back into
one canonical graph: duplicate entities are resolved, edges are repointed onto
the survivors, disagreements are surfaced (never silently overwritten), and you
get a full report of what happened and who contributed it.

It ships as a core package subpath:

```typescript
import { branch, merge } from "@nicia-ai/typegraph/graph-merge";
```

Everything here is defined over ordinary TypeGraph stores, schemas, indexes,
backends, and ontology semantics — there is no separate service to run.

## What you can build

Graph Merge exists because "append everything" is the wrong default for graphs:
it produces duplicate entities and dangling relationships. With a real merge
primitive you can build:

- **Multi-agent knowledge-graph construction.** Run N extraction agents in
  parallel, each on its own branch, then merge. The same real-world entity
  discovered by three agents collapses to one canonical node; every agent's
  edges follow it; disagreements come back as conflicts to adjudicate.
- **Parallel ETL / import reconciliation.** Ingest an EHR export, a claims
  feed, and a lab feed as independent branches and reconcile them into one
  patient-care graph — by exact identifier, blocking key, or fuzzy name match.
- **Master-data / entity dedup (CRM, FHIR, catalogs).** Use declared `unique`
  constraints as definitional identity and similarity scoring for the rest.
- **Human-in-the-loop review queues.** `merge()` returns a report, not just a
  mutation. Auto-apply the clean parts, route the conflicts to a reviewer, and
  keep a provenance trail of every decision.
- **Incremental ingestion against a live graph.** `mergeIncremental()` lets new
  batches land on a target that has *advanced* since the branch was taken,
  re-discovering already-committed entities instead of duplicating them.
- **Semantic deduplication.** Plug in an embedder for `vector` or `hybrid`
  similarity to collapse near-duplicates that exact and trigram matching miss.

The throughline: **isolation while writing, determinism while merging, and a
report you can act on.**

## How it works

The mental model is a three-act lifecycle:

1. **`branch()`** stamps the base store's `base@V` (a hash of its schema *and*
   live content) and materializes an isolated, independently-mutable working
   copy. Writers edit the working copy with the normal store API; the base is
   never touched.
2. Writers do whatever they want — create nodes/edges, modify inherited rows,
   delete inherited rows.
3. **`merge()`** diffs every branch against the base, then runs a fixed
   pipeline to fold them into the target:

   ```text
   stage (diff every branch)
     → generate candidates (exact unique · blocking key · similarity)
       → cluster (group nodes that are the same entity)
         → canonicalize (pick a survivor, union properties, resolve conflicts)
           → repoint + dedupe edges onto survivors
             → reconcile delete/modify and types
               → commit transactionally + build the report
   ```

The pipeline is **deterministic by construction**: candidate sets are sorted,
clusters resolve by stable keys, and every conflict is decided on an explicit
`branchOrder` (or lexicographic branch id) — *never* wall-clock arrival. Merging
the same branches in any order yields the same committed graph and the same
normalized report. That property is what makes a merge safe to retry, cache, and
reason about.

## Quick start

Create a base store, fork one branch per writer, write to the branch stores,
then merge them back into the target.

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { asBranchId, branch, isOk, merge, unwrap } from "@nicia-ai/typegraph/graph-merge";

const [base] = await createStoreWithSchema(graph, baseBackend);

// branch() is backend-agnostic: you supply a factory for each branch's backend.
const makeBranchBackend = async () => createFreshBackend();

const sourceA = unwrap(await branch(base, makeBranchBackend, { id: asBranchId("source-a") }));
const sourceB = unwrap(await branch(base, makeBranchBackend, { id: asBranchId("source-b") }));

await sourceA.store.nodes.Patient.create({ name: "Anna Rivera", birthDate: "1974-03-09", mrn: "MRN-001" });
await sourceB.store.nodes.Patient.create({ name: "Ana Rivera", birthDate: "1974-03-09", mrn: "MRN-001" });

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

if (!isOk(result)) throw result.error;
console.log(result.data.resolutions); // the two patients collapsed to one
console.log(result.data.conflicts); // the "Anna" vs "Ana" spelling disagreement
```

`branch()` returns a `Result`; `unwrap` throws on failure (or branch on
`isOk`). The default working-copy strategy clones the base through TypeGraph's
export/import, so each branch gets a fresh backend from your factory.

## Entity resolution

Resolution is configured **per node kind** in `resolve`. A kind that is omitted
merges *by id only*: its new nodes and edges are copied through, but no fuzzy
matching runs. Each configured kind composes up to three candidate sources, all
feeding one shared scorer:

| Source | What it matches | Configured by |
| ------ | --------------- | ------------- |
| Exact unique | Two staged nodes sharing all of a declared `unique` constraint's values — a *definitional* match that bypasses scoring | the graph's `unique` constraints |
| Blocking key | Cheap pre-grouping so similarity only compares plausibly-related nodes | `block` (staged) / `blockIndex` (vs. committed base) |
| Similarity | Fuzzy scoring of candidate pairs against a `threshold` | `similarity` + `threshold` |

```typescript
resolve: {
  Patient: {
    block: (node) => node.mrn ?? node.birthDate, // cheap candidate grouping
    similarity: { kind: "fulltext", fields: ["name"] },
    threshold: 0.78, // pairs scoring >= 0.78 merge
  },
}
```

### Blocking: `block` vs `blockIndex`

Blocking bounds the otherwise-`O(n²)` pairwise comparison by only comparing
nodes that share a cheap key.

- **`block(node) => string | undefined`** is an arbitrary function over staged
  nodes — a normalized email, a tenant id, a birth date, a `soundex(name)`.
  Returning `undefined` puts the node in the shared *unblocked* bucket.
- **`blockIndex`** names a declared `defineNodeIndex` and is the **new-vs-base**
  block key: it lets the merge query *already-committed* nodes that share a
  staged node's index key and propose them as candidates. It powers incremental
  ingestion (see [Snapshot vs incremental](#snapshot-vs-incremental)) and is
  ignored on the snapshot `merge()` path.

```typescript
import { defineNodeIndex } from "@nicia-ai/typegraph";

const patientCohort = defineNodeIndex(Patient, { name: "patient_cohort_idx", fields: ["cohort"] });
const graph = defineGraph({ /* ... */ indexes: [patientCohort] });

// In resolve, recall committed patients in the same cohort:
resolve: { Patient: { blockIndex: "patient_cohort_idx", similarity: { kind: "fulltext", fields: ["name"] }, threshold: 0.85 } }
```

### Keyless windows

A node with no block key and no unique signature lands in the *unblocked*
bucket, which is otherwise compared all-vs-all. For large unblocked sets, set
`keyless` to switch to bounded single-pass **sorted-neighbourhood**: nodes are
sorted by their similarity text and each is compared only to its next `window`
neighbours — `O(n·window)` instead of `O(n²)`, still fully deterministic.

```typescript
resolve: {
  Article: {
    similarity: { kind: "fulltext", fields: ["title"] },
    threshold: 0.8,
    keyless: { window: 20 }, // compare each unblocked article to its 20 nearest neighbours
  },
}
```

### Similarity strategies

Four strategies cover the spectrum from zero-dependency to embedding-powered:

| Strategy | Needs embedder? | Use case |
| -------- | --------------- | -------- |
| `fulltext` | No | Portable in-memory Sørensen–Dice trigram score over one or more fields (e.g. `name`). The cross-backend default. |
| `custom` | No | Your own deterministic `score(a, b) => number` — domain rules, weighted field blends, edit distance. |
| `vector` | Yes | Cosine similarity over one field's embedding. Catches semantic near-duplicates. |
| `hybrid` | Yes | Blend `vector` and `fulltext` by `weights` (default 0.5 / 0.5). |

The `fulltext` scorer runs **in memory** over the staged candidate text — it
deliberately does not consult database fulltext indexes, because branch
candidates are staged working-copy rows, not indexed search results. That keeps
scoring deterministic and identical across SQLite and Postgres.

For `vector` / `hybrid`, supply an `embedder` (batched, async, deterministic —
the same text must always map to the same vector):

```typescript
const result = await merge(base, branches, {
  embedder: async (texts) => texts.map((text) => embedModel(text)), // text[] -> Float32Array[]
  resolve: {
    Article: {
      similarity: { kind: "hybrid", fields: ["title", "summary"], weights: { vector: 0.7, fulltext: 0.3 } },
      threshold: 0.84,
    },
  },
});
```

A `vector`/`hybrid` strategy with no embedder configured fails with a typed
`SimilarityUnavailableError`, never a silent no-op.

## Conflicts

When merged contributors disagree on a property value, Graph Merge **resolves by
an explicit, deterministic policy and records what it did** — it never lets
arrival order decide.

### Property conflicts

| Policy | Behavior |
| ------ | -------- |
| `flag` (default) | Commit the deterministic survivor value (or the committed base value, for base-vs-branch) and record a `PropertyConflict` for review. The graph still gets a value; the disagreement is surfaced rather than resolved toward another branch. |
| `lastWriteWins` | Pick the value from the highest-priority branch (earliest in `branchOrder`) — *logical* order, never wall-clock. |
| `provenanceWeighted` | Pick the value from the highest-weight branch (see `provenanceWeights`). Ties fall back to branch order. |
| function | Delegate: `(conflict) => JsonValue` lets application code decide per conflict. |

There are **two** property-conflict knobs, deliberately separate so a fuzzy
branch match can never silently overwrite committed data:

- `onPropertyConflict` — staged branch vs. staged branch.
- `onBasePropertyConflict` — committed base vs. a branch (new-vs-base merges).
  Defaults to `flag` independently, and does **not** inherit `onPropertyConflict`.

`provenanceWeighted` reads per-branch trust weights you supply:

```typescript
const result = await merge(base, branches, {
  onPropertyConflict: "provenanceWeighted",
  provenanceWeights: new Map([
    [authoritativeFeed.id, 1.0], // the system of record wins ties of value
    [bestEffortAgent.id, 0.2],
  ]),
});
```

### Delete / modify conflicts

An inherited node or edge that one branch **deletes** while another **modifies**
is neither a pure delete nor a pure modify. `onDeleteModifyConflict` governs it
for both nodes and edges:

| Policy | Behavior |
| ------ | -------- |
| `flag` (default) | The modification survives **and** an unresolved `DeleteModifyConflict` is recorded — a merge must never silently destroy the only branch still carrying data. |
| `deleteWins` | Honor the delete; discard the modification; record the conflict. |
| `modifyWins` | Resurrect the row; keep the modification; record the conflict. |

Independent edits to the *same* inherited row by different branches are
**three-way merged against the base**: a field only one branch changed takes
that change with no conflict; only fields multiple branches changed to differing
values become conflicts. This holds for node *and* edge properties, so disjoint
edits compose instead of clobbering each other.

## Edges follow their entities

When nodes collapse, their edges must too. After clustering, Graph Merge:

1. **Repoints** every edge endpoint onto its cluster's canonical survivor.
2. **Drops** any edge whose endpoint was finally deleted (recorded in `dropped`).
3. **Dedupes** edges as a pure set keyed by `(from, type, to, props)`, so two
   branches' "same" edge collapses to one.
4. **Reconciles** edges that collapse to the same `(from, type, to)` but
   disagree on properties, via the same conflict policy as nodes.

Inherited edges that a branch **deleted** are removed from the target, and
inherited edges **modified** by multiple branches go through the same base-aware
three-way merge as nodes — so an edge's `since` edited by one branch and `note`
edited by another keep *both* edits.

## Ontology type reconciliation

With `reconcileTypes: "ontology"`, two staged nodes that share an id but carry
subtype-compatible kinds (via the graph's `subClassOf` closure) are collapsed to
the **most-specific** common type, recorded as a `TypeReconciliation`. A base
`Doctor` and a branch `SpecialistDoctor` reconcile to `SpecialistDoctor` instead
of being dropped as incompatible. The default `"off"` keeps identity strictly
`(kind, id)`.

```typescript
const graph = defineGraph({ /* ... */ ontology: [subClassOf(SpecialistDoctor, Doctor)] });
const result = await merge(base, branches, { reconcileTypes: "ontology" });
```

## Choosing the survivor

By default a cluster's canonical survivor is the member with the
lexicographically-minimal id (and, on new-vs-base merges, a committed base
member always wins so its committed identity stays stable). Override the
staged-vs-staged choice with `canonical`:

```typescript
const result = await merge(base, branches, {
  canonical: (cluster) => preferGoldenSource(cluster.members), // pick which id survives
});
```

## Scaling & safety

Two guards keep a merge bounded and predictable on large or pathological inputs:

- **`maxComparisonsPerKind`** caps fuzzy comparisons per kind. On overflow,
  `onComparisonCeiling` decides: `"error"` (default) fails with a typed error,
  or `"mergeByIdOnly"` skips similarity for that kind (still honoring exact
  unique matches) and records a warning. Tighten your `block` to shrink buckets
  rather than raising the ceiling blindly.
- **`clusterMaxDiameter`** optionally splits over-broad clusters: if a cluster's
  single-link diameter exceeds the bound, the weakest edges are dropped
  deterministically until every sub-cluster fits. This stops a chain of
  near-matches (`a~b~c~…`) from fusing genuinely-distinct entities.

```typescript
const result = await merge(base, branches, {
  maxComparisonsPerKind: 50_000,
  onComparisonCeiling: "mergeByIdOnly",
  clusterMaxDiameter: 2,
});
```

## The merge report

`merge()` returns `Result<MergeReport, MergeError>`. The report is the
**application boundary** — show conflicts to an operator, write a review record,
persist provenance, or feed a downstream step.

```typescript
type MergeReport = {
  merged: { nodes: number; edges: number }; // counts committed
  resolutions: EntityResolution[]; // which fork ids collapsed into each canonical
  conflicts: PropertyConflict[]; // per-property disagreements + how they resolved
  deleteModifyConflicts: DeleteModifyConflict[]; // node/edge delete-vs-modify cases
  typeReconciliations: TypeReconciliation[]; // ontology kind collapses
  dropped: DroppedItem[]; // edges to deleted endpoints, incompatible members
  baseAmbiguities: BaseAmbiguity[]; // new-vs-base matches that spanned >= 2 committed entities
  provenance: ProvenanceIndex; // byBranch(id) -> { nodeIds, edgeIds }
  warnings: string[]; // non-fatal advisories (ceiling skips, provenance-persist failures)
  provenancePersisted?: { graphId: string; count: number }; // when persistProvenance ran
};
```

A typical operator loop: auto-apply when `conflicts` and
`deleteModifyConflicts` are empty; otherwise enqueue them for review alongside
`resolutions` so the reviewer sees what merged and why.

## Provenance

Provenance answers *which branch contributed each merged node and edge*.

- **Report-only (default, `provenance: true`)** — `report.provenance.byBranch(id)`
  returns the `{ nodeIds, edgeIds }` that branch contributed. In-memory; it
  evaporates after the call.
- **Durable (`persistProvenance: true`)** — after the commit, one
  `{branch, sourceId} → canonical` row per contribution is upserted into a
  *sidecar* graph on the target's backend (its own namespaced tables; your
  domain schema is untouched). It is best-effort and post-commit: a persistence
  failure surfaces as a `warnings` entry, never a failed merge. Re-running the
  same merge upserts (deterministic ids), never duplicates.

Query persisted provenance back later:

```typescript
import { openProvenanceStore, readProvenance } from "@nicia-ai/typegraph/graph-merge";

const store = await openProvenanceStore(target.backend, target.graphId);
const fromAgentA = await readProvenance(store, { branchId: "agent-a" }); // what did agent A contribute?
const whoMadeX = await readProvenance(store, { canonicalId: "patient-123" }); // who contributed node X?
```

## Snapshot vs incremental

A branch is forked from a `base@V` — a token combining the base's schema hash
and a fingerprint of its live content. The two merge entry points differ in how
they treat that token.

**`merge()` is a snapshot merge.** Every branch must have forked from the
target's *current* `base@V`. If the target advanced since the branch was taken,
`merge()` returns a `BaseVersionMismatchError` rather than risk clobbering newer
data. This is the right model for "fork, do work, merge back" within one round.

**`mergeIncremental()` is a fork-point merge into a live target.** It merges
branches that forked from a frozen `forkPoint` into a `target` that may have
*moved on*. Additions are re-discovered against already-committed entities (via
`blockIndex` / unique constraints) so a re-seen entity updates the committed row
instead of duplicating it. Inherited node and edge modifications/deletions are
also propagated through the same three-way planner, with the live target kept
authoritative when it changed concurrently.

```typescript
import { mergeIncremental } from "@nicia-ai/typegraph/graph-merge";

const result = await mergeIncremental({
  forkPoint, // the frozen ancestor the branches forked from
  target, // the live committed graph (may have advanced)
  branches,
  options: {
    resolve: { Patient: { blockIndex: "patient_cohort_idx", similarity: { kind: "fulltext", fields: ["name"] }, threshold: 0.85 } },
    onBasePropertyConflict: "flag", // required: never overwrite a newer committed value
  },
});
```

`mergeIncremental()` requires `onBasePropertyConflict: "flag"` so a stale branch
value can never overwrite a newer committed value during new-vs-base recall.
If both the branch and the live target changed the same inherited row, the target
value/deletion wins and the conflict is reported. Both `merge()` and
`mergeIncremental()` commit **transactionally** and require a
transaction-capable target backend.

## Working copies

`branch()` is backend-agnostic. The default `cloneWorkingCopyStrategy` exports
the base through TypeGraph's interchange and imports it into a fresh store on a
backend your factory provides — so it works identically across SQLite, Postgres,
and in-process PGlite, and needs no schema changes.

```typescript
// Each branch gets its own in-memory SQLite backend:
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
const makeBackend = async () => createLocalSqliteBackend().backend;
const fork = unwrap(await branch(base, makeBackend, { id: asBranchId("worker-1") }));
```

For a custom isolation mechanism (e.g. a future copy-on-write namespace), pass a
`WorkingCopyStrategy` as the fourth argument to `branch()` — its single `create`
method returns an independently-mutable store over the same graph definition.

## Determinism

Graph Merge is built to be reproducible, which is what lets you retry, cache,
diff, and test a merge with confidence:

- Candidate sets are sorted before clustering; clusters resolve by stable keys.
- Conflict resolution consults only the captured `branchOrder` (or lexicographic
  branch id) — never wall-clock.
- The committed graph and the normalized report are a pure function of the
  *unordered* branch set.

Use `branchOrder` to make preference explicit wherever a policy needs ordering:

```typescript
const branchOrder = [systemOfRecord.id, agentA.id, agentB.id];
const result = await merge(base, [agentB, systemOfRecord, agentA], {
  branchOrder,
  onPropertyConflict: "lastWriteWins", // systemOfRecord wins, regardless of input order
});
```

## Errors

All entry points return a `Result`; the error arm is a typed `TypeGraphError`
subclass you can branch on:

| Error | When |
| ----- | ---- |
| `BranchError` | `branch()` could not materialize a working copy. |
| `BaseVersionMismatchError` | A branch forked from a different `base@V` than the target now has (snapshot `merge()`). |
| `SimilarityUnavailableError` | A `vector`/`hybrid` strategy was requested with no `embedder`. |
| `MergeConflictError` | A conflict could not be resolved under the configured policy. |
| `MergeError` | Any other merge failure (e.g. comparison-ceiling `"error"`, a non-transactional target). `MERGE_ERROR_CODES` enumerates the codes. |

## Example

See [FHIR Graph Merge](/examples/fhir-graph-merge) for a complete runnable
snapshot merge that reconciles two independently-extracted patient-care branches,
and [Incremental Merge](/examples/incremental-merge) for live-target ingestion
against an advancing base with persisted, queryable provenance.
