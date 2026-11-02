---
"@nicia-ai/typegraph": minor
---

Bind the match-key convergence isolation check to the graph that acquired the write fence, so a fence acquired for another graph in the same transaction session is refused rather than accepted on the session match alone.

## Breaking

- **`assertGraphCommandConvergenceIsolation(port, graphId, coordination)` takes the graph id.** The helper exported from `@nicia-ai/typegraph/backend` gains a required `graphId` argument between `port` and `coordination`. A custom command port that calls it passes the id of the graph the command targets (`command.plan.params.graphId`).
