---
"@nicia-ai/typegraph": minor
---

Add public snapshot and incremental merge planning APIs that return stable,
JSON-serializable `MergePlanArtifact` values. Plans bind the reviewed write set
to the target graph, active schema, durable revision origin and revision, carry a
content digest, and can be applied exactly once with `applyMergePlan`. Applying a
plan validates the artifact and checks its fence atomically without re-running
candidate generation, scoring, embeddings, canonical selection, or conflict
callbacks. Existing `merge` and `mergeIncremental` entry points retain their
one-call compatibility behavior while sharing the same resolution, validation,
and mechanical write owners.

Explain entity resolution with deterministic decisive edges, complete built-in
candidate-source attribution, and scored strategy/score/threshold evidence while
keeping definitional matches distinct from similarity scores. Add opt-in,
deterministically bounded accepted/rejected candidate diagnostics. Default
evidence excludes raw compared values.

Custom similarity scorers that return `NaN` or infinity now fail with
`MatchEvidenceError`; non-finite values cannot be represented faithfully in a
serialized evidence artifact. Candidate-source failures now use the more
specific `CandidateSourceError`; legacy `details.source` remains available
alongside `details.sourceId` for base-source configuration failures.
