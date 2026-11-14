---
"@nicia-ai/typegraph": minor
---

Expose one cycle-closing return path on `EdgeAcyclicityError.details.witness` and `AcyclicityMergeConflictError.details.witness`. Witnesses identify ordered node references and stored or proposed edge ids in relation orientation, including composition and cycles through unwritten batch rows. Paths report at most 64 edges with a truncation flag. Diagnostics run only after a positive cycle verdict, leaving accepted-write reachability unchanged.
