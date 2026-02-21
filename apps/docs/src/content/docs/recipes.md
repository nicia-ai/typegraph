---
title: Common Patterns
description: Short, focused patterns for common graph problems
---

Recipes are **short, focused patterns** that solve a specific problem in a few code blocks. For complete,
end-to-end implementations, see [Examples](/examples/document-management).

| Pattern | Use Case |
|---------|----------|
| [RBAC](#role-based-access-control-rbac) | Permission checks through role hierarchies |
| [Social Network](#social-network-followers--feeds) | Feeds, followers, friend recommendations |
| [Content Versioning](#content-versioning-with-history) | Temporal queries and audit trails |
| [Tagging System](#tagging-system) | Flexible categorization with tag clouds |
| [Tree Navigation](#tree-navigation) | Hierarchical menus, org charts, file systems |
| [Weighted Relationships](#weighted-relationships) | Scoring, relevance, confidence levels |
| [Soft Deletes](#soft-deletes-with-cascade) | Safe deletion with relationship cleanup |
| [Unique Constraints](#enforcing-unique-constraints) | Preventing duplicates |

## Role-Based Access Control (RBAC)

TypeGraph's traversal capabilities make it excellent for modeling permission systems, where access
can be inherited through roles or groups.

### Schema Definition

```typescript
import { z } from "zod";
import { defineNode, defineEdge, defineGraph } from "@nicia-ai/typegraph";

// 1. Define Nodes
const User = defineNode("User", {
  schema: z.object({ username: z.string() }),
});

const Role = defineNode("Role", {
  schema: z.object({ name: z.string() }),
});

const Permission = defineNode("Permission", {
  schema: z.object({ action: z.string(), resource: z.string() }),
});

const Resource = defineNode("Resource", {
  schema: z.object({ type: z.string(), externalId: z.string() }),
});

// 2. Define Edges
const hasRole = defineEdge("hasRole");
const hasPermission = defineEdge("hasPermission");
const appliesTo = defineEdge("appliesTo");

// 3. Define Graph (endpoints are specified here, not in defineEdge)
const rbacGraph = defineGraph({
  id: "rbac_system",
  nodes: {
    User: { type: User },
    Role: { type: Role },
    Permission: { type: Permission },
    Resource: { type: Resource },
  },
  edges: {
    hasRole: { type: hasRole, from: [User], to: [Role] },
    hasPermission: { type: hasPermission, from: [Role, User], to: [Permission] },
    appliesTo: { type: appliesTo, from: [Permission], to: [Resource] },
  },
});
```

### Checking Permissions

To check if a user has a specific permission, we can query for a path from the User to the
Permission, either directly or through a Role.

```typescript
async function checkPermission(userId: string, action: string, resourceId: string) {
  const result = await store
    .query()
    .from("User", "u")
    .whereNode("u", (p) => p.id.eq(userId))
    // Traverse optional roles
    .optionalTraverse("hasRole", "r_edge")
    .to("Role", "r")
    // From either User or Role, look for permissions
    .traverse("hasPermission", "p_edge")
    .to("Permission", "p")
    .whereNode("p", (p) => p.action.eq(action))
    .execute();

  return result.length > 0;
}
```

## Social Network (Followers & Feeds)

Modeling social features requires efficient handling of relationships and recursive queries for recommendations.

### Schema Definition

```typescript
const User = defineNode("User", {
  schema: z.object({ handle: z.string() }),
});

const Post = defineNode("Post", {
  schema: z.object({ content: z.string(), timestamp: z.string() }),
});

const follows = defineEdge("follows");
const authored = defineEdge("authored");

const socialGraph = defineGraph({
  id: "social",
  nodes: {
    User: { type: User },
    Post: { type: Post },
  },
  edges: {
    follows: { type: follows, from: [User], to: [User] },
    authored: { type: authored, from: [User], to: [Post] },
  },
});
```

### Generating a Feed

Retrieve posts from users that the current user follows, ordered by time.

```typescript
const feed = await store
  .query()
  .from("User", "me")
  .whereNode("me", (u) => u.id.eq(currentUserId))
  .traverse("follows", "f")
  .to("User", "author")
  .traverse("authored", "p")
  .to("Post", "post")
  .select((ctx) => ({
    author: ctx.author.handle,
    content: ctx.post.content,
    date: ctx.post.timestamp,
  }))
  .orderBy("post", "timestamp", "desc")
  .execute();
```

### Friend Recommendations

Find "Friends of Friends" that the user doesn't follow yet.

```typescript
const recommendations = await store
  .query()
  .from("User", "me")
  .whereNode("me", (u) => u.id.eq(currentUserId))
  .traverse("follows", "f1")
  .to("User", "friend")
  .traverse("follows", "f2")
  .to("User", "fof")
  // Exclude people I already follow (simplified - in practice use EXCEPT or client filtering)
  .select((ctx) => ({
    handle: ctx.fof.handle,
  }))
  .limit(10)
  .execute();
```

## Content Versioning with History

TypeGraph has built-in support for temporal data. Every node and edge tracks `valid_from` and
`valid_to` timestamps, allowing you to travel through time without complex schema changes.

### Enabling Temporal Mode

Ensure your graph definition allows for history. By default, TypeGraph uses
`temporalMode: "current"`, which only returns currently valid data.

```typescript
const cmsGraph = defineGraph({
  id: "cms",
  nodes: {
    /* ... */
  },
  edges: {
    /* ... */
  },
  defaults: {
    // This allows us to query past states
    temporalMode: "current", // Default, but can be overridden per query
  },
});
```

### Updating Content

When you update a node, TypeGraph automatically:

1. Marks the old row as valid until `now()`.
2. Inserts a new row valid from `now()`.

```typescript
// 1. Create initial version
const article = await store.nodes.Article.create({
  title: "Draft 1",
  content: "Work in progress...",
});

// 2. Update it (automatically versions)
await store.nodes.Article.update(article.id, {
  title: "Final Version",
  content: "Ready to publish!",
});
```

### Querying Past States

You can query the state of the graph as it existed at any point in time using `asOf`.

```typescript
// Get the current version (Final Version)
const current = await store
  .query()
  .from("Article", "a")
  .whereNode("a", (a) => a.id.eq(article.id))
  .select((ctx) => ctx.a)
  .execute();

// Get the version from 5 minutes ago (Draft 1)
const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

const past = await store
  .query()
  .from("Article", "a")
  .temporal("asOf", fiveMinutesAgo)
  .whereNode("a", (a) => a.id.eq(article.id))
  .select((ctx) => ctx.a)
  .execute();
```

### Audit Logs

To see the full history of changes for a specific node, you can use `includeEnded`.

```typescript
const history = await store
  .query()
  .from("Article", "a")
  .temporal("includeEnded") // Include historical rows
  .whereNode("a", (a) => a.id.eq(article.id))
  .orderBy("a", "valid_from", "desc")
  .select((ctx) => ({
    title: ctx.a.title,
    validFrom: ctx.a.valid_from,
    validTo: ctx.a.valid_to,
  }))
  .execute();
```

## Tagging System

A flexible tagging system where items can have multiple tags, and you can query by tag combinations.

### Schema

```typescript
const Item = defineNode("Item", {
  schema: z.object({ title: z.string(), type: z.string() }),
});

const Tag = defineNode("Tag", {
  schema: z.object({ name: z.string(), color: z.string().optional() }),
});

const taggedWith = defineEdge("taggedWith");

const graph = defineGraph({
  id: "tagging",
  nodes: { Item, Tag },
  edges: { taggedWith: { type: taggedWith, from: [Item], to: [Tag] } },
});
```

### Find Items by Tag

```typescript
const photoshopItems = await store
  .query()
  .from("Tag", "t")
  .whereNode("t", (t) => t.name.eq("photoshop"))
  .traverse("taggedWith", "e", { direction: "in" })
  .to("Item", "i")
  .select((ctx) => ctx.i)
  .execute();
```

### Tag Cloud (Count Items per Tag)

```typescript
import { count, field } from "@nicia-ai/typegraph";

const tagCounts = await store
  .query()
  .from("Item", "i")
  .traverse("taggedWith", "e")
  .to("Tag", "t")
  .groupBy("t", "name")
  .aggregate({
    tag: field("t", "name"),
    count: count("i"),
  })
  .execute();

// Sort by count descending
const tagCloud = tagCounts.toSorted((a, b) => b.count - a.count);
```

### Items with Multiple Tags (AND)

```typescript
// Find items tagged with BOTH "javascript" AND "tutorial"
const jsTag = await store
  .query()
  .from("Tag", "t")
  .whereNode("t", (t) => t.name.eq("javascript"))
  .select((ctx) => ctx.t)
  .first();

const tutorialTag = await store
  .query()
  .from("Tag", "t")
  .whereNode("t", (t) => t.name.eq("tutorial"))
  .select((ctx) => ctx.t)
  .first();

if (!jsTag || !tutorialTag) {
  return []; // Tags don't exist
}

const items = await store
  .query()
  .from("Item", "i")
  .traverse("taggedWith", "e1")
  .to("Tag", "t1")
  .whereNode("t1", (t) => t.id.eq(jsTag.id))
  .traverse("taggedWith", "e2", { direction: "in" })
  .to("Item", "i2")
  .traverse("taggedWith", "e3")
  .to("Tag", "t2")
  .whereNode("t2", (t) => t.id.eq(tutorialTag.id))
  .select((ctx) => ctx.i)
  .execute();
```

## Tree Navigation

Hierarchical structures like menus, org charts, or file systems.

### Schema

```typescript
const Category = defineNode("Category", {
  schema: z.object({
    name: z.string(),
    slug: z.string(),
    depth: z.number().default(0),
  }),
});

const parentOf = defineEdge("parentOf");

const graph = defineGraph({
  id: "categories",
  nodes: { Category },
  edges: { parentOf: { type: parentOf, from: [Category], to: [Category] } },
});
```

### Get All Ancestors (Breadcrumb)

```typescript
const breadcrumb = await store
  .query()
  .from("Category", "c")
  .whereNode("c", (c) => c.slug.eq("electronics/phones/iphone"))
  .traverse("parentOf", "e")
  .recursive({ path: "path" })
  .to("Category", "ancestor")
  .select((ctx) => ({
    name: ctx.ancestor.name,
    slug: ctx.ancestor.slug,
  }))
  .execute();
// Returns: [{ name: "Phones", slug: "..." }, { name: "Electronics", slug: "..." }, ...]
```

### Get All Descendants

```typescript
const allChildren = await store
  .query()
  .from("Category", "root")
  .whereNode("root", (c) => c.slug.eq("electronics"))
  .traverse("parentOf", "e", { direction: "in" })
  .recursive({ depth: "level" })
  .to("Category", "child")
  .select((ctx) => ({
    name: ctx.child.name,
    level: ctx.level,
  }))
  .orderBy((ctx) => ctx.level, "asc")
  .execute();
```

### Build a Tree Structure

```typescript
async function buildTree(rootSlug: string): Promise<TreeNode> {
  const descendants = await store
    .query()
    .from("Category", "root")
    .whereNode("root", (c) => c.slug.eq(rootSlug))
    .traverse("parentOf", "e", { direction: "in" })
    .recursive({ maxHops: 10 })
    .to("Category", "child")
    .select((ctx) => ({
      id: ctx.child.id,
      name: ctx.child.name,
      parentId: ctx.e.fromId,
    }))
    .execute();

  // Build tree in memory
  const nodeMap = new Map<string, TreeNode>();
  for (const d of descendants) {
    nodeMap.set(d.id, { ...d, children: [] });
  }
  for (const d of descendants) {
    if (d.parentId && nodeMap.has(d.parentId)) {
      nodeMap.get(d.parentId)!.children.push(nodeMap.get(d.id)!);
    }
  }
  return nodeMap.get(rootSlug)!;
}
```

## Weighted Relationships

Edges with scores for relevance, confidence, or priority.

### Schema

```typescript
const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});

const relatedTo = defineEdge("relatedTo", {
  schema: z.object({
    score: z.number().min(0).max(1),
    type: z.enum(["similar", "cites", "extends"]),
  }),
});

const graph = defineGraph({
  id: "documents",
  nodes: { Document },
  edges: { relatedTo: { type: relatedTo, from: [Document], to: [Document] } },
});
```

### Find Highly Related Documents

```typescript
const related = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) => d.id.eq(documentId))
  .traverse("relatedTo", "e")
  .to("Document", "r")
  .whereEdge("e", (e) => e.score.gte(0.8))
  .select((ctx) => ({
    title: ctx.r.title,
    score: ctx.e.score,
    type: ctx.e.type,
  }))
  .orderBy((ctx) => ctx.score, "desc")
  .execute();
```

### Aggregate Relationship Scores

```typescript
import { avg, count, field } from "@nicia-ai/typegraph";

const docStats = await store
  .query()
  .from("Document", "d")
  .traverse("relatedTo", "e")
  .to("Document", "r")
  .groupByNode("d")
  .aggregate({
    docId: field("d", "id"),
    title: field("d", "title"),
    relationCount: count("e"),
    avgScore: avg("e", "score"),
  })
  .execute();
```

## Soft Deletes with Cascade

Delete nodes while preserving relationships for undo capability.

### Mark as Deleted

```typescript
// TypeGraph uses soft deletes by default
await store.nodes.Document.delete(documentId);

// The node still exists but has deleted_at set
// Queries automatically filter it out
```

### Restore Deleted Nodes

```typescript
// upsertById "un-deletes" soft-deleted nodes
await store.nodes.Document.upsertById(documentId, {
  title: "Restored Document",
  content: "...",
});
```

### Find Deleted Nodes

```typescript
// Use temporal queries to see deleted nodes
const deletedDocs = await store
  .query()
  .from("Document", "d")
  .temporal("includeEnded")
  .whereNode("d", (d) => d.deletedAt.isNotNull())
  .select((ctx) => ({
    id: ctx.d.id,
    title: ctx.d.title,
    deletedAt: ctx.d.deletedAt,
  }))
  .execute();
```

### Cascade Delete Pattern

```typescript
async function cascadeDelete(documentId: string): Promise<void> {
  await store.transaction(async (tx) => {
    // Find all related edges
    const edges = await tx
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.id.eq(documentId))
      .traverse("relatedTo", "e")
      .to("Document", "r")
      .select((ctx) => ({ edgeId: ctx.e.id }))
      .execute();

    // Delete edges first
    for (const { edgeId } of edges) {
      await tx.edges.relatedTo.delete(edgeId);
    }

    // Then delete the node
    await tx.nodes.Document.delete(documentId);
  });
}
```

## Enforcing Unique Constraints

Prevent duplicate nodes or relationships.

### Schema-Level Uniqueness

```typescript
const User = defineNode("User", {
  schema: z.object({
    email: z.string().email(),
    username: z.string(),
  }),
});

const graph = defineGraph({
  id: "users",
  nodes: {
    User: {
      type: User,
      unique: [
        { name: "user_email", fields: ["email"], scope: "kind", collation: "caseInsensitive" },
        { name: "user_username", fields: ["username"], scope: "kind", collation: "caseSensitive" },
      ],
    },
  },
  edges: {},
});
```

### Use `getOrCreateByConstraint`

```typescript
async function createOrUpdateUserByEmail(
  email: string,
  username: string
): Promise<{
  user: Node<typeof User>;
  action: "created" | "found" | "updated" | "resurrected";
}> {
  return store.nodes.User.getOrCreateByConstraint(
    "user_email",
    { email, username },
    { ifExists: "update" }
  );
}
```

### Use `getOrCreateByEndpoints` for Edge Deduplication

```typescript
async function followUser(followerId: string, followeeId: string): Promise<void> {
  const follower = await store.nodes.User.getById(followerId);
  const followee = await store.nodes.User.getById(followeeId);
  if (!follower || !followee) {
    throw new Error("User not found");
  }

  await store.edges.follows.getOrCreateByEndpoints(
    follower,
    followee,
    {},
    { ifExists: "return" }
  );
}
```

## Next Steps

For complete, end-to-end implementations, see the [Examples](/examples/document-management) section:

- [Document Management](/examples/document-management) - CMS with semantic search
- [Product Catalog](/examples/product-catalog) - Categories, variants, inventory
- [Workflow Engine](/examples/workflow-engine) - State machines with approvals
- [Audit Trail](/examples/audit-trail) - Complete change tracking
- [Multi-Tenant SaaS](/examples/multi-tenant) - Tenant isolation patterns
