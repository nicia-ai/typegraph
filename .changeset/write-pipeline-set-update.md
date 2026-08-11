---
"@nicia-ai/typegraph": patch
---

Route the set-based node update through the write pipeline: `updateWhere`'s
transaction body is now `applyNodeSetUpdate`, a node write step, reached through
`session.reviseNodeSet` under a write plan. The uniqueness drop it performs
moves to the uniqueness sidecar module, and the fence the set UPDATE has no
field to carry is now refused by name instead of being absent from the call.
With this, no module outside the declared step and sidecar modules calls a
backend mutation member for a node write. No public API, behavior, error type,
or lock scope changes.
