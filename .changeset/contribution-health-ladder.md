---
"@nicia-ai/typegraph": minor
---

Complete the contribution health lifecycle with a read-only readiness probe and
an explicit destructive rebuild, so the three maintenance operations form one
escalation ladder: `probeContributions()` (writes nothing) →
`repairContributions()` (non-destructive, already shipped) →
`rebuildContribution()` (drops and recreates storage).

`store.probeContributions()` answers "is search coherent with the graph right
now" without mutating anything — safe on a read path, on a replica, and under a
least-privilege role. It returns one `ready` / `degraded` entry per search
projection plus the durable `graphRevision` the assessment was taken at on a
revision-tracked Store. It shares the detection logic of
`verifyContributions()` rather than reimplementing it, so a health check can
never disagree with the gate the hot path actually consults. A projection with
no declared contributions is omitted rather than reported `ready`, and a backend
that provisions contributions but cannot probe its catalog refuses instead of
answering — "assessed and healthy" and "never looked" never share a return
value.

`store.rebuildContribution("fulltext")` is the repair that was missing for a
`stale` contribution, whose table exists at a shape the current `createDdl` no
longer produces: the ensure path's `CREATE ... IF NOT EXISTS` no-ops against it,
so re-stamping the marker would leave it blessing storage of the wrong shape.
The rebuild drops the storage, recreates it, reconstructs the content from the
node rows, and stamps the marker inside one transaction under the schema-write
fence, so an interrupted rebuild rolls back rather than leaving storage attested
but empty. It is reachable only by name — never from `repairContributions()`,
which continues to report these findings as `requires-rebuild`.

Vector contributions are not rebuildable, and the call refuses with
`ContributionRebuildUnsupportedError` rather than dropping them: TypeGraph
stores the vectors callers supply and never the inputs that produced them, so
the embeddings exist only in the storage a rebuild would destroy.
`reembedVectorField(kind, fieldPath, { embed })` remains the sanctioned
destructive path, because it takes the callback that can regenerate them. The
same typed error covers a fulltext strategy that declares no `dropDdl` and a
backend with no transactional schema fence; all three refuse before anything is
dropped, and all three are declared ahead of time on the new
`backend.capabilities.contributions` capability.

Also adds optional `dropDdl` to `TableContribution` — declared by both bundled
fulltext strategies — which is what opts a strategy into the rebuild.
