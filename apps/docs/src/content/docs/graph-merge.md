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
- **Human-in-the-loop review queues.** `planMerge()` returns the exact proposed
  write set, conflicts, and entity-resolution evidence without changing the
  target. Persist that JSON artifact, review it in another process, and apply
  the reviewed bytes later with `applyMergePlan()`.
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
3. **Plan, then apply.** `planMerge()` diffs every branch against the base and
   runs a fixed planning pipeline. `applyMergePlan()` validates the serialized
   artifact and its digest, checks its revision fence inside the write
   transaction, then mechanically applies the already-resolved writes:

   ```text
   stage (diff every branch)
     → generate candidates (exact unique · blocking key · similarity)
       → cluster (group nodes that are the same entity)
         → canonicalize (pick a survivor, union properties, resolve conflicts)
           → repoint + dedupe edges onto survivors
             → reconcile delete/modify and types
               → emit a revision-fenced JSON plan
                 → validate + commit transactionally + build the report
   ```

   `merge()` remains the one-call convenience wrapper over this same lifecycle;
   it plans and immediately applies. If the target Store carries a reconciled
   schema version, its commit acquires
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

## Reviewable plan/apply lifecycle

Use the two-step API when approval must happen before accepted graph truth
changes. The target must have `revisionTracking: true` or `history: true` so the
plan can carry a durable, store-specific revision fence.

```typescript
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  isOk,
  planMerge,
} from "@nicia-ai/typegraph/graph-merge";

const planned = await planMerge(base, [sourceA, sourceB], {
  resolve: {
    Patient: {
      block: (node) => node.mrn ?? node.birthDate,
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.78,
    },
  },
});
if (!isOk(planned)) throw planned.error;

// Persist outside the target graph, or send to a separate review process.
const stored = JSON.stringify(planned.data);
const reviewed = JSON.parse(stored);

// Later, against the same unchanged target:
const applied = await applyMergePlan(base, reviewed);
if (!isOk(applied)) throw applied.error;
console.log(applied.data.merged); // actual committed effects
```

Planning does not mutate the target. The public plan contains only JSON-safe,
deterministically ordered data: its target/schema/revision fence, resolved write
set, review information, match evidence, and a stable content digest. It never
contains a Store, backend, `Map`, `Set`, callback, or embedder. Applying it does
not re-run blocking, candidate generation, similarity scoring, embeddings,
canonical selection, or conflict callbacks. The final report copies the
reviewed entity-resolution evidence unchanged.

The envelope is deliberately explicit: `formatVersion` selects the wire schema;
`digest` identifies its canonical content; `mode`, `target`, and `anchors` state
what was observed; `proposed` summarizes the review; `writes` is the complete
mechanical write set; and `review` holds the conflicts, resolutions, evidence,
diagnostics, warnings, and other report material known before apply.

### Apply a plan with application writes

Use `applyMergePlanInTransaction(target, tx, artifact)` when the merge, a graph
receipt or anchor, and application SQL must share one caller-owned commit. Build
`tx` by passing the native transaction to the **same target Store's**
`withRecordedTransaction()` callback. Apply the plan before any other write to
the target graph in that transaction; after it returns, the callback may make
more graph writes and the caller may run more SQL on the native handle.

```typescript
await db.transaction(async (nativeTx) => {
  const { result: report, receipt } = await target.withRecordedTransaction(
    nativeTx,
    async (tx) => {
      const applied = await applyMergePlanInTransaction(target, tx, reviewed);
      await tx.nodes.MergeReceipt.create({
        planDigest: reviewed.digest.value,
        mergedNodes: applied.merged.nodes,
      });
      return applied;
    },
  );

  await nativeTx.insert(mergeRuns).values({
    planDigest: reviewed.digest.value,
    recordedAt: receipt.recorded,
    mergedNodes: report.merged.nodes,
  });
}); // await this outer commit before reporting success
```

The adopted applier returns `Promise<MergeReport>` and throws a typed
`MergeError` on refusal or failure. It does not open, commit, roll back, or retry
a transaction. Let the exception reject the outer callback so all merge and
application writes roll back together. Never catch it inside the transaction
and then commit. When the driver reports a retryable transaction failure, retry
the entire outer transaction, including the application writes; do not add an
inner retry or nested transaction around the merge.

PostgreSQL requires the transaction's observed isolation to be `READ COMMITTED`.
SQLite acquires its serialized writer slot before checking the plan fence. The
plan must explicitly have `persistProvenance: false`: atomic sidecar provenance
persistence is refused on this path. `includeInReport` remains supported, so
the returned report can still contain the in-memory provenance index.

On a history store, `receipt.recorded` is allocated after the
`withRecordedTransaction()` capture callback returns. The caller can persist
that anchor with application SQL on `nativeTx` before the outer commit, as the
example above does. Await the outer commit before treating the report or receipt
as durable.

The plan's `proposed` summary describes **proposed changes**. It deliberately
does not call them “merged”: `MergeReport.merged` is reserved for the actual
effects returned after a successful transaction. Coalescing and idempotent
identity operations can make actual counts differ from the proposal.

### Merge after schema evolution in one caller transaction

