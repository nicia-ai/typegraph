---
"@nicia-ai/typegraph": patch
---

Fix writes through an ephemeral PostgreSQL working copy of a history-enabled store. The copy's store was built over the allocation store's already capture-wrapped backend, so recorded capture wrapped twice and every create, update, or delete failed with a `ConfigurationError` from the raw-write guard. The ephemeral store is now built over the unwrapped owned backend, and its writes are captured in the copy's own recorded history.
