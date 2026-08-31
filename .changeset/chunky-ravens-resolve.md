---
"@nicia-ai/typegraph": minor
---

Keep eligible large node and edge `bulkUpsertById()` sets on the atomic mutation-program path when they exceed one statement's bind budget. Resolved updates, mixed creates and updates, projection sidecars, per-chunk postimage assertions, and ordered result reads now execute as bind-sized statements inside one atomic transport submission. On Cloudflare D1 this removes the previous 17-node and 6-edge batch-wide ceilings without weakening rollback: a moved member in any chunk aborts every sibling chunk.
