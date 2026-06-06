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
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { createStore, defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows");

const graph = defineGraph({
  id: "social",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const sqlite = new Database(":memory:");
const db = drizzle(sqlite);
sqlite.exec(generateSqliteMigrationSQL());

const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

const alice = await store.nodes.Person.create({ name: "Alice" });
const bob = await store.nodes.Person.create({ name: "Bob" });
await store.edges.knows.create(alice, bob);
```

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
- surface property and delete/modify conflicts in a `MergeReport`;
- expose report-only provenance, with optional sidecar persistence.

It lives in the core package because the primitive is defined over TypeGraph
stores, schemas, indexes, backends, and ontology semantics rather than as a
separate product surface.

Docs: [Graph Merge](https://typegraph.dev/graph-merge)

Example: [FHIR Graph Merge](https://typegraph.dev/examples/fhir-graph-merge)

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
