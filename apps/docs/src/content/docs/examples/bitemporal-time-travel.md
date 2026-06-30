---
title: Bitemporal Time Travel
description: Valid time plus recorded time for corrections, effective dating, and the bitemporal 2x2
---

This example shows TypeGraph's built-in temporal history path:

- **Valid time**: when a fact is true in the world, controlled by
  `validFrom` / `validTo` and read with `store.asOf(T)`.
- **Recorded time**: when TypeGraph wrote the fact down, enabled with
  `history: true` and read with `store.asOfRecorded(T)`.

Together they let you answer the audit question a single clock cannot express
for TypeGraph-managed writes: what TypeGraph captured as true at a recorded
commit instant.

:::tip[Just want the code?]
Full source on GitHub:
[`packages/typegraph/examples/20-bitemporal-time-travel.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/20-bitemporal-time-travel.ts)
:::

## What It Demonstrates

- Recorded-time reconstruction after a correction: the invoice amount as it was
  first reported versus the amount known now.
- Valid-time effective dating: a promotion active only inside its validity
  window.
- The bitemporal 2x2: the same subscription question answered at two valid-time
  instants and two recorded-time instants.
- `store.recordedNow()` as the stable recorded-time anchor after writes.
- `store.asOf(validT).asOfRecorded(recordedT)` for independent valid and
  recorded axes.

## Run It

From the repository root:

```bash
pnpm --filter @nicia-ai/typegraph exec tsx examples/20-bitemporal-time-travel.ts
```

Or from `packages/typegraph`:

```bash
npx tsx examples/20-bitemporal-time-travel.ts
```

It uses an in-memory SQLite backend with `history: true`, so it needs no Docker
or external services.

## Core API

```typescript
const [store] = await createStoreWithSchema(graph, backend, {
  history: true,
});

const invoice = await store.nodes.Invoice.create({
  vendor: "Acme",
  amount: 1000,
});

const asReported = await store.recordedNow();
if (asReported === undefined) throw new Error("expected recorded history");

await store.nodes.Invoice.update(invoice.id, {
  vendor: "Acme",
  amount: 1250,
});

const reportedThen = await store
  .asOfRecorded(asReported)
  .nodes.Invoice.getById(invoice.id);
```

For independent axes, start from a valid-time view and add the recorded-time pin:

```typescript
const capturedOnJul15BeforeCorrection = await store
  .asOf("2024-07-15T00:00:00.000Z")
  .asOfRecorded(beforeCorrection)
  .nodes.Subscription.getById(subscriptionId);
```

Direct `store.asOfRecorded(T)` is diagonal sugar: it pins the recorded axis and
the valid-time axis to the same recorded instant. Chaining from `store.asOf(T)`
is the form to use when the domain-effective date and the TypeGraph-capture date
are different.

## Sample Output

```text
[1] Recorded time - a correction

  Invoice inv_... (vendor: Acme)

    as reported    (asOfRecorded): $1000
    as known now   (live read):    $1250

[3] Both axes - the bitemporal 2x2

    valid-time ↓ \ recorded-time ->   before correction      now
    valid May 1                     ✓ active               ✓ active
    valid Jul 15                    ✗ inactive             ✓ active
```

The Jul-15 / before-correction cell is the important one: at that valid date,
the captured graph state had the subscription already cancelled, even though you
now know it was still active.

## When to Use This Pattern

Use bitemporal reads when the difference between **truth in the domain** and
**captured TypeGraph state** matters:

- Financial restatements and audit reports
- Policy or contract effective dating
- Compliance snapshots generated from later-corrected data
- Support investigations where the system's earlier captured state matters

See [Temporal queries](/queries/temporal#recorded-time-bitemporal) for the full
API contract and limitations.
