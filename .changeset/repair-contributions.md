---
"@nicia-ai/typegraph": minor
---

Add `store.repairContributions()`, a privileged, idempotent repair pass for
strategy-owned contribution storage. It re-audits declarations from the active
persisted graph, non-destructively retries `missing-marker` and
`failed-materialization` findings, reports `stale` and `orphaned-marker` as
`requires-rebuild`, and returns a fresh post-repair diagnostic result. Repair
targets remain backend-owned so callers do not need access to TypeGraph-managed
tables, physical names, or DDL.
