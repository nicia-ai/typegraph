---
"@nicia-ai/typegraph": patch
---

Restore transaction revision and engine-native mutation flags when TypeGraph rolls back a savepoint, and discard success hooks for adopted-transaction operations whose writes were rolled back. Catching a refused in-transaction merge and committing the surrounding transaction no longer reports rolled-back writes or advances a revision for them. Writes outside the savepoint retain their effects.
