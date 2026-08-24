---
"@nicia-ai/typegraph": minor
---

Add graph-local durable edge match identities. An edge registration can declare one named, canonical property-field set; TypeGraph persists its directed endpoint/property key on every edge row, maintains it across normal and trusted import writers, refuses ordinary updates to identity fields, retains it across soft deletion, and releases it on hard deletion. SQLite and PostgreSQL provision and idempotently upgrade the edge relation with a pair-null check and unique arbiter.

Schema-managed root `getOrCreateByEndpoints` calls using a declared identity now compile endpoint validation, the schema fence, conflict arbitration, and the created/found result into one database statement on bundled SQLite and PostgreSQL backends. Dynamic call-level `matchOn` remains available through the transaction-fenced compatibility path, and a supplied field list on a declared edge must exactly match the declaration. Bulk endpoint candidate reads use the set-oriented heterogeneous endpoint member instead of one read per endpoint pair on bundled backends.

Direct creates use the same durable arbiter at every cardinality. Built-in bulk creates preserve set-oriented insertion through a conflict-arbitrated batch command rather than falling back to one managed write per row.

Operation-end hooks now report `outcome: "written" | "unchanged" | "unknown"`. An authoritative get-or-create command that finds an incumbent completes as `"unchanged"` and does not fire `onError`; the same explicit outcome prevents revision/history churn for the no-write leg. Commands without an authoritative physical-write verdict report `"unknown"` instead of guessing from success.

Normal import uses the same set-oriented durable command for claimless slices and savepoint-protected batch recovery for exceptional conflicts, including on history-enabled stores. Non-transactional backends refuse ambiguous per-row retry after a failed batch rather than re-inserting a possibly committed prefix.

Adding, removing, or changing a match identity is a breaking schema change. The initial migration contract refuses activation while the affected edge kind holds rows; export and hard-delete those rows, migrate the schema, then import them so every row receives the new durable key.
