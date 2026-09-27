---
"@nicia-ai/typegraph": patch
---

Materialize class membership once while paging current identity classes. SQLite could otherwise repeat the full node scan inside the kind filter for every class, making `identity.classes()` much slower than the earlier in-memory read on graphs with many unrelated node kinds.
