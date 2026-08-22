---
"@nicia-ai/typegraph": patch
---

Read persisted unique constraints that omit `scope` or `collation` by applying the documented `"kind"` and `"binary"` defaults. Schema-management APIs can now inspect databases written with those omitted fields instead of reporting a malformed schema document.
