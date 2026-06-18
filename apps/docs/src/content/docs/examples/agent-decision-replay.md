---
title: Agent Decision Replay
description: Reconstruct the graph an agent actually saw and replay the same reasoning code
---

This example shows recorded-time capture as an agent-debugging tool. An agent
chooses the best source for a claim by traversing a knowledge graph and ranking
papers by citation authority. Later, the graph changes: a paper is removed and
new citations arrive. A live rerun gives a different answer, but
`store.asOfRecorded(decisionTime)` reconstructs the exact graph the agent saw.

:::tip[Just want the code?]
Full source on GitHub:
[`packages/typegraph/examples/21-agent-decision-replay.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/21-agent-decision-replay.ts)
:::

## What It Demonstrates

- `history: true` capture on a knowledge graph used by an AI agent.
- `store.recordedNow()` as the durable decision-time checkpoint.
- One reasoning function that runs unchanged against live and recorded views.
- A sealed recorded `query()` plus `degree()` graph algorithm over reconstructed
  history.
- Why live reruns cannot explain old decisions once the evidence graph changes.

## Run It

From the repository root:

```bash
pnpm --filter @nicia-ai/typegraph exec tsx examples/21-agent-decision-replay.ts
```

Or from `packages/typegraph`:

```bash
npx tsx examples/21-agent-decision-replay.ts
```

## The Reusable Shape

The agent takes a read surface, not a concrete store. A live `StoreView` and a
recorded `RecordedStoreView` both satisfy the parts it needs:

```typescript
type EvidenceView = Pick<
  RecordedStoreView<typeof graph>,
  "query" | "degree" | "nodes"
>;

async function recommendSource(view: EvidenceView, claimId: string) {
  const supporterIds = await view
    .query()
    .from("Claim", "c")
    .whereNode("c", (c) => c.id.eq(claimId))
    .traverse("supports", "e", { direction: "in" })
    .to("Paper", "p")
    .select((ctx) => ctx.p.id)
    .execute();

  const scored = await Promise.all(
    supporterIds.map(async (id) => ({
      id,
      citations: await view.degree(id, {
        edges: ["cites"],
        direction: "in",
      }),
    })),
  );

  return scored.sort((a, b) => b.citations - a.citations)[0];
}
```

At decision time, save the recorded anchor:

```typescript
const decisionTime = await store.recordedNow();
if (decisionTime === undefined) throw new Error("expected recorded history");

const original = await recommendSource(
  store.view({ mode: "current" }),
  claim.id,
);
```

During audit, replay the same code against the old graph:

```typescript
const replay = await recommendSource(
  store.asOfRecorded(decisionTime),
  claim.id,
);
```

## Sample Output

```text
Agent answers: 'best source for the claim?'

  -> Kaplan - Scaling Laws  (3 citations)
  recorded at: 2026-...

Re-run on the CURRENT graph (the evidence moved):
  -> Hoffmann - Compute-Optimal LLMs  (3 citations)
  x This is a different answer.

Replay on `store.asOfRecorded(decisionTime)` (same code):
  -> Kaplan - Scaling Laws  (3 citations)
  ok Reproduced exactly.
```

## When to Use This Pattern

Use recorded decision replay when agent output must be explainable after the
graph changes:

- Eval replay for graph-grounded agents
- Audit trails for automated decisions
- Debugging "why did the agent say this?" incidents
- Reproducible RAG and knowledge-graph experiments

See [Temporal queries](/queries/temporal#recorded-time-bitemporal) for the
recorded-time rules and [Graph Algorithms](/graph-algorithms) for `degree()`.
