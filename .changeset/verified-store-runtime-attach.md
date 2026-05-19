---
"@nicia-ai/typegraph": minor
---

Add `createVerifiedStore` and `assertSchemaCurrent` — the runtime
counterparts of `createStoreWithSchema` for the least-privilege
deployment model.

`createStoreWithSchema()` runs DDL (bootstrap, safe auto-migrations,
durable contribution materialization) and must run under a role with
`CREATE` privileges. For applications that want their runtime under a
least-privilege, DML-only role, the previous options were `createStore`
(zero-DDL attach with no schema gate — drift goes undetected until a
hot-path operation trips) or hand-rolling a SELECT-only verification
dance from `getActiveSchema` + `getSchemaChanges`.

This release adds two cleanly named entrypoints that share the same
zero-DDL verification path:

- **`createVerifiedStore(graph, backend, options?)`** — a SELECT-only
  attach (zero DDL) with a verification gate. Reads the active schema
  row and contribution markers, folds the persisted graph extension,
  and refuses to construct the Store unless the database is at the
  same schema version as the code graph. Returns
  `Promise<[Store<G>, SchemaValidationResult]>` mirroring
  `createStoreWithSchema`. Throws `MigrationError` on any drift (safe
  or breaking — the least-privilege runtime cannot migrate),
  `ConfigurationError` when no schema has been initialized, and
  `StoreNotInitializedError` when the schema is current but
  runtime-contribution markers (e.g. fulltext) are missing/stale.

- **`assertSchemaCurrent(backend, graph)`** — the same verification gate
  exposed as a standalone predicate for readiness probes / healthchecks.
  Returns the `SchemaValidationResult` or throws the same errors.

The recommended deployment shape is now:

1. **Migration step** (privileged role with DDL/`CREATE`): run
   `createStoreWithSchema()` once at startup, or apply
   `generatePostgresMigrationSQL` / `generateSqliteMigrationSQL` plus a
   one-shot `createStoreWithSchema()` to materialize runtime
   contributions.
2. **Runtime** (least-privilege, DML-only role): attach with
   `createVerifiedStore()`. Zero DDL on the runtime path; schema drift
   fails fast with a clean `MigrationError` instead of leaking into
   hot-path operations or 500ing on a permission error.

Internal: factored a pure `mergeStoredGraphExtension` helper out of
`loadAndMergeGraphExtensionDocument` so the SELECT-only verifier reuses
the same parse + extension-merge + deprecated-kind logic without going
through the bootstrap-capable loader. No behavior change for the
existing schema entrypoints.

Documentation: "Database roles & least privilege" in `backend-setup.md`
now folds in `createVerifiedStore` as the canonical runtime attach;
`schema-management.md` covers Basic / Managed / Verified stores side by
side; `troubleshooting.md` adds entries for `MigrationError` from a
verifying attach and `ConfigurationError` on uninitialized databases.
