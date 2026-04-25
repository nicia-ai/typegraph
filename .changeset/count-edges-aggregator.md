---
"@nicia-ai/typegraph": minor
---

Add `countEdges(edgeAlias)` and `countDistinctEdges(edgeAlias)` — edge-count aggregators that skip the target-node join in the count aggregate fast path.

The default `count(targetAlias)` counts edges whose target node is currently live under the query's temporal mode, which requires joining the edges to the target node table on every aggregation. For the common "how many follow relationships does this user have?" question, that join is unnecessary work: you want to count edges, not reach through each edge to validate the target.

```typescript
import { count, countEdges, field } from "@nicia-ai/typegraph";

const result = await store
  .query()
  .from("User", "u")
  .optionalTraverse("follows", "e", { expand: "none" })
  .to("User", "target")
  .groupByNode("u")
  .aggregate({
    name: field("u", "name"),
    // Counts live edges, regardless of target-node validity.
    // Skips the typegraph_nodes join entirely — ~1.7x faster on
    // SQLite, ~1.35x on PostgreSQL at benchmark scale.
    followCount: countEdges("e"),
    // Counts edges to live targets. Keeps the target-node join
    // so the target's temporal window is honored.
    liveFollowCount: count("target"),
  })
  .execute();
```

**When to use which:**

- `count(targetAlias)` — when the semantic question is "how many of this user's follows point to a live user?" The target-node join enforces the target's `validTo` / `deleted_at` filters.
- `countEdges(edgeAlias)` — when the semantic question is "how many follow relationships does this user have?" The edge's own temporal and deletion filters are enforced; target validity is not consulted.
- `countDistinctEdges(edgeAlias)` — same semantics as `countEdges` but with `COUNT(DISTINCT ...)`. Useful under ontology-driven expansions where the same edge can appear multiple times in join output.

The two can be mixed in one aggregate. When present together, the compiler keeps the target-node join but switches it to a `LEFT JOIN` with node-side filters pushed into the `ON` clause so edge counts reflect all live edges while node counts only reflect edges to live targets.

No change to existing `count(...)` behavior. This is purely additive — code that currently uses `count("targetAlias")` continues to count live targets exactly as before.
