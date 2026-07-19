# @nicia-ai/typegraph

Type-driven embedded knowledge graph for TypeScript.

- Docs: [typegraph.dev](https://typegraph.dev)
- Repo: [github.com/nicia-ai/typegraph](https://github.com/nicia-ai/typegraph)

## Installation

```bash
npm install @nicia-ai/typegraph zod drizzle-orm better-sqlite3
```

## Quick Start

```ts
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createLocalSqliteStore } from "@nicia-ai/typegraph/sqlite/local";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows");

const graph = defineGraph({
  id: "social",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const store = await createLocalSqliteStore(graph);

const alice = await store.nodes.Person.create({ name: "Alice" });
const bob = await store.nodes.Person.create({ name: "Bob" });
await store.edges.knows.create(alice, bob);
await store.close();
```

Use the explicit `/adapters/drizzle/...` entrypoints when your application owns
the database connection or needs adapter-native transaction handles.

Schema-only packages can import the graph DSL and schema-derived types from the
Drizzle-free `@nicia-ai/typegraph/core` entrypoint. Custom backend, dialect, and
search-strategy authors can import the complete Drizzle-free contract vocabulary
from `@nicia-ai/typegraph/backend`.

See the repo README for more.

Examples: [github.com/nicia-ai/typegraph/tree/main/packages/typegraph/examples](https://github.com/nicia-ai/typegraph/tree/main/packages/typegraph/examples)

## Graph Merge

TypeGraph ships semantic graph merge as a dedicated subpath:

```ts
import { branch, merge } from "@nicia-ai/typegraph/graph-merge";
```

`branch()` creates isolated working copies over caller-provided backends, stamped
with the base graph's schema and content version. `merge()` reconciles those
branches back into a target graph with deterministic entity resolution, conflict
reporting, edge repointing, optional ontology type reconciliation, and provenance
reporting.

Use it when several agents, importers, reviewers, or local workers edit graph
state independently and the application needs one canonical result instead of an
append-only pile of duplicates. The merge pipeline can:

- resolve duplicate entities by exact unique constraints, blocking keys,
  fulltext/custom similarity, or vector/hybrid similarity;
- preserve branch-specific context by repointing edges to canonical nodes;
- surface property and delete/modify conflicts (for nodes and edges) in a
  `MergeReport`, three-way merged against base so disjoint edits compose;
- expose report-only provenance, with optional sidecar persistence you can query.

`merge()` is a snapshot merge (all branches forked from the current base);
`mergeIncremental()` additively folds a new source into a target that has already
advanced, re-discovering committed entities instead of duplicating them — the
primitive for continuous ingestion.

It lives in the core package because the primitive is defined over TypeGraph
stores, schemas, indexes, backends, and ontology semantics rather than as a
separate product surface.

Docs: [Graph Merge](https://typegraph.dev/graph-merge)

Examples: [FHIR Graph Merge](https://typegraph.dev/examples/fhir-graph-merge)
· [Incremental Merge](https://typegraph.dev/examples/incremental-merge)

## Bitemporal History

TypeGraph supports valid-time reads and opt-in recorded-time reconstruction:

- **Valid time** (`validFrom` / `validTo`, `store.asOf(T)`): when a fact is true
  in the world.
- **Recorded time** (`history: true`, `store.asOfRecorded(T)`): when the
  TypeGraph store wrote that fact down.

Together they answer what TypeGraph captured as true at a recorded commit
instant for writes that go through TypeGraph's collections. Use this for
audit trails, agent decision replay, policy effective dating, and incident
forensics.

```ts
const store = createStore(graph, backend, { history: true });

await store.nodes.Decision.create({ answer: "approve source A" });
const decisionTime = await store.recordedNow();
if (decisionTime === undefined) throw new Error("expected recorded history");

const replay = store.asOfRecorded(decisionTime);
const answer = await replay.nodes.Decision.getById(decisionId);
```

Docs: [Temporal queries](https://typegraph.dev/queries/temporal)

Examples: [Bitemporal Time Travel](https://typegraph.dev/examples/bitemporal-time-travel)
· [Agent Decision Replay](https://typegraph.dev/examples/agent-decision-replay)
· [Breach Forensics](https://typegraph.dev/examples/breach-forensics)

## Provenance and Retraction

TypeGraph ships source-lineage retraction as a dedicated subpath:

```ts
import { createRetractionCapability } from "@nicia-ai/typegraph/provenance";
```

Map ordinary graph kinds onto source, justification, fact, premise, and
derivation roles. Retraction flips a source's boolean flag, recomputes
well-founded support, keeps facts with alternate support current, and makes
unsupported facts non-current. Source roles can cover multiple node kinds, and
terminal fact kinds do not have to be valid premises. Because the capability
requires `history: true`, recorded-time reads can replay what the graph believed
before and after the transition.

Docs: [Provenance and Retraction](https://typegraph.dev/provenance)

Example: [Provenance Retraction](https://typegraph.dev/examples/provenance-retraction)

## Performance Smoke Check

The perf harness lives in `@nicia-ai/typegraph-benchmarks`; these commands delegate to it.

Run a deterministic SQLite perf sanity suite with guardrails:

```bash
pnpm --filter @nicia-ai/typegraph test:perf
```

Run the same guardrailed suite against PostgreSQL (requires `POSTGRES_URL`):

```bash
POSTGRES_URL=postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test \
  pnpm --filter @nicia-ai/typegraph test:perf:postgres
```

For report-only mode (no pass/fail guardrails):

```bash
pnpm --filter @nicia-ai/typegraph bench:perf
```
