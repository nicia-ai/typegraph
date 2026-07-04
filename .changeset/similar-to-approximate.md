---
"@nicia-ai/typegraph": minor
---

feat: `.similarTo(vector, k, { approximate: true })` — opt-in approximate retrieval for the inline vector predicate. Each declaring kind's relevance branch compiles to the engine's native ANN search form (vec0 `MATCH … k=`, libSQL `vector_top_k`, pgvector's index-eligible scan), scoped to the query's candidate nodes via the same pushdown the search facade uses, so composed predicates and traversals still constrain results. Never applied silently: the default remains the exact distance scan, and slots declared `indexType: "none"` keep it even with the opt-in.
