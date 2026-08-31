---
"@nicia-ai/typegraph": minor
---

Keep eligible large node and edge `bulkUpsertById()` sets on the atomic mutation-program path when they exceed one statement's bind budget. Resolved updates, mixed creates and updates, projection sidecars, per-chunk postimage assertions, and ordered result reads now execute as bind-sized statements inside one bounded atomic transport submission. On Cloudflare D1 this raises the previous 17-node and 6-edge batch-wide ceilings to 512 nodes and 187 edges without weakening rollback: a moved member in any chunk aborts every sibling chunk. Larger sets fail closed to the portable path rather than constructing an unbounded transport request.
