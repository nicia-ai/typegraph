---
"@nicia-ai/typegraph": patch
---

Harden atomic edge-write refusal diagnosis. Bundled backends now diagnose missing endpoints with set-oriented reads instead of a sequential read per edge; custom backends without the batch-point-read capability use bounded-concurrency windows that still cover the complete input. If endpoint or cardinality state changes after the atomic rollback and no current violation can be found, TypeGraph preserves the driver cause in a typed `DatabaseOperationError` instead of leaking an unclassified transport error. Native singleton edge deletes now report the same authoritative `written` hook outcome as node deletes.
