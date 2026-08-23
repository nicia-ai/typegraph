---
"@nicia-ai/typegraph": minor
---

Replace the three specialized edge-insert backend hooks with the shared semantic command port. Managed edge creates now compile endpoint validation, an optional schema fence, and an optional cardinality claim into one all-or-nothing `edge.create` command with an explicit result. Custom backends implement the required command contract and must apply or refuse every requested dimension.

Breaking change and migration: custom backends should remove their old specialized edge-insert hook wiring and implement `commands.execute` for `edge.create` (and `edge.converge-create` when convergence is supported). Return the typed `unsupported` dimension result when endpoint, schema-fence, cardinality, or convergence behavior is unavailable.
