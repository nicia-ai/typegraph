---
"@nicia-ai/typegraph": minor
---

Bind TypeGraph-owned recorded anchors to their durable graph origin and recording namespace using the `r2:<origin>:<namespace digest>:<revision>:<timestamp>` format. Historical reads, including empty reads and first-page adjacency, refuse retired or foreign origins after a graph reset. Engine-native `e1:` ownership remains separate. Legacy `r1:` strings remain parseable but cannot authorize historical reads; migrate them only with independently retained origin evidence, or discard and resynchronize checkpoints whose origin cannot be proven.

Add `store.resolveRecordedInstant(wallTime)` for one indexed lookup of the latest retained recorded allocation anchor at or before a canonical UTC timestamp. Equal timestamps choose the greatest revision; future requests return the latest retained cut; empty graphs and requests before known complete history return `undefined`; unlogged coverage throws `RECORDED_LOOKUP_HISTORY_NOT_LOGGED`. This describes allocation time, not database commit visibility. Base-schema version 7 installs the retained anchor log and its index; coverage starts with captured transactions after installation, without inventing earlier allocation timestamps. Custom backends must declare and honor `recordedAnchorLookup`; engine-native histories refuse this TypeGraph-owned resolver.

Upgrade merge-plan appliers before planners. All newly emitted merge plans use format 2 with a required allocation owner; version 1 remains parseable for inspection but application refuses it. Regenerate all persisted merge plans and re-baseline branches whose revision fences contain the old anchor format before resuming application. Do not rewrite embedded fence strings or artifact digests with the checkpoint migration helper.

Complete `PostgresTableNames` / `SqliteTableNames` maps must include `recordedAnchors`; partial table-name overrides continue to use defaults. Custom PostgreSQL working-copy connectors must bind this relation to the allocated namespace along with the other graph relations.

Expose the complete owner through `store.allocationOwner()` and `recordedInstantOwner()`. Rotate unpublished same-name physical forks with `store.rotateAllocationOwner(expectedOwner)` before independent writes; backups intended to continue the same allocation retain their owner. Rotation preserves data and captured history while retiring old checkpoints in the fork. External recorded relations without local origin metadata can provide `recordedRelation({ schema, owner })`; legacy unbound sources require explicit checkpoint migration.

Update reset handling to match `GRAPH_ALLOCATION_OWNER_MISMATCH`, shared by recorded reads, comparisons, and merge origin refusals. This replaces the earlier adjacency/merge-specific reset codes. Recorded transaction sessions and iterative algorithms enforce the same ownership check. Migration verifies bound inputs and refuses revisions beyond the retained clock.

Known writable forks created by `forkedWorkingCopyStrategy()` and physical copies allocated by `branchDurable()` rotate their owner automatically after base verification; parent checkpoints must be reacquired under the fork owner. External writers can construct owner-bound checkpoints with `recordedInstant({ revision, wallTime, owner })`; `recordedReadOwner()` uses the configured source owner reader. `allocationOwner()` and rotation refer only to native writes, independently of external reads.

Replace `revisionOriginNow()` callers with `allocationOwner()`. Retain the complete owner for checkpoints and fences rather than comparing only its origin component; raw origin minting is now private.

Custom concrete Store implementations must expose `rotateAllocationOwner(expectedOwner)` as a lifecycle operation, or implement a typed refusal when their ownership cannot be rotated. The structural `StoreCore` capability remains optional before resolution; read-only surfaces do not acquire this write method.

Allocation owner mismatches use `GRAPH_ALLOCATION_OWNER_MISMATCH` for either origin or namespace differences. Native owner access requires the Store revision-tracking option; missing configuration raises `ConfigurationError`, not a backend capability refusal. Physical fork paths share one rotation decision.

Custom concrete Stores must implement `recordedReadOwner()` as well as native `allocationOwner()` and lifecycle rotation, or provide the documented typed refusals. Rename `MergePlanOriginMismatchError` to `MergePlanOwnerMismatchError` and `MERGE_ERROR_CODES.planOriginMismatch` to `planOwnerMismatch`; both origin and namespace differences use this owner vocabulary. Destroy unsealed physical forks during host recovery; never adopt an allocation whose rotation and sealing did not complete.
