---
"@nicia-ai/typegraph": patch
---

Refuse PostgreSQL working-copy allocation or durable reopen when the target connection changes the bundled fulltext strategy. This prevents copied fulltext projections from being exposed through a backend with different storage or disabled fulltext support.
