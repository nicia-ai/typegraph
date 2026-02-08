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
import { createSqliteBackend, getSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows");

const graph = defineGraph({
  id: "social",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const sqlite = new Database(":memory:");
const db = drizzle(sqlite);
sqlite.exec(getSqliteMigrationSQL());

const backend = createSqliteBackend(db);
const store = createStore(graph, backend);

const alice = await store.nodes.Person.create({ name: "Alice" });
const bob = await store.nodes.Person.create({ name: "Bob" });
await store.edges.knows.create(alice, bob);
```

See the repo README for more.

Examples: [github.com/nicia-ai/typegraph/tree/main/packages/typegraph/examples](https://github.com/nicia-ai/typegraph/tree/main/packages/typegraph/examples)
