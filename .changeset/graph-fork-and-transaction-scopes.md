---
"@nicia-ai/typegraph": minor
---

Add history-preserving PostgreSQL graph namespace forks, store-free graph-extension introspection, recorded fork points for incremental merge, and bounded change enumeration for revision-tracked stores. Linear traversal queries now read their final hop directly. PostgreSQL transaction backends and bare client sessions serialize statements on their pinned connection; transaction marker checks read that same connection.

Install the revision-change journal with `installRevisionChangesJournal()` during privileged schema setup. Runtime lineage verifies that its table and triggers are ready without running DDL; short-lived clones may set `revisionJournal: false`. Install the namespace fork retry ledger with `installNamespaceForkLedger()` on the private target before runtime use. `Store.clear({ preserveContributionMaterializations: false })` also removes graph-local contribution markers for cutover purges.

Custom engine profiles need revision-change table and index DDL for base-schema version 4 adoption, and trigger DDL plus a readiness probe to enable the change journal. Missing dependencies raise `ConfigurationError` when those operations are requested.
