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
    title: z.string(),
    content: z.string(),
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
    Folder: { type: Folder },
    Document: { type: Document },
    User: { type: User },
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
import { createSqliteBackend, getSqliteMigrationSQL } from "@nicia-ai/typegraph/sqlite";
import { createStore } from "@nicia-ai/typegraph";

// Initialize database with vector extension
const sqlite = new Database("documents.db");
sqliteVec.load(sqlite);
sqlite.exec(getSqliteMigrationSQL());

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

    // Check if folder exists
    let folder = await store
      .query()
      .from("Folder", "f")
      .whereNode("f", (f) => f.path.eq(currentPath))
      .select((ctx) => ctx.f)
      .first();

    if (!folder) {
      folder = await store.nodes.Folder.create({
        title: part,
        path: currentPath,
        createdBy: userId,
        status: "published",
      });

      if (parentFolder) {
        await store.edges.contains.create(parentFolder, folder, {});
      }
    }

    parentFolder = folder;
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

### Semantic Search

```typescript
async function searchDocuments(
  query: string,
  options: {
    folderId?: string;
    status?: "draft" | "published" | "archived";
    limit?: number;
    minScore?: number;
  } = {}
): Promise<Array<{ document: DocumentProps; score: number }>> {
  const { folderId, status = "published", limit = 10, minScore = 0.7 } = options;

  const queryEmbedding = await generateEmbedding(query);

  let queryBuilder = store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => {
      let pred = d.embedding.similarTo(queryEmbedding, limit, {
        metric: "cosine",
        minScore,
      });

      if (status) {
        pred = pred.and(d.status.eq(status));
      }

      return pred;
    });

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
          .and(d.status.eq(status))
      );
  }

  return queryBuilder
    .select((ctx) => ({
      document: ctx.d,
      score: ctx.d.embedding.similarity(queryEmbedding),
    }))
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

```typescript
async function getBreadcrumb(
  contentId: string
): Promise<Array<{ id: string; title: string; path: string }>> {
  return store
    .query()
    .from("Content", "c", { includeSubClasses: true })
    .whereNode("c", (c) => c.id.eq(contentId))
    .traverse("contains", "e", { direction: "in" })
    .recursive()
    .to("Folder", "ancestor")
    .select((ctx) => ({
      id: ctx.ancestor.id,
      title: ctx.ancestor.title,
      path: ctx.ancestor.path,
    }))
    .execute();
}
```

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
