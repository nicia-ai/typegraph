---
"@nicia-ai/typegraph": patch
---

Reduce schema-fence round trips for multi-write transactions created through the portable Store API while preserving per-write fencing for adapter and adopted transactions that can use caller-controlled savepoints.
