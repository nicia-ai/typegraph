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

1. **`branch()`** stamps the base store's `base@V` and materializes an
   isolated, independently-mutable working copy. With `revisionTracking: true`
   (or `history: true`), `base@V` uses the store's durable revision anchor: a
   per-graph random origin plus a monotonic clock. Validation therefore does
   not fingerprint every live row or mistake a coincident revision in a
   separately created store for the branch's base. Existing stores retain the
   schema-and-content-fingerprint fallback. Writers edit the working copy with
   the normal store API; the base is never touched.
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

   If the target Store carries a reconciled schema version, its commit acquires
   and validates the normal schema-write fence before row DML. A raw target
   remains outside that guarantee. PostgreSQL serialization failures are retried
   automatically around the complete merge commit.

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

const [base] = await createStoreWithSchema(graph, baseBackend, {
  // Recommended for graphs that branch repeatedly or stay live while agents work.
  revisionTracking: true,
});

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
streaming interchange, so each branch gets a fresh backend from your factory
without building a graph-sized export document in memory.

## Scaling branches and interchange

`revisionTracking: true` is the recommended mode for long-lived, repeatedly
branched graphs. It advances one durable revision anchor inside each successful
Store write transaction. The anchor combines a per-graph random origin with the
monotonic commit clock, so a branch can only match the store that created it —
not an independent database whose clock happens to share the same timestamp. A
branch and its merge precondition then read that constant-size anchor instead of
hashing every live node and edge. Stores created with `history: true` already
have the same guarantee through their recorded-time commit clock.

On PostgreSQL, the guarantee serializes writes to the same graph with a
transaction-scoped advisory lock. That is the correct trade-off for a live graph
whose branch merges must fail closed, but it can reduce throughput and increase
write latency for a high-concurrency, single-graph workload. Partition that
workload across graphs or leave revision tracking off when the content-fingerprint
fallback is acceptable.

Turning revision tracking off does **not** turn off all serialization.
*Constrained* writes now take the same per-graph mutual exclusion regardless of
`revisionTracking` or `history`, because their check-then-write is only sound if
nothing else writes the graph in between: edge cardinality (`one`, `unique`,
`oneActive`, and the `getOrCreateByEndpoints` create and resurrect legs),
node-kind disjointness on create, and a `kindWithSubClasses` uniqueness
constraint that actually expands to more than one kind — a scope covering a
single kind probes exactly the row the uniques table's primary key then
reserves, so that key is already its fence. Everything else — an unconstrained
create, a delete, a cardinality-`many` edge — pays nothing, so the cost is
proportional to the constraints you actually declared. On PostgreSQL that
exclusion is the same transaction-scoped advisory lock; on SQLite it is the
`BEGIN IMMEDIATE` writer slot the backend already takes. A backend running
without transactions (D1, `neon-http`, or `transactionMode: "none"`) has neither
and cannot be fenced.

This unlocks:

- Many concurrent agent, importer, or review branches without base-version
  validation growing with the graph.
- Large graph copies, backup/export, and transfer pipelines that keep only one
  interchange batch resident at a time via `exportGraphStream()` and
  `importGraphStream()`.
- A safe fast path for a live base: a branch is rejected if any tracked base
  write lands before its merge commits, rather than silently merging a stale
  plan.

Streaming removes the graph-sized heap spike, but a physical working copy still
copies `O(graph)` rows and snapshot merge staging still compares branch state to
the base. Copy-on-write logical branches and delta-only staging remain the next
larger architectural step; they are not hidden behind a micro-optimization.

