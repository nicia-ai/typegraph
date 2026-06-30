---
title: Breach Forensics
description: Pin an access graph to the breach instant and traverse the real blast radius
---

This example uses bitemporal graph reconstruction for incident response. The
question after a breach is not "what can this account reach now?" It is "what
could this account reach at the moment of compromise?"

By the time the investigation starts, dangerous grants may have been revoked or
hard-deleted. A live graph can understate exposure. With `history: true`, you can
pin the access graph to the recorded breach instant and run `reachable()` over
the reconstructed graph.

:::tip[Just want the code?]
Full source on GitHub:
[`packages/typegraph/examples/22-breach-forensics.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/22-breach-forensics.ts)
:::

## What It Demonstrates

- A role/access graph with `Account -> Role -> Resource` paths.
- A dangerous `deployer -> admin` escalation edge that is later hard-deleted.
- `store.recordedNow()` as the breach-time recorded anchor.
- `store.asOfRecorded(breachTime).reachable(...)` to reconstruct the blast
  radius at compromise time.
- Point reads (`getByIds`) on the recorded view to resolve reached resources.

## Run It

From the repository root:

```bash
pnpm --filter @nicia-ai/typegraph exec tsx examples/22-breach-forensics.ts
```

Or from `packages/typegraph`:

```bash
npx tsx examples/22-breach-forensics.ts
```

## The Access Graph

```text
svc-deploy --assumes--> deployer --grants--> ci-secrets
                              |
                           escalates
                              v
                            admin --grants--> prod-db, customer-pii
```

The `escalates` edge is the dangerous misconfiguration. Incident response
removes it, but the recorded graph still knows it existed at the breach instant.

## Core API

```typescript
const breachTime = await store.recordedNow();
if (breachTime === undefined) throw new Error("expected recorded history");

await store.edges.escalates.hardDelete(overGrant.id);

const reachedAtBreach = await store
  .asOfRecorded(breachTime)
  .reachable(account.id, {
    edges: ["assumes", "escalates", "grants"],
    maxHops: 10,
  });
```

The example wraps this in a small helper that accepts either a live view or a
recorded view:

```typescript
type AccessView = Pick<
  RecordedStoreView<typeof graph>,
  "reachable" | "nodes"
>;
```

That shape matters: incident-response code can run the same traversal against
"now" and "then" without duplicating logic.

## Sample Output

```text
Reachable resources on the CURRENT graph:
  - ci-secrets     (medium)
  Looks contained - but the escalation was deleted.

Reachable resources reconstructed AT THE BREACH INSTANT:
  - ci-secrets     (medium)
  - prod-db        (high)     <- EXPOSED
  - customer-pii   (critical) <- EXPOSED
```

## When to Use This Pattern

Use bitemporal graph forensics when deleted or corrected relationships affect
the answer:

- Identity and access blast-radius analysis
- Data-sharing and entitlement investigations
- Incident timelines where cleanup changed the graph
- "Who could reach what?" reports at a historical recorded instant

See [Temporal queries](/queries/temporal#recorded-time-bitemporal) for
recorded-time constraints and [Graph Algorithms](/graph-algorithms) for
`reachable()`.
