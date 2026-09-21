---
"@nicia-ai/typegraph": patch
---

`cloneWorkingCopyStrategy` now imports with `onUnknownProperty: "allow"`, so a working copy — and therefore `branch()`, `ingestionBranch()`, and `planCandidateWriteSet()` — can be seeded from live rows that carry undeclared properties `validateStore()` already reports as healthy. Incoming candidate write-set documents remain strict. A streamed interchange abort now names the failing entity and property in the thrown message instead of wrapping only a generic abort.
