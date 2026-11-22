---
title: Project Structure
description: Recommended patterns for organizing TypeGraph in your codebase
---

How you organize your TypeGraph code depends on your project's size and complexity.
This guide covers recommended patterns from simple single-file setups to large multi-domain graphs.

## Small Projects

For projects with a handful of node and edge types, keep everything in two files:

```text
src/
  graph.ts          # Node/edge definitions + graph
  graph-store.ts    # Store instantiation
```

### graph.ts

Contains all definitions and exports the graph:

```typescript
import { z } from "zod";
import { defineNode, defineEdge, defineGraph, disjointWith } from "@nicia-ai/typegraph";

// Node definitions
export const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().email().optional(),
  }),
});

export const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

// Edge definitions
export const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string().optional(),
    since: z.string().optional(),
  }),
});

// Graph definition
export const graph = defineGraph({
  id: "my_app",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
  ontology: [disjointWith(Person, Company)],
});
```

### graph-store.ts

Instantiates and exports the store:

```typescript
import { createStore } from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { graph } from "./graph";

const { backend } = createLocalSqliteBackend({ path: "./data.db" });

export const store = createStore(graph, backend);
```

This separation keeps the schema definition (which is static) separate from
store instantiation (which involves runtime configuration like database paths).

Both modules export inferred types, and that works under `declaration: true`
(a library, or a project with `composite` builds) without type annotations or
extra imports; see [Declaration emit](#declaration-emit) for how, and for the
few signatures whose results you should not export by inference.

## Medium Projects

When your graph grows to 10+ node types or you want better organization, split definitions into separate files:

```text
src/graph/
  index.ts          # Re-exports + defineGraph
  nodes.ts          # All node definitions
  edges.ts          # All edge definitions
  ontology.ts       # Ontological relations
  store.ts          # Store instantiation
```

### nodes.ts

```typescript
import { z } from "zod";
import { defineNode } from "@nicia-ai/typegraph";

export const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().email().optional(),
    role: z.string().optional(),
  }),
});

export const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
    founded: z.number().optional(),
  }),
});

export const Project = defineNode("Project", {
  schema: z.object({
    name: z.string(),
    status: z.enum(["planning", "active", "completed"]),
  }),
});

// ... more node definitions
```

### edges.ts

```typescript
import { z } from "zod";
import { defineEdge } from "@nicia-ai/typegraph";

export const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string().optional(),
    since: z.string().optional(),
  }),
});

export const manages = defineEdge("manages");

export const assignedTo = defineEdge("assignedTo", {
  schema: z.object({
    assignedAt: z.string().optional(),
  }),
});

// ... more edge definitions
```

### ontology.ts

```typescript
import { subClassOf, disjointWith, inverseOf } from "@nicia-ai/typegraph";
import { Person, Company, Project } from "./nodes";
import { manages } from "./edges";

export const ontology = [
  disjointWith(Person, Company),
  disjointWith(Person, Project),
  disjointWith(Company, Project),
  // inverseOf(manages, reportsTo),
];
```

### index.ts

Combines everything into the graph definition:

```typescript
import { defineGraph } from "@nicia-ai/typegraph";
import { Person, Company, Project } from "./nodes";
import { worksAt, manages, assignedTo } from "./edges";
import { ontology } from "./ontology";

export const graph = defineGraph({
  id: "my_app",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Project: { type: Project },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
    manages: { type: manages, from: [Person], to: [Person] },
    assignedTo: { type: assignedTo, from: [Project], to: [Person] },
  },
  ontology,
});

// Re-export for convenience
export * from "./nodes";
export * from "./edges";
export { store } from "./store";
```

### store.ts

```typescript
import { createStore } from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { graph } from "./index";

const { backend } = createLocalSqliteBackend({ path: "./data.db" });

export const store = createStore(graph, backend);
```

## Large Projects

For large graphs with distinct domains, group related nodes and edges together:

```text
src/graph/
  index.ts              # Combines all domains
  store.ts              # Store instantiation
  domains/
    users.ts            # User, Profile, Team + related edges
    content.ts          # Document, Comment, Tag + related edges
    projects.ts         # Project, Task, Milestone + related edges
```

### domains/users.ts

```typescript
import { z } from "zod";
import { defineNode, defineEdge, subClassOf, disjointWith } from "@nicia-ai/typegraph";

// Nodes
export const User = defineNode("User", {
  schema: z.object({
    email: z.string().email(),
    name: z.string(),
    role: z.enum(["admin", "member", "guest"]),
  }),
});

export const Profile = defineNode("Profile", {
  schema: z.object({
    bio: z.string().optional(),
    avatarUrl: z.string().optional(),
  }),
});

export const Team = defineNode("Team", {
  schema: z.object({
    name: z.string(),
    description: z.string().optional(),
  }),
});

// Edges
export const hasProfile = defineEdge("hasProfile");
export const memberOf = defineEdge("memberOf", {
  schema: z.object({ joinedAt: z.string().optional() }),
});
export const leads = defineEdge("leads");

// Domain-specific ontology
export const usersOntology = [
  disjointWith(User, Team),
  disjointWith(User, Profile),
];

// Export for graph assembly
export const usersNodes = {
  User: { type: User },
  Profile: { type: Profile },
  Team: { type: Team },
};

export const usersEdges = {
  hasProfile: { type: hasProfile, from: [User], to: [Profile] },
  memberOf: { type: memberOf, from: [User], to: [Team] },
  leads: { type: leads, from: [User], to: [Team] },
};
```

### index.ts

Assembles domains into the final graph:

```typescript
import { defineGraph } from "@nicia-ai/typegraph";
import { usersNodes, usersEdges, usersOntology } from "./domains/users";
import { contentNodes, contentEdges, contentOntology } from "./domains/content";
import { projectsNodes, projectsEdges, projectsOntology } from "./domains/projects";

export const graph = defineGraph({
  id: "my_app",
  nodes: {
    ...usersNodes,
    ...contentNodes,
    ...projectsNodes,
  },
  edges: {
    ...usersEdges,
    ...contentEdges,
    ...projectsEdges,
  },
  ontology: [
    ...usersOntology,
    ...contentOntology,
    ...projectsOntology,
  ],
});

// Re-export types for convenience
export * from "./domains/users";
export * from "./domains/content";
export * from "./domains/projects";
export { store } from "./store";
```

## Cross-Domain Edges

When edges connect nodes from different domains, define them at the graph level:

```typescript
// index.ts
import { defineEdge } from "@nicia-ai/typegraph";
import { User } from "./domains/users";
import { Document } from "./domains/content";
import { Project } from "./domains/projects";

// Cross-domain edges
const authored = defineEdge("authored");
const assignedTo = defineEdge("assignedTo");

export const graph = defineGraph({
  // ...
  edges: {
    ...usersEdges,
    ...contentEdges,
    ...projectsEdges,
    // Cross-domain
    authored: { type: authored, from: [User], to: [Document] },
    assignedTo: { type: assignedTo, from: [User], to: [Project] },
  },
});
```

## Naming Conventions

| Element | Convention | Example |
|---------|------------|---------|
| Node definitions | PascalCase | `Person`, `Company` |
| Edge definitions | camelCase | `worksAt`, `hasAuthor` |
| Graph IDs | snake_case | `my_app`, `content_graph` |
| Files | kebab-case | `graph-store.ts`, `project-structure.ts` |
| Query aliases | short lowercase | `p`, `c`, `e1` |

## Type Exports

Export types alongside definitions for use in your application:

```typescript
// graph/nodes.ts
import { type Node, type NodeProps, type NodeId } from "@nicia-ai/typegraph";

export const Person = defineNode("Person", { /* ... */ });

// Convenience type exports
export type PersonNode = Node<typeof Person>;
export type PersonProps = NodeProps<typeof Person>;
export type PersonId = NodeId<typeof Person>;
```

This lets consumers import types directly:

```typescript
import { type PersonNode, type PersonProps } from "./graph";

function displayPerson(person: PersonNode) {
  console.log(person.name);
}

function validatePersonInput(data: unknown): PersonProps {
  return Person.schema.parse(data);
}
```

### Declaration emit

A module that imports any single TypeGraph entrypoint can export the inferred
type of what it returns (a graph, a store, a query, a fragment, a merge plan)
under `declaration: true`. Each entrypoint's declarations load the public
subpaths that export the types they name, through `/// <reference path>`
lines at the top of each entry `.d.ts`, so TypeScript writes those types as
`import("@nicia-ai/typegraph/query").…` and so on, never as a path into
`dist`. This holds under `moduleResolution` `bundler` and `node16`, with
`skipLibCheck` on or off, and for a library whose bundler (tsup or another
rollup-plugin-dts setup) rolls its declarations while keeping TypeGraph as an
external import. It does not hold under the legacy `moduleResolution: "node10"`
(`"node"`), which ignores the package's `exports`: there TypeScript names these
types through a deep path into a content-hashed `dist` file, which breaks on
the next release, so use `bundler`, `node16` or `nodenext`.

The exception is a public signature whose type names a backend-authoring
contract, which only `@nicia-ai/typegraph/backend` exports and semver does not
cover. Exporting a value whose inferred type comes from one of these
signatures still fails declaration emit with TS2742 (TS2883 on newer
TypeScript): the backend an adapter factory returns, `store.capabilities`,
the result of `query.compile()`, a fulltext or vector strategy, and the
others below. Export the value it belongs to instead (the store rather than
its backend or capabilities, the query rather than its compiled SQL), give the
export an explicit type of your own, or annotate a backend as `GraphBackend`.
The complete list, by declaration and member:

<!-- authoring-type-signatures:start -->
- `AdapterStoreReconciliation`: `withBackend` (names `AdapterBackend`)
- `BatchableQuery`: `executeOn` (names `TransactionBackend`)
- `BundledBackendCapabilityOverrides`: itself (names `BackendCapabilities`)
- `CompileQueryOptions`: `fulltextStrategy`, `recursiveTraversal`, `vectorStrategy` (names
  `FulltextStrategy`, `RecursiveTraversalVerdict`, `VectorStrategy`)
- `createAdapterStore`: itself (names `AdapterBackend`)
- `createAdapterStoreWithSchema`: itself (names `AdapterBackend`)
- `createPgvectorStrategy`: itself (names `VectorStrategy`)
- `createPostgresBackend`: itself (names `AdapterBackend`)
- `createPostgresTransactionBackend`: itself (names `AdapterBackend`)
- `createSqliteBackend`: itself (names `AdapterBackend`)
- `createVerifiedAdapterStore`: itself (names `AdapterBackend`)
- `EdgeMeta`: itself (names `EdgeRow`)
- `ExecutableAggregateQuery`: `compile`, `executeOn` (names `CompiledSelectSql`,
  `TransactionBackend`)
- `ExecutableProjectionQuery`: `compile`, `compileOneStatementBatchItem`, `executeOn` (names
  `CompiledRowsSql`, `TransactionBackend`)
- `ExecutableQuery`: `compile`, `compileNodeCandidateIds`, `executeOn` (names `CompiledSelectSql`,
  `TransactionBackend`)
- `ExecutableRelationQuery`: `compile`, `compileOneStatementBatchItem`, `executeOn` (names
  `CompiledRowsSql`, `TransactionBackend`)
- `fts5Strategy`: itself (names `FulltextStrategy`)
- `generatePostgresDDL`: itself (names `FulltextStrategy`)
- `generatePostgresDropSQL`: itself (names `FulltextStrategy`)
- `generatePostgresMigrationSQL`: itself (names `FulltextStrategy`)
- `generateSqliteDDL`: itself (names `FulltextStrategy`)
- `generateSqliteMigrationSQL`: itself (names `FulltextStrategy`)
- `GraphBackend`: every member (the backend contract; its vocabulary is exported only by
  `@nicia-ai/typegraph/backend`)
- `LibsqlBackendOptions`: `schemaProvisioning` (names `SchemaProvisioning`)
- `LibsqlBackendResult`: `backend` (names `AdapterBackend`)
- `libsqlVectorStrategy`: itself (names `VectorStrategy`)
- `LocalPgliteBackendOptions`: `fulltext`, `schemaProvisioning` (names `FulltextStrategy`,
  `SchemaProvisioning`)
- `LocalPgliteBackendResult`: `backend` (names `AdapterBackend`)
- `LocalPgliteStoreOptions`: `fulltext` (names `FulltextStrategy`)
- `LocalSqliteBackendOptions`: `fulltext`, `schemaProvisioning` (names `FulltextStrategy`,
  `SchemaProvisioning`)
- `LocalSqliteBackendResult`: `backend` (names `AdapterBackend`)
- `LocalSqliteStoreOptions`: `fulltext` (names `FulltextStrategy`)
- `NodeCandidateQuery`: `compileNodeCandidateIds` (names `CompiledSelectSql`)
- `NodeMeta`: itself, `version` (names `NodeRow`)
- `OneStatementBatchableQuery`: `compileOneStatementBatchItem` (names `CompiledSelectSql`)
- `pgvectorStrategy`: itself (names `VectorStrategy`)
- `PostgresBackendOptions`: `fulltext`, `schemaProvisioning`, `vector` (names `FulltextStrategy`,
  `SchemaProvisioning`, `VectorStrategy`)
- `postgresFenceSql`: itself (names `FenceSql`)
- `PostgresWorkingCopyOptions`: `connect` (names `VectorStrategy`)
- `RecordedReadSource`: `predicate`, `source` (names `RecordedSourceTable`, `SqlFragment`)
- `resolveGraphVectorSlots`: itself (names `VectorSlot`)
- `SqliteBackendOptions`: `fulltext`, `schemaProvisioning`, `vector` (names `FulltextStrategy`,
  `SchemaProvisioning`, `VectorStrategy`)
- `sqliteVecStrategy`: itself (names `VectorStrategy`)
- `SqlSchema`: `edgesTable`, `fulltextTable`, `identityAssertionsTable`, `identityClosureTable`,
  `identitySeparationTable`, `identityTransitionRetentionTable`, `identityTransitionsTable`,
  `nodesTable`, `recordedClockTable`, `recordedEdgesTable`, `recordedIdentityAssertionsTable`,
  `recordedNodesTable`, `revisionOriginsTable`, `tables` (names `ResolvedSqlTableNames`,
  `SqlFragment`)
- `SqlSchemaFields`: `edgesTable`, `fulltextTable`, `identityAssertionsTable`,
  `identityClosureTable`, `identitySeparationTable`, `identityTransitionRetentionTable`,
  `identityTransitionsTable`, `nodesTable`, `recordedClockTable`, `recordedEdgesTable`,
  `recordedIdentityAssertionsTable`, `recordedNodesTable`, `revisionOriginsTable`, `tables` (names
  `ResolvedSqlTableNames`, `SqlFragment`)
- `StoreCore`: `capabilities` (names `BackendCapabilities`)
- `StoreSearchContext`: `batchPointRead` (names `BATCH_POINT_READ`, `BundleVerdictOf`)
- `TransactionCollections`: `backend` (names `TransactionReadBackend`)
- `tsvectorStrategy`: itself (names `FulltextStrategy`)
- `UnionableQuery`: `compile`, `executeOn` (names `CompiledSelectSql`, `TransactionBackend`)
<!-- authoring-type-signatures:end -->

## Framework Integration

### Next.js / React Server Components

Keep the store in a server-only module:

```text
src/
  graph/
    index.ts
    store.server.ts     # Server-only store
```

```typescript
// store.server.ts
import "server-only";
import { createStore } from "@nicia-ai/typegraph";
import { graph } from "./index";
// ...
```

### Edge Runtimes (Cloudflare Workers, Vercel Edge)

Use the Drizzle backend with edge-compatible drivers:

```typescript
// graph/store.ts
import { createStore } from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { drizzle } from "drizzle-orm/d1";
import { graph } from "./index";

export function createGraphStore(env: { DB: D1Database }) {
  const db = drizzle(env.DB);
  const backend = createSqliteBackend(db);
  return createStore(graph, backend);
}
```

## Next Steps

- [Getting Started](/getting-started) - Build your first graph
- [Schemas & Types](/core-concepts) - Deep dive into node and edge definitions
- [Integration](/integration) - Database setup and Drizzle integration
