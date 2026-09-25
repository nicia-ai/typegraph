---
"@nicia-ai/typegraph": minor
---

Add history-preserving PostgreSQL graph namespace forks, store-free graph-extension introspection, recorded fork points for incremental merge, and bounded change enumeration for revision-tracked stores. Linear traversal queries now read their final hop directly. PostgreSQL transaction backends and bare client sessions serialize statements on their pinned connection; transaction marker checks read that same connection.

Install the revision-change journal with `installRevisionChangesJournal()` during privileged schema setup. Runtime lineage verifies that its table and triggers are ready without running DDL; short-lived clones, including `branchForEvolution()` working copies, may set `revisionJournal: false`. Install the namespace fork retry ledger with `installNamespaceForkLedger()` on the private target before runtime use. `Store.clear({ preserveContributionMaterializations: false })` also removes graph-local contribution markers for cutover purges.

### Upgrade notes

Adopt base schema version 4 with the schema owner before deploying runtime roles. Existing PostgreSQL installations need the generated migration or a privileged `createStoreWithSchema()` / `createAdapterStoreWithSchema()` open; the new revision-change table and index are part of that base schema. Install the optional revision-change function and triggers once with `installRevisionChangesJournal()` under the owner role. Runtime lineage only checks readiness and never runs DDL; a revision-tracked store without history throws `REVISION_JOURNAL_NOT_READY` when the journal is missing. Set `revisionJournal: false` for clones that do not need journal-backed lineage, including the fourth `branchForEvolution()` argument.

`Store.clear()` preserves graph-local contribution materialization markers by default; pass `{ preserveContributionMaterializations: false }` to remove them during a full cutover purge. Journal triggers attach to whole physical tables, so on shared tables they record writes for every graph using those tables, and journal rows have no automatic cleanup or retention policy. Avoid enabling the journal on shared tables unless that cross-graph capture and unbounded retention are acceptable.

`forkGraphNamespace()` holds one repeatable-read source transaction open for the entire copy, including row reads, target inserts, and digest checks. Long-running copies therefore retain the source snapshot until the copy finishes.

Custom engine profiles need revision-change table and index DDL for base-schema version 4 adoption, and trigger DDL plus a readiness probe to enable the change journal. Missing dependencies raise `ConfigurationError` when those operations are requested.
