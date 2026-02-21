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
