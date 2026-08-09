---
"@nicia-ai/typegraph": patch
---

Add the internal write-pipeline seam: a total, disjoint classification of every
`GraphBackend` member, a typed write plan, per-kind write fences with total
applier maps, the fused write session, and the executor that is the single
sanctioned caller of the write transaction. An ESLint rule now bans direct
backend mutation calls outside the step and sidecar modules that own them, with
a declared exemption list a ratchet holds equal to the tree. No public API,
behavior, statement order, or lock scope changes.
