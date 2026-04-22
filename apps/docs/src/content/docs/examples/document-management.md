---
title: Document Management System
description: A complete CMS example with semantic search, versioning, and access control
---

This example builds a document management system with:

- **Document hierarchy** (folders, documents, sections)
- **Semantic search** with vector embeddings
- **Version history** using temporal queries
- **Access control** with permission inheritance
- **Related documents** discovery

## Schema Definition

```typescript
import { z } from "zod";
import {
  defineNode,
  defineEdge,
  defineGraph,
  embedding,
  searchable,
  subClassOf,
  partOf,
  hasPart,
} from "@nicia-ai/typegraph";

// Base content type (abstract)
const Content = defineNode("Content", {
  schema: z.object({
    title: z.string(),
    createdBy: z.string(),
    status: z.enum(["draft", "published", "archived"]).default("draft"),
  }),
});

// Folder extends Content
const Folder = defineNode("Folder", {
  schema: z.object({
    title: z.string(),
    createdBy: z.string(),
    status: z.enum(["draft", "published", "archived"]).default("draft"),
    path: z.string(), // /engineering/specs
  }),
});

// Document extends Content
const Document = defineNode("Document", {
  schema: z.object({
    // Both fields are indexed for BM25 ranked fulltext. Combined with
    // the embedding below, this unlocks hybrid retrieval: title matches
    // (proper nouns, acronyms, terms-of-art) via BM25 plus paraphrased
    // / conceptual matches via the embedding.
    title: searchable({ language: "english" }),
    content: searchable({ language: "english" }),
    createdBy: z.string(),
    status: z.enum(["draft", "published", "archived"]).default("draft"),
    contentType: z.enum(["markdown", "html", "plaintext"]).default("markdown"),
    embedding: embedding(1536).optional(),
  }),
});

// Users and permissions
const User = defineNode("User", {
  schema: z.object({
    email: z.string().email(),
    name: z.string(),
    role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
  }),
});

const Permission = defineNode("Permission", {
  schema: z.object({
    level: z.enum(["read", "write", "admin"]),
  }),
});

// Edges
const contains = defineEdge("contains");
const relatedTo = defineEdge("relatedTo", {
  schema: z.object({
    type: z.enum(["references", "supersedes", "related"]),
    confidence: z.number().min(0).max(1).optional(),
  }),
});
const hasPermission = defineEdge("hasPermission");
const createdBy = defineEdge("createdBy");

// Graph definition
const graph = defineGraph({
  id: "document_management",
  nodes: {
    Content: { type: Content },
    Folder: {
      type: Folder,
      unique: [
        {
          name: "folder_path",
          fields: ["path"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Document: { type: Document },
    User: {
      type: User,
      unique: [
        {
          name: "user_email",
          fields: ["email"],
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
    Permission: { type: Permission },
  },
  edges: {
    contains: { type: contains, from: [Folder], to: [Folder, Document] },
    relatedTo: { type: relatedTo, from: [Document], to: [Document] },
    hasPermission: { type: hasPermission, from: [User], to: [Content] },
    createdBy: { type: createdBy, from: [Content], to: [User] },
  },
  ontology: [
    // Type hierarchy
    subClassOf(Folder, Content),
    subClassOf(Document, Content),

    // Compositional relationships
    partOf(Document, Folder),
    hasPart(Folder, Document),
  ],
});
```

## Database Setup

```typescript
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createSqliteBackend, generateSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";
import { createStore } from "@nicia-ai/typegraph";

// Initialize database with vector extension
const sqlite = new Database("documents.db");
sqliteVec.load(sqlite);
sqlite.exec(generateSqliteMigrationSQL());

const db = drizzle(sqlite);
const backend = createSqliteBackend(db);
const store = createStore(graph, backend);
```

## Core Operations

### Creating Folder Structure

```typescript
async function createFolderPath(path: string, userId: string): Promise<Node<typeof Folder>> {
  const parts = path.split("/").filter(Boolean);
  let currentPath = "";
  let parentFolder: Node<typeof Folder> | undefined;

  for (const part of parts) {
    currentPath += `/${part}`;

    // The `folder_path` unique constraint makes this atomic: concurrent
    // callers converge on one folder instead of racing to create duplicates.
    const result = await store.nodes.Folder.getOrCreateByConstraint(
      "folder_path",
      {
        title: part,
        path: currentPath,
        createdBy: userId,
        status: "published",
      },
    );

    if (result.action === "created" && parentFolder) {
      await store.edges.contains.create(parentFolder, result.node, {});
    }

    parentFolder = result.node;
  }

  return parentFolder!;
}
```

### Creating Documents with Embeddings

