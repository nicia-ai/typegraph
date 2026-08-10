---
"@nicia-ai/typegraph": patch
---

Close the write-pipeline seam: the row-work read projection is now the type
every write path actually uses. The preparation helpers, constraint and
uniqueness probes, batch validation caches and identity hooks the migrated
modules reach are re-typed off `GraphBackend | TransactionBackend` onto the
narrow handle a write frame hands out, so the counted `unfencedTarget` widening
falls from seventeen call sites to one. That one is structural rather than
migration debt — the bulk `getOrCreateByEndpoints` legs re-enter the executor
against their enclosing frame's target, and re-entry mints a session — and the
ratchet now records it as a reasoned floor with a second escape failing the
build.

Three seams are stated instead of implied along the way. `IdentityTarget` is an
explicit facet composition of what an identity statement needs (reads plus the
optional raw-statement port) rather than the whole backend union, with the
service context's `backend` named for what it is: the handle the service opens
its own write frames on. `ConstraintContext` and the uniqueness probe carry
read facets, which states in the type that no check in either module writes.
The executor's overlaid-session mint takes the READS to answer rather than a
backend to write through, so row work can no longer hand the session an
arbitrary backend. `src/store/operations/index.ts` publishes the seam
(`runWritePlan`, `WritePlan`, `WriteSession`) and still re-exports no step or
sidecar module, and the write-pipeline files come off knip's ignore list. No
public API, behavior, error type, statement or lock scope changes.