Prepare the evolution first, then call
`planMergeForEvolution(target, evolutionPlan, branches, options?)` outside the
write transaction. This route resolves writes against the graph produced by
the evolution plan while checking the current target's durable data and
revision fence. The serialized merge plan names the resulting schema
version/hash. If the target schema or revision changes during planning, the
planner refuses the artifact; replan outside the transaction.
Branches forked from the original baseline can merge existing kinds. To
include a newly added kind, call
`branchForEvolution(target, evolutionPlan, makeBackend)` before the caller
transaction (on PostgreSQL, pass the working-copy manager's `makeBackend`; see
[PostgreSQL table-backed working copies](#postgresql-table-backed-working-copies)),
then add data on that isolated branch. The planner accepts
branches from either one matching baseline; a mixed set of old-schema and
resulting-schema forks is refused.
Pass `{ revisionJournal: false }` as the fourth `branchForEvolution()` argument
when its working copy does not need journal-backed changed-key lineage. The
branch remains revision-tracked, and merge planning uses the portable diff
when no other lineage source is available.

```typescript
const evolutionPlan = await target.planEvolution(extension);
const futureBranch = unwrap(
  await branchForEvolution(target, evolutionPlan, makeIsolatedBackend),
);
try {
  await futureBranch.store.getNodeCollectionOrThrow("Tag").create({ label: "New" });
  const mergePlan = unwrap(
    await planMergeForEvolution(target, evolutionPlan, [futureBranch]),
  );

  await db.transaction(async (nativeTx) => {
    const { result: report, receipt } = await target.withEvolvedTransaction(
      nativeTx,
      evolutionPlan,
      (tx) => applyMergePlanInTransaction(target, tx, mergePlan),
    );
    await nativeTx.insert(mergeRuns).values({
      mergedNodes: report.merged.nodes,
      schemaVersion: receipt.schema.version,
    });
  });
} finally {
  await futureBranch.close();
}
```

Apply the merge before other graph writes in the evolved callback. The
applier uses the evolved graph and checks the plan's resulting schema and
revision fences on the same caller session. Passing a merge plan for the old
schema refuses before merge mutation. Evolution's schema CAS is not treated
as a prior callback entity write. Roll back the entire native transaction on
any refusal; the schema change, merge, recorded capture, and application SQL
then roll back together. The report and receipt are provisional until the
outer commit succeeds. An adapter configured with
`schemaProvisioning: "transactional"` can provision required identity or vector
storage on the same native session before the merge callback. The default
DML-only policy refuses such requirements before the schema fence or merge
mutation. Bootstrap base storage before adopting either route; run generic
eager index maintenance separately after the outer commit.

### Candidate write sets for a planned schema

`planCandidateWriteSetForEvolution()` is the branch-free counterpart for a
bounded candidate batch. First use
`captureCandidateWriteSetTargetForEvolution(target, evolutionPlan)` when
authoring the JSON document; it records the evolution plan's resulting schema
identity rather than the currently active one. The planner stages the candidate
against that resulting graph and returns the same resulting-schema merge
artifact accepted by `withEvolvedTransaction()`.

Candidate resolution still includes the committed target as an accepted source.
Existing unique matches and property conflicts are therefore visible in the
reviewed plan before the evolution transaction begins, rather than surfacing as
late write-time failures.

```typescript
const evolutionPlan = await target.planEvolution(extension);
const writeSet = {
  formatVersion: 1 as const,
  sourceId: "import-batch-42",
  target: captureCandidateWriteSetTargetForEvolution(target, evolutionPlan),
  nodes: [{
    kind: "Tag",
    id: "import-batch-42:tag-1",
    properties: { label: "Research" },
    validFrom: "2026-01-01T00:00:00.000Z",
  }],
  edges: [],
};
const mergePlan = unwrap(await planCandidateWriteSetForEvolution({
  target,
  evolutionPlan,
  makeBackend: makeIsolatedBackend,
  writeSet,
}));

await db.transaction(async (nativeTx) =>
  target.withEvolvedTransaction(nativeTx, evolutionPlan, (tx) =>
    applyMergePlanInTransaction(target, tx, mergePlan),
  ),
);
```

The schema change and accepted candidate writes share the caller's one
transaction and recorded revision. If another writer changes the target while
planning, `MergePlanningStaleError` is an expected concurrency result: discard
the candidate plan, recapture the target for a new evolution plan, and replan.

For a frozen ancestor and a live destination, use the named incremental planner:

```typescript
const planned = await planMergeIncremental({
  forkPoint,
  target,
  branches,
  options,
});
if (!isOk(planned)) throw planned.error;

const applied = await applyMergePlan(target, planned.data);
```

When `target` records history, a durable branch can use its sealed recorded
fork point without keeping a second frozen Store:

```typescript
const forkPoint = created.branch.recordedForkPoint;
if (forkPoint === undefined) throw new Error("History was not captured at fork");
const planned = await planMergeIncremental({
  forkPoint,
  target,
  branches: [created.branch],
  options: { onBasePropertyConflict: "flag" },
});
```

`recordedForkPoint` is available when the source captured history at fork time;
it contains both the recorded instant and the branch's `base@V` token. The
planner reads ancestor rows from the target's recorded relations, validates the
origin, schema, and revision anchor, and enumerates only changed keys when
lineage can prove a complete delta. A missing or incompatible anchor is refused
before planning. The direct `mergeIncremental()` wrapper accepts the same fork
point. Keep the durable descriptor with the branch: reopening restores the
recorded fork point from the sealed origin.

The same target revision must still be current when the reviewed plan is
applied. If it moved during planning, planning returns
`MergePlanningStaleError` and no artifact. This is an expected retry-and-replan
outcome under concurrency: recapture the target, create a new plan, and review
its new digest before retrying. If it moved afterwards, `applyMergePlan()`
returns `StaleMergePlanError` before plan writes. Re-plan, review the new
digest and proposal, then apply the new artifact; never edit an
old plan or retry it as though it still represented the target. A successful
plan is single-use: a second or concurrent application is stale.

Persisting a plan or approval in the target graph also advances this revision.
For exact-plan approval, use external storage or a separate graph ID; writes to
that graph do not advance this target's revision. This does not provide atomic
writes across graphs, and any intervening target write still requires a fresh
plan. For candidate batches whose review records belong in the target itself,
use the durable review protocol below.

`merge()` and `mergeIncremental()` remain convenient compatibility wrappers.
They invoke the same planner and applier contiguously and return the same
`MergeReport` shape as before, now with match evidence on each resolution. Use
the wrappers when no external approval boundary is needed.

:::caution[Sensitive plans and trust]
A plan contains the complete resolved writes and may therefore contain personal,
regulated, or otherwise sensitive application data. Protect it like the source
graph: encrypt it where appropriate, restrict access, and avoid logging it. The
digest identifies the exact canonical artifact and detects accidental or
unrecorded changes. It is **not** a signature, proof of origin, authentication,
or authorization. Authenticate untrusted storage and authorize the caller before
passing a plan to `applyMergePlan()`.
:::

### Durable candidate review in the target graph

`planCandidateWriteSetReview()` separates immutable review evidence from a
revision-bound execution plan. Its `MergeReviewArtifact` retains the original
candidate write set, reviewed plan, normalized merge options, explicit policy
identity/context, and target baseline. You can persist this artifact and later
approval records in the target before calling
`revalidateCandidateWriteSetReview()` to compute a fresh execution plan.

Both review formats support candidate write sets only. They do not rebase arbitrary artifacts
from `planMerge()` or `planMergeIncremental()`.

Candidate planning on revision-tracked graphs reads existing candidate ids and
edge endpoints by key, then seeds only those rows in the transient working
copy. On identity-enabled graphs, it also follows live same-id peers and
current identity assertions from those references to a fixed point. The
planner reads peers of a candidate edge with `one` cardinality by source,
peers of a `unique` edge by its endpoint pair, and the active peer of a
`oneActive` edge by source. The active-only read checks an open `validTo` even
when `validFrom` is in the future, and does not return ended history. These reads
let the transient copy enforce the same cardinality rule as a complete clone.
On graphs with ontology relations, it also reads live nodes sharing each
candidate reference's id across kinds, so disjointness sees the same peers as a
complete clone. Ontology subtype relationships remain graph metadata.
The candidate diff and its target baseline are bounded to that dependency set and
any committed rows recalled by configured unique or index sources. Planning
still fences the target revision before and after these reads. With edge
match-identity constraints, a backend offering `findEdgesByMatchIdentity`
seeds the exact durable owners named by the candidate. A missing keyed read,
an owner excluded from the clone projection, or a target without revision
tracking uses the complete clone path. A custom backend lacking the optional
`findActiveEdgesBySourceV1` read also uses that path for `oneActive` graphs.

On the complete clone path, when the copy and target really share one serialized connection, clone export
is materialized before import, but its snapshot still holds the connection's
exclusive stream lease while it is collected. Concurrent review calls on that
resource can therefore return a merge error caused by a `ConfigurationError`
with `details.code: INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT` or
`INTERCHANGE_SERIALIZED_IMPORT_IN_PROGRESS`. Await the whole review call before
starting another on the same serialized resource. A `pg.Pool` with more than one
connection is not one serialized resource; do not declare its pool object as
`{ mode: "shared" }` just because the working copies use that pool. See
[Serialized connections](/backend-setup#serialized-connections).

The following continues the [candidate write set example](#constraint-aware-ingestion-branches).
`Artifact`, `Decision`, and `evidence` are application-defined node/edge kinds;
`proposal` is an existing node. The target enables `history` or `revisionTracking`.

```typescript
import {
  applyMergePlan,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";

const policy = {
  id: "acceptance-policy-v1",
  context: { requiredApprovals: 1, resolverVersion: "2026-09-01" },
};
const review = unwrap(
  await planCandidateWriteSetReview({
    target: store,
    makeBackend,
    writeSet,
    policy,
  }),
);
const artifact = await store.nodes.Artifact.create(
  { content: JSON.stringify(review) },
  { id: review.digest.value },
);
await store.edges.evidence.create(proposal, artifact, { note: "review" });

// After an authenticated reviewer approves under the application's policy:
const decision = await store.nodes.Decision.create({
  approved: true,
  reviewDigest: review.digest.value,
});
await store.edges.evidence.create(decision, artifact, { note: "approval" });

// Later: authenticate the stored artifact and decision, then check current
// authorization, approval validity, and policy before reusing that approval.
const persisted = await store.nodes.Artifact.getById(artifact.id);
if (persisted === undefined) throw new Error("Missing review artifact");
const checked = unwrap(
  await revalidateCandidateWriteSetReview({
    target: store,
    makeBackend,
    review: JSON.parse(persisted.content),
    policy,
  }),
);
if (checked.status !== "compatible") {
  console.log(checked.differences);
  throw new Error("Create a new review and obtain a new approval");
}
if (checked.reviewDigest.value !== decision.reviewDigest) {
  throw new Error("Approval does not identify the validated review");
}

// Keep this fresh execution plan ephemeral: another target write makes it stale.
const applied = unwrap(await applyMergePlan(store, checked.plan));

// A separate commit AFTER successful apply; see the recovery boundary below.
await store.nodes.Artifact.create({
  content: JSON.stringify({
    reviewDigest: checked.reviewDigest,
    approvalId: decision.id,
    executionPlanDigest: checked.plan.digest,
    executionTarget: checked.plan.target,
    report: applied,
  }),
});
```

All approval records and links must be committed before final revalidation.
Do not persist each replacement execution plan in the target: that repeats the
staleness cycle. Retain the original review, and use the returned `reviewDigest`
plus the fresh plan's `digest` and `target` fence to relate approval to execution.

Both review APIs return `Result<..., MergeError>`. Revalidation accepts the
persisted artifact as `unknown` and replans its retained candidate input once
target, policy, and baseline checks pass.
Supply current merge `options` and `policy` again; callbacks are never restored
from serialized data.

| Revalidation status | Meaning and next step |
| --- | --- |
| `compatible` | Includes a fresh `plan` and the original `reviewDigest`. Application policy may reuse approval; authorize the action and apply promptly. Compatibility itself grants no permission. |
| `changed` | `differences` identify changed policy/options, baseline entities/identity, or plan fields. Obtain a new review and approval. A `plan` is included only when fresh planning completed. |
| `incompatible` | The graph ID, schema identity, or revision origin differs. Approval cannot be reused for this target; resolve the mismatch and create a new review. |

Malformed/unsupported artifacts, mismatched digests, and missing required
evidence return `MergeReviewError` (`GRAPH_MERGE_REVIEW`). Existing typed planning
and constraint errors remain errors rather than compatibility statuses. A target
change during evidence capture/planning returns `MergePlanningStaleError`.

The V1 baseline is deliberately conservative:

- Every original node and edge row, including tombstones and validity metadata,
  must remain unchanged. Editing an old audit record requires a new review even
  when the candidate's resolved writes would be identical.
- Expected absences for candidate/write/guard references must remain absent.
  Same-ID nodes of other kinds are also guarded, because they can change implicit
  identity membership. Complete archival identity evidence must remain unchanged.
- Newly added rows can coexist with approval only when fresh planning produces
  identical resolved writes, guards, conflicts, evidence, provenance, and other
  plan content. Candidate-derived anchors and the execution digest/fence are
  regenerated. There is no exemption for an “audit” kind.

For an eligible revision-tracked graph, pass
`reviewScope: "candidate"` to `planCandidateWriteSetReview()` to emit
candidate-scoped evidence (`formatVersion`
`MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED`, 4). It fingerprints the
candidate's node and edge ids,
edge endpoints, resolved writes, and plan guards, including expected absences
across kinds. On Operational Identity graphs it also records the reachable
identity assertion and same-id peer closure, plus assertion-ID collision
evidence. Revalidation expands that retained identity scope, rereads the
referenced rows, and replans the candidate under a new target fence. An unrelated original row may change
without invalidating a candidate-scoped review when it cannot affect the
fresh resolved plan; the default whole-target review (`formatVersion`
`MERGE_REVIEW_FORMAT_VERSION`, 3) would report that row change. Applications
whose approval policy needs the whole-graph rule should omit `reviewScope`.
The review artifact records its format and scope, so revalidation applies the
rule originally reviewed. A review stored under format 1 or 2 embeds a
version-1 plan and is refused with `MergeReviewError`
`details.reason: "unsupported-version"`; plan and review the candidate write
set again.
Candidate-scoped review refuses graphs outside those eligibility rules.
On a `oneActive` graph, a custom backend must expose
`findActiveEdgesBySourceV1` for candidate-scoped review; the complete-clone
candidate planner and whole-target review remain available when it does not.
A graph that declares a target-side cardinality, an `acyclic` edge or a
composition pair is not eligible either: those constraints depend on rows
outside the candidate's own scope.
On an Operational Identity graph, a custom Store runtime must also expose
endpoint-scoped and assertion-ID-scoped identity reads. Without both reads,
ordinary candidate planning uses the complete working-copy clone and
whole-target review remains available; an explicit candidate-scoped review
request is refused.

Applicable store constraints still run during atomic application. Compatibility
does not promise that apply will succeed: new rows may introduce constraint
conflicts, and any write between revalidation and apply causes
`StaleMergePlanError`. A failed application commits no partial candidate node,
edge, or identity writes. Revalidate again after a stale refusal; require reapproval if
the result changes. This includes an `acyclic: true` edge kind: canonicalization
and repointing can close a cycle out of edges that were individually fine in
every branch. Every entry point (`merge()`, `mergeAgainstBase()`, `planMerge()`,
`planMergeIncremental()`, `mergeIncremental()`) checks the resolved plan's
projected edge writes for such a cycle at PLAN time, before anything is
written — including a cycle formed entirely from edges the plan itself
proposes, with nothing live on the target yet. A violation surfaces as the
typed `AcyclicityMergeConflictError` (`code: "GRAPH_MERGE_ACYCLICITY_CONFLICT"`),
naming the relation and every offending edge in `details`, so a `planMerge()`
review sees it before deciding whether to apply. Only a cycle that arises from
a write racing the plan-time check (which holds no per-graph lock, since
planning does no write) escapes it, and is still caught by the unchanged
apply-time write path: apply refuses with `MergeConstraintConflictError`
wrapping the underlying `EdgeAcyclicityError` — the same generic
declared-constraint translation cardinality, disjointness, and uniqueness
conflicts already take, because apply writes every edge through the store's
own collection API, which already enforces it.

`policy.id` identifies your policy implementation; `policy.context` explicitly
records every opaque dependency that can change its decision. Include callback
and resolver versions, model/prompt versions, external configuration or data
versions, and any application state used to authorize approval reuse. Use an
empty context only when no such dependencies exist. TypeGraph captures callback
presence and serializable options, but cannot discover callback code, closure
state, external reads, or hidden application policy dependencies.

The producer must supply complete evidence, and the application must authenticate
the entire stored review and its approval. Content addressing and SHA-256 detect
content changes; anyone able to replace evidence can recompute a digest. A valid
digest is neither proof that the baseline was complete nor authorization to
reuse approval. Enforce artifact immutability and access control in your storage
or application. The review contains candidate data and an entire reviewed plan,
so protect it with the same care as graph data.

Whole-target review capture and revalidation read and fingerprint the complete target
graph and archival identity ledger. The artifact stores one fingerprint per
original row plus expected absences. Budget graph-sized reads and artifact
storage for it. Candidate-scoped review uses bounded point and identity
closure reads for its baseline on eligible graphs.

The execution receipt above is a separate commit. If its write fails or the
process stops after apply, the merge may already be committed without a receipt.
Retain the original review and approval, and reconcile committed history and
application operation identity before repairing the receipt. Do not treat a
missing receipt as permission to replay the candidate; applying its old execution
plan is stale, and replanning is not a duplicate-execution check. To commit the
receipt atomically with the merge, create it in an `afterApply` callback as
described in [Composing application checks and writes](#composing-application-checks-and-writes).
Review revalidation alone does not add that guarantee.

See the runnable [durable merge review example](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/27-durable-merge-review.ts)
for the complete schema and lifecycle.

## Composing application checks and writes

Pass execution callbacks to `applyMergePlan()` when a reviewed candidate and
related application records must commit together:

```typescript
const result = await applyMergePlan(target, reviewedPlan, {
  beforeApply: async (reads) => {
    const resource = await reads.nodes.Resource.getById(resourceId);
    if (resource?.owner !== "unclaimed") {
      throw new Error("Resource is already claimed");
    }
  },
  afterApply: async (tx, applied) => {
    await tx.nodes.Resource.update(resourceId, { owner: "accepted" });
    const decision = await tx.nodes.Decision.create({
      status: "accepted",
      changedNodes: applied.merged.nodes,
    });
    await tx.edges.decides.create(decision.id, resourceId, {});
  },
});
if (!isOk(result)) throw result.error;
// The plan and application writes have now committed together.
```

`Resource`, `Decision`, and `decides` stand for types registered in your graph.
Import `MergePlanApplyOptions`, `MergePlanReadContext`, and `MergePlanApplied`
from `@nicia-ai/typegraph/graph-merge` to type reusable helpers. Callbacks are
execution options: they are not stored in the artifact or covered by its digest.

The transaction acquires the schema fence before the graph write lock, validates
schema, revision origin, and revision, and then calls `beforeApply`. This context
exposes node and edge collection reads and, for identity-enabled graphs, identity
reads. Write methods, native SQL, and a root Store are absent. Application writes
before plan application are deliberately unsupported: an uncommitted write can
change the reviewed state without changing its durable revision yet.

After the precheck, TypeGraph performs the existing plan preflight, identity
checks, and writes. `afterApply` receives a `TransactionContext` whose reads see
those writes. Its `applied.merged` contains only the plan's provisional counts;
callback writes do not contribute to the final report's merge counts. Use the
supplied contexts for every graph operation. Calling the original Store inside a
callback does not enlist it in this transaction. Do not retain a context for later
work, and await every operation before returning.

Callbacks must resolve without a value. Throw or reject to abort; returning a
value, including an `Err`, is refused with `InvalidMergeOptionsError`. A callback
rejection, stale plan, merge failure, capture-flush failure, or commit failure
rolls back the combined graph operation. Errors are converted to the outer
`Result` after rollback; ordinary application errors are retained in the cause
chain. Existing typed merge errors and constraint translation remain intact.
Only the successful outer result confirms commit.

Transaction conflicts (PostgreSQL serialization failures or deadlocks) retry the
whole transaction up to **three attempts**, including both callbacks. Every
attempt checks the fence again; an intervening committed write makes the plan
stale rather than silently rebasing it. Keep callbacks safe to repeat. Do not send
messages, call external services with side effects, or publish an outcome inside
a callback. Perform those effects after successful completion, or write an
application outbox record through `tx` for later delivery. Returned contexts and
provisional outcomes are not durable notifications.

Protection covers the target graph's transactional state and participating
TypeGraph writers using its graph fence. It does not make an application policy a
declarative constraint: every writer changing that policy's state must enforce
it, for example through its own conditional operation. It does not cover other
graphs, arbitrary SQL, or external systems. SQLite uses its writer transaction;
Composed PostgreSQL applications use read-committed isolation and the graph
write lock with or without history. The lock statement records the effective
session isolation; incompatible or unknown isolation is refused before callbacks.
Standalone revision-tracking-only applications retain serializable isolation. Unsupported
transaction capabilities are refused before callbacks. Existing session-bound
fence and recorded-capture isolation checks still apply.

With history enabled, plan and application writes share the transaction's
recorded capture and flush, producing one per-graph recorded revision. Without
history, revision tracking likewise advances for the combined transaction.
Failure leaves no live changes or recorded revision from the failed attempt.
Existing valid-time bounds, including open bounds, retain their semantics.

Optional persisted merge provenance remains separate from recorded history:
provenance records are persisted only after successful graph commit, and a
persistence failure remains a report warning. Callbacks do not receive a
post-commit provenance result. Previously committed review records in the target
still invalidate a plan's revision fence; this API does not relax plan staleness.
For a durable candidate review, revalidate the stored review first, then pass
the compatible result's fresh `plan` and these callbacks to `applyMergePlan()`.

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
nothing else writes the graph in between: edge cardinality — both the
source-side axis (`one`, `unique`, `oneActive`) and the independent
[target-side axis](/core-concepts#target-cardinality) (`targetCardinality:
"one" | "oneActive"`), including the `getOrCreateByEndpoints` create and
resurrect legs on either axis — node-kind disjointness on create, and a
`kindWithSubClasses` uniqueness
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
the base. Bundled backends page those comparisons across declared kinds, so
unused kinds do not each cost a database statement; custom backends without the
cross-kind read retain per-kind keyset pagination. Disposable candidate clones
also skip statistics refresh. Copy-on-write logical branches and delta-only
staging remain the next larger architectural step.

Revision tracking covers writes through the Store API. Direct backend writes and
raw graph-table writes through `tx.sql` bypass the anchor, so applications using
either escape hatch must avoid them for a branchable graph or retain the default
content-fingerprint validation. On transactional backends, streaming export holds
one read-only repeatable-read transaction across nodes, edges, and identity
assertions, so every chunk belongs to one committed snapshot. A snapshot stream
cannot be piped directly into a target that writes through the same serialized
connection: the same SQLite backend, distinct wrappers sharing one better-sqlite3
handle or one local (`file:`/`:memory:`) libSQL client, a bare `pg`/neon
`Client` (a checked-out `PoolClient` included), a `pg` `Pool` capped at one
connection (`{ max: 1 }`, and equally the uncoerced string forms `{ max: "1" }`
and the legacy `{ poolSize: "1" }` that `max: process.env.PG_MAX` produces), a
postgres-js client capped at one connection (`{ max: 1 }`, `?max=1` in the URL,
or `PGMAX=1`), distinct PGlite backend wrappers sharing one in-process
connection, or Cloudflare Durable Object storage, whose transaction frame is
ambient on the storage object — materialize it first or import it into an
independent backend. Pooled connections, HTTP drivers, remote libSQL, and
separate handles on one database are deliberately not treated as serialized:
each statement gets an independent connection there,
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

| Source       | What it matches                                                                                                        | Configured by                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Exact unique | Two staged nodes sharing all of a declared `unique` constraint's values — a *definitional* match that bypasses scoring | the graph's `unique` constraints                     |
| Blocking key | Cheap pre-grouping so similarity only compares plausibly-related nodes                                                 | `block` (staged) / `blockIndex` (vs. committed base) |
| Similarity   | Fuzzy scoring of candidate pairs against a `threshold`                                                                 | `similarity` + `threshold`                           |

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

| Strategy   | Needs embedder? | Use case                                                                                                         |
| ---------- | --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `fulltext` | No              | Portable in-memory Sørensen–Dice trigram score over one or more fields (e.g. `name`). The cross-backend default. |
| `custom`   | No              | Your own deterministic `score(a, b) => number` — domain rules, weighted field blends, edit distance.             |
| `vector`   | Yes             | Cosine similarity over one field's embedding. Catches semantic near-duplicates.                                  |
| `hybrid`   | Yes             | Blend `vector` and `fulltext` by `weights` (default 0.5 / 0.5).                                                  |

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

### Identity separation veto

On a graph with `identity` enabled, a current `different` assertion between
two nodes' identity classes vetoes a match **at plan time**, whichever source
proposed it. There is no option to state: a `different` assertion is an
integrity fact, so the veto runs for every identity-enabled merge.

| Proposed match | Outcome |
| --- | --- |
| A **scored** candidate pair | Dropped. The merge continues, both entities land as staged, and the vetoed pair is reported on [`MergeReport.identityConflicts`](#identity-conflicts) |
| A **definitional** match (a shared unique value, a `blockIndex` hit, an ontology retype) that survives the base and diameter guards | The plan fails with `GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT`, naming both entities, the separating assertion and the sources that proposed the match |
| A **transitive** fusion — `a`–`b` and `b`–`c` each pass the threshold while `a` and `c` are held apart | The plan fails with `GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT`, naming the separated pair and the whole cluster |

This converts what would otherwise be a commit-time database constraint
violation into an upfront, attributed outcome.

A `same` assertion is not a candidate source. Asserting `same` between two
nodes records identity truth — a class, honored by every identity-aware read —
and the merge carries that assertion across, but it never rewrites the two rows
into one. Rows are fused only by [entity resolution](#entity-resolution).

## Conflicts

When merged contributors disagree on a property value, Graph Merge **resolves by
an explicit, deterministic policy and records what it did** — it never lets
arrival order decide.

### Property conflicts

| Policy               | Behavior                                                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag` (default)     | Commit the deterministic survivor value (or the committed base value, for base-vs-branch) and record a `PropertyConflict` for review. The graph still gets a value; the disagreement is surfaced rather than resolved toward another branch. |
| `lastWriteWins`      | Pick the value from the highest-priority branch (earliest in `branchOrder`) — *logical* order, never wall-clock.                                                                                                                             |
| `provenanceWeighted` | Pick the value from the highest-weight branch (see `provenanceWeights`). Ties fall back to branch order.                                                                                                                                     |
| function             | Delegate: `(conflict) => JsonValue` lets application code decide per conflict.                                                                                                                                                               |

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

### Identity conflicts

A merge carries each branch's identity assertions and retractions to the
target, classifying every pair three ways against the target's current truth.
The rules are fixed; there is no policy to choose.

| Staged shape | Outcome |
| --- | --- |
| Branches assert the same pair under different assertion ids | One survivor is written: an id the target already holds wins, then the earliest `validFrom`, then the code-point-smallest id. Every other id is reported on `dropped` with reason `identity:duplicate-assertion` |
| Branches end the same assertion at different instants | One retraction is written, at the **earliest** staged `validTo` — independent of branch order |
| One branch retracts a pair and re-asserts it itself | Both are written: the base assertion ends at the staged instant and the replacement lands |
| One branch retracts a pair while a **different** branch re-asserts it without retracting | The merge fails with `GRAPH_MERGE_IDENTITY_CONFLICT`, naming both assertions and both branches |
| Branches assert `same` and `different` for one pair over overlapping validity windows | The merge fails with `GRAPH_MERGE_IDENTITY_CONFLICT`, naming both assertions |
| A scored candidate match spans two identity classes held apart by a `different` assertion | The match is dropped and reported (see below); the merge continues |

Every staged assertion and retraction therefore ends as a write, a `dropped`
entry with a reason, or a refusal that names it — none disappears silently. A
refusal writes nothing: reconcile the branches (retract one side, or re-assert
on the branch that retracted) and merge again.

`MergeReport.identityConflicts` — and `review.identityConflicts` inside the
durable plan artifact — lists each scored match the
[separation veto](#identity-separation-veto) dropped:

| Field | Meaning |
| --- | --- |
| `kind` | `"separation"` |
| `a`, `b` | The two entities the candidate source proposed as one |
| `assertionIds` | The `different` assertion holding their classes apart |
| `source` | The recall path that proposed the match |

A plan carrying an `identityConflicts` entry is still applicable: the vetoed
match is simply not made.

### Delete / modify conflicts

An inherited node or edge that one branch **deletes** while another **modifies**
is neither a pure delete nor a pure modify. `onDeleteModifyConflict` governs it
for both nodes and edges:

| Policy           | Behavior                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flag` (default) | The modification survives **and** an unresolved `DeleteModifyConflict` is recorded — a merge must never silently destroy the only branch still carrying data. |
| `deleteWins`     | Honor the delete; discard the modification; record the conflict.                                                                                              |
| `modifyWins`     | Resurrect the row; keep the modification; record the conflict.                                                                                                |

Independent edits to the *same* inherited row by different branches are
**three-way merged against the base**: a field only one branch changed takes
that change with no conflict; only fields multiple branches changed to differing
values become conflicts. This holds for node *and* edge properties, so disjoint
edits compose instead of clobbering each other.

### Composition orphans

Two independent ways a merge can leave a required or optional composition
part with no whole, both surfaced through the same
`MergePlanReview.compositionOrphans` finding and the same
`MergeCompositionOrphanError`:

- **`cause: "deleted"`** — a branch deletes a composition whole (see
  [Composition](/ontology#composition)) while a part attached to it on the
  target *after* the branch point, or independently of it, survives — the
  branch's diff carries no deletion for that part, so applying the plan as
  trusted would leave it pointing at a whole that no longer exists.
- **`cause: "unattached"`** — a required-existence part (`existence:
  "required"`, see [Composition existence](/ontology#existence-a-part-that-cannot-exist-without-a-whole))
  this merge writes, or whose composition edge this merge explicitly deletes
  or ends, resolves to no live whole at all after canonicalization. There is
  no whole to name for this cause, so `whole` is absent.

`planMerge` and `planMergeIncremental` scan for both against the target's
current state and report every finding in `MergePlanReview.compositionOrphans`:

```typescript
type MergePlanCompositionOrphan = {
  part: { kind: string; id: string };
  whole?: { kind: string; id: string }; // absent for cause: "unattached"
  viaEdgeKind: string; // the realizing composition edge
  cause: "deleted" | "unattached";
};
```

This is a best-effort, unlocked dry-run read, surfaced for an operator to act
on before approving the plan. `applyMergePlan` re-verifies the same finding
inside the apply transaction, under the per-graph write lock, and refuses with
`MergeCompositionOrphanError` (see [Errors](/errors#mergecompositionorphanerror))
if it still recurs there — so a plan-time report that comes back empty is not
a guarantee against a concurrent attach racing the eventual apply. The
`"unattached"` cause has its own residual blind spot: a composition edge
silently dropped by canonicalization's endpoint-deleted repointing issues no
write for any per-write guard to see — see
[Limitations](/limitations#composition-existence-existence-required).

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
subtype-compatible kinds (via the store's own validated `KindRegistry` — the
same registry a query runs against, not a private closure the merge recomputes)
are collapsed to the **most-specific** common type, recorded as a
`TypeReconciliation`. A base `Doctor` and a branch `SpecialistDoctor` reconcile
to `SpecialistDoctor` instead of being dropped as incompatible. The default
`"off"` keeps identity strictly `(kind, id)`.

```typescript
const graph = defineGraph({ /* ... */ ontology: [subClassOf(SpecialistDoctor, Doctor)] });
const result = await merge(base, branches, { reconcileTypes: "ontology" });
```

`equivalentTo` participates in "most specific" too, since it is mutual
subsumption (see [Ontology & Reasoning](/ontology#equivalence)): a base
`Doctor` and a branch `Physician` declared `equivalentTo` reconcile to whichever
of the two sorts first in code-point order, deterministically, rather than
being flagged incompatible.

## Choosing the survivor

By default a cluster's canonical survivor is the member with the
lexicographically-minimal id. A committed member always wins instead, so its
committed identity and the edges already attached to it stay stable: on
new-vs-base merges that is a committed base member, and on incremental merges
it is also a node the live target committed after the fork point, such as one
an earlier branch's merge added. Override the staged-vs-staged choice with
`canonical`:

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
  resolutions: EntityResolution[]; // collapse membership + decisive match evidence
  conflicts: PropertyConflict[]; // per-property disagreements + how they resolved
  deleteModifyConflicts: DeleteModifyConflict[]; // node/edge delete-vs-modify cases
  typeReconciliations: TypeReconciliation[]; // ontology kind collapses
  // Node drops (deleted endpoints, incompatible members), edge drops, identity
  // drops (identity:duplicate-assertion, identity:endpoints-collapsed,
  // identity:retraction-target-mismatch, identity:deletion-overruled), and
  // lower-bound deltas the commit cannot apply (window-not-applicable)
  dropped: DroppedItem[];
  // Inherited rows whose end-of-validity the merge resolved. Each entry carries
  // validTo for a set/move or clearValidTo: true for a reopening.
  validityEnds: ValidityEndResolution[];
  baseAmbiguities: BaseAmbiguity[]; // new-vs-base matches that spanned >= 2 committed entities
  provenance: ProvenanceIndex; // byBranch(id) -> { nodeIds, edgeIds }
  warnings: string[]; // non-fatal advisories (ceiling skips, provenance-persist failures)
  candidateDiagnostics?: CandidateDiagnostics; // bounded, opt-in scored comparisons
  provenancePersisted?: { graphId: string; count: number }; // when persistProvenance ran
  identityConflicts: IdentityUnresolvedConflict[]; // scored matches the separation veto dropped
};
```

A typical operator loop: auto-apply when `conflicts` and
`deleteModifyConflicts` are empty; otherwise enqueue them for review alongside
`resolutions` so the reviewer sees what merged and why.

### Why two entities matched

Every multi-member `EntityResolution` has `decisiveEdges`: a deterministic
minimal connectivity witness. A resolution over N distinct `(kind, id)`
identities normally has N−1 edges. Endpoints retain both kind and id, so
same-id nodes of different kinds remain distinguishable during ontology
reconciliation.

A same-id ontology retype remains a `TypeReconciliation`, rather than creating
an id-merge resolution. Its optional `decisiveEdges` carries the accepted retype
witness without changing the meaning of the existing resolution collection.
When a retype cluster also spans several ids, the id-merge resolution it does
produce names the **reconciled** kind in `EntityResolution.kind` — the kind the
canonical row is written under, the same value `TypeReconciliation.toType`
records — never the staged survivor's pre-retype kind.

Each edge records every candidate source that proposed the pair in stable order.
Definitional evidence names the trusted rule, such as a unique constraint, and
does not pretend the internal forced match was a perfect similarity score.
Scored evidence records the strategy descriptor, actual score, and threshold
used by the shared scorer:

```typescript
type MatchEvidence =
  | {
      a: { kind: string; id: string };
      b: { kind: string; id: string };
      sources: MatchSource[];
      decision: "definitional";
    }
  | {
      a: { kind: string; id: string };
      b: { kind: string; id: string };
      sources: MatchSource[];
      decision: "scored";
      strategy: MatchStrategy;
      score: number;
      threshold: number;
    };
```

Built-in source metadata distinguishes block, unique, base-unique, base-index,
keyless, and ontology-retype proposals. Several
sources proposing the same pair are all retained after deduplication. Strategy metadata describes `fulltext`,
`vector`, `hybrid`, or `custom` configuration, never custom function source.
Default evidence excludes the raw compared values and rejected pairs because
those may contain PII and can make reports enormous.

Candidate diagnostics are explicit and bounded:

```typescript
const planned = await planMerge(base, branches, {
  ...options,
  candidateDiagnostics: { limit: 1_000 },
});
```

When enabled, the report and reviewable plan include accepted and rejected
scored comparisons in canonical order. A definitional edge removed by the base
ambiguity or diameter guard is also retained with its exclusion reason, so the
final partition remains explainable. The collection also carries `total`,
`limit`, and `truncated`.
The limit is deterministic: the same candidate set produces the same retained
prefix regardless of branch, source, or backend enumeration order. Diagnostics
still omit raw compared values; join their `(kind, id)` references to application
data only in an appropriately protected evaluation environment.

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
with the store's durable revision anchor when `revisionTracking: true` or
`history: true` is on, or a complete live-content fingerprint otherwise.
The revision anchor is namespaced by a durable per-graph origin, which
`Store.clear()` rotates. A lineage-capable untracked store whose backend
supports that origin relation also carries it beside its content fingerprint.
The two merge entry points differ in how they
treat that token.

The token is printable text, so it can be stored anywhere an application
keeps descriptors, plans, and fork points, including PostgreSQL `text` and
`jsonb` columns. Treat it as opaque: compare it whole and never parse it.
Tokens minted by releases before this format, which separated components
with a NUL character, are refused with a `BaseVersionMismatchError` whose
`details.reason` is `"legacy-token-format"`. Re-branch or re-plan from the
current target. Earlier `engine:` anchors and untracked content tokens without
the active schema version also require re-branching; they cannot match the
current target's token.

The token is printable text, so it can be stored anywhere an application
keeps descriptors, plans, and fork points, including PostgreSQL `text` and
`jsonb` columns. Treat it as opaque: compare it whole and never parse it.
Tokens minted by releases before this format, which separated components
with a NUL character, are refused with a `BaseVersionMismatchError` whose
`details.reason` is `"legacy-token-format"`. Re-branch or re-plan from the
current target.

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

### Lineage and pruned diffs

A backend may declare a `lineage` capability: an opaque, whole-database
`revision(session)` it can report and compare, plus `changesSince(session,
revision, graphId)`, which names every node and edge of one graph that
changed (inserted, updated, deleted, or resurrected) after that revision — or
admits `{ kind: "unbounded" }` when it cannot bound the answer. Bundled SQLite
and PostgreSQL stores with `revisionTracking: true` also provide bounded
lineage through a DML journal when history capture is disabled. `lineageRevisionNow()`
mints a public anchor and `changesSince(anchor)` returns changed node and edge
keys. Use that anchor API rather than `revisionNow()`, which returns a clock
value without the graph's origin identity. The journal is installed when the
store is provisioned through `createStoreWithSchema()`, or explicitly with
`installRevisionChangesJournal(backend)` from `@nicia-ai/typegraph/schema`
under a schema owner role. Existing installations must first adopt base schema
version 4 through a privileged schema open or generated base-schema migration.
Runtime lineage checks the journal and its triggers without issuing DDL; a
revision-tracked store without history fails with `REVISION_JOURNAL_NOT_READY`
when the journal is not ready. Short-lived clones that do not need this bounded
lineage can set `revisionJournal: false`. Writes before the first anchor are
outside that anchor's range.
Node and edge inserts, updates, and deletes are recorded by database triggers.
Identity-only revisions and revisions whose write provenance is incomplete
produce `{ kind: "unbounded" }` rather than an incomplete key list. Custom
backends must provide their own lineage capability to get bounded results.
`store.changesSince(anchor)` holds to the same rule on a history-capturing
store: the keys name nodes and edges only, so a span in which an identity
assertion was created, retracted or ended answers `unbounded` rather than a
key list that omits it. The lineage source `resolveLineage(store)` returns is
unchanged — a merge reads identity through its own path, and its pruned diff
keeps a bounded node and edge delta across an identity write.
Each trigger is attached to a whole physical node, edge, or identity table; it
records every write to that table and uses `graph_id` to identify the affected
graph. On shared tables this captures writes from every graph, not only graphs
whose stores enabled the journal. Journal rows are retained per revision and
never cleaned up automatically; applications should avoid installing triggers
on shared tables unless cross-graph capture is intended, and should plan an
external retention policy that preserves every revision still used as a branch
anchor. `resolveLineage(store)`
selects backend lineage first, then captured history, then the first-party
revision journal. A lineage source is consulted only to avoid rework; it never
changes what a merge decides.

`revision()` reports `<origin>:<clock>`, never the bare clock value alone:
the durable, random per-graph revision-origin nonce
(`typegraph_revision_origins`) plus the recorded-time clock. Two
independently created stores that share a `graphId`, or the SAME store
across a `Store.clear()` boundary, can mint numerically comparable clock
values, and the origin is what keeps `changesSince` from mistaking one for
the other — a revision whose origin no longer matches the graph's LIVE
origin row is `unbounded`, regardless of what its numeric clock value is.

The recorded-relations derivation's delta is trustworthy only when EVERY
writer to the graph goes through a store that captures history — a precondition
it can partially, but not fully, enforce itself. `changesSince` proves
completeness directly rather than inferring it from a high-water mark: every
integer revision between the requested one and the graph's current clock
must carry direct evidence — a `recorded_from` or a non-sentinel
`recorded_to` — in one of the three recorded relations (nodes, edges,
identity assertions). This catches an incomplete record wherever the hole
falls, including a `revisionTracking`-only `Store` (no `history`) that
advanced the shared clock without inserting a row and was later FOLLOWED by
a capturing commit — a later capturing commit cannot retroactively supply
the missing evidence, so the gap is caught regardless of what comes after
it. What it CANNOT detect: a non-capturing writer bypassing every `Store`
entirely (a raw `GraphBackend` write, or an engine-side mutation outside
TypeGraph), which leaves no evidence to be short of. Route every writer
through a capturing `Store` if a `"keys"` delta from this source must be
exhaustive.

`session` is the connection the caller's decision is bound to — a
session-less bag could never be pinned to anything, so this one always
carries one. A caller planning outside any transaction (`branch()`'s
fork-revision capture, the pruning below) passes the root backend it holds;
a caller re-validating a content fingerprint inside an open commit transaction
reads through that transaction's own handle, so the fingerprint observes the
transaction's snapshot and establishes dependencies on the rows it covers.

**Untracked stores use a complete fingerprint.** An engine-wide revision and
node/edge-only `changesSince` result cannot fence an identity-only write. It
also cannot establish read dependencies on the graph state used in planning.
For this reason, a store without TypeGraph revision tracking fingerprints live
nodes, edges, and current identity assertions even if its backend exposes
`lineage`. Where supported, the token also carries the durable graph origin.
The commit transaction checks the origin and recomputes the fingerprint before
applying its writes. Previously minted `engine:` base tokens are retired; re-branch
from the current store rather than applying an old merge.

**`Store.clear()` rotates the revision origin.** For revision-tracked stores,
`clear()` deletes and re-mints the per-graph origin in the same transaction.
A branch forked before that clear cannot merge into the post-clear store even
when its revision clock has the same numeric value.

The origin row is also read fresh on every mint (`computeBaseVersion`,
`Store.revisionOriginNow()`), never cached on a `Store` instance. Two live
`Store` objects can legitimately observe the same graph — nothing requires
that only one `Store` ever exists per database — and only one of them runs
`clear()` at a time; a stale per-instance cache on the other would keep
minting anchors from the origin that existed before the clear, so a branch
it forks would fail every merge at commit until that `Store` happened to be
recreated. Reading fresh means a second `Store` over a graph another `Store`
just cleared sees the rotation immediately, with nothing to recreate.

**Pruning the diff.** `branch()` also records a `forkRevision` on the
returned `GraphBranch` — the fork's own `lineage.revision(session)`, read
right after the working copy is created and before any write reaches it,
with the working copy's own root backend as the session (this runs strictly
outside any transaction). For the recorded-relations source this is
origin-bearing like any other reading, so clearing and repopulating the
FORK itself to the same revision count `forkRevision` held is caught the
same way a cleared BASE store already is — there is no separate guard for
the fork side to add, because the token itself now carries the check. When
staging a branch for merge, its diff against the base is restricted to the
union of two deltas: what changed on the *fork* since `forkRevision`, and
what changed on the *base* since the anchor in its own `base@V` — instead of
enumerating every live row on both sides. A key absent from both deltas
cannot have changed since the fork point, so narrowing the read to their
union cannot miss anything the full diff would have found; it only fetches
fewer rows to compare. Pruning is a pure optimization with one rule:
whenever either side cannot supply a bounded delta, the merge falls back to
comparing every live row, exactly as it always has. That covers no
`forkRevision` (a hand-built branch, or one whose store resolved no
`lineage`); either side's `changesSince` answering `unbounded` or
REJECTING (a transient engine error never fails a merge the full diff would
have completed); and the base's own anchor failing to resolve against the
base store's lineage at all — an origin mismatch between a revision-anchored
`base` and the base store's live revision row, a revision anchor minted
before the base store's first tracked write, or an old engine anchor that
must be re-branched. Nothing about *what* a merge decides depends on
whether its diff was pruned.

## Working copies

`branch()` is backend-agnostic. The default `cloneWorkingCopyStrategy` exports
the base through TypeGraph's interchange and imports it into a fresh store on a
backend your factory provides — so it works identically across SQLite, Postgres,
and in-process PGlite, and needs no schema changes. The import is
fidelity-preserving: undeclared properties that `validateStore()` treats as
healthy semi-structured data are carried through. Stripping them would make a
later merge invent deletions against the original base.

```typescript
// Each branch gets its own in-memory SQLite backend:
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
const makeBackend = async () => createLocalSqliteBackend().backend;
const fork = unwrap(await branch(base, makeBackend, { id: asBranchId("worker-1") }));
```

For a custom isolation mechanism (e.g. a future copy-on-write namespace), pass a
`WorkingCopyStrategy` as the fourth argument to `branch()` — its single `create`
method receives the base store and the `BaseVersion` `branch()` already
stamped off it, and returns an independently-mutable store over the same
graph definition.

**A branch is a data fork.** `branch()` records the clone's committed schema
`(version, hash)` at fork time, and the merge refuses (typed, as
`BaseVersionMismatchError`) any branch whose store ran a schema operation
afterwards — `evolve()`, `migrateSchema()`, or `removeKinds()` — even a
round-trip migration that restores the original document hash. Those
operations mutate rows through their own preflights, and projecting the side
effects into a merge would detach them from the schema change that caused
them. Apply schema changes to the target first (or re-fork), then merge.

### PostgreSQL table-backed working copies

`createPostgresWorkingCopyManager` allocates a private set of TypeGraph tables
in the source PostgreSQL database. It derives the table inventory and base
schema marker from TypeGraph's PostgreSQL schema contributions, copies the
source graph with fenced `INSERT ... SELECT` statements, and records ownership
in `typegraph_working_copy_allocations`. The control backend, source backend,
and backends returned by `connect` must all reach the same database, and
`control` and `connect` must run as the same role
([One database role](#one-database-role)). TypeGraph checks the allocation's
private ownership token through each connection.
The control backend must execute DDL inside its PostgreSQL transactions;
its root `executeDdl` port is not required.

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import {
  createPostgresBackend,
  createPostgresTables,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createPostgresWorkingCopyManager } from "@nicia-ai/typegraph/adapters/drizzle/postgres/working-copy";
import {
  asBranchId,
  branchDurable,
  destroyDurableBranch,
  reopenDurableBranch,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";

const control = createPostgresBackend(drizzle(pool));
const copies = createPostgresWorkingCopyManager<typeof graph>({
  control,
  connect: (names, allocation) =>
    Promise.resolve(
      createPostgresBackend(drizzle(pool), {
        tables: createPostgresTables(names),
        ...(allocation === undefined ?
          {}
        : { vector: allocation.vectorStrategy }),
      }),
    ),
});

const { branch: copy, descriptor } = unwrap(
  await branchDurable(sourceStore, copies.durable, {
    id: asBranchId("candidate-42"),
    allocationId: "candidate-allocation-42",
  }),
);
await copy.close(); // Releases the connection; the tables remain.

const reopened = unwrap(
  await reopenDurableBranch(graph, descriptor, copies.durable),
);
await reopened.close();
unwrap(await destroyDurableBranch(descriptor, copies.durable));
```

The same manager exposes `ephemeral` for `branch()`; closing that branch drops
its tables. `listUnsealedAllocations({ after, limit })` pages through durable
allocations awaiting seal and ephemeral allocations. These rows may still have
active owners; the ledger alone cannot identify a crashed process. After
confirming that no live branch or allocation uses a row, call
`abortAllocation(id)` to remove it. A durable branch's descriptor contains only
the allocation ID, not connection credentials. Pass `sourceTableNames` when the source backend uses
custom status table names; pass `reopenOptions` to restore process-local hooks
or query options on a later process. An external `recordedRead` binding is
refused because its relation is outside the owned table inventory. Reopen
options cannot replace the allocation's schema, recorded-read binding,
history mode, or revision-tracking mode. Pass `operations` to let
`durable.operations` commit host mutations atomically with immutable evidence;
see [Atomic operations and immutable evidence](#atomic-operations-and-immutable-evidence).
Each durable allocation also owns an evidence table (`<prefix>op_evidence`) in
the allocation's schema, addressed through that schema rather than the
connection's `search_path`; destroy refuses to drop it while undelivered
evidence remains.

The source backend and every backend returned by `connect` must expose the
complete PostgreSQL `tableNames` inventory, including history, identity, and
status relations. The manager refuses missing or mismatched bindings with a
`BranchError` before cloning or opening a Store. For `ephemeral` and `durable`,
`connect` runs after the allocation tables are created, so custom callbacks may
inspect those tables; on binding failure, the manager removes the new tables and
ledger row. `makeBackend` connects earlier, before it provisions anything.

The table-backed strategy supports bundled tsvector fulltext, declared
PostgreSQL B-tree, GIN, and trigram graph indexes, and pgvector sidecars. It
builds each declared graph index on private tables under stable
allocation-scoped physical names while keeping logical index names and schema
hashes unchanged. `materializeIndexes()` can retry or repair indexes after
reopen; destroy removes their owned tables and indexes. When `connect` receives
an allocation vector strategy, pass it to `createPostgresBackend`; the strategy
assigns stable table and index names from the ledger-reserved physical prefix.
Allocation claims and all initial table and vector DDL commit together, so a
colliding or failed provision leaves no partly owned sidecars. Source vector sidecars
are copied under the same transaction locks as TypeGraph relations. The ledger
stores every relation name declared by each slot's `ownedTables()` contribution,
so destroy can remove them in reverse declaration order without a graph object.
Reopening requires the graph's vector slots and owned-relation inventory to
match the persisted allocation manifest. Older ledger rows that stored only
`tableName()` remain readable as single-relation slots. A declared vector slot
whose source sidecar is absent is refused because its contents cannot be
snapshotted exactly.

The `ephemeral` and `durable` copies have a fixed schema: `evolve`, kind
removal, and deprecation refuse before mutation. Use `makeBackend`, below, when
the working copy's schema must change. Custom fulltext strategies still need a host-level database
fork. The source and every copy connection, including durable reopen, must use
the bundled `tsvectorStrategy`: a custom strategy may own additional physical
tables whose rows cannot be copied safely from the generic contribution
inventory. A connection with fulltext disabled is refused for the same reason.
System index maintenance remains available. Source table locks cover the
entire TypeGraph relation set and vector sidecars while the SQL clone runs, so a
large clone briefly blocks writes to other graphs in the same database.

#### One database role

The manager supports one deployment shape: the `control` backend and every
session `connect` returns run as the **same PostgreSQL role**. TypeGraph reads
`current_user` on both sessions and refuses a difference with a
`ConfigurationError` whose `details.code` is `WORKING_COPY_ROLE_MISMATCH`, and
the refused allocation is not left behind.

The reason is ownership. A `control` session provisions and removes every
allocation, but the Store that opens on a connected backend issues its own DDL:
runtime-contribution markers, the revision journal and its triggers, system and
declared indexes, and vector tables an evolved graph introduces. Only a table's
owner (or a member of the owning role, or a superuser) can drop it, and the
comparison is by role name, so a `connect` role that is merely a member of
`control`'s role is refused rather than trusted. A different role would leave
the tables it creates behind on close and `abortAllocation`. The shared role
therefore needs `CREATE` on the schema.

`makeBackend` calls `connect` before it writes the ledger row or any DDL and
refuses a mismatch there, so nothing is allocated. `ephemeral` and `durable`
call `connect` after their allocation tables exist, so they refuse right after
it, before cloning or opening a Store, and remove the new allocation; a durable
reopen refuses the same way and leaves the sealed allocation untouched.

#### One schema per allocation

Every allocation lives in one schema: the `control` session's current schema when
the allocation is made, recorded in the ledger's `schema_name` column. No
`search_path` decides where an allocation's relations are created or dropped, so
a `connect` pool whose connections lead with different schemas cannot strand
tables that removal never finds.

- **Provisioning** fixes its transaction's search path to that schema before it
  claims the ledger row, so the tables it creates land there whichever pooled
  connection runs it, and the claim records the schema the statement itself
  observed.
- **The connected backend** receives table names that carry the schema. A
  backend built with `createPostgresTables(names)` over that object runs the DDL
  it issues lazily (bundled tables a Store ensures on first use, fulltext and
  contribution storage, schema-write transactions) with the schema leading its
  search path, and the allocation's pgvector strategy names its tables and
  indexes through the schema. `CREATE INDEX CONCURRENTLY` cannot run in a
  transaction; it creates the index in the schema of the table it names, which
  is already the allocation's. The backend's catalog probes (table, index, and
  column lookups, including the recorded-time compatibility check a
  `history: true` Store runs) read the allocation's schema, not the session's
  current one. Extensions are database-global and create no
  allocation relation, but their DDL still runs through the same DDL runner
  wherever the write fence takes no lock: there, a backend built over a caller's
  own transaction is subject to the same session check as any other lazy DDL
  (below). Under a lock fence, a pooled backend installs the extension in its own
  transaction, as before; a backend built over a caller's own transaction runs it
  as a savepoint inside that transaction and makes no session check, because the
  extension creates no allocation relation.
- **Refusals.** A connection whose backend was built over a *copy* of `names`
  (which carries no schema) is refused with a `BranchError`. A `connect` driver
  that cannot hold an interactive transaction (`drizzle-orm/neon-http`) is
  refused with a `ConfigurationError`
  (`ALLOCATION_SCHEMA_REQUIRES_INTERACTIVE_TRANSACTIONS`), because it cannot run
  its DDL under a fixed schema. A backend built over a caller's own transaction
  runs its lazy DDL and schema writes, and adopts that transaction for a schema
  write, only when that session's current schema is the allocation's; otherwise
  it is refused with a `ConfigurationError`
  (`ALLOCATION_SCHEMA_SESSION_MISMATCH`). The caller owns that session's search
  path, so it is checked rather than rewritten.
- **Removal** (`close`, `abort`, `destroy`, `abortAllocation`) searches the
  catalog across every schema for relations named with the allocation's reserved
  prefixes. It drops those in the recorded schema, schema-qualified in one
  statement, and deletes the ledger row in the same transaction. If a drop fails
  (a view that depends on an allocation table, for example) the transaction rolls
  back, the row stays, and the allocation remains in `listUnsealedAllocations()`
  for `abortAllocation()` once the dependency is gone. If any such relation sits
  in a different schema, removal refuses with a `BranchError` that names the
  schemas found and keeps the row, because deleting the row would discard the
  only pointer to them. Three cases are worded differently. When the recorded
  schema holds none of them, the schema was renamed or the tables moved (the
  message says the relations are "not in its schema"; move the tables back or
  correct the row's `schema_name` and remove again). When every relation found
  elsewhere has a same-named relation in the recorded schema, it is a stale copy
  left in another schema, such as a backup or restore schema (the message says
  the allocation "also has relations" there; drop the copy and remove again,
  since the copy blocks removal until it is gone). When some relations moved and
  others stayed, for example one table moved to a backup schema while the rest
  remain, the allocation is split and the relations elsewhere may be the only
  copy (the message says the allocation "is split across schemas"; the
  suggestion drops nothing, so move the relations back or correct the row's
  `schema_name`). `details` carries `allocationId`, `schema`, `foundIn`, and
  `schemas`, and `suggestion` names the recovery step. If the
  allocation's relations exist nowhere (its tables were dropped entirely) there
  is nothing to recover, and removal deletes the ledger row, so a crashed owner's
  allocation cannot stay listed forever.
- **Ledger rows from before the schema was recorded** (written by 0.72.0) carry
  no schema. They resolve through the session that removes them and reopen
  without binding, and follow the same removal rule: relations found in a schema
  other than the removing session's refuse removal and name that schema. `control` adds the column to an
  existing ledger the first time it runs.

The connection must still be able to *resolve* the allocation's tables, so its
`search_path` must include the schema, typically `public`. A per-role `"$user"`
schema ahead of it is fine. The ledger itself lives where `control`'s session
creates it, so run `control` with one consistent `search_path`.

#### `makeBackend` for branches, candidate planning, and evolution previews

`copies.makeBackend` is a `MakeBackend`, so PostgreSQL callers no longer
hand-roll table prefixes, DDL, and cleanup. It fits every API that takes one:
`branch`, `ingestionBranch`, `planCandidateWriteSet`,
`planCandidateWriteSetReview` (including sparse staging), `branchForEvolution`,
and `planCandidateWriteSetForEvolution`.

```typescript
import { branch, branchForEvolution } from "@nicia-ai/typegraph/graph-merge";

const fork = unwrap(await branch(sourceStore, copies.makeBackend));
const preview = unwrap(
  await branchForEvolution(sourceStore, evolutionPlan, copies.makeBackend),
);
```

Each call allocates a fresh allocation in the same ledger, in the `ephemeral`
state, and returns an **empty, schema-mutable** backend: the caller (or the
branch API) seeds it and may commit new kinds and fields, which the fixed-schema
`ephemeral` and `durable` copies refuse. Closing the backend drops the
allocation. While it is live it appears in `listUnsealedAllocations()`, and if
its owner crashes without closing it, `abortAllocation(id)` removes everything
it owns.

Because the graph is unknown when the backend is allocated:

- **Vector tables.** A graph that declares embeddings creates its per-field
  pgvector tables after allocation, so the ledger manifest cannot list them.
  Dropping an allocation therefore also removes every table in its schema whose
  name starts with the allocation's reserved vector prefix. That prefix is
  fixed-length and never truncated, so it cannot match another allocation's
  tables. `connect` always receives the allocation vector strategy for
  `makeBackend`; bind it with
  `createPostgresBackend({ vector: allocation.vectorStrategy })`. A connection
  that binds any other vector strategy is refused with a `BranchError`, because
  it could create tables the allocation does not own. Pass `vector: false` to
  opt out of vector support.
- **Graph indexes.** PostgreSQL index names are database-global, so a declared
  index cannot reuse its logical name on a private table. `makeBackend` scopes
  each declaration to the allocation (`<prefix>gix_<hash>`) the first time the
  Store's `materializeIndexes()` sees it, leaving logical names and schema
  hashes unchanged and never touching the source's or another allocation's
  indexes. A backend you derive from the returned one with `deriveBackend`
  inherits the scoping; one you build by copying its members does not.
- **Fulltext.** The same bundled `tsvectorStrategy` requirement applies as for
  the cloned copies.

`control` and `connect` must run as the same role
([One database role](#one-database-role)). Both must also use the allocation's
schema ([One schema per allocation](#one-schema-per-allocation)); a pooled
connection's own `search_path` does not decide where anything is created.

### Forked working copies

A second bundled strategy, `forkedWorkingCopyStrategy<G, TFork>({ fork, connect })`,
targets a fork-capable host instead of a streamed-interchange clone: `fork`
asks the host itself to produce a complete, independent copy of the database
`baseStore` is on, and `connect` opens a backend on that copy.

```typescript
import {
  asBranchId,
  branch,
  forkedWorkingCopyStrategy,
  unwrap,
  type ForkHandle,
} from "@nicia-ai/typegraph/graph-merge";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { decorateBackend } from "@nicia-ai/typegraph/backend";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// A host whose fork call returns a new connection string for the branch —
// this is the shape of the copy-on-write branching APIs some Postgres hosts
// offer (Neon and Supabase branches, for example), without either SDK.
type HostBranch = ForkHandle & Readonly<{ connectionString: string }>;

const strategy = forkedWorkingCopyStrategy<G, HostBranch>({
  fork: async () => {
    const created = await hostBranchApi.createBranch(baseDatabaseId);
    return {
      connectionString: created.connectionString,
      dispose: async () => hostBranchApi.deleteBranch(created.id),
    };
  },
  connect: async (fork) => {
    // `createPostgresBackend` takes a Drizzle database, not a pool — open
    // one here. Its `close()` deliberately does not end a caller-owned pool
    // (Drizzle leaves connection lifecycle to the caller), so compose the
    // pool's own shutdown into this fork's `close` through the public
    // `decorateBackend` (never a spread) — `branch()`'s composed close then
    // ends the pool along with releasing the fork.
    const pool = new Pool({ connectionString: fork.connectionString });
    const backend = createPostgresBackend(drizzle(pool));
    return decorateBackend(backend, {
      close: async () => {
        await backend.close();
        await pool.end();
      },
    });
  },
});

// `makeBackend` is ignored once an explicit strategy is supplied — pass a
// factory whose only job is to reject if it is ever called by mistake.
const rejectMakeBackend = () =>
  Promise.reject(new Error("makeBackend must not be called"));

const worker = unwrap(
  await branch(
    base,
    rejectMakeBackend,
    { id: asBranchId("worker-1") },
    strategy,
  ),
);

// ... write on worker.store, plan and apply the merge ...

await worker.close();
```

`TFork` must extend `ForkHandle` (`{ dispose?: () => Promise<void> }`).
`forkedWorkingCopyStrategy` supplies ephemeral copies only. Its base-version
comparison checks the graph's schema and revision or live-content anchor;
the host fork must preserve the full physical database, including TypeGraph
sidecars and extensions. A durable host strategy must persist its branch ID
and attest the sealed origin when reopening it.

For a hosted PostgreSQL branch such as [Neon](https://neon.com/docs/get-started-with-neon/workflow-primer),
`connect` must use that branch's connection string and compute endpoint for
every pooled checkout and transaction. Reusing the source pool can appear to
pass a base-version check while writing to the source. Doltgres can pin a
connection through a [database revision specifier](https://www.doltgres.com/docs/reference/version-control/branches/);
avoid session-level branch switching on a pool whose checkouts may retain
different branch state. Doltgres exposes native branch and merge commands,
but TypeGraph continues to use its own merge planner and apply path; native
merge and Doltgres backend support require separate conformance testing.
`create()` calls `fork(baseStore)`, then `connect(fork)`; the connected
backend's `close` is composed with the fork's `dispose` through `deriveBackend`
(never a spread), so `worker.close()` — the branch's public release call —
releases both the connection and the fork. A `connect` failure disposes the fork before
rethrowing, leaving nothing open and the base untouched.

A fork inherits the base's WHOLE construction option set — hooks, upsert
coalescing, the SQL schema (custom table names), the auto-refresh-statistics
threshold, query defaults, and an externally-bound recorded-read relation —
read once through `Store.workingCopyOptions`, plus `history`/
`revisionTracking`, matched to the base's own `historyEnabled`/
`revisionTrackingEnabled`. This is safe precisely because a fork is the SAME
physical database as the base: a custom `schema` names relations the fork
carries too, and an external `recordedRead` binding points at one. The clone
strategy inherits only `revisionTracking` — its fresh backend is a distinct,
empty database, so a schema naming the base's tables or a `recordedRead`
binding populated nowhere on the clone would misdirect it.

Because the fork's store reads and writes through the base's table names,
`connect()`'s backend must bind those SAME names. `create()` compares the
connected backend's own table bindings against the base's own resolved SQL
schema (`Store.revisionSchema` — the base's explicit `schema` option, or its
backend's own `tableNames` otherwise), and refuses with a `BranchError`,
closing the backend first, when they disagree: a backend bound to different
(often just the default) table names would read and write through tables the
fork's rows were never written to.

**A fork preserves what a clone drops, and that is why it is safe to merge.**
The clone strategy above streams the base through public interchange with
`includeDeleted: false`, so it omits every soft-deleted row entirely: the
interchange `meta` schema has no `deletedAt` field, so a tombstoned row would
otherwise round-trip as LIVE and read as a spurious resurrection on the
clone's diff. It also regenerates `created_at`/`updated_at` on import — safe
only because the merge's state diff always compares against the *original*
base store, never the clone. A fork is never rebuilt through
`exportGraphStream`/`importGraphStream`, so none of that applies: tombstones,
`created_at`/`updated_at`, and the `version` column carry over unchanged, and
— with `history: true` — the fork physically carries the base's recorded
relations, so `store.asOfRecorded(<an instant before the fork>)` answers from
that history. A clone-based branch never enables history, so the same call on
it refuses outright.

`create()` asserts `computeBaseVersion(forkStore) === base` right after
attaching the store, where `base` is the token `branch()` already stamped off
the ORIGINAL base store before invoking the strategy — cheap when the base has
revision tracking (an O(1) anchor compare), an O(graph) content fingerprint
otherwise, and computed exactly once either way. This proves base-token
equality at the instant the fork was taken, not byte-for-byte physical
identity: the untracked fingerprint deliberately omits tombstones,
`created_at`/`updated_at`, the `version` column, and recorded history (the "A
fork preserves what a clone drops" paragraph above) — providing those
unchanged is the FORK MECHANISM's job, not something this assertion re-verifies
on every branch. That is still the right fence: the merge's lost-update guard
reads `version` and the diff reads tombstones/timestamps straight off the
fork, so a `fork` that is not a true physical copy breaks them regardless of
what the content fingerprint agrees on. A mismatch closes the backend first
and refuses with a `BranchError` carrying `forkVersion`/`baseVersion` in
`error.details`; `branch()` catches it and returns that `BranchError` as the
`cause` of the outer `BranchError` it resolves with. Only a base-token
mismatch is refused here — a fork taken while the base was mid-write, or a
`fork` that returns a different graph; divergence confined to the physical
state the token omits (tombstones, timestamps, row versions, recorded
history) passes the fence, and keeping that state faithful remains the fork
mechanism's contract.

`create()` also refuses BEFORE ever attaching a store when `connect()`'s
backend aliases the base's own backend: the same backend object, one derived
from the other through `deriveBackend`, or two wrappers sharing one underlying
connection. Without this check, a `connect()` that mistakenly hands back the
base's own backend (a cached factory keyed by database name, say) would pass
every fence below trivially — every write on the "fork" would actually mutate
the base, and closing the working copy would close the base's own backend. The
refusal disposes only the fork (never the aliased backend, which the base
still owns) and throws a `BranchError` naming `connect()`. This cannot detect
every aliasing shape: a fresh backend built over the base's own connection
pool is indistinguishable from a real fork's connection when that pool audits
as independent (the normal case for a default-size `pg.Pool`) — a pooled
checkout genuinely is a different connection from the pool's perspective.

`ingestionBranch()` stays clone-based. Its strategy derives a working-copy
schema with node uniqueness deferred so an untrusted batch's repeated keys can
reach entity resolution before validation; a host-level fork carries the
base's schema exactly, uniqueness included, with no hook to relax it.

:::caution[Suspend hazard]
A fork-capable host that suspends idle compute to reclaim it between requests
drops that compute's in-process state, including anything memoized against a
particular connection or session. TypeGraph's own locking already assumes
this rather than trusting a lock survives idle time: the recorded-write lock
memo (`RecordedGraphLockMemo`, populated by
`memoizeAcquiredRecordedGraphWriteLock`) and the schema-fence lease
(`memoizeLeasedSchemaFence`) are both keyed weakly by the transaction-scoped
backend object, so they hold for exactly one transaction's lifetime and
re-acquire on the next one, and the write fence itself (see
[Write fence declaration](/backend-setup#write-fence-declaration-writefence))
is resolved and its lock taken fresh per transaction, never cached across
one. An ordinary sequence of separate `store` calls — each its own
transaction — therefore tolerates a suspend between any two of them.

What does NOT tolerate a suspend is a single `store.transaction` callback:
every read and write the callback issues, and the lock it holds, runs on one
native database transaction over one connection, so a suspend partway
through drops that connection out from under the callback and aborts
whatever was in flight. Keep a `store.transaction` callback's wall-clock
duration short and free of anything that could let the host suspend
underneath it — an external API call, a human approval step, a long queue
wait — and commit a long-running workflow across multiple `store.transaction`
calls instead of holding one open across such a wait.
:::

### Durable host-native branches

`branchDurable()` is the persistent counterpart to `branch()`. A
`DurableWorkingCopyStrategy` allocates a host branch, opens a Store on it, and
returns a non-secret JSON locator. TypeGraph seals the immutable fork origin
beside that allocation and returns a `DurableBranchDescriptor` that can cross a
queue, process, deployment, or machine boundary.

For a remote host, persist a chosen `{ id, allocationId }` before calling
`branchDurable(base, strategy, { id, allocationId })`. `create()` receives both
and must refuse an allocation ID that may already exist. If the host allocates
a branch but its response is lost, use host tooling to inspect the ID and
recover or remove the allocation before retrying. A failed create reports both
IDs for that reconciliation. The host must never allocate a second physical
copy for the same ID or return a sealed copy as though it were new.

```typescript
import {
  applyDurableMergePlan,
  branchDurable,
  destroyDurableBranch,
  planMerge,
  reopenDurableBranch,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";

const created = unwrap(await branchDurable(base, durableStrategy));
await created.branch.store.nodes.Person.create({ name: "Ada" });

// Releases this process's connection and writer lease. The host branch stays.
await created.branch.close();
await queue.put(JSON.stringify(created.descriptor));

// A later process reconstructs the ordinary GraphBranch used by planning.
const descriptor = JSON.parse(await queue.get()) as typeof created.descriptor;
const reopened = unwrap(
  await reopenDurableBranch(graph, descriptor, durableStrategy),
);
const plan = unwrap(await planMerge(base, [reopened]));

// Applies the complete TypeGraph plan inside the target transaction.
const report = unwrap(
  await applyDurableMergePlan({
    target: base,
    branch: reopened,
    descriptor,
    strategy: durableStrategy,
    plan,
  }),
);

await reopened.close();
unwrap(await destroyDurableBranch(descriptor, durableStrategy));
```

Closing and destroying are deliberately separate. `GraphBranch.close()` closes
the backend and releases its access lease, but leaves the persistent allocation
reopenable. `destroyDurableBranch()` asks the strategy to attest the complete
origin and delete or archive that allocation atomically. A descriptor is
untrusted input: TypeGraph checks its allocation id, graph definition, branch
id, base token, schema anchor, and engine revision against the origin the host
sealed. The allocation id is independent of the caller's branch id, so
swapping or relabeling a locator cannot authorize deletion of another copy
even when two copies were given the same branch id.

Strategies write new locators using `version` and may list older supported
locator versions in `readableVersions`. Every method must understand each
listed version, including destroy and evidence access.

The strategy locator must be JSON-safe and **must not contain secrets**. Use a
branch id, database id, or other lookup key, then resolve credentials from
strategy-owned configuration. TypeGraph returns the locator to application code
so a connection URL, password, or bearer token placed there can escape through
ordinary descriptor storage. Framework cleanup errors deliberately omit the
locator and raw host cleanup error from diagnostic details.

#### Exact forks and access leases

After `strategy.create()` returns, TypeGraph recomputes `base@V` from the source.
A source write racing allocation therefore refuses and aborts the working copy
instead of sealing a branch from the wrong ancestor. TypeGraph then accepts an
exact matching working-copy token as the fast path. When a strategy creates an
equivalent persistent copy with an independent revision namespace, TypeGraph
instead verifies that its complete merge-visible graph state has no delta from
the source, fencing the source again after enumeration. The host remains
responsible for physical fidelity outside TypeGraph's graph semantics.
To enable lineage-pruned merge diffs, `create()` may return `forkRevision`
captured atomically with the physical fork. When it cannot prove that cut, omit
the revision and TypeGraph compares the complete graph state; reading a later
revision after the copy was opened could miss an intervening branch write.

Every `create()` and `reopen()` also returns a `DurableWorkingCopyAccess`:

- `engine-fenced` says the database provides sound cross-client isolation and
  change fencing for the full Store planning/apply access pattern, across every
  connection and process that could mutate the working copy.
- `exclusive` carries an allocation-wide writer lease. The strategy must acquire
  it before returning and exclude every other process and backend instance.
  TypeGraph closes the backend first, then releases the lease; a failed release
  is retried by the next `close()` call.

Do not use `engine-fenced` merely because one backend object serializes its own
calls. A `caller-serialized` backend owns one in-memory queue per backend
instance, so two reopened pools or two processes still race. Such an engine must
use a host-wide `exclusive` lease, and a concurrent reopen must wait or refuse.
Merge planning also assumes the working copy is quiescent while it is diffed.

#### Native database branches

A strategy may allocate a working copy using a database-native branch, but
`applyDurableMergePlan()` always applies the approved TypeGraph plan through
the target Store transaction. The former native-merge callback was removed:
it could commit outside the transaction that checked the target revision.
A future native merge capability needs a host-native compare-and-swap on the
actual target, plus proof that the full physical diff equals the approved
TypeGraph writes, including schema, history, identity, composition, and
sidecars.

For a Doltgres strategy, pin each Store connection to the intended database
branch. [Doltgres revision specifiers](https://www.doltgres.com/docs/reference/version-control/branches/)
provide that connection-level selection. Its
[`DOLT_BRANCH()` and `DOLT_MERGE()` functions](https://www.doltgres.com/docs/reference/version-control/dolt-sql-functions/)
implicitly commit the current transaction, so a fence checked before those
functions cannot by itself protect their target.

#### Atomic operations and immutable evidence

A `DurableWorkingCopyStrategy` may also expose an optional `operations`
capability (`DurableOperationCapability`). It lets a durable host combine one
opaque graph mutation with its immutable operation evidence in a **single host
transaction**.
TypeGraph owns descriptor validation, sealed-origin attestation, request
canonicalization, and evidence validation; the host owns the database mechanics.

```typescript
import {
  durableBranchHasUndeliveredEvidence,
  getDurableOperation,
  markDurableOperationDelivered,
  operateDurableBranch,
  scanDurableOperations,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";

const request = {
  idempotencyKey: "statement-42",
  // Host-defined, JSON-safe description of the graph change to apply.
  mutation: { kind: "statement", op: "upsert", payload: { subject: "s-1" } },
  // Host evidence, retained verbatim. TypeGraph never interprets either field.
  metadata: { source: "etl", schemaVersion: 3 },
};

const outcome = unwrap(
  await operateDurableBranch(descriptor, durableStrategy, request),
);
if (outcome.outcome === "unsupported") {
  // The strategy applied no mutation and wrote no evidence; TypeGraph refuses
  // rather than emulating atomicity with best effort or callbacks that run
  // outside the evidence transaction.
  throw new Error(`Missing capabilities: ${outcome.dimensions.join(", ")}`);
}
console.log(outcome.outcome); // "applied" | "replayed"
// Newly applied evidence is always false. A replay returns the current
// committed delivery state, which may already be true.
console.log(outcome.evidence.delivered);
```

Both `mutation` and `metadata` are **JSON-safe host values**. TypeGraph never
interprets their application fields; it canonicalizes `metadata` plus `mutation`
into the `operationDigest` and otherwise carries them through untouched. The
digest covers the complete request except the idempotency key, so reusing a key
with a different mutation *or* different metadata conflicts. Non-JSON content is
refused before any host call.

`metadata` is retained as evidence; `mutation` is the host's own description of
the graph change it must apply atomically with the evidence row. The strategy
attests the caller's `expectedOrigin` against the allocation the descriptor
names, exactly as reopen and destroy do. Every committed
operation returns `before`/`after` coordinates — the merge-visible `base`
fingerprint and, when the working copy resolves lineage, the engine `revision`.
TypeGraph validates that the returned evidence echoes the canonical request and
digest; a host cannot forge a different digest, echo a different request, or
return non-JSON metadata (`DurableOperationEvidenceError`).

**Idempotency.** The strategy treats `idempotencyKey` as its unique key:

- Identical key **and** digest: returns the previously committed evidence
  (`outcome: "replayed"`) and re-applies nothing. Because delivery marking is
  monotonic, a replay after delivery legitimately returns `delivered: true`.
- Identical key with a **different** digest: refuses with
  `DurableOperationConflictError` and mutates nothing.

A first application (`outcome: "applied"`) must return `delivered: false`.
TypeGraph rejects `applied` evidence that is already delivered, so a host cannot
bypass downstream delivery or the destroy fence. It also validates the complete
host outcome envelope: malformed outcomes and empty, duplicate, or unknown
`unsupported` dimensions return `DurableOperationEvidenceError`.

**Evidence access and delivery.**

- `getDurableOperation(descriptor, strategy, idempotencyKey)` reads one
  operation's evidence, or `undefined` when it was never committed.
- `scanDurableOperations(descriptor, strategy, { after?, limit? })` returns
  `{ operations, cursor, hasMore }` in monotonic commit order, with ties broken
  deterministically. Pass the opaque `cursor` back as `after` to resume, even
  after `hasMore: false`; later commits must sort after that cursor. An empty
  page echoes `after`, and only an empty initial scan omits `cursor`. `limit` defaults to
  `DURABLE_OPERATION_SCAN_DEFAULT_LIMIT` (100) and may not exceed
  `DURABLE_OPERATION_SCAN_MAX_LIMIT` (1000); a larger page is refused.
- `markDurableOperationDelivered(descriptor, strategy, idempotencyKey)` marks
  one operation delivered, idempotently: marking an already-delivered operation
  returns the same evidence and writes nothing, and an unknown key returns
  `undefined`.
- `durableBranchHasUndeliveredEvidence(descriptor, strategy)` reports whether
  any committed evidence is still undelivered — the queryable half of the
  destroy fence below.

`operateDurableBranch()` is the only orchestrator that tolerates a missing
capability: a strategy with no `operations` returns the explicit `unsupported`
outcome (`dimensions: ["atomicMutation"]`) having executed no host call. `get`,
`scan`, `markDelivered`, and `hasUndelivered` instead refuse with a typed
`DurableOperationUnsupportedError`. TypeGraph never emulates the atomic
guarantee: a callback that runs inside the strategy's own evidence transaction
(as `apply` does in the bundled PostgreSQL manager below) is the host's atomic
mutation, while best effort or a callback outside that transaction is refused.

**Destroy fence.** A strategy with `operations` MUST refuse destruction while
undelivered evidence remains, throwing `DurableEvidenceUndeliveredError`;
`destroyDurableBranch()` preserves that typed refusal instead of flattening it
into a generic branch failure, so the caller can still recover the evidence.
Deliver (or archive) the outstanding evidence before destroying the branch.
Concurrent `operate` and `destroy` are serialized by the host's own transaction:
either the operation commits first (destroy then observes undelivered evidence
and refuses) or destroy commits first (the operation fails against the removed
allocation). No partial state is ever observable.

##### Bundled PostgreSQL manager

`createPostgresWorkingCopyManager` implements the capability when given an
`operations` option. `apply` is how the host's opaque mutation reaches the
graph; TypeGraph still never interprets `mutation`.

```typescript
const copies = createPostgresWorkingCopyManager<typeof graph>({
  control,
  connect,
  operations: {
    graph,
    // Runs inside the transaction that commits the evidence row. A throw rolls
    // back both the mutation and the evidence.
    apply: async (transaction, mutation) => {
      await applyHostMutation(transaction, mutation);
    },
  },
});

const outcome = unwrap(
  await operateDurableBranch(descriptor, copies.durable, request),
);
```

`operations.graph` is required because a capability member receives only the
descriptor, so the manager must reopen the allocation from the graph the host
names. Before any connection or transaction opens, every member checks that
graph against the sealed allocation's attested origin: its graph id and its
version-blind definition hash must equal the ones the branch was forked with, so
a graph that reuses the id with a different definition is refused. `apply`
receives the transaction-scoped context of the allocation's fixed-schema Store,
the same context `store.transaction` provides, so the allocation's fixed schema
applies. Without the option, `copies.durable.operations` is undefined and
`operateDurableBranch()` returns `unsupported` (`atomicMutation`).

Each durable allocation owns one evidence relation under its ledger-reserved
physical prefix, created in the provisioning transaction and dropped by destroy.
The ledger records whether an allocation has one (`operation_evidence`).
`operate` takes the allocation lock on the allocation's own transaction session,
attests the sealed origin, resolves idempotency, takes the graph write lock,
computes the `before` coordinates, calls `apply`, computes the `after`
coordinates once the transaction's revision bookkeeping has run, and inserts
undelivered evidence, all in one transaction. The allocation lock is a
transaction-scoped advisory lock keyed on the allocation id, in a namespace of
its own so it can never collide with a graph's write lock. It serializes
operations per allocation, so the evidence sequence that backs the opaque scan
cursor is commit order, and each operation's `before` equals the previous
operation's `after` whenever every writer to the allocation goes through
`operate` or takes the graph write lock. Ordinary writes take that lock on an
allocation that tracks history or revisions, so a direct write cannot commit
between `before` and `apply`; on an allocation that tracks neither, a direct
write is not fenced and the evidence's `before`/`after` pair may include it.

The graph write lock is graph-wide. While `apply` runs, tracked writes to the
source graph and to every sibling working copy of it wait on that lock, so keep
`apply` short and do not wait on other graph writers inside it.

Coordinates always carry `base`. They also carry `revision`, the engine
revision, when the allocation resolves lineage, which is when it tracks history
or revisions; both are read on the transaction's own session so they describe
one state. An allocation that tracks neither reports no `revision`, and its
`base` values are content fingerprints, which read the whole graph twice per
operation.

**Isolation is observed, not assumed.** `operate`, `markDelivered`, and destroy
each request READ COMMITTED, and the statement that takes the allocation lock
also reports the isolation level its session actually runs at. Any other level
is refused before anything is read or written, with a `ConfigurationError` whose
`details.code` is `WORKING_COPY_ISOLATION_UNSUPPORTED`, because the request is
honored only where a backend supports it and a role or server default of
REPEATABLE READ would otherwise give the fence and the idempotency lookup a
snapshot older than the lock wait. A `control` or `connect` wrapper must
therefore forward the transaction `isolationLevel` option. The refusal only
fires when a wrapper drops the requested option and the session's default is
not READ COMMITTED.

The same check runs everywhere the manager drops an allocation, not only in
destroy and `abortAllocation`: closing an ephemeral working-copy store, closing
a `makeBackend` backend, and the cleanup after a failed allocation. The first
two surface the refusal from `close()`. The cleanup swallows it so the
allocation's original failure reaches the caller, which leaves the allocation
behind. Every such orphan is discoverable with `listUnsealedAllocations` and is
removed by `abortAllocation` once `control` forwards the option.

**Destroy fence.** Destroy (and `abortAllocation`) takes the same allocation
lock. `destroyDurableBranch()` refuses with `DurableEvidenceUndeliveredError`
while undelivered evidence exists, even from a manager built without
`operations`; delivering the evidence requires a manager built with
`operations`. An in-flight `operate` and a destroy on one allocation serialize
on the lock: whichever commits first decides the other's outcome. The destroy
waits at most `cleanupLockTimeoutMs` (5000 ms by default); one that outwaits a
long `apply` fails with the database's lock timeout having committed nothing,
and can be retried after the operation settles. `get`, `scan`, and
`hasUndelivered` take no allocation lock, so they never wait behind an `apply`.
A destroy that commits after any member has attested the sealed row but before
that member holds the allocation (before its connection is attested, before
`operate` mints the revision origin, or before `get`, `scan`, or `hasUndelivered`
reads the evidence relation) fails the member with one `BranchError`
(`changed owner or was destroyed during the operation`), the same error
`operate` and `markDelivered` raise against a removed allocation. It is never a
raw missing-relation error or the "connection is not bound to the allocation
database" refusal, which is reserved for a connection that reaches a different
database than the one the ledger names.

The fence follows the manager's [removal rule](#one-schema-per-allocation). It
reads the evidence relation only in the allocation's own schema. Evidence
relations that sit in another schema refuse removal before the fence runs and
are kept. The fence runs only when the evidence relation is among the
relations removal drops. An allocation whose evidence relation is gone has no
evidence left to deliver and nothing to recover, so destroy removes its
remaining relations and its ledger row, exactly as it does for an allocation
whose relations exist nowhere.

**Mixed-version deployments.** Only managers on this version take the allocation
lock and honor the destroy fence. A manager from an earlier release that shares
the ledger destroys an allocation without consulting its evidence, so
undelivered evidence is lost with the allocation, and it does not drop the
evidence relation, so a later `allocate` with the same id refuses because
`<prefix>op_evidence` exists without a ledger row. Upgrade every process that
shares a working-copy ledger before any of them creates or destroys a durable
allocation. To recover an orphaned evidence relation, read its undelivered rows
(`WHERE NOT delivered`) and deliver them, then drop the relation the refusal
names and retry. TypeGraph never drops it for you, because it may hold the only
copy of undelivered evidence.

An allocation provisioned by an earlier release has no evidence relation, and
its ledger row says so without any statement that changes the database.
`operate` returns `unsupported` with `dimensions: ["evidenceStore"]`. The only
statement it runs is one read-only ledger `SELECT` through `control`; it runs no
DDL, takes no lock, calls no `connect`, and applies and writes nothing. The read
members report no evidence: `get` and `markDelivered` return `undefined`, `scan`
returns an empty page (echoing `after`), and `hasUndelivered` returns `false`.
Re-fork the branch to gain evidence.

### Constraint-aware ingestion branches

For a bounded candidate batch, `planCandidateWriteSet()` hides the transient
branch lifecycle completely. It accepts a validated, versioned JSON document,
stages it through the same constraint-aware ingestion implementation, delegates
to incremental merge planning, and closes the working copy on every outcome.
The result is the ordinary `MergePlanArtifact`, so review and application use
the same APIs as every other merge plan.

On eligible revision-tracked graphs, planning
seeds existing candidate rows, edge
endpoints, cardinality peers, live same-id ontology peers, and any reachable
current identity component into the disposable working copy.
The resolver still queries the live target for declared unique and index peers,
and the plan retains its ordinary provenance, conflicts, digest, and commit-time
fences. Existing undeclared target properties survive staging; extra candidate
properties are refused. A custom backend without the active-only source read
uses the complete clone path for `oneActive` graphs. A custom backend without
the keyed match-identity owner read, or a candidate whose owner is excluded
from the clone projection, also uses that path. Other ineligible graphs use
the complete clone path so staging
still checks constraints that can depend on rows beyond the candidate's ids.

```typescript
import {
  captureCandidateWriteSetTarget,
  planCandidateWriteSet,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";

const writeSet = {
  formatVersion: 1,
  sourceId: "provider-a",
  target: await captureCandidateWriteSetTarget(store),
  nodes: [
    {
      kind: "Patient",
      id: "provider-a:123",
      properties: { name: "Ana", mrn: "123" },
      validFrom: "2026-01-01T00:00:00.000Z",
    },
  ],
  edges: [],
} as const;

const plan = unwrap(
  await planCandidateWriteSet({
    target: store,
    makeBackend,
    writeSet: JSON.parse(JSON.stringify(writeSet)),
    options: {
      resolve: {
        Patient: {
          blockIndex: "patient_mrn_candidates",
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.9,
        },
      },
    },
  }),
);
```

`sourceId` is the stable attribution carried into conflicts, resolutions, and
provenance; node and edge ids remain the contribution source ids. The target
schema identity prevents a document authored against one graph contract from
being staged against another. `validFrom` is required (and may be `null`) so
replaying identical JSON cannot acquire a new import-time timestamp and change
the plan digest.

This adapter applies TypeGraph's existing entity/property merge semantics. Two
distinct records that both validate do not conflict merely because an
application interprets their subject, predicate, time, source, or value fields
as disagreement. Domain-specific acceptance and Statement semantics remain in
the consuming application.

Use `ingestionBranch()` when an untrusted ingestion batch may contain aliases
that deliberately repeat a canonical node's unique key. An ordinary `branch()`
keeps the complete graph schema and rejects the duplicate during staging,
before entity resolution can review and collapse it. An ingestion branch
materializes an honest working-copy schema with only node uniqueness deferred;
schema validation, edge endpoint checks, disjointness, and edge cardinality
(both the source and target axis) still apply immediately.

```typescript
import { asNodeId } from "@nicia-ai/typegraph";
import {
  applyMergePlan,
  asBranchId,
  ingestionBranch,
  planMergeIncremental,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";
import { importGraph } from "@nicia-ai/typegraph/interchange";

const incoming = unwrap(
  await ingestionBranch(base, makeBackend, {
    id: asBranchId("provider-a"),
  }),
);

const imported = await importGraph(incoming, providerDocument, {
  onConflict: "error",
  onUnknownProperty: "error",
});
if (!imported.success) throw new Error("Provider import was rejected");

const alias = await incoming.nodes.Patient.getById(
  asNodeId("incoming-patient"),
);
if (alias === undefined) throw new Error("Imported patient was not found");

// `canonicalPatient` is an existing Patient read from the base before forking.
// The repeated MRN and its identity evidence can be staged together.
await incoming.identity.assertSame(canonicalPatient, alias);

const plan = unwrap(
  await planMergeIncremental({
    forkPoint: base,
    target: base,
    branches: [incoming],
    options: {
      onBasePropertyConflict: "flag",
      resolve: {
        Patient: {
          blockIndex: "patient_mrn_candidates",
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.9,
        },
      },
    },
  }),
);
const applied = unwrap(await applyMergePlan(base, plan));
await incoming.close();
```

Both `importGraph()` and `importGraphStream()` accept the returned handle, so an
interchange document can be staged without a hand-written collection copy loop.
Import remains the single owner of node-first ordering, validity windows, edge
endpoint order and reference validation.

On an identity-enabled graph, the handle also exposes an assertion-only
`IdentityAssertionWriteFacade` as `identity`: `assertSame`, `assertDifferent`,
`bulkAssertSame`, and `bulkAssertDifferent`. This lets a batch stage aliases
that repeat unique keys and the explicit identity evidence needed to reconcile
them before merge-time constraint validation. Assertion contradictions and
invalid endpoints are still refused while staging; only node uniqueness is
deferred.

The returned handle exposes those ingestion collections and identity assertion
writes, not the branch's underlying `Store`. Identity reads and retractions,
schema operations, transactions, and runtime internals remain unavailable, so
callers cannot bypass the deferred-constraint contract. As with `Store`, the
`identity` property is absent at the type level when the graph does not enable
Operational Identity.

The original graph definition remains the merge contract:
`applyMergePlan()` validates node uniqueness against the entire resolved write
set in the target transaction. Valid key handoffs and swaps are accepted as one
set. If reviewed resolution leaves two live owners of the same unique key, the
merge returns `MergeConstraintConflictError` and commits no graph or provenance
writes.

The derived schema is persisted on the working-copy backend, so the relaxed
contract is auditable and an explicit reattachment with an equivalent graph
definition verifies the same constraint behavior. `ingestionBranch()` does not
expose a general reopen/resume API. Deferral is not an in-memory flag and does
not disable database constraints ad hoc. Ingestion branches require a backend
with the batch uniqueness operations needed for atomic final validation.
Unsupported backends are refused rather than falling back to sequential checks.

## Valid-time windows

**A new row's window travels with the merge.** An explicitly open-left row stays
open-left through snapshot and incremental merges, including edge repointing.
Reviewable plans serialize that lower bound as `validFrom: null`; an omitted
plan field means the write states no lower-bound change. JSON export/import and
plan application preserve the distinction.

A branch-authored node or edge window — including a deliberately ended one on a resurrection — is written
as-is by the commit rather than reset to merge time. When the incremental
target itself also created the surviving row, the target's committed window
wins.

**An inherited row's end-of-validity is merged.** Both
`update(id, {}, { validTo })` and `update(id, {}, { clearValidTo: true })` on a
branch are ordinary writes. The merge carries the set, move, or reopening to the
target even when the row's properties are untouched:

```typescript
await fork.store.nodes.Patient.update(asNodeId("pat-1"), {}, { validTo: "2030-06-01T00:00:00.000Z" });
const report = unwrap(await merge(base, [fork]));
// base now holds pat-1 with valid_to = 2030-06-01, and:
report.validityEnds;
// [{ entity: "node", kind: "Patient", id: "pat-1",
//    validTo: "2030-06-01T00:00:00.000Z", claimedBy: ["worker-1"] }]

await fork.store.nodes.Patient.update(asNodeId("pat-1"), {}, { clearValidTo: true });
// A merge now reopens pat-1 and reports:
// [{ entity: "node", kind: "Patient", id: "pat-1",
//    clearValidTo: true, claimedBy: ["worker-1"] }]
```

An ending is treated as a **sibling of deletion**, not as a property, because it
makes the same kind of statement: *this stopped being true*. That single choice
explains the whole contract:

| Situation | Outcome |
| --------- | ------- |
| One branch ends the row | That end is written — including a *later* end, which extends the window. |
| One branch reopens the row | The end is cleared with `clearValidTo: true`. |
| Several branches end it differently | No conflict. The **earliest** end wins, and `report.validityEnds` names every claiming branch. |
| Sibling branches end and reopen it | The end wins as the stronger monotone claim; every claimant remains visible in `report.validityEnds`. |
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
instant it wrote, or `clearValidTo: true` says it reopened the row. An entry
with `precedence: "target"` is one it did **not** — the incremental target had
already changed that end, so the entry describes the target's set or clear,
`claimedBy` names the branch claims that were thrown away, and nothing was
written or credited for the row. A row no branch claimed at all produces no
entry, since there was nothing to discard.

`validityEnds` reports claims about rows inherited from the fork point. If the
fork point is empty, every branch row is branch-created and the array is always
empty. A demo or topology that needs to exercise this report must seed the row
before branching, then end that inherited row on one or more branches.

Because an ending is not a modification, `onDeleteModifyConflict` never sees
one: a row whose *only* change is its window loses to a concurrent deletion even
under `"prefer-modify"`, since there is no modification to prefer. A row with a
properties edit *and* an ending keeps the usual delete/modify behavior on the
properties, and its ending rides along only if that modification survives.

**What is still NOT merged, and why.** On a row that is live in both the base
and the branch, `validTo` is the only window field a branch can author *and* the
commit can apply. A row's lower bound is immutable outside resurrection —
`validFrom` is written only when a soft-deleted row is brought back — so that
lower-bound delta remains observable in a fork but unapplicable:

| Observed delta | Reachable how | Merged? |
| -------------- | ------------- | ------- |
| `validTo` set or moved | `update(id, {}, { validTo })` | **Yes** |
| `validTo` cleared back to open | `update(id, {}, { clearValidTo: true })` | **Yes** |
| `validFrom` changed | soft-delete + resurrect inside the fork | No |

Rather than silently ignore it, the merge reports the lower-bound change in
`report.dropped` with reason `"window-not-applicable"`. Reconciling a value the
commit would then drop is worse than not merging it: the report would claim a
change that never happened.

Delete+resurrect can also make an ended base row appear open because resurrection
creates a fresh window. When `validFrom` changed, that open end is part of the
same non-applicable resurrection artifact; it is not treated as a branch-authored
`clearValidTo`, and an incremental target artifact does not outrank another
branch's explicit end claim.

Full interval reconciliation (intersecting `[validFrom, validTo]` across
branches) is deliberately out of scope — it needs a write path that moves a live
row's lower bound, which contradicts the temporal model, and it would silently
discard a branch's extension.

## Forking one graph namespace

`forkGraphNamespace(sourceStore, privateBackend, operationKey)` copies one
history-enabled graph into an independently allocated PostgreSQL database. It
copies the graph's committed schema, current rows, tombstones, recorded-time
relations, revision clock and journal, identity relations, and TypeGraph
materialization records. It checks a repeatable-read source snapshot against a
pre-cut `base@V` token, compares every copied row before target commit, and
returns `{ store, proof, abort }`. One source transaction holds that snapshot
for the entire copy, from its first source read through the target copy and
digest checks. The source can accept writes after the snapshot cut, while the
long-lived snapshot remains open until copying finishes; `proof.sourceBase`
identifies the copied cut.

```typescript
import {
  forkGraphNamespace,
  prepareNamespaceForkTarget,
} from "@nicia-ai/typegraph/graph-merge";

// Run with the schema owner role before the runtime fork.
await prepareNamespaceForkTarget(sourceStore, privateBackend);
const fork = await forkGraphNamespace(sourceStore, privateBackend, "restore-42");
// Owner role again: builds IVFFlat indexes over the copied rows.
await fork.store.materializeIndexes();
const historical = await fork.store
  .asOfRecorded(receipt.recorded)
  .nodes.Item.getById(receipt.itemId);

// Publish the private database through your own placement registry only after
// checking the fork and any application-specific restore invariants.
// Before publication, await fork.abort() to discard an unchanged copy.
```

The caller provisions and owns `privateBackend`. It may contain other graph
namespaces, but it must contain no rows for the source graph. TypeGraph refuses
a connection to the source database, including an aliased backend object.

`prepareNamespaceForkTarget()` is the owner-side step, and the fork itself
issues no DDL. It installs the retry ledger, creates the graph's per-field
pgvector tables, and builds every index the source has materialized for the
graph with the DDL the source used. It writes no graph rows and no
materialization records, so it can run before the target is empty-checked,
and running it again is harmless. Indexes whose build never completed on the
source are neither built nor required. IVFFlat indexes are the exception:
IVFFlat clusters the rows present when it is built, so building one on an
empty table gives poor recall. They are not built by preparation and their
materialization records are not copied; run `fork.store.materializeIndexes()`
after the fork to build them over the copied rows. Every other index the fork
carried is already recorded, so that call only builds the IVFFlat ones. An
IVFFlat index left on the target by an aborted fork has no record, so the
next fork's `materializeIndexes()` drops and rebuilds it over the new rows. The target stays private
until the caller changes its own placement pointer;
TypeGraph does not publish it. `abort()` atomically removes the copied graph
and operation marker while preserving unrelated namespaces, and refuses if the
target has changed. A retry with the same operation key returns the same proof
after checking the target digest and base token; a different key cannot reuse
the populated target.

This first-party copy supports the bundled PostgreSQL table layout, bundled
`pgvector` embedding storage, and default `tsvector` fulltext storage.
Embeddings are copied, digested, and verified like every other graph relation,
and `abort()` removes them. A graph with embedding fields forks only between
backends with the same vector storage: pgvector on both sides, or
`vector: false` on both, where embeddings live only in node properties. A
vector-disabled source never wrote the vector tables a pgvector target would
search, so that pair is refused. The fork refuses custom table mappings, custom vector or fulltext
strategies, and contribution-owned tables it cannot copy and validate. The
current copy buffers one relation at a time and
inserts rows in bounded batches, so operators should size the private copy
process for its largest graph relation. It does not use interchange, whose payload lacks
recorded history and tombstones.

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

Most entry points return a `Result`; the error arm is a typed `TypeGraphError`
subclass you can branch on. `applyMergePlanInTransaction()` instead throws a
typed `MergeError` so a caller-owned transaction callback cannot resolve and
commit after a partially applied failure:

| Error                        | When                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BranchError`                | `branch()` or `ingestionBranch()` could not materialize a working copy.                                                                                                                                                                                                        |
| `BaseVersionMismatchError`   | A branch forked from a different `base@V` than the target now has (snapshot `merge()`). Also the typed replan error `mergeIncremental()`'s in-transaction guards raise, and the by-ID freshness check both commit modes run, when the target moved in the plan→commit window. |
| `IdentityMergeConflictError` | Code `GRAPH_MERGE_IDENTITY_CONFLICT` by default. Thrown by both `merge()` and `mergeIncremental()` for identity contradictions, assertion-ID collisions, opposing relations, and retract/reassert races — see [Identity conflicts](#identity-conflicts) and the [identity guide](/identity/#interchange-and-branch-merge). One related code on the same error class names a more specific cause: `GRAPH_MERGE_IDENTITY_SEPARATION_CONFLICT` (a definitional match or a transitive cluster crosses a class-lifted `different` assertion — see [Identity separation veto](#identity-separation-veto)). |
| `AcyclicityMergeConflictError` | Code `GRAPH_MERGE_ACYCLICITY_CONFLICT`. Thrown at plan time by every entry point (`merge()`, `mergeAgainstBase()`, `planMerge()`, `planMergeIncremental()`, `mergeIncremental()`) when the resolved plan's edge writes — after canonicalization and repointing — would close a cycle in a declared `acyclic: true` relation. Its `details` name the relation and every offending edge. |
| `MergeConstraintConflictError` | Code `GRAPH_MERGE_CONSTRAINT_CONFLICT`. The resolved plan would violate a deterministic store constraint, such as source- or target-side edge cardinality or node uniqueness. Its category is `constraint`, its `cause` is the original typed store error (a `CardinalityError` with `details.direction` for a cardinality conflict), and its details expose the original constraint fields. No graph or provenance writes commit. |
| `InvalidMergeOptionsError`   | Code `GRAPH_MERGE_INVALID_OPTIONS`. The supplied option combination is invalid, `mergeIncremental()` was given the snapshot-only `target` option instead of silently ignoring it, or `mergeIncremental()`'s `onBasePropertyConflict` is not `"flag"`.                         |
| `SimilarityUnavailableError` | A `vector`/`hybrid` strategy was requested with no `embedder`.                                                                                                                                                                                                                |
| `MergeConflictError`         | A conflict could not be resolved under the configured policy.                                                                                                                                                                                                                 |
| `MergePlanCapabilityError`   | Public planning was requested for a target without the durable revision guarantee needed across processes and time. Enable `revisionTracking` or `history`.                                                                                                                   |
| `MergePlanningStaleError`    | The target moved while planning was reading it. This is an expected retry-and-replan outcome under concurrent writers: no plan was returned, so recapture the target and create a new plan before retrying.                                                                    |
| `StaleMergePlanError`        | The target revision changed after planning, or this plan was already applied. Review a newly-created plan.                                                                                                                                                                    |
| `InvalidMergePlanError`      | The input is not a valid plan artifact. More specific subclasses distinguish unsupported versions, digest changes, and target/schema/origin mismatches.                                                                                                                       |
| `CandidateSourceError`       | A built-in candidate source failed; details identify its source id, entity kind, and operation.                                                                                                                                                                               |
| `CandidateWriteSetError`     | Code `GRAPH_MERGE_CANDIDATE_WRITE_SET`. Candidate JSON is malformed, targets another graph schema, cannot be staged, or violates the active graph contract. The accepted graph is unchanged.                                                                                  |
| `MergeReviewError`           | Code `GRAPH_MERGE_REVIEW`. Durable review evidence is malformed, unsupported, incomplete, or inconsistent, or review options cannot be represented safely.                                                                                                                     |
| `DurableOperationError`      | Code `GRAPH_MERGE_OPERATION`. System-category failure while calling a durable-operation host, including transport and strategy failures.                                                                                                                                    |
| `DurableOperationRequestError` | Code `GRAPH_MERGE_OPERATION_REQUEST`. User-category refusal for an invalid durable-operation request, descriptor, or scan option.                                                                                                                                          |
| `DurableOperationConflictError` | Code `GRAPH_MERGE_OPERATION_CONFLICT`. Constraint-category refusal when an idempotency key is reused with a different operation digest. The previously committed operation is returned untouched; nothing new is written.                                                         |
| `DurableOperationUnsupportedError` | Code `GRAPH_MERGE_OPERATION_UNSUPPORTED`. The strategy's `operations` capability lacks a requested member; TypeGraph refuses rather than emulating the atomic guarantee.                                                                                              |
| `DurableOperationEvidenceError` | Code `GRAPH_MERGE_OPERATION_EVIDENCE`. System-category failure because a host returned malformed or request-inconsistent operation evidence.                                                                                                                                 |
| `DurableEvidenceUndeliveredError` | Code `GRAPH_MERGE_OPERATION_UNDELIVERED`. `destroyDurableBranch()` was refused because committed operation evidence is still undelivered. Deliver or archive it first; the typed refusal is preserved so the evidence stays recoverable.                                |
| `MatchEvidenceError`         | Evidence could not be constructed safely, including a custom scorer returning `NaN` or infinity.                                                                                                                                                                              |
| `MergeError`                 | Any other merge failure (e.g. comparison-ceiling `"error"`, a non-transactional target). `MERGE_ERROR_CODES` enumerates the codes.                                                                                                                                            |

## Example

See [FHIR Graph Merge](/examples/fhir-graph-merge) for a complete runnable
snapshot merge that reconciles two independently-extracted patient-care branches,
and [Incremental Merge](/examples/incremental-merge) for live-target ingestion
against an advancing base with persisted, queryable provenance.
