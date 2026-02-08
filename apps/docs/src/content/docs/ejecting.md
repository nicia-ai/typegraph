---
title: Ejecting
description: How to migrate away from TypeGraph if you need to
---

TypeGraph is designed with zero lock-in. If you decide to move on, you're left
with a clean, conventional database schema that works with any SQL tooling.

## What You're Left With

When you eject TypeGraph, your database contains two well-structured tables:

```sql
-- Your nodes
SELECT * FROM typegraph_nodes;
┌──────────┬─────────┬──────────────────┬─────────────────────────────────┐
│ kind     │ id      │ props            │ created_at                      │
├──────────┼─────────┼──────────────────┼─────────────────────────────────┤
│ Person   │ p-001   │ {"name": "Ada"}  │ 2024-01-15T10:30:00Z            │
│ Company  │ c-001   │ {"name": "Acme"} │ 2024-01-15T10:30:00Z            │
└──────────┴─────────┴──────────────────┴─────────────────────────────────┘

-- Your relationships
SELECT * FROM typegraph_edges;
┌──────────┬──────────┬─────────┬──────────┬─────────┐
│ kind     │ from_id  │ to_id   │ props    │ ...     │
├──────────┼──────────┼─────────┼──────────┼─────────┤
│ worksAt  │ p-001    │ c-001   │ {}       │ ...     │
└──────────┴──────────┴─────────┴──────────┴─────────┘
```

This is exactly the schema you'd design yourself for a flexible entity-relationship system.

## Querying Without TypeGraph

All your data is accessible with plain SQL. No special drivers, no proprietary formats.

### Find all people at a company

```sql
SELECT n.props->>'name' as person_name
FROM typegraph_nodes n
JOIN typegraph_edges e ON e.from_id = n.id
WHERE e.kind = 'worksAt'
  AND e.to_id = 'c-001'
  AND n.deleted_at IS NULL;
```

### Traverse a relationship

```sql
SELECT
  p.props->>'name' as person,
  c.props->>'name' as company
FROM typegraph_nodes p
JOIN typegraph_edges e ON e.from_id = p.id AND e.kind = 'worksAt'
JOIN typegraph_nodes c ON c.id = e.to_id
WHERE p.kind = 'Person'
  AND c.kind = 'Company'
  AND p.deleted_at IS NULL
  AND c.deleted_at IS NULL;
```

### Point-in-time query

```sql
SELECT *
FROM typegraph_nodes
WHERE kind = 'Article'
  AND valid_from <= '2024-06-01'
  AND (valid_to IS NULL OR valid_to > '2024-06-01');
```

## Using Your Own Tools

The schema works with everything in the SQL ecosystem:

- **ORMs**: Drizzle, Prisma, Knex, TypeORM, Sequelize
- **Query builders**: Kysely, Slonik
- **Raw SQL**: Any PostgreSQL or SQLite client
- **BI tools**: Metabase, Superset, Tableau
- **Migration tools**: dbmate, Flyway, Liquibase

### Example: Drizzle ORM

```typescript
import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

const nodes = pgTable("typegraph_nodes", {
  graphId: text("graph_id").notNull(),
  kind: text("kind").notNull(),
  id: text("id").notNull(),
  props: jsonb("props").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  deletedAt: timestamp("deleted_at"),
});

// Query as usual
const people = await db
  .select()
  .from(nodes)
  .where(eq(nodes.kind, "Person"));
```

### Example: Prisma

```prisma
model TypegraphNode {
  graphId   String   @map("graph_id")
  kind      String
  id        String
  props     Json
  createdAt DateTime @map("created_at")
  deletedAt DateTime? @map("deleted_at")

  @@id([graphId, kind, id])
  @@map("typegraph_nodes")
}
```

## Migration Strategies

### Option 1: Keep the schema as-is

The TypeGraph schema is production-ready. Continue using it directly with your preferred SQL tools.

### Option 2: Normalize into separate tables

If you want traditional per-entity tables:

```sql
-- Create a typed table
CREATE TABLE people AS
SELECT
  id,
  props->>'name' as name,
  props->>'email' as email,
  created_at,
  updated_at
FROM typegraph_nodes
WHERE kind = 'Person'
  AND deleted_at IS NULL;

-- Add constraints
ALTER TABLE people ADD PRIMARY KEY (id);
```

### Option 3: Create views for compatibility

Keep the original tables but add typed views:

```sql
CREATE VIEW people AS
SELECT
  id,
  props->>'name' as name,
  props->>'email' as email,
  created_at
FROM typegraph_nodes
WHERE kind = 'Person'
  AND deleted_at IS NULL;
```

## What About the Ontology?

The ontology (type hierarchies, edge constraints) exists only in your TypeScript
code. The database stores raw data without semantic constraints.

After ejecting:

- You lose automatic subclass queries (`includeSubClasses`)
- You lose edge validation (ensuring valid from/to kinds)
- You keep all your data exactly as stored

If you need these features, you'll implement them in application code—which is what any alternative would require anyway.

## Summary

TypeGraph adds a type-safe API layer over a conventional SQL schema. Remove the library and you still have:

- Standard SQL tables
- JSON properties (supported natively by SQLite and PostgreSQL)
- Full temporal history
- Soft deletes
- No proprietary formats
- No data migration required

Your data is always yours.
