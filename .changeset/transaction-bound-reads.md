---
"@nicia-ai/typegraph": minor
---

Add transaction-bound `query()`, `neighbors()`, `countNeighbors()`, `subgraph()`, and `batchOnce()` reads. Every read executes through the open transaction and observes earlier writes in the callback; `tx.subgraph()` and `tx.batchOnce()` each execute as exactly one statement.
