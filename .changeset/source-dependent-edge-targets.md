---
"@nicia-ai/typegraph": minor
---

Define source-dependent edge targets with a `to` map, such as `from: [Employee, Student]` with `to: { Employee: [Department], Student: [Course] }`. This allows one edge kind to connect specific source/target pairs without admitting every combination. Array-valued `to` declarations retain their existing Cartesian-product behavior.

Allowed pairs are preserved in typed writes, runtime validation, schema serialization, imports, graph merges, and runtime graph extensions. Invalid pairs produce `EndpointPairError`, removing allowed pairs is a breaking schema change, and ontology compatibility checks account for the pair relationship. See [source-dependent targets](https://typegraph.dev/core-concepts#source-dependent-targets) for examples and lifecycle rules.
