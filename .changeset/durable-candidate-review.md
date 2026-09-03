---
"@nicia-ai/typegraph": minor
---

Add durable candidate merge reviews with `planCandidateWriteSetReview()` and `revalidateCandidateWriteSetReview()`. Persist immutable review and approval evidence in the target graph, then compare the retained candidate against current state before applying a fresh revision-fenced plan. Structured compatibility results expose changes requiring review without weakening atomic apply-time concurrency or constraint checks.
