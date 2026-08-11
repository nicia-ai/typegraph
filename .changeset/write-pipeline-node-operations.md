---
"@nicia-ai/typegraph": patch
---

Route every node write except the set update through the write pipeline: the
eight managed entry points in `node-operations.ts` now compose a write plan and
run through the executor, and their row and sidecar writes are the session's
fused units rather than hand-paired calls. The identity-participation decision
moves from eight inline conditions to one declaration per plan, and the update
path's validity lower-bound fence becomes a required argument instead of a
spread convention. No public API, behavior, error type, or lock scope changes.
