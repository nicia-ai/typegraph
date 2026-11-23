---
"@nicia-ai/typegraph": patch
---

Two `store.withTransaction(sqlTx)` contexts built from one adapter transaction object no longer share the per-graph write lock their writes hold. A custom adapter whose `adoptTransaction` returns the same object for two adoptions used to let a write of the second context, started while a write of the first was taking the lock, skip its own acquisition. Object identity does not prove that the two contexts are one native transaction, and skipping an acquisition is only safe when they are, so each context now takes the lock itself, as two stores on one native transaction always have. Inside one native transaction the second acquisition does not wait and costs one statement. The bundled adapters return a new object per adoption and are unaffected.
