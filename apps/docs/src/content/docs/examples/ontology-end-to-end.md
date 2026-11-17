---
title: An Ontology, End to End
description: One documentation graph where five declarations replace five pieces of application code
---

This example builds a small documentation library: documents, runbooks (a kind
of document) and the sections they are made of. It uses five ontology and edge
declarations, and for each one shows the application code it makes
unnecessary.

:::tip[Just want the code?]
Full source on GitHub:
[`packages/typegraph/examples/35-ontology-end-to-end.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/35-ontology-end-to-end.ts)
:::

## What It Demonstrates

| You declare | You stop writing |
| --- | --- |
| `subClassOf(Runbook, Document)` | an opt-in flag on every query over documents |
| `partOf(Section, Document, { via: sectionOf })` | the job that sweeps up sections of deleted documents |
| `acyclic: true` on `dependsOn` | a depth limit guarding a relation that must not loop |
| `targetCardinality: "one"` on `supersedes` | a read-then-write check that two requests can both pass |
| a tighter rule on a populated graph | a data audit run after the migration |

It closes with identity history: two records of one document are joined and
split again, and the store replays how that belief changed.

## Run It

From the repository root:

```bash
pnpm --filter @nicia-ai/typegraph exec tsx examples/35-ontology-end-to-end.ts
```

Or from `packages/typegraph`:

```bash
npx tsx examples/35-ontology-end-to-end.ts
```

## The Graph

```typescript
import {
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  subClassOf,
} from "@nicia-ai/typegraph";
import { z } from "zod";

const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});
const Runbook = defineNode("Runbook", {
  schema: z.object({ title: z.string(), service: z.string() }),
});
const Section = defineNode("Section", {
  schema: z.object({ heading: z.string() }),
});

const sectionOf = defineEdge("sectionOf");
const dependsOn = defineEdge("dependsOn");
const supersedes = defineEdge("supersedes");
const linksTo = defineEdge("linksTo");

const graph = defineGraph({
  id: "docs",
  nodes: {
    Document: { type: Document },
    Runbook: { type: Runbook },
    Section: { type: Section },
  },
  edges: {
    sectionOf: {
      type: sectionOf,
      from: [Section],
      to: [Document],
      cardinality: "one",
    },
    dependsOn: {
      type: dependsOn,
      from: [Document],
      to: [Document],
      acyclic: true,
    },
    supersedes: {
      type: supersedes,
      from: [Document],
      to: [Document],
      targetCardinality: "one",
    },
    linksTo: { type: linksTo, from: [Document], to: [Document] },
  },
  ontology: [
    subClassOf(Runbook, Document),
    partOf(Section, Document, { via: sectionOf }),
  ],
  identity: { sameIdAcrossKinds: "ignore" },
});
```

No edge mentions `Runbook`. A runbook can hold sections, depend on documents
and be superseded because it is a document.

## Core API

A query over the supertype returns its subtypes; `expansion: "exact"` asks for
the plain kind only:

```typescript
const titles = await store
  .query()
  .from("Document", "d")
  .orderBy("d", "title")
  .select((ctx) => `${ctx.d.kind}: ${ctx.d.title}`)
  .execute();
```

A delete of a whole is previewed, then guarded by the preview, so a part added
in between refuses the delete:

```typescript
const plan = await store.nodes.Runbook.planDelete(failover.id);
if (plan === undefined) throw new Error("Runbook not found");

// ...show plan.cascadedParts to a person, then:
await store.nodes.Runbook.delete(failover.id, { expect: plan });
```

A refused cycle carries the path the new edge would close:

```typescript
try {
  await store.edges.dependsOn.create(cacheFlush, overview, {}, { id: "dep-3" });
} catch (error) {
  if (!(error instanceof EdgeAcyclicityError)) throw error;
  console.log(error.details.witness?.nodes.map((node) => node.id).join(" -> "));
}
```

`EdgeAcyclicityError` and `NodeDeletePlanMismatchError` are imported from
`@nicia-ai/typegraph/errors`.

Opening the store with a graph that tightens a rule checks the stored rows
inside the schema commit:

```typescript
try {
  await createStoreWithSchema(graphWithAcyclicLinks, backend);
} catch (error) {
  if (
    error instanceof MigrationError &&
    error.details.reason === "ontology-tightening-violated"
  ) {
    console.log(error.details.violations);
  }
}
```

## Sample Output

```text
=== 1. A query over Document returns runbooks ===

[
  'Document: Architecture overview',
  'Runbook: Cache flush',
  'Runbook: Database failover'
]
[ 'Document: Architecture overview' ]

=== 2. Deleting a runbook deletes its sections ===

Section failover-1 (part of rb-failover via sectionOf)
Section failover-2 (part of rb-failover via sectionOf)
Section failover-3 (part of rb-failover via sectionOf)
3 edges removed
NodeDeletePlanMismatchError: Delete of Runbook/rb-failover no longer matches the expected plan: 1 part(s) added, 0 dropped; 1 edge id(s) added, 0 dropped.
4 sections deleted, 0 left

=== 3. A dependency that would close a loop is refused ===

Acyclicity violation: "dependsOn" edge dep-3 would close a cycle in the "dependsOn" relation (Document/doc-architecture already reaches Runbook/rb-cache-flush).
doc-architecture -> rb-incident -> rb-cache-flush
[ 'dep-1 (stored)', 'dep-2 (stored)' ]

=== 4. A document is superseded at most once ===

CardinalityError: Cardinality violation: "supersedes" targeting Document/doc-architecture allows "one" but 1 edge(s) already exist

=== 5. A new rule is checked against existing rows ===

[
  {
    family: 'edgeAcyclicity',
    relation: 'linksTo',
    edgeIds: [ 'link-1', 'link-2' ]
  }
]
[ 'Edge "linksTo" declared acyclic: true' ]

=== 6. Why are these two records the same document? ===

assert: [doc-architecture] -> [doc-architecture, wiki-architecture]
retract: [doc-architecture, wiki-architecture] -> [doc-architecture]
```

The example's `OK:` assertion lines are left out above. A split records one
transition for each class it leaves behind; both read the same from this
document's side, so the example prints one line per distinct change.

## When to Use This Pattern

The same five declarations fit any domain whose rules are about how things
relate:

- **Org charts**: reporting lines cannot loop (`acyclic`), and a person has
  one manager (`cardinality`).
- **Bills of materials**: components are deleted with their assembly
  (`partOf`), and a revision supersedes one predecessor (`targetCardinality`).
- **Permissions**: a group cannot contain itself (`acyclic`), and a service
  account is a kind of principal (`subClassOf`).
- **Agent memory**: a rule the store enforces holds for every writer,
  including one that never read the application code.

See [Ontology & Reasoning](/ontology) for each relation,
[Composition](/ontology#composition) for the cascade and its preview,
[Schema Evolution](/schema-evolution#ontology-tightenings-are-checked-against-your-data)
for tightenings, and [Identity](/identity#replay-and-identity-history) for
replay.
