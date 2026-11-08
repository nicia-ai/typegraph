---
"@nicia-ai/typegraph": minor
---

Return `AppliedMergeReport.receipt` from `applyMergePlan`, using the terminal receipt of its protected transaction. `receipt.recorded` identifies that transaction's captured cut, including callback writes, even if another writer advances the graph before the response returns. Write counts retain the existing collection-intent semantics. History-disabled applications have no recorded anchor; an empty capture-backed plan still records the revision the merge executor requests. Caller-owned `applyMergePlanInTransaction` receives its terminal receipt from the enclosing `transactionWithReceipt` instead. Best-effort provenance persistence remains outside the merge transaction and cannot change its receipt. Existing engine-native merge-plan capability refusals are preserved.
