---
"@nicia-ai/typegraph": minor
---

Durable branch descriptors now carry a unique allocation ID, independent of the caller's branch ID. Reopen, destroy, and durable merge compare this ID with the host's sealed origin, so two copies using the same branch ID cannot be confused by a swapped locator. Callers may persist a stable branch ID and allocation ID before creation for host-side reconciliation after an uncertain result. A durable branch handle has the `DurableGraphBranch` type, which binds it to its allocation. `applyDurableMergePlan()` also carries the recorded fork point when comparing a branch with its descriptor, allowing plans for history-enabled durable branches to apply.

Strategies may declare `readableVersions` alongside the locator format `version` they write, allowing upgraded strategies to continue reading and managing older locator formats. The descriptor version is passed to every read, destroy, and evidence method. A strategy may supply a `forkRevision` captured atomically with allocation; when it cannot, TypeGraph uses a full diff to avoid missing writes between allocation and sealing. Durable operation scans now return `hasMore` and retain their cursor at the end of a page, so callers can resume after later commits; strategies must order evidence by a monotonic commit position.

Untracked stores now use the complete graph-content fingerprint and active schema version even when their backend offers lineage. The previous engine anchor could miss identity-only writes and did not read the planned graph state inside the commit transaction. The optional host-native `merge` strategy method is removed; `applyDurableMergePlan()` applies through the target Store transaction until a native merge contract can prove its target fence across the native operation's commit boundary.

### Upgrade notes

- Re-create durable branch descriptors and sealed host origins from earlier releases. They lack the required `allocationId` fence and are refused on reopen, destroy, merge, and evidence access. Keep the previous release available to finish or remove those branches before upgrading.
- Update `DurableOperationCapability.scan` implementations to return `{ operations, cursor, hasMore }`. The cursor must identify the last observed commit position even when `hasMore` is `false`; an empty page echoes `after`.
- Move any strategy revision capture into `create()` and return it as `forkRevision` only when it was captured atomically with the physical fork. Omit it when the host cannot prove that cut.
- Update `DurableWorkingCopyStrategy.create` to accept the allocation ID and refuse a duplicate until the host has explicitly reconciled it. Callers that need crash recovery should persist both IDs before calling `branchDurable` and pass them in options.
- Re-branch or re-plan work whose base version uses the retired `engine:` anchor or an older untracked content token. New untracked tokens fingerprint current identity assertions and include the active schema version.
- Remove `DurableWorkingCopyStrategy.merge` implementations and use `applyDurableMergePlan()`'s transactional apply. Database-native working-copy allocation remains supported.
