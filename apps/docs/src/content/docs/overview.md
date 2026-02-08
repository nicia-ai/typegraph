---
title: What is TypeGraph?
description: A TypeScript-first embedded knowledge graph library
---

TypeGraph is a **TypeScript-first, embedded knowledge graph library** that brings property graph semantics and
ontological reasoning to applications using standard relational databases. Rather than introducing a separate graph
database, TypeGraph lives inside your application as a library, storing graph data in your existing SQLite or
PostgreSQL database.

## Architecture

![TypeGraph Architecture: Your application imports TypeGraph as a library dependency. TypeGraph uses Drizzle ORM to store graph data (nodes, edges, schema, ontology) in your existing SQLite or PostgreSQL database. No separate graph database required.](../../assets/typegraph-architecture.svg)

## Core Capabilities

### 1. Type-Driven Schema Definition

Zod schemas are the single source of truth. From one schema definition, TypeGraph derives:

- Runtime validation rules
- TypeScript types (inferred, not duplicated)
- Database storage requirements
- Query builder type constraints

```typescript
const Person = defineNode("Person", {
  schema: z.object({
    fullName: z.string().min(1),
    email: z.string().email().optional(),
    dateOfBirth: z.date().optional(),
  }),
});
```

### 2. Semantic Layer with Ontological Reasoning

Type-level relationships enable sophisticated inference:

| Relationship   | Meaning                                   | Use Case               |
| -------------- | ----------------------------------------- | ---------------------- |
| `subClassOf`   | Instance inheritance (Podcast IS-A Media) | Query expansion        |
| `broader`      | Hierarchical concept (ML broader than DL) | Topic navigation       |
| `equivalentTo` | Same concept, different name              | Cross-system mapping   |
| `disjointWith` | Cannot be both (Person ≠ Organization)    | Constraint validation  |
| `implies`      | Edge entailment (marriedTo implies knows) | Relationship inference |
| `inverseOf`    | Edge pairs (manages/managedBy)            | Bidirectional queries  |

### 3. Self-Describing Schema (Homoiconic)

The schema and ontology are stored in the database as data, enabling:

- Runtime schema introspection
- Versioned schema history
- Self-describing exports and backups
- Migration tooling

### 4. Type-Safe Query Compilation

Queries compile to an AST before targeting SQL:

- Consistent semantics across SQLite and PostgreSQL
- Type-checked at compile time
- Query results have inferred types

## Design Philosophy

### Embedded, Not External

TypeGraph is a library dependency, not a networked service. TypeGraph initializes with your application, uses your
database connection, and requires no separate deployment.

### Schema-First, Type-Driven

Define your schemas once with Zod, and TypeGraph handles validation, type inference, and storage.
No duplicate type definitions or manual synchronization.

### Explicit Over Implicit

TypeGraph favors explicit declarations:

- Relationships are declared, not inferred from foreign keys
- Semantic relationships are explicit in the ontology
- Cascade behavior is configured, not assumed

### Portable Abstractions

The query builder generates portable ASTs that can target different SQL dialects.
The same query code works with SQLite and PostgreSQL.

## What TypeGraph Is Not

TypeGraph deliberately excludes:

- **Graph algorithms**: No built-in shortest path, PageRank, or community detection
- **Distributed storage**: Single-database deployment only

These exclusions keep TypeGraph focused and maintainable.

Note: TypeGraph **does support** semantic search via database vector extensions
(pgvector for PostgreSQL, sqlite-vec for SQLite). See [Semantic Search](/semantic-search) for details.

Note: TypeGraph does support **variable-length paths** via `.recursive()` with
configurable depth limits (`.minHops()`, `.maxHops()`), path collection, and
cycle detection. See [Recursive Traversals](/queries/recursive) for details.

## Why TypeGraph?

### Compared to Graph Databases (Neo4j, Amazon Neptune)

Graph databases are powerful but come with operational overhead:

| Aspect | Graph Database | TypeGraph |
|--------|---------------|-----------|
| **Deployment** | Separate service to manage, scale, and monitor | Library in your app, uses existing database |
| **Network** | Additional latency for every query | In-process, no network hop |
| **Transactions** | Separate transaction scope from your SQL data | Same ACID transaction as your other data |
| **Learning curve** | New query language (Cypher, Gremlin) | TypeScript you already know |
| **Graph algorithms** | Built-in (PageRank, shortest path) | Not included |
| **Scale** | Optimized for billions of nodes | Best for thousands to millions |

**Choose TypeGraph** when your graph is part of your application domain (knowledge bases, org
charts, content relationships) rather than a standalone analytical system.

### Compared to ORMs (Prisma, Drizzle, TypeORM)

ORMs model relations through foreign keys, which works well for simple associations but lacks graph semantics:

| Aspect | Traditional ORM | TypeGraph |
|--------|----------------|-----------|
| **Relationships** | Foreign keys, eager/lazy loading | First-class edges with properties |
| **Traversals** | Manual joins or N+1 queries | Fluent traversal API, compiled to efficient SQL |
| **Inheritance** | Table-per-class or single-table | Semantic `subClassOf` with query expansion |
| **Constraints** | Foreign key constraints | Disjointness, cardinality, implications |
| **Schema** | Migrations alter tables | Schema versioning, JSON properties |

**Choose TypeGraph** when you need to traverse relationships, model type hierarchies, or enforce
semantic constraints beyond what foreign keys provide.

### Compared to Triple Stores (RDF, SPARQL)

Triple stores and RDF provide rich ontological modeling but have practical challenges:

| Aspect | Triple Store | TypeGraph |
|--------|-------------|-----------|
| **Type safety** | Runtime validation, stringly-typed | Full TypeScript inference |
| **Query language** | SPARQL (powerful but verbose) | TypeScript fluent API |
| **Schema** | OWL/RDFS (complex specification) | Zod schemas (familiar, composable) |
| **Integration** | Separate system, data sync required | Embedded in your app |
| **Inference** | Full reasoning engines available | Precomputed closures, practical subset |

**Choose TypeGraph** when you want ontological concepts (subclass, disjoint, implies) without the
complexity of full semantic web stack.

### The TypeGraph Sweet Spot

TypeGraph is designed for applications where:

1. **The graph is your domain model** — not a separate analytical system
2. **You already use SQL** — and don't want another database to manage
3. **Type safety matters** — you want compile-time checking, not runtime surprises
4. **Semantic relationships help** — inheritance, implications, constraints add value
5. **Scale is moderate** — thousands to millions of nodes, not billions

## When to Use TypeGraph

TypeGraph is ideal for:

- **Knowledge bases** with typed entities and relationships
- **Organizational structures** with hierarchies and roles
- **Content graphs** with topics, articles, and references
- **Domain models** requiring semantic constraints
- **RAG applications** combining graph traversal with vector search

TypeGraph is not ideal for:

- Large-scale graph analytics requiring distributed processing
- Social networks with billions of edges
- Real-time streaming graph data
- Applications requiring graph algorithms (use Neo4j or a graph library)
