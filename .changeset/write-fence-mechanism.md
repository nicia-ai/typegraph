---
"@nicia-ai/typegraph": minor
---

`capabilities.writeFence` is the write-fence declaration: `{ mechanism: "advisory" |
"engine-serialized" | "caller-serialized"; drain: "table-lock" | "quiescent" | "none" }`.
`mechanism` is the exclusion primitive a backend provides; `drain` is the separate fact of
whether a caller that already excluded other writers can additionally take a relation-wide lock
on a resource a few sites protect. Both bundled backends declare it directly
(`SQLITE_CAPABILITIES`: `{ mechanism: "engine-serialized", drain: "table-lock" }`;
`POSTGRES_CAPABILITIES`: `{ mechanism: "advisory", drain: "table-lock" }`), so nothing built
against them changes: same emitted SQL, same resolved plan.

A new arm, `{ kind: "caller-serialized" }`, joins `WriteFencePlan`'s union for a deployment-level
promise that no other client writes to the backend's database while it is open.
`createPostgresBackend` accepts `writeFence: { mechanism: "caller-serialized", drain }` — a claim
about the deployment, not the engine — while continuing to refuse `mechanism:
"engine-serialized"` outright, since that claims the engine itself serializes writers. The
promise splits into two halves: in process, TypeGraph enforces its own half by routing every
write unit issued through a `caller-serialized` backend — collection writes,
`store.transaction`, schema commits, identity and contribution maintenance, index
materialization, import — through one per-backend serialized queue, so two concurrent calls
through the same pool cannot race each other; outside the process, the deployment still has to
hold up its half (no other client writing to the same database) since TypeGraph cannot observe
that.

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