Revision tracking covers writes through the Store API. Direct backend writes and
raw graph-table writes through `tx.sql` bypass the anchor, so applications using
either escape hatch must avoid them for a branchable graph or retain the default
content-fingerprint validation. On transactional backends, streaming export holds
one read-only repeatable-read transaction across nodes, edges, and identity
assertions, so every chunk belongs to one committed snapshot. A snapshot stream
cannot be piped directly into a target that writes through the same serialized
connection: the same SQLite backend, distinct wrappers sharing one better-sqlite3
handle or one local (`file:`/`:memory:`) libSQL client, a bare `pg`/neon
`Client` (a checked-out `PoolClient` included), a `Pool` explicitly configured
with `max: 1`, a postgres-js client built with `{ max: 1 }`, distinct PGlite
backend wrappers sharing one in-process connection, or Cloudflare Durable Object
storage, whose transaction frame is ambient on the storage object — materialize
it first or import it into an independent backend. Pooled connections, HTTP
drivers, remote libSQL, and separate handles on one database are deliberately
not treated as serialized: each statement gets an independent connection there,
so refusing would refuse work that succeeds. The exclusion is one **exclusive** lease
per serialized connection, not a one-time check and not a cross-kind-only rule:
at most one long-lived interchange stream of any kind holds a given connection,
so all four pairings are refused — import behind export snapshot (even through a
user-wrapped stream that no longer identifies its source backend), export
snapshot behind streaming import, export behind export, and import behind
import. Whichever long-lived stream starts second gets a typed
`ConfigurationError` instead of both hanging; its `details.code` names the
condition holding the connection and `details.requested` / `details.heldBy` name
the pairing that was refused (see
[Interchange serialized-connection guard codes](/errors#interchange-serialized-connection-guard-codes)).
Every long-lived import claims that lease, not only the chunk-streaming one:
`importGraph` holds it for the whole call and `trustedImportGraph` /
`trustedImportGraphStream` for the whole trusted session, so those APIs can throw
this `ConfigurationError` too — new in 0.46 for trusted import, which previously
threw only `TrustedImportError`. TypeGraph's branch cloner detects
the shared-client case and materializes its snapshot before importing it.
Non-transactional backends can export identity-disabled graphs without this
snapshot guarantee. Identity-enabled stores already require a transactional
backend at construction, so every identity export has the snapshot guarantee.

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
3. **Dedupes** edges that repointing brought together, as a pure set keyed by
   `(from, type, to, props)` — so `x → a` and `x → b` both landing on `x → c*`
   collapse to one edge.
4. **Reconciles** edges that collapse that way but disagree on properties, via
   the same conflict policy as nodes — over the properties each side actually
   *changed*, so an inherited row's untouched value never competes with (or
   outvotes) a value some branch authored.

Steps 3 and 4 are scoped to collisions **repointing caused**: edges are grouped by
the endpoint pair they named *before* repointing, and one row per pair collapses. A
TypeGraph store is a multigraph — nothing enforces uniqueness on `(from, kind, to)`,
`create()` makes a parallel edge, and `getOrCreateByEndpoints()` is the opt-in
set-semantics accessor — so a branch that created a parallel edge merges as a
parallel edge, and a window claim lands on the row its author touched. A repointed
edge landing on endpoints that already have several parallel rows merges into one of
them; the rest keep their own properties and windows. What makes two staged edges
"the same row" is their **edge id**, not equal properties: one inherited edge
staged by several branches folds into a single write, while a branch-created edge
is a new row even when its properties happen to match an existing one's.

When such a collapse mixes an **inherited** edge with a branch-created one, the
inherited row is the one kept: a collapse rewrites the row it keeps and does not end
the rows folded into it, so writing onto the row the target already holds is what
keeps a committed edge from being left beside the row that replaced it. This mirrors
the node rule below, and it is also what the surviving edge id in `PropertyConflict`,
window resolutions, and provenance names. A collapse of branch-created edges alone
keeps the lexicographically-minimal edge id.

Inherited edges that a branch **deleted** are removed from the target, and
inherited edges **modified** by multiple branches go through the same base-aware
three-way merge as nodes — so an edge's `since` edited by one branch and `note`
edited by another keep *both* edits. The collapse in step 4 is base-aware for the
same reason: a staged copy of an inherited row carries that row's whole property
bag, and only the values it *changed* count as claims. The clearest case is a row
staged solely to carry an end-of-validity — it authored no property, so it
contributes no claim and raises no conflict, whatever its branch's rank.

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
  merged: {
    nodes: number;
    edges: number;
    identity: { asserted: number; retracted: number }; // ledger effects
  };
  resolutions: EntityResolution[]; // which fork ids collapsed into each canonical
  conflicts: PropertyConflict[]; // per-property disagreements + how they resolved
  deleteModifyConflicts: DeleteModifyConflict[]; // node/edge delete-vs-modify cases
  typeReconciliations: TypeReconciliation[]; // ontology kind collapses
  // Node drops (deleted endpoints, incompatible members), edge drops, identity
  // drops (identity:duplicate-assertion, identity:endpoints-collapsed,
  // identity:retraction-target-mismatch, identity:deletion-overruled), and
  // window deltas the commit cannot apply (window-not-applicable)
  dropped: DroppedItem[];
  // Inherited rows whose end-of-validity the merge resolved, and who claimed each
  // end; precedence: "target" marks a row the incremental target had already ended
  validityEnds: ValidityEndResolution[];
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

Provenance answers *which branch contributed each merged node and edge*. A
contribution is anything a branch authored into the committed row — the
properties it staged, the modification that survived, or the end-of-validity the
merge applied.

- **Report-only (default, `provenance: true`)** — `report.provenance.byBranch(id)`
  returns the `{ nodeIds, edgeIds }` that branch contributed. In-memory; it
  evaporates after the call.
- **Durable (`persistProvenance: true`)** — one `{branch, sourceId} → canonical`
  row per contribution is upserted into a *sidecar* graph on the target's
  backend (its own namespaced tables; your domain schema is untouched). The
  sidecar is opened and claimed **before** the merge commits, so a sidecar graph
  id TypeGraph cannot claim refuses the whole merge and leaves the target
  unmodified; only the row write itself is post-commit and best-effort, where a
  transient failure surfaces as a `warnings` entry rather than a failed merge.
  Re-running the same merge upserts (deterministic ids), never duplicates.

`openProvenanceStore` only ever opens a sidecar graph id it can prove it owns,
and ownership is **marker-first**: a durable `ProvenanceOwner` marker row is the
sidecar's first write of any kind, committed inside the schema fence *before*
the sidecar schema is registered. A never-seen id is free to claim only when it
holds no row in **any** per-graph table — nodes and edges, but equally
recorded-time history, the revision clock and origins, identity assertions and
their derived closure and separation, fulltext, and unique keys — because a
plain `createStore` writes rows without registering a schema, so an unregistered
id is not by itself evidence of a free namespace. Ownership is then the marker
alone, checked independently of the schema hash, because an application is free
to define the same `Provenance` shape at an unrelated id. Because the marker
comes first, the resumable interrupted state is **marker without schema** (or a
marker beside a pre-marker legacy schema): that resumes by registering or
migrating the schema. The opposite state — the exact current sidecar schema with
no marker — is one TypeGraph cannot produce, and is refused unconditionally
whatever the graph contains, empty and provenance-shaped included, since
contents an application could have written are not evidence of authorship.

**What a claim costs, on PostgreSQL.** One writer class takes neither the
per-graph fence nor the graph's active schema row: a schema-less raw
`createStore` writer, or a direct `backend.insertNode` / `insertEdge` call. At
READ COMMITTED its insert could commit between the claim's re-inspection and the
claim's own commit, leaving the marker on an id an application had just made its
own. To close that, the claim issues
`LOCK TABLE <nodes>, <edges> IN SHARE ROW EXCLUSIVE MODE` inside the fence and
before the re-inspection. That mode excludes every `INSERT` / `UPDATE` /
`DELETE` on those two tables **for every graph on the database** — they are
shared tables — while still admitting readers. So while a claim runs, every node
and edge write database-wide waits.

The bound is what makes it acceptable: the lock is taken **only inside a claim**,
which happens when a sidecar is created, upgraded from the pre-marker schema, or
resumed after a crash — never on the common path, where an already-owned sidecar
opens with no fence at all. Its duration is the re-inspection's probes plus one
`INSERT`, with no caller code and no caller I/O inside it. The mode is
`SHARE ROW EXCLUSIVE` rather than plain `SHARE` because it must be
self-exclusive: two concurrent claims on different sidecar ids hold different
advisory locks, so under `SHARE` both would acquire it and then both request
`ROW EXCLUSIVE` for their own marker insert — a lock-upgrade deadlock PostgreSQL
resolves by aborting one of them. SQLite takes no such lock; `BEGIN IMMEDIATE`
already owns the engine's single writer slot.

Refusals carry the code `GRAPH_MERGE_PROVENANCE_ID_COLLISION` and one of five
`details.reason` values — `application-graph`, `empty-legacy-sidecar`,
`unupgradeable-legacy-sidecar`, `unowned-exact-schema-graph`, or
`corrupt-ownership-marker` — so the remediation matches what is actually there
instead of generic advice; a backend with no transactional schema fence refuses
an unclaimed sidecar with `GRAPH_MERGE_PROVENANCE_CLAIM_UNFENCED` (an
already-owned sidecar still opens there). Under `persistProvenance: true` both
of those arrive as a typed `InvalidMergeOptionsError` naming
`details.option: "persistProvenance"`, with the originating `ConfigurationError`
as its `cause` — see
[Merge provenance sidecar codes](/errors#merge-provenance-sidecar-codes).

Query persisted provenance back later:

```typescript
import { openProvenanceStore, readProvenance } from "@nicia-ai/typegraph/graph-merge";

const store = await openProvenanceStore(target);
const fromAgentA = await readProvenance(store, { branchId: "agent-a" }); // what did agent A contribute?
const whoMadeX = await readProvenance(store, { canonicalId: "patient-123" }); // who contributed node X?
```

Inspection tools that have a backend and graph id but not the target's
`GraphDef` can use the standalone overload:

```typescript
const store = await openProvenanceStore(backend, targetGraphId);
```

## Snapshot vs incremental

A branch is forked from a `base@V` — a token combining the base's schema hash
with either its durable revision anchor (`revisionTracking: true` / `history:
true`) or the compatibility fingerprint of live content. A revision anchor is
namespaced by a durable per-graph origin, so it is not transferable between
independently created stores. The two merge entry points differ in how they treat
that token.

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

`mergeIncremental()` requires `onBasePropertyConflict: "flag"` — any other value
is refused with `InvalidMergeOptionsError` — so a stale branch value can never
overwrite a newer committed value during new-vs-base recall.
The `forkPoint` must stay **frozen for the duration of the call**: every branch
diff is computed against it, and the commit transaction re-reads its `base@V`
before applying anything, so a write landing on the fork point mid-merge is
refused with `BaseVersionMismatchError` instead of committing diffs against an
ancestor that no longer exists. Only the `target` may advance while the merge
runs.
If both the branch and the live target changed the same inherited row, the target
value/deletion wins and the conflict is reported. Both `merge()` and
`mergeIncremental()` commit **transactionally** and require a
transaction-capable target backend. Managed targets also acquire the
schema-version write fence; raw targets remain outside schema fencing. On
PostgreSQL, serialization failures from either the target-content guard or the
schema fence are retried automatically around the complete commit.

## Working copies

`branch()` is backend-agnostic. The default `cloneWorkingCopyStrategy` exports
the base through TypeGraph's interchange and imports it into a fresh store on a
backend your factory provides — so it works identically across SQLite, Postgres,
and in-process PGlite, and needs no schema changes.

```typescript
// Each branch gets its own in-memory SQLite backend:
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
const makeBackend = async () => createLocalSqliteBackend().backend;
const fork = unwrap(await branch(base, makeBackend, { id: asBranchId("worker-1") }));
```

For a custom isolation mechanism (e.g. a future copy-on-write namespace), pass a
`WorkingCopyStrategy` as the fourth argument to `branch()` — its single `create`
method returns an independently-mutable store over the same graph definition.

**A branch is a data fork.** `branch()` records the clone's committed schema
`(version, hash)` at fork time, and the merge refuses (typed, as
`BaseVersionMismatchError`) any branch whose store ran a schema operation
afterwards — `evolve()`, `migrateSchema()`, or `removeKinds()` — even a
round-trip migration that restores the original document hash. Those
operations mutate rows through their own preflights, and projecting the side
effects into a merge would detach them from the schema change that caused
them. Apply schema changes to the target first (or re-fork), then merge.

## Valid-time windows

**A new row's window travels with the merge.** A branch-authored node or edge
window — including a deliberately ended one on a resurrection — is written
as-is by the commit rather than reset to merge time. When the incremental
target itself also created the surviving row, the target's committed window
wins.

**An inherited row's end-of-validity is merged.** `update(id, {}, { validTo })`
on a branch is an ordinary write, and the merge carries that ending to the
target even when the row's properties are untouched:

```typescript
await fork.store.nodes.Patient.update(asNodeId("pat-1"), {}, { validTo: "2030-06-01T00:00:00.000Z" });
const report = unwrap(await merge(base, [fork]));
// base now holds pat-1 with valid_to = 2030-06-01, and:
report.validityEnds;
// [{ entity: "node", kind: "Patient", id: "pat-1",
//    validTo: "2030-06-01T00:00:00.000Z", claimedBy: ["worker-1"] }]
```

An ending is treated as a **sibling of deletion**, not as a property, because it
makes the same kind of statement: *this stopped being true*. That single choice
explains the whole contract:

| Situation | Outcome |
| --------- | ------- |
| One branch ends the row | That end is written — including a *later* end, which extends the window. |
| Several branches end it differently | No conflict. The **earliest** end wins, and `report.validityEnds` names every claiming branch. |
| The incremental target already ended it | The target's end stands. A branch never re-windows a row the target itself windowed, and the row is left out of the merge's writes entirely — but the discarded claims are still reported, as an entry carrying `precedence: "target"` and the target's own instant. |
| One branch ends it, another deletes it | Deleted, with **no** `DeleteModifyConflict` — the stronger statement absorbs the weaker one. |
| A branch re-states the end the target holds | No write at all — nothing is staged, so there is no version bump or history row even with `coalesceUnchangedUpserts` off. |
| No branch touched the window | Untouched. A properties-only edit never passes a window, so the committed one stands. |

The earliest-end rule is fixed, not a policy knob: it is commutative and
associative, so the merge stays order-independent, and `onPropertyConflict`
never sees a property your schema does not have.

**The branch that authored the committed end is credited.** An ending is
authored state, so its author is a contributor to that row in
`report.provenance` and in the durable sidecar — even when moving the window is
the only thing that branch changed. Credit follows the *committed* end: when
several branches end a row differently, only the branches whose claim equals the
written instant are credited, while `validityEnds[].claimedBy` still names every
claimant, winning or not. An ending a deletion absorbed commits nothing, so it
credits nobody, and neither does an entry marked `precedence: "target"` — the
merge committed none of that end.

**Every claim the merge observed is visible in `validityEnds`, applied or not.**
An entry with no `precedence` is one the merge *decided*: `validTo` is the
instant it wrote. An entry with `precedence: "target"` is one it did **not** —
the incremental target had already moved that end, so `validTo` is the instant
the target already held, `claimedBy` names the branch claims that were thrown
away, and nothing was written or credited for the row. A row no branch claimed
at all produces no entry, since there was nothing to discard.

Because an ending is not a modification, `onDeleteModifyConflict` never sees
one: a row whose *only* change is its window loses to a concurrent deletion even
under `"prefer-modify"`, since there is no modification to prefer. A row with a
properties edit *and* an ending keeps the usual delete/modify behavior on the
properties, and its ending rides along only if that modification survives.

**What is still NOT merged, and why.** On a row that is live in both the base
and the branch, `validTo` is the only window field a branch can author *and* the
commit can apply. A row's lower bound is immutable outside resurrection —
`validFrom` is written only when a soft-deleted row is brought back — and
`validTo` can be set or moved but never cleared back to open. So two window
deltas are observable in a fork yet unapplicable:

| Observed delta | Reachable how | Merged? |
| -------------- | ------------- | ------- |
| `validTo` set or moved | `update(id, {}, { validTo })` | **Yes** |
| `validFrom` changed | soft-delete + resurrect inside the fork | No |
| `validTo` cleared back to open | soft-delete + resurrect inside the fork | No |

Rather than silently ignore those, the merge reports each one in
`report.dropped` with reason `"window-not-applicable"`. Reconciling a value the
commit would then drop is worse than not merging it: the report would claim a
change that never happened.

Full interval reconciliation (intersecting `[validFrom, validTo]` across
branches) is deliberately out of scope — it needs a write path that moves a live
row's lower bound, which contradicts the temporal model, and it would silently
discard a branch's extension.

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
| `BaseVersionMismatchError` | A branch forked from a different `base@V` than the target now has (snapshot `merge()`). Also the typed replan error `mergeIncremental()`'s in-transaction guards raise, and the by-ID freshness check both commit modes run, when the target moved in the plan→commit window. |
| `IdentityMergeConflictError` | Code `GRAPH_MERGE_IDENTITY_CONFLICT`. Thrown by both `merge()` and `mergeIncremental()` for identity contradictions, assertion-ID collisions, and retract/reassert races. See the [identity guide](/identity/#interchange-and-branch-merge). |
| `InvalidMergeOptionsError` | Code `GRAPH_MERGE_INVALID_OPTIONS`. The supplied option combination is invalid, `mergeIncremental()` was given the snapshot-only `target` option instead of silently ignoring it, or `mergeIncremental()`'s `onBasePropertyConflict` is not `"flag"`. |
| `SimilarityUnavailableError` | A `vector`/`hybrid` strategy was requested with no `embedder`. |
| `MergeConflictError` | A conflict could not be resolved under the configured policy. |
| `MergeError` | Any other merge failure (e.g. comparison-ceiling `"error"`, a non-transactional target). `MERGE_ERROR_CODES` enumerates the codes. |

## Example

See [FHIR Graph Merge](/examples/fhir-graph-merge) for a complete runnable
snapshot merge that reconciles two independently-extracted patient-care branches,
and [Incremental Merge](/examples/incremental-merge) for live-target ingestion
against an advancing base with persisted, queryable provenance.
