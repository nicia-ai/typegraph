---
"@nicia-ai/typegraph": minor
---

Allow `NodeCollection.updateWhere()` to take a same-graph, same-execution-target query as its candidate source. Candidate queries can use correlated cross-kind predicates without stored edges; TypeGraph forces their root-node identity projection and intersects it with existing `where` and relationship selectors before running the ordinary atomic set-update pipeline.
