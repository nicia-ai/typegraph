---
"@nicia-ai/typegraph": patch
---

Two write paths now honor identity exactly as the ordinary node writes do. A provenance retraction that closes a fact's currency detaches the fact from its identity class, ending its open identity assertions as any soft delete does, and a reopen folds it back in as a restore; previously a closed fact kept its open assertions and stayed in its class while tombstoned. `bulkUpsertById` items that set `validTo` now go through the same identity check as `update` and `upsertById`, so a window end that an open identity assertion would outlive is refused with `IdentityEndpointValidityError` instead of committing.
