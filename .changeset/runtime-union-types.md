---
"@nicia-ai/typegraph": minor
---

Add runtime discriminated union types: `AnyNode<G>`, `AnyEdge<G>`, `SubsetNode<G, K>`, `SubsetEdge<G, K>`.

These pure type-level utilities produce discriminated unions of runtime node/edge instances from a graph definition. Unlike `AllNodeTypes<G>` (union of type *definitions*), `AnyNode<G>` gives the union of runtime `Node<T>` values — discriminated by `kind` for exhaustive `switch` narrowing. `SubsetNode<G, K>` narrows the union to a specific set of kinds.
