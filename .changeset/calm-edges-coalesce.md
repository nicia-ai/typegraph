---
"@nicia-ai/typegraph": patch
---

Coalesce unchanged endpoint edge get-or-create updates when `coalesceUnchangedUpserts` is enabled. A coalesced replay now returns action `"found"`; `"updated"` means an update actually ran.

The coalescing check needs the endpoint match-key convergence fence. On a backend without top-level transactions, such as Cloudflare D1 or `neon-http`, an otherwise unchanged endpoint replay now refuses with `CONSTRAINT_WRITE_FENCE_UNSUPPORTED` instead of running unfenced. The bulk endpoint form and the create leg already required this fence.

This option does not coalesce node `getOrCreateByConstraint` updates; use `upsertById` for replay projectors that need unchanged node writes to avoid history churn.
