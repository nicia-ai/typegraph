---
"@nicia-ai/typegraph": minor
---

Export the ontology transitive-closure utilities (`computeTransitiveClosure`, `invertClosure`, `isReachable`) from the package root. These were previously internal-only. Exposing them lets consumers reason over `subClassOf` / `equivalentTo` hierarchies — e.g. reconciling node types when merging graphs from independent sources.