```typescript
import OpenAI from "openai";

const openai = new OpenAI();

async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-ada-002",
    input: text,
  });
  return response.data[0].embedding;
}

async function createDocument(
  folderId: string,
  title: string,
  content: string,
  userId: string
): Promise<Node<typeof Document>> {
  const embedding = await generateEmbedding(`${title}\n\n${content}`);

  const document = await store.nodes.Document.create({
    title,
    content,
    createdBy: userId,
    status: "draft",
    contentType: "markdown",
    embedding,
  });

  // Link to folder
  const folder = await store.nodes.Folder.getById(folderId);
  if (!folder) throw new Error(`Folder not found: ${folderId}`);
  await store.edges.contains.create(folder, document, {});

  // Link to creator
  const user = await store.nodes.User.getById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);
  await store.edges.createdBy.create(document, user, {});

  return document;
}
```

### Updating Documents (Versioned)

```typescript
async function updateDocument(
  documentId: string,
  updates: { title?: string; content?: string; status?: "draft" | "published" | "archived" }
): Promise<Node<typeof Document>> {
  const current = await store.nodes.Document.getById(documentId);
  if (!current) throw new Error(`Document not found: ${documentId}`);

  // If content changed, regenerate embedding
  let embedding = current.embedding;
  if (updates.content && updates.content !== current.content) {
    const text = `${updates.title ?? current.title}\n\n${updates.content}`;
    embedding = await generateEmbedding(text);
  }

  // Update creates a new version automatically
  return store.nodes.Document.update(documentId, {
    ...updates,
    embedding,
  });
}
```

## Searching Documents

Document search is the canonical hybrid-retrieval use case. Users search
for proper nouns, project names, and quoted phrases that embeddings
smooth over, plus conceptual questions that keyword search alone
can't answer. This example shows both sides.

### Semantic Search

Embedding-only search is still useful when the query is a paraphrase or
a question rather than a set of keywords:

```typescript
async function searchDocumentsSemantically(
  query: string,
  options: {
    folderId?: string;
    status?: "draft" | "published" | "archived";
    limit?: number;
    minScore?: number;
  } = {}
): Promise<DocumentProps[]> {
  const { folderId, status = "published", limit = 10, minScore = 0.7 } = options;

  const queryEmbedding = await generateEmbedding(query);

  let queryBuilder = store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.embedding
        .similarTo(queryEmbedding, limit, { metric: "cosine", minScore })
        .and(d.status.eq(status)),
    );

  // If folderId specified, filter to folder descendants
  if (folderId) {
    queryBuilder = store
      .query()
      .from("Folder", "f")
      .whereNode("f", (f) => f.id.eq(folderId))
      .traverse("contains", "e")
      .recursive()
      .to("Document", "d")
      .whereNode("d", (d) =>
        d.embedding
          .similarTo(queryEmbedding, limit, { metric: "cosine", minScore })
          .and(d.status.eq(status)),
      );
  }

  // Results are already ordered by similarity (most similar first).
  return queryBuilder.select((ctx) => ctx.d).execute();
}
```

### Fulltext Search (BM25 with snippets)

When the user types a proper noun, filename, or exact phrase, keyword
search outperforms embeddings — and snippets give them a preview of
where the match occurred:

```typescript
async function findDocumentsByKeyword(
  query: string,
  options: { limit?: number } = {},
): Promise<Array<{ document: DocumentProps; score: number; snippet?: string }>> {
  const hits = await store.search.fulltext("Document", {
    query,
    limit: options.limit ?? 10,
    includeSnippets: true,
  });

  return hits.map((hit) => ({
    document: hit.node,
    score: hit.score,
    snippet: hit.snippet,
  }));
}
```

### Hybrid Search (the production-grade path)

Most document-search products want both signals. `store.search.hybrid()`
runs fulltext + vector in parallel and fuses the rankings with RRF.
Each hit carries sub-scores from each half for debugging:

```typescript
async function searchDocuments(
  query: string,
  options: {
    status?: "draft" | "published" | "archived";
    limit?: number;
  } = {},
): Promise<Array<{ document: DocumentProps; score: number; snippet?: string }>> {
  const { status = "published", limit = 10 } = options;
  const queryEmbedding = await generateEmbedding(query);

  const hits = await store.search.hybrid("Document", {
    limit,
    vector: {
      fieldPath: "embedding",
      queryEmbedding,
      metric: "cosine",
      k: limit * 4,
    },
    fulltext: {
      query,
      k: limit * 4,
      includeSnippets: true,
    },
    fusion: { method: "rrf", k: 60 },
  });

  return hits
    .filter((hit) => hit.node.status === status)
    .map((hit) => ({
      document: hit.node,
      score: hit.score,
      snippet: hit.fulltext?.snippet,
    }));
}
```

