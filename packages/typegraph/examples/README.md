# TypeGraph Examples

Runnable examples demonstrating TypeGraph features. Each example is self-contained and can be run independently.

## Running Examples

All examples use an in-memory SQLite backend by default, requiring no external database setup.

```bash
# From the packages/typegraph directory
npx tsx examples/01-basic-usage.ts

# Or run any example directly
npx tsx examples/<example-name>.ts
```

## Examples Overview

### Core Concepts

| Example | Description |
|---------|-------------|
| [01-basic-usage.ts](./01-basic-usage.ts) | Getting started with nodes, edges, and queries |
| [02-schema-validation.ts](./02-schema-validation.ts) | Zod schema validation for nodes and edges |

### Ontology Features

| Example | Description |
|---------|-------------|
| [03-subclass-hierarchy.ts](./03-subclass-hierarchy.ts) | Type inheritance with `subClassOf` |
| [04-disjoint-constraints.ts](./04-disjoint-constraints.ts) | Mutual exclusion with `disjointWith` |
| [05-edge-implications.ts](./05-edge-implications.ts) | Edge hierarchies with `implies` |
| [06-inverse-edges.ts](./06-inverse-edges.ts) | Bidirectional relationships with `inverseOf` |
| [08-custom-ontology.ts](./08-custom-ontology.ts) | Advanced ontology features and meta-edges |

### Data Management

| Example | Description |
|---------|-------------|
| [07-delete-behaviors.ts](./07-delete-behaviors.ts) | Cascade, restrict, and disconnect on delete |
| [09-pagination-streaming.ts](./09-pagination-streaming.ts) | Cursor pagination and result streaming |

### Backend Configuration

| Example | Description |
|---------|-------------|
| [10-postgresql.ts](./10-postgresql.ts) | PostgreSQL backend setup and usage |

### Semantic Search & RAG

| Example | Description |
|---------|-------------|
| [11-semantic-search.ts](./11-semantic-search.ts) | Vector embeddings and similarity search |
| [12-knowledge-graph-rag.ts](./12-knowledge-graph-rag.ts) | Knowledge graph patterns for RAG applications |

## Prerequisites

### All Examples (except PostgreSQL)

```bash
npm install @nicia-ai/typegraph zod drizzle-orm better-sqlite3
```

### PostgreSQL Example (10-postgresql.ts)

Requires a running PostgreSQL instance:

```bash
# Using Docker
docker run -d --name typegraph-pg \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16

# Set connection URL
export POSTGRES_URL="postgresql://postgres:postgres@localhost:5432/postgres"

# Run the example
npx tsx examples/10-postgresql.ts
```

### Semantic Search with Native Vector Similarity

For native vector similarity search (`.similarTo()` predicate), you need:

**PostgreSQL with pgvector:**

```sql
CREATE EXTENSION vector;
```

**SQLite with sqlite-vec:**

```bash
npm install sqlite-vec
```

Without these extensions, embeddings are stored but similarity search must be performed manually (as shown in example 11).

## Example Structure

Each example follows a consistent pattern:

1. **Schema Definition** - Define nodes, edges, and graph structure
2. **Setup** - Create backend and store
3. **Operations** - Demonstrate CRUD and queries
4. **Cleanup** - Close backend connections

## Suggested Learning Path

1. Start with **01-basic-usage** to understand core concepts
2. Learn schema validation with **02-schema-validation**
3. Explore ontology features (03-06, 08) based on your needs
4. Understand data lifecycle with **07-delete-behaviors**
5. Learn efficient data access with **09-pagination-streaming**
6. For production, see **10-postgresql** for backend configuration
7. For AI/ML applications, see **11-semantic-search** and **12-knowledge-graph-rag**
