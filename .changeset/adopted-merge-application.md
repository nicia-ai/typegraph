---
"@nicia-ai/typegraph": minor
---

Add `applyMergePlanInTransaction()` so applications can apply an approved merge plan, record graph receipts, and write application SQL under one caller-owned transaction and recorded-time receipt.

Merge callbacks and adopted application now refuse custom backends without engine serialization or session-bound read-committed isolation evidence. Custom backends must expose that evidence through their write fence.

Fix constrained writes in adopted SQLite history transactions by acquiring the writer slot through the internal transaction-control path while retaining capture lifetime checks.