### Folder-Scoped Hybrid Search (query builder path)

For tighter composition — "only within this folder subtree, using hybrid
retrieval" — `$fulltext.matches()` and `.similarTo()` combine in one
query-builder statement. The fusion runs at the SQL layer:

```typescript
async function searchInFolder(
  folderId: string,
  query: string,
  limit = 10,
): Promise<DocumentProps[]> {
  const queryEmbedding = await generateEmbedding(query);

  return store
    .query()
    .from("Folder", "f")
    .whereNode("f", (f) => f.id.eq(folderId))
    .traverse("contains", "e")
    .recursive()
    .to("Document", "d")
    .whereNode("d", (d) =>
      d.$fulltext
        .matches(query, limit * 4)
        .and(d.embedding.similarTo(queryEmbedding, limit * 4))
        .and(d.status.eq("published")),
    )
    .fuseWith({ k: 60 })
    .select((ctx) => ctx.d)
    .limit(limit)
    .execute();
}
```

### Find Related Documents

```typescript
async function findRelatedDocuments(
  documentId: string,
  limit = 5
): Promise<Array<{ document: DocumentProps; relationship: string }>> {
  // First, get explicit relationships
  const explicit = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.id.eq(documentId))
    .traverse("relatedTo", "e")
    .to("Document", "related")
    .select((ctx) => ({
      document: ctx.related,
      relationship: ctx.e.type,
    }))
    .execute();

  // Then, find semantically similar documents
  const source = await store.nodes.Document.getById(documentId);
  if (!source) throw new Error(`Document not found: ${documentId}`);
  if (!source.embedding) {
    return explicit;
  }

  const similar = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) =>
      d.embedding
        .similarTo(source.embedding!, limit * 2, { metric: "cosine", minScore: 0.8 })
        .and(d.id.neq(documentId))
    )
    .select((ctx) => ({
      document: ctx.d,
      relationship: "similar" as const,
    }))
    .limit(limit)
    .execute();

  return [...explicit, ...similar].slice(0, limit);
}
```

## Version History

### Get Document History

```typescript
interface DocumentVersion {
  title: string;
  content: string;
  status: string;
  validFrom: string;
  validTo: string | undefined;
  version: number;
}

async function getDocumentHistory(documentId: string): Promise<DocumentVersion[]> {
  return store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) => d.id.eq(documentId))
    .orderBy((ctx) => ctx.d.validFrom, "desc")
    .select((ctx) => ({
      title: ctx.d.title,
      content: ctx.d.content,
      status: ctx.d.status,
      validFrom: ctx.d.validFrom,
      validTo: ctx.d.validTo,
      version: ctx.d.version,
    }))
    .execute();
}
```

### View Document at Point in Time

```typescript
async function getDocumentAsOf(
  documentId: string,
  timestamp: Date
): Promise<DocumentProps | undefined> {
  return store
    .query()
    .from("Document", "d")
    .temporal("asOf", timestamp.toISOString())
    .whereNode("d", (d) => d.id.eq(documentId))
    .select((ctx) => ctx.d)
    .first();
}
```

### Compare Versions

```typescript
async function compareVersions(
  documentId: string,
  version1: number,
  version2: number
): Promise<{ before: DocumentProps; after: DocumentProps } | undefined> {
  const versions = await store
    .query()
    .from("Document", "d")
    .temporal("includeEnded")
    .whereNode("d", (d) =>
      d.id.eq(documentId).and(d.version.in([version1, version2]))
    )
    .orderBy((ctx) => ctx.d.version, "asc")
    .select((ctx) => ctx.d)
    .execute();

  if (versions.length !== 2) return undefined;

  return { before: versions[0], after: versions[1] };
}
```

## Access Control

### Check Read Permission

```typescript
async function canRead(userId: string, contentId: string): Promise<boolean> {
  // Check direct permission
  const directPermission = await store
    .query()
    .from("User", "u")
    .whereNode("u", (u) => u.id.eq(userId))
    .traverse("hasPermission", "p")
    .to("Content", "c", { includeSubClasses: true })
    .whereNode("c", (c) => c.id.eq(contentId))
    .first();

  if (directPermission) return true;

  // Check inherited permission (from parent folders)
  const content = await store.nodes.Content.getById(contentId);
  if (!content) return false;

  // Walk up the folder tree checking permissions
  const parentFolders = await store
    .query()
    .from("Folder", "f")
    .traverse("contains", "e")
    .recursive()
    .to("Content", "c", { includeSubClasses: true })
    .whereNode("c", (c) => c.id.eq(contentId))
    .select((ctx) => ctx.f.id)
    .execute();

  for (const folderId of parentFolders) {
    const folderPermission = await store
      .query()
      .from("User", "u")
      .whereNode("u", (u) => u.id.eq(userId))
      .traverse("hasPermission", "p")
      .to("Folder", "f")
      .whereNode("f", (f) => f.id.eq(folderId))
      .first();

    if (folderPermission) return true;
  }

  return false;
}
```

