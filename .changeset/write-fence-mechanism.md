---
"@nicia-ai/typegraph": minor
---

`capabilities.writeFence` is the write-fence declaration, a discriminated union on `mechanism`:
`{ mechanism: "advisory"; drain: "table-lock" | "quiescent" | "none" }` |
`{ mechanism: "engine-serialized" }` | `{ mechanism: "caller-serialized" }`. `mechanism` is the
exclusion primitive a backend provides; `drain` — a field of the `"advisory"` shape only — is the
separate fact of whether a caller that already excluded other writers can additionally take a
relation-wide lock on a resource a few sites protect. Both bundled backends declare it directly
(`SQLITE_CAPABILITIES`: `{ mechanism: "engine-serialized" }`; `POSTGRES_CAPABILITIES`:
`{ mechanism: "advisory", drain: "table-lock" }`), so nothing built against them changes: same
emitted SQL, same resolved plan. `resolveWriteFencePlan` validates a declared `writeFence` at
runtime — an unrecognized `mechanism`, an unrecognized `drain`, or a `drain` attached to a
serialized mechanism — and refuses with `WRITE_FENCE_DECLARATION_INVALID` naming the field and
(where applicable) the accepted values, since a plain-JavaScript backend author is not held to the
discriminated-union type the way a TypeScript caller is.

A new arm, `{ kind: "caller-serialized" }`, joins `WriteFencePlan`'s union for a deployment-level
promise that no other client writes to the backend's database while it is open.
`createPostgresBackend` accepts `writeFence: { mechanism: "caller-serialized" }` — a claim about
the deployment, not the engine — while continuing to refuse `mechanism: "engine-serialized"`
outright, since that claims the engine itself serializes writers. The promise splits into two
halves. In process, TypeGraph enforces its own half: every root member the backend classifies in a
mutation-capable class — graph-entity and sidecar writes, backend-owned bulk import, derived-data
maintenance, schema commits, table/DDL provisioning, `clearGraph`, and the raw-SQL members that can
carry an arbitrary write (`execute`, `executeRaw`, `executeStatement`,
`executeTemporaryStatement`) — plus `transaction` and `transactionWithNative`, runs through one
per-backend serialized queue, so two concurrent calls through the same pool cannot race each other;
a root write awaited from inside a `store.transaction` callback is refused
(`SERIALIZED_QUEUE_REENTRANT_SUBMISSION`) rather than left to deadlock. Adopting an externally
owned transaction (`adoptTransaction`, backing `store.withTransaction(externalTx)`) is refused
outright (`CALLER_SERIALIZED_REFUSES_ADOPTION`): its lifetime belongs to the caller, not to this
backend's queue, so there is no honest way to hold a queue slot open for it. Outside the process,
the deployment still has to hold up its half (no other client writing to the same database) since
TypeGraph cannot observe that.

`requireWriteFence` takes `requires: "keyed" | "drain"`: `"keyed"` is satisfied by every
non-`unfenced` arm; `"drain"` refuses only when the resolved plan's `drain` is `"none"`, and
`"engine-serialized"` / `"caller-serialized"` satisfy it without consulting `drain` at all.

## Breaking

- `capabilities.pessimisticLocks` and its `PessimisticLockCapabilities` type are removed — declare
  `capabilities.writeFence` instead.
- `requireWriteFence`'s `requires` parameter is renamed: `"advisory-lock"` becomes `"keyed"`,
  `"table-lock"` becomes `"drain"`.
- `WriteFencePlan`'s `lock` arm drops `tableLocks` and `advisoryLocks` — read `drain` instead
  (`"table-lock"` means what `tableLocks: true` used to).
- `WriteFencePlan`'s `unfenced` arm drops `reason` — declaring `writeFence` leaves no shape that
  resolves `unfenced` for a reason other than an absent declaration, so there is nothing left to
  distinguish.
- `WriteFencePlan` gained the `caller-serialized` arm as a permanent part of the union — an
  external exhaustive switch on `WriteFencePlan["kind"]` must add a case for it (or its `default`
  branch, if any, now sees it too).
- `WRITE_FENCE_DECLARATION_CONFLICT` is removed — `writeFence` is the only declaration, so no two
  declarations can conflict.
- `WriteFenceDeclaration` is now a discriminated union on `mechanism`, not one flat shape: `drain`
  is a field of `{ mechanism: "advisory" }` only. Declaring `drain` alongside
  `mechanism: "engine-serialized"` or `mechanism: "caller-serialized"` — accepted (and ignored) by
  earlier commits on this same feature branch — is now refused with
  `WRITE_FENCE_DECLARATION_INVALID`. Read `declaration.drain` only after narrowing
  `declaration.mechanism === "advisory"`.
