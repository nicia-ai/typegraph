---
"@nicia-ai/typegraph": minor
---

`forkGraphNamespace()` now forks graphs that use the bundled pgvector storage. Embedding rows are copied inside the same repeatable-read snapshot, included in the content digest that the copy, retries and `abort()` verify, and removed by `abort()`. A graph with embedding fields forks only between backends that both use pgvector; custom vector and fulltext strategies are still refused.

`prepareNamespaceForkTarget(source, target)` is the owner-side step. It installs the retry ledger, creates the graph's pgvector tables, and builds every index the source has materialized for the graph, relational and ANN, with the DDL the source used. It writes no graph rows and no materialization records, and the runtime fork still issues no DDL.

A materialized vector index no longer makes the fork refuse, and indexes whose build never completed on the source are neither built on nor required of the target.

### Upgrade notes

- Replace `installNamespaceForkLedger(target)` with `prepareNamespaceForkTarget(source, target)`, run with the schema owner role before the runtime fork. `installNamespaceForkLedger` is removed.
- Stop opening namespace-fork backends with `vector: false` as a workaround. Backends on a forked graph with embedding fields must now use pgvector on both sides.
