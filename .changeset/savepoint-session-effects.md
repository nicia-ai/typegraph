---
"@nicia-ai/typegraph": patch
---

Restore transaction revision and engine-native mutation flags when TypeGraph rolls back a savepoint, and report rolled-back operations through `onError` with their rollback cause. Receipt checkpoints and deferred success hooks share the same savepoint lifecycle for adopted and Store-owned transactions. Catching a refused in-transaction merge and committing the surrounding transaction no longer reports rolled-back writes or advances a revision for them. Writes outside the savepoint retain their effects.