### Grant Permission

```typescript
async function grantPermission(
  userId: string,
  contentId: string,
  level: "read" | "write" | "admin"
): Promise<void> {
  const user = await store.nodes.User.getById(userId);
  if (!user) throw new Error(`User not found: ${userId}`);
  const content = await store.nodes.Content.getById(contentId);
  if (!content) throw new Error(`Content not found: ${contentId}`);

  // Create permission node
  const permission = await store.nodes.Permission.create({ level });

  // Link user to content via permission
  await store.edges.hasPermission.create(user, content, {});
}
```

## Folder Navigation

### Get Folder Contents

```typescript
interface FolderContents {
  folders: Array<{ id: string; title: string; path: string }>;
  documents: Array<{ id: string; title: string; status: string }>;
}

async function getFolderContents(folderId: string): Promise<FolderContents> {
  const folders = await store
    .query()
    .from("Folder", "parent")
    .whereNode("parent", (f) => f.id.eq(folderId))
    .traverse("contains", "e")
    .to("Folder", "child")
    .select((ctx) => ({
      id: ctx.child.id,
      title: ctx.child.title,
      path: ctx.child.path,
    }))
    .execute();

  const documents = await store
    .query()
    .from("Folder", "parent")
    .whereNode("parent", (f) => f.id.eq(folderId))
    .traverse("contains", "e")
    .to("Document", "doc")
    .select((ctx) => ({
      id: ctx.doc.id,
      title: ctx.doc.title,
      status: ctx.doc.status,
    }))
    .execute();

  return { folders, documents };
}
```

### Get Breadcrumb Path

`store.algorithms.reachable` walks `contains` edges in reverse to collect
every ancestor folder, tagged with its depth from the starting content:

```typescript
async function getBreadcrumb(
  contentId: string
): Promise<Array<{ id: string; title: string; path: string }>> {
  const ancestors = await store.algorithms.reachable(contentId, {
    edges: ["contains"],
    direction: "in",
    excludeSource: true,
  });

  if (ancestors.length === 0) return [];

  const folderIds = ancestors
    .filter((node) => node.kind === "Folder")
    .toSorted((a, b) => b.depth - a.depth) // root first
    .map((node) => node.id);

  const folders = await store.nodes.Folder.getByIds(folderIds);
  return folders
    .filter((folder): folder is NonNullable<typeof folder> => folder !== undefined)
    .map((folder) => ({
      id: folder.id,
      title: folder.title,
      path: folder.path,
    }));
}
```

`reachable` returns `{ id, kind, depth }` — one recursive-CTE query returns
the full ancestor chain, then a single batched `getByIds` hydrates the folder
properties.

## Bulk Operations

### Move Document to Folder

```typescript
async function moveDocument(documentId: string, targetFolderId: string): Promise<void> {
  await store.transaction(async (tx) => {
    // Remove from current folder
    const currentEdge = await tx
      .query()
      .from("Folder", "f")
      .traverse("contains", "e")
      .to("Document", "d")
      .whereNode("d", (d) => d.id.eq(documentId))
      .select((ctx) => ctx.e.id)
      .first();

    if (currentEdge) {
      await tx.edges.contains.delete(currentEdge);
    }

    // Add to new folder
    const document = await tx.nodes.Document.getById(documentId);
    if (!document) throw new Error(`Document not found: ${documentId}`);
    const targetFolder = await tx.nodes.Folder.getById(targetFolderId);
    if (!targetFolder) throw new Error(`Folder not found: ${targetFolderId}`);
    await tx.edges.contains.create(targetFolder, document, {});
  });
}
```

### Bulk Archive

```typescript
async function archiveFolder(folderId: string): Promise<number> {
  // Get all documents in folder and subfolders
  const documents = await store
    .query()
    .from("Folder", "f")
    .whereNode("f", (f) => f.id.eq(folderId))
    .traverse("contains", "e")
    .recursive()
    .to("Document", "d")
    .select((ctx) => ctx.d.id)
    .execute();

  // Archive each document
  await store.transaction(async (tx) => {
    for (const docId of documents) {
      await tx.nodes.Document.update(docId, { status: "archived" });
    }
  });

  return documents.length;
}
```

## Next Steps

- [Product Catalog](/examples/product-catalog) - Categories, variants, inventory
- [Workflow Engine](/examples/workflow-engine) - State machines with approvals
- [Audit Trail](/examples/audit-trail) - Complete change tracking
