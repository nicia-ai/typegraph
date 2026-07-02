---
"@nicia-ai/typegraph": patch
---

Fix a uniqueness-reservation loss on node resurrection. Resurrecting a
soft-deleted node through `getOrCreateByConstraint` (or any
`clearDeleted: true` upsert) ran the diff-based uniqueness maintenance, which
skips a key that did not change — but the soft delete had already removed the
node's uniqueness entries, so the resurrected node held NO reservation and a
later `create` with the same unique value silently succeeded, duplicating it.
A resurrecting update now re-checks and re-inserts the entries for its new
props, exactly as the provenance reopen path does.
