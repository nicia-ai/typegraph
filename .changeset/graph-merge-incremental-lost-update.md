---
"@nicia-ai/typegraph": patch
---

Guard `mergeIncremental()` against inherited-row lost updates. The incremental
commit path re-checked new-row identity resolution and per-row resurrect/strip
hazards, but not whether a committed row the plan overwrites still held the value
the plan merged against — so a concurrent write to an inherited row between
planning (reads taken outside the transaction) and commit was silently
discarded. The commit now re-reads each planned write's row in-transaction and
aborts with a retryable `BaseVersionMismatchError` if its version advanced,
matching the snapshot merge path's TOCTOU contract.
