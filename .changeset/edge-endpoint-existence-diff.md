---
"@nicia-ai/typegraph": patch
---

Fix schema diff ignoring an edge kind's `endpointExistence`. Changing only that field (for example `"notDeleted"` to `"ever"`) changed the schema hash but diffed as "no changes", so `ensureSchema` returned `unchanged` and the stored document kept the old value. The change is now diffed as a `warning` (it only affects which endpoints a write accepts, so existing edges are untouched and it auto-migrates like a cardinality change) and committed as a new schema version.
