---
"@nicia-ai/typegraph": minor
---

`@nicia-ai/typegraph/graph-merge` now exports `forkedWorkingCopyStrategy`, `ForkedWorkingCopyOptions`, and `ForkHandle` — a second bundled `WorkingCopyStrategy` for `branch()`, alongside the existing `cloneWorkingCopyStrategy`. Where the clone streams the base through public interchange into a fresh backend, `forkedWorkingCopyStrategy<G, TFork>({ fork, connect })` targets a fork-capable host: `fork(baseStore)` calls the caller's own host-level fork API (a file copy, `CREATE DATABASE ... TEMPLATE`, a hosting provider's branch call) and returns a `TFork extends ForkHandle` (an optional `dispose`), and `connect(fork)` opens a `GraphBackend` on the result. The connected backend's `close` is composed with `dispose` so the working copy's single `close()` releases both the connection and the fork, and a `connect` failure disposes the fork before rethrowing.

Because the fork is expected to be byte-for-byte identical to the base, the strategy asserts `computeBaseVersion` agrees between the forked store and the base right after attaching it, and refuses with a typed `BranchError` — closing the backend first — when they disagree. Unlike a clone, a fork is never rebuilt through `exportGraphStream`/`importGraphStream`, so it preserves soft-delete tombstones, `created_at`/`updated_at`, the `version` column, and — with `history: true` — the base's recorded relations, letting a fork answer `asOfRecorded` for instants before the fork was taken.

See ["Forked working copies"](https://typegraph.dev/graph-merge#forked-working-copies) for a worked strategy and the suspend hazard on hosts that reclaim idle compute.
