---
"@nicia-ai/typegraph": patch
---

Fence constrained writes inside caller-adopted SQLite transactions by taking the writer slot before decision-driving reads, acquire graph-merge locks in the canonical schema-first order, and compile temporal-system `orderBy` fields against their physical columns instead of a missing JSON property.

Bulk node and edge wrappers now have regression coverage that pins one durable revision advance per public bulk call rather than one advance per member.
