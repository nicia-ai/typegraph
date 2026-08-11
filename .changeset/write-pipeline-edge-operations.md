---
"@nicia-ai/typegraph": patch
---

Route every edge write through the write pipeline: the raw `insertEdge` /
`updateEdge` / `deleteEdge` / `hardDeleteEdge` calls move into a new
`edge-write-pipeline.ts` step module and the insert dispatch, reached through
the session's seven edge methods under an edge write plan. All nine edge entry
points — including the bulk `getOrCreateByEndpoints` batch — now declare their
constraint probe as plan data instead of spelling it at the transaction call,
and an edge update states its asserted identity and validity bound as a fence
record whose keys are required, so a partially stated fence is a type error
rather than a silently unfenced write. The zero-row diagnosis
(`withUnmatchedEdgeUpdateRefusal`) moves to `edge-write-fences.ts` and stays
caller-applied, because the store's converge-or-refuse reading and interchange
import's report-and-continue reading are genuinely different recovery policies.
No public API, behavior, error type, statement, or lock scope changes.
