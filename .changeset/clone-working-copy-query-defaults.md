---
"@nicia-ai/typegraph": patch
---

`cloneWorkingCopyStrategy` (the default `branch()` strategy) and the ingestion-branch clone now open the working copy with the base store's `queryDefaults`, as the fork, namespace-fork and PostgreSQL table strategies already did. A base opened with `queryDefaults: { expansion: "exact" }` or a non-default `traversalExpansion` previously got a working copy on the library defaults, so the same query returned different rows on the branch than on the store it was branched from. Hooks, `coalesceUnchangedUpserts` and `autoRefreshStatistics` are still not carried to a clone.
