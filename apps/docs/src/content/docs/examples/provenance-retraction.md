---
title: Provenance Retraction
description: Retract bad sources, keep facts with alternate support, and replay belief changes with recorded time
---

This example shows provenance retraction on a derived knowledge graph. Distinct
source kinds support fact kinds through explicit justification nodes. When a
source is retracted, TypeGraph recomputes the well-founded support set:

- facts with alternate support stay current
- terminal facts can be derived without being valid premises themselves
- facts with no remaining support become non-current
- recorded-time reads can replay what the graph believed before and after

:::tip[Just want the code?]
Full source on GitHub:
[`packages/typegraph/examples/23-provenance-retraction.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/23-provenance-retraction.ts)
:::

## What It Demonstrates

- `@nicia-ai/typegraph/provenance` as a first-class package subpath.
- Multiple source node kinds via `source: { kinds: [...] }`.
- A terminal `DeployDecision` fact kind that is derived but is not allowed in
  `premiseOf.from`.
- `createRetractionCapability()` over a store created with `{ history: true }`.
- `holding()` for current well-founded believed facts.
- `retract()` reports where facts died or survived through alternate
  justifications.
- `store.asOfRecorded(T)` replays the fact currency before and after the
  retraction.
- `unRetract()` clears a source's retraction flag and reopens supported facts.

## Run It

From the repository root:

```bash
pnpm --filter @nicia-ai/typegraph exec tsx examples/23-provenance-retraction.ts
```

Or from `packages/typegraph`:

```bash
npx tsx examples/23-provenance-retraction.ts
```

The example uses an in-memory SQLite backend with `history: true`, so it does
not require Docker or external services.

## Graph Shape

The example models a security advisory workflow:

```text
scanner-source -> justification-scanner-finding -> vulnerability-libvector
vendor-source  -> justification-vendor-advisory -> vulnerability-libvector
vulnerability-libvector -> justification-block-deploy -> decision-block-deploy
```

`vulnerability-libvector` has two independent source-level supports.
`decision-block-deploy` depends on `vulnerability-libvector`, so it should
survive as long as the vulnerability fact still has at least one grounded
support path.

The graph is ordinary TypeGraph schema:

```typescript
const ScannerSource = defineNode("ScannerSource", {
  schema: z.object({
    title: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const VendorSource = defineNode("VendorSource", {
  schema: z.object({
    title: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Vulnerability = defineNode("Vulnerability", {
  schema: z.object({ cve: z.string(), packageName: z.string() }),
});

const DeployDecision = defineNode("DeployDecision", {
  schema: z.object({ action: z.string() }),
});
```

`DeployDecision` is terminal: it is a fact kind and a valid derivation target,
but it is not a premise kind.

```typescript
const graph = defineGraph({
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [ScannerSource, VendorSource, Vulnerability],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: [Vulnerability, DeployDecision],
    },
  },
});
```

Then the roles are mapped into provenance retraction:

```typescript
const provenance = createRetractionCapability(store, {
  source: { kinds: ["ScannerSource", "VendorSource"] },
  justification: { kind: "Justification" },
  fact: { kinds: ["Vulnerability", "DeployDecision"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
});
```

## Retraction

Retracting the scanner source does not kill the facts, because the vendor
advisory still supports `vulnerability-libvector`:

```typescript
const scannerReport = await provenance.retract(scanner);
console.log(scannerReport.survivedVia);
```

Retracting the vendor source too removes the last grounded support. The
vulnerability and deploy decision become non-current, but the recorded relation
still knows when they were believed:

```typescript
const beforeVendorRetraction = await store.recordedNow();
if (beforeVendorRetraction === undefined) throw new Error("expected history");

await provenance.retract(vendor);

const afterVendorRetraction = await store.recordedNow();
if (afterVendorRetraction === undefined) throw new Error("expected history");

const before = await store.asOfRecorded(beforeVendorRetraction).nodes.DeployDecision.getById(blockDeploy.id);

const after = await store.asOfRecorded(afterVendorRetraction).nodes.DeployDecision.getById(blockDeploy.id);
```

## Sample Output

```text
Initial derived beliefs:
  holding(): decision-block-deploy, vulnerability-libvector

Retract the unverified scanner source.
    died:        (none)
    survived:    decision-block-deploy via justification-block-deploy; vulnerability-libvector via justification-vendor-advisory
    unaffected:  (none)
  holding(): decision-block-deploy, vulnerability-libvector

Retract the vendor advisory too.
    died:        decision-block-deploy, vulnerability-libvector
    survived:    (none)
    unaffected:  (none)
  holding(): (none)

Recorded-time replay of the deploy-block fact:
  before vendor retraction: Block the production deploy
  after vendor retraction:  not current
```

## When to Use This Pattern

Use provenance retraction when derived facts must respond to source quality:

- AI memory and RAG citations where a source document is later invalidated
- security or compliance knowledge graphs with advisory retractions
- ingestion pipelines where downstream facts depend on upstream source trust
- audit workflows that need both current belief state and past belief replay

See [Provenance and Retraction](/provenance) for the API guide and
[Temporal queries](/queries/temporal#recorded-time-bitemporal) for the
recorded-time rules.
