---
"@nicia-ai/typegraph": patch
---

Fence constrained writes inside caller-adopted SQLite transactions by taking the writer slot before decision-driving reads, acquire graph-merge locks in the canonical schema-first order, and compile temporal-system `orderBy` fields against their physical columns when the schema does not declare a same-named property. Declared properties retain precedence so filtering and ordering use the same field.

Bulk node and edge wrappers now have regression coverage that pins one durable revision advance per public bulk call rather than one advance per member.
