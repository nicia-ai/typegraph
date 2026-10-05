---
"@nicia-ai/typegraph": patch
---

Upgrade a pre-marker merge-provenance sidecar on a database with the revision-change journal installed. The journal's triggers record every node write, so the sidecar's own `Provenance` rows left entries under its graph id and the upgrade refused them with `GRAPH_MERGE_PROVENANCE_ID_COLLISION` (`reason: "application-graph"`). A journal entry is now accepted when it records a `Provenance` node whose row is still stored and verifies; any other journal entry under that graph id still refuses.
