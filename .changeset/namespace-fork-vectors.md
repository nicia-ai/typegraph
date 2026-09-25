---
"@nicia-ai/typegraph": minor
---

`forkGraphNamespace()` now forks graphs that use the bundled pgvector storage. Embedding rows are copied inside the same repeatable-read snapshot, included in the content digest that the copy, retries and `abort()` verify, and removed by `abort()`. A graph with embedding fields forks only between backends with the same vector storage, pgvector on both sides or `vector: false` on both; custom vector and fulltext strategies are still refused.

`prepareNamespaceForkTarget(source, target)` is the owner-side step. It installs the retry ledger, creates the graph's pgvector tables, and builds every index the source has materialized for the graph with the DDL the source used. It writes no graph rows and no materialization records, and the runtime fork still issues no DDL. IVFFlat indexes need the copied rows to cluster well, so preparation skips them, the fork does not copy their records, and `fork.store.materializeIndexes()` builds them after the copy.

`materializeIndexes()` now rebuilds an IVFFlat index that exists without a materialization record, for example one an aborted fork left behind, instead of keeping it with `IF NOT EXISTS`: it was clustered for other rows. A backend without `dropVectorIndex` keeps the previous behavior.

A materialized vector index no longer makes the fork refuse, and indexes whose build never completed on the source are neither built on nor required of the target.

### Upgrade notes

- Replace `installNamespaceForkLedger(target)` with `prepareNamespaceForkTarget(source, target)`, run with the schema owner role before the runtime fork. `installNamespaceForkLedger` is removed.
- Namespace-fork backends no longer need `vector: false`. For a graph with embedding fields, open source and target with the same vector storage: pgvector on both, or `vector: false` on both.
- After forking a graph that declares IVFFlat indexes, run `materializeIndexes()` on the forked store under the owner role to build them.
