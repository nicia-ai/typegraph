---
"@nicia-ai/typegraph": patch
---

Guard `mergeIncremental()` against inherited-row lost updates. The incremental
commit path re-checked new-row identity resolution and per-row resurrect/strip
hazards, but not whether a committed row the plan mutates still held the value
the plan merged against — so a concurrent write to an inherited row between
planning (reads taken outside the transaction) and commit was silently
discarded. The commit now re-reads, in-transaction, every committed target row
the plan will change and aborts with a retryable `BaseVersionMismatchError` if it
drifted, matching the snapshot merge path's TOCTOU contract. This covers all four
mutating paths: node writes and node deletions (checked by `version`), and edge
upserts and edge deletions (checked by a content signature over endpoints,
liveness, and canonical props, since edges carry no version column).
