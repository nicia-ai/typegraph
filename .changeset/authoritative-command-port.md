---
"@nicia-ai/typegraph": minor
---

Replace the optional managed-create hook with a required semantic command port that carries its root or transaction session and, only after an advisory graph lock is acquired, a graph- and session-bound coordination token. Transparent `deriveBackend` command wrappers retain the underlying session identity and isolation; a wrapper for another connection cannot reuse its token. Under that lock, PostgreSQL endpoint get-or-create folds the match-key read, endpoint validation, and insert into one statement, returning either the created edge or the existing winner without another application-level read.

Breaking change and migration: custom `GraphBackend` implementations must add a `commands` member with `{ session, execute(command, context) }`. Move managed-create and specialized edge-insert behavior into the `node.create`, `edge.create`, and `edge.converge-create` command cases, and return the typed `unsupported` result for dimensions the backend cannot apply. Built-in adapters already provide this port.
