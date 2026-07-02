---
"@nicia-ai/typegraph": patch
---

Fix a uniqueness-reservation corruption on a conflicting node update.
`updateUniquenessEntries` deleted the old unique key before checking the new one,
so a caller that catches the resulting `UniquenessError` and still commits the
transaction — notably `importGraph(..., { onConflict: "update" })`, which reports
the conflict per row — left the node holding its old value with no uniqueness
entry, letting a later create silently duplicate it. The new key is now
preflighted before the old key is released, so a conflicting update throws with
no partial write, for every caller of the shared node-write pipeline.
