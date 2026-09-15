---
"@nicia-ai/typegraph": minor
---

Query a nonempty explicit list of node kinds with `from(["Person", "Company"], "entity")`. Shared fields support the existing query composition APIs, and full-node results retain kind-discriminated properties.

Multi-kind cursor pagination and streaming now use both kind and ID to preserve rows when IDs overlap across kinds. Polymorphic sources refuse predicate, grouping, and ordering fields that are missing or incompatible across their kinds. Existing multi-kind cursors may need to be restarted because their identity columns now include kind.
