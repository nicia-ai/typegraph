---
"@nicia-ai/typegraph": patch
---

Fix a uniqueness-reservation corruption on a conflicting node update.
`updateUniquenessEntries` mutated one constraint's sidecar at a time — releasing
the old key before proving the new one free — so a caller that catches the
resulting `UniquenessError` and still commits the transaction (notably
`importGraph(..., { onConflict: "update" })`, which reports the conflict per row)
left the node's already-mutated sidecars in a corrupt state: an earlier
constraint's old key released (letting a later create silently duplicate it) or a
new key wrongly reserved, while the row itself stayed unchanged. The update now
runs in two passes — preflight every changed constraint's new key first, then
apply all sidecar deletes and inserts only after every key is proven free — so a
conflict throws with zero partial writes, for every caller of the shared
node-write pipeline and for nodes with any number of unique constraints.
