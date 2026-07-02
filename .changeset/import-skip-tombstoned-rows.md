---
"@nicia-ai/typegraph": patch
---

`importGraph(..., { onConflict: "update" })` now skips soft-deleted target rows
instead of failing. Import never resurrects a tombstone: a node or edge that
exists only as a tombstone counts as `skipped`, keeps its tombstone, and gets no
uniqueness/embedding/fulltext side effects (a uniqueness reservation held by a
tombstoned node would block live creates of the same value). Previously the
update path attempted a live-row update that threw and aborted the whole
import. `onUnknownProperty: "allow"` is also pinned as the fidelity-preserving
strategy: it validates known fields but persists the given properties
byte-for-byte — no transform re-application, no default injection — so an
export→import round trip cannot corrupt values whose schema transforms are not
idempotent; use `"strip"` for a normalizing import.
