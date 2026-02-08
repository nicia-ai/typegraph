<!-- markdownlint-disable MD013 MD033 MD041 -->
<p align="center">
  <img src="apps/docs/typegraph-logo.svg" width="120" height="120" alt="TypeGraph logo">
</p>

<h1 align="center">TypeGraph</h1>

<p align="center">
  <a href="https://github.com/nicia-ai/typegraph/actions/workflows/ci.yml"><img src="https://github.com/nicia-ai/typegraph/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@nicia-ai/typegraph"><img src="https://img.shields.io/npm/v/@nicia-ai/typegraph" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>
<!-- markdownlint-enable MD013 MD033 MD041 -->

TypeScript-first embedded knowledge graph library.

TypeGraph brings property graph modeling and practical ontology support to your existing SQLite or PostgreSQL
database. Define nodes and edges with Zod, query with a fluent TypeScript API, and keep graph + app data in one
deployment.

## Why teams use it

- Keep graph data in your existing SQL database (no separate graph service)
- Model richer semantics with `subClassOf`, `implies`, `inverseOf`, and `disjointWith`
- Traverse relationships with compile-time type safety
- Start with SQLite, move to PostgreSQL without changing your graph definition

## Best fit

TypeGraph works well for:

- Knowledge graphs and RAG context modeling
- Identity/permissions and other relationship-heavy domain models
- Applications that want graph semantics without extra infrastructure

TypeGraph is not designed for:

- Distributed graph processing
- Built-in graph algorithm workloads (PageRank, shortest path, community detection)
- Billion-scale graphs requiring dedicated graph-engine performance

## Installation

```bash
npm install @nicia-ai/typegraph zod drizzle-orm better-sqlite3
npm install -D @types/better-sqlite3
```

For edge/serverless environments (D1, libsql, bun:sqlite), see the docs:
[Edge and Serverless](https://typegraph.dev/integration#edge-and-serverless).

## Quick Start

```typescript
import { z } from "zod";
import { createStore, defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";

const { backend } = createLocalSqliteBackend();

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), role: z.string().optional() }),
});
const Project = defineNode("Project", {
  schema: z.object({ name: z.string(), status: z.enum(["active", "done"]) }),
});
const worksOn = defineEdge("worksOn");

const graph = defineGraph({
  id: "my_app",
  nodes: {
    Person: { type: Person },
    Project: { type: Project },
  },
  edges: {
    worksOn: { type: worksOn, from: [Person], to: [Project] },
  },
});

const store = createStore(graph, backend);

const alice = await store.nodes.Person.create({ name: "Alice", role: "Engineer" });
const website = await store.nodes.Project.create({ name: "Website", status: "active" });
await store.edges.worksOn.create(alice, website, {});

const results = await store
  .query()
  .from("Person", "p")
  .traverse("worksOn", "e")
  .to("Project", "proj")
  .select((ctx) => ({ person: ctx.p.name, project: ctx.proj.name }))
  .execute();

console.log(results);
// [{ person: "Alice", project: "Website" }]
```

For production schema management, see:
[createStoreWithSchema](https://typegraph.dev/getting-started#store-creation-which-function-to-use).

## Learn More

- Docs: [typegraph.dev](https://typegraph.dev)
- Overview: [What is TypeGraph?](https://typegraph.dev/overview)
- Setup: [Getting Started](https://typegraph.dev/getting-started)
- Query builder: [Queries Overview](https://typegraph.dev/queries/overview)
- Application patterns: [Common Patterns](https://typegraph.dev/recipes)
- Complete examples: [packages/typegraph/examples](packages/typegraph/examples/)
- Project docs: [Testing](docs/TESTING.md), [Release Process](docs/RELEASE.md)

## License

MIT
