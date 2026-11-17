---
"@nicia-ai/typegraph": patch
---

`store.identity.transitionsOf()` and `replay()` list the transitions of one commit in the order the commit recorded them. Transitions that share a recorded revision, such as the two a retraction records when it splits a class, were ordered by a random id, so two stores that recorded the same changes could list them in different orders, and a test or report that printed a lineage was not reproducible. The ids a commit assigns now sort in recording order. Transitions already stored keep the order they had, which was arbitrary but stable, and paging cursors are unaffected.
