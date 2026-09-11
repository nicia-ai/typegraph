---
"@nicia-ai/typegraph": minor
---

Add `store.bulkFindEdgesTo` and its pinned-view counterpart for set-oriented inbound reads across edge kinds. Detect whole-node and whole-edge selections before issuing a projected query, avoiding a redundant fetch for fresh query instances. Add `executeChecked(expectedSchemaVersion)` for a relational read and committed-schema check in one statement, with `SchemaChangedError` on mismatch, including empty results.
