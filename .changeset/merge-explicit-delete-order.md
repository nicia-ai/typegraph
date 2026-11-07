---
"@nicia-ai/typegraph": patch
---

Apply explicit edge deletions before node deletions during graph merge. A merge that removes a connecting edge and its endpoint now succeeds under restricted node deletion, while undeleted edges still block the node removal. Edge upserts continue to follow node writes so newly created endpoints exist, and all writes retain the existing transaction and revision fences.

For `cascade` and `disconnect` node policies, explicitly planned edge removals now emit their own edge delete hooks before the node deletion.
