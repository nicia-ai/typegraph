---
"@nicia-ai/typegraph": minor
---

A durable PostgreSQL working copy's locator now records the schema of the ledger its allocation was recorded in, and every call by locator uses that ledger: `seal`, `abort`, `reopenDurableBranch`, `destroyDurableBranch`, and the durable operation members. Before, each call resolved the ledger through `control`'s current schema at the time of the call. A caller whose `search_path` named a schema that did not exist yet (`future_schema, public`) created a branch in `public`; once it created `future_schema`, without changing the path, destroying the same descriptor created an empty ledger in `future_schema`, failed with "allocation does not exist", and left the original row and tables behind. Removing the allocation's schema from the path did the same. The locator alone now decides the ledger, so a manager built afresh from the stored descriptor finds it whatever `control`'s path resolves.

The locator format moves to version 2: `{ allocationId, ledgerSchema }`. The strategy still reads and manages version 1 locators (`readableVersions: [1]`), which name no schema; they resolve the ledger through `control`'s current schema at the time of the call, exactly as the released version does. A version 2 locator without `ledgerSchema`, a version 1 locator that names one, or an empty schema name is refused with a `BranchError`, and nothing is removed.

`listUnsealedAllocations` and `abortAllocation` accept a `ledgerSchema` option naming the ledger to read; without it they read the ledger in `control`'s current schema, as before. Each listed `PostgresUnsealedAllocation` now carries the `ledgerSchema` it was listed from, to pass back to `abortAllocation`. The option type is exported as `PostgresWorkingCopyLedgerOptions`.

Upgrade notes:

- Upgrade every process that reopens or destroys durable PostgreSQL working copies before any process creates new ones. A release before this one refuses a version 2 descriptor ("Unsupported PostgreSQL working-copy locator version") instead of resolving it through the wrong ledger. Descriptors you have already stored keep working unchanged.
- A version 1 descriptor still depends on `control`'s current schema when it is used: reopen or destroy it with `control`'s `search_path` resolving the schema it was created in.
- Code that constructs or compares `PostgresUnsealedAllocation` values, or checks a stored locator's exact shape, must account for the new `ledgerSchema` field.
