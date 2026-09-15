---
"@nicia-ai/typegraph": minor
---

Add directed node index keys that can interleave property and system columns, enabling B-tree indexes such as `(createdAt DESC, id ASC)` while keeping covering fields last. Export `NODE_SYSTEM_COLUMN_NAMES` as the readonly runtime companion to `NodeSystemColumnName` for config generation and validation.
