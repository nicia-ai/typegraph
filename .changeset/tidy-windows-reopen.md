---
"@nicia-ai/typegraph": minor
---

Add `clearValidTo: true` across node and edge update/upsert APIs so applications can reopen an ended valid-time window without changing entity identity. Built-in SQLite and PostgreSQL backends apply the clear, unchanged replays coalesce, `oneActive` relationships are rechecked when reopening, unsupported custom backends refuse explicitly, and graph merge carries branch-authored reopenings while rejecting delete-and-resurrect window artifacts.
