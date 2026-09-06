---
"@nicia-ai/typegraph": minor
---

`capabilities.writeFence` replaces the three `pessimisticLocks` booleans as the write-fence
declaration: `{ mechanism: "advisory" | "engine-serialized" | "caller-serialized"; drain:
"table-lock" | "quiescent" | "none" }`. `mechanism` is the exclusion primitive a backend
provides; `drain` is the separate fact of whether a caller that already excluded other writers
can additionally take a relation-wide lock on a resource a few sites protect. `pessimisticLocks`
stays accepted — deprecated, not removed — and `resolveWriteFencePlan` maps it to the new shape
through one function: `advisoryLocks: true` becomes `{ mechanism: "advisory", drain: tableLocks ?
"table-lock" : "none" }`; `serializedWriters: true` becomes `{ mechanism: "engine-serialized",
drain: "table-lock" }`. Declaring both `writeFence` and `pessimisticLocks` on the same backend is
refused with a new `ConfigurationError` code, `WRITE_FENCE_DECLARATION_CONFLICT`, naming both
declarations. Both bundled backends keep declaring `pessimisticLocks` in this release, so nothing
built against them changes: same emitted SQL, same capabilities, same resolved plan.

The resolved `WriteFencePlan`'s `lock` arm gains `drain`, with `tableLocks: boolean` kept as a
deprecated alias derived from it (`drain === "table-lock"`) — read `drain` in new code, since it
distinguishes a declaration that cannot drain a site at all (`"none"`) from one that drains it
without a statement (`"quiescent"`), a distinction `tableLocks: false` collapses to one case. A
new arm, `{ kind: "caller-serialized" }`, joins the plan's union for a deployment-level promise
that no other client writes to the backend's database while it is open. **This is an additive
change to a released discriminated union**: any code outside this package that exhaustively
switches on `WriteFencePlan["kind"]` must add a `"caller-serialized"` case, or its `default`
branch (if any) now sees it too. `requireWriteFence`'s behavior is unchanged for
`"advisory-lock"`; for `"table-lock"` it now refuses only when the resolved plan's `drain` is
`"none"` (previously: whenever `tableLocks` was `false`), and `"engine-serialized"` /
`"caller-serialized"` satisfy either requirement without consulting `drain`.

`createPostgresBackend` accepts `writeFence: { mechanism: "caller-serialized", drain }` — a claim
about the deployment, not the engine — while continuing to refuse the legacy
`pessimisticLocks.serializedWriters: true` outright, since that boolean claims the engine itself
serializes writers. The promise splits into two halves: in process, TypeGraph now enforces its
own half by routing every write unit issued through a `caller-serialized` backend — collection
writes, `store.transaction`, schema commits, identity and contribution maintenance, index
materialization, import — through one per-backend serialized queue, so two concurrent calls
through the same pool cannot race each other; outside the process, the deployment still has to
hold up its half (no other client writing to the same database) since TypeGraph cannot observe
that.

`WriteFenceDeclaration` is exported directly from `@nicia-ai/typegraph/backend`.
`pessimisticLockDeclarationLine` stays as a deprecated (but permanently supported) alias printing
the legacy declaration line; new refusal messages recommend `writeFence` first and the legacy
shape second.
