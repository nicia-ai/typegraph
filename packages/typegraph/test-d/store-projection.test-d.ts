import { expectAssignable, expectError } from "tsd";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
  type StoreProjection,
  type TransactionContext,
} from "..";

// ============================================================
// Shared node and edge types
// ============================================================

const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});

const Chunk = defineNode("Chunk", {
  schema: z.object({ text: z.string() }),
});

const Comment = defineNode("Comment", {
  schema: z.object({ text: z.string() }),
});

const Task = defineNode("Task", {
  schema: z.object({ type: z.string() }),
});

const Label = defineNode("Label", {
  schema: z.object({ name: z.string() }),
});

const Category = defineNode("Category", {
  schema: z.object({ name: z.string() }),
});

const hasChunk = defineEdge("hasChunk", {
  from: [Document],
  to: [Chunk],
});

const aboutChunk = defineEdge("aboutChunk", {
  from: [Comment],
  to: [Chunk],
});

const createdByTask = defineEdge("createdByTask");

// ============================================================
// Graphs that share a core subgraph
// ============================================================

const reviewGraph = defineGraph({
  id: "review",
  nodes: {
    Document: { type: Document },
    Chunk: { type: Chunk },
    Comment: { type: Comment },
    Task: { type: Task },
    Label: { type: Label },
  },
  edges: {
    hasChunk: { type: hasChunk, from: [Document], to: [Chunk] },
    aboutChunk: { type: aboutChunk, from: [Comment], to: [Chunk] },
    createdByTask: { type: createdByTask, from: [Comment], to: [Task] },
    hasLabel: {
      type: defineEdge("hasLabel"),
      from: [Document],
      to: [Label],
    },
  },
});

const catalogGraph = defineGraph({
  id: "catalog",
  nodes: {
    Document: { type: Document },
    Chunk: { type: Chunk },
    Comment: { type: Comment },
    Task: { type: Task },
    Category: { type: Category },
  },
  edges: {
    hasChunk: { type: hasChunk, from: [Document], to: [Chunk] },
    aboutChunk: { type: aboutChunk, from: [Comment], to: [Chunk] },
    createdByTask: { type: createdByTask, from: [Comment], to: [Task] },
    inCategory: {
      type: defineEdge("inCategory"),
      from: [Document],
      to: [Category],
    },
  },
});

// Graph with unique constraint on a shared node
const reviewGraphWithUnique = defineGraph({
  id: "review-unique",
  nodes: {
    Document: {
      type: Document,
      unique: [
        {
          name: "title_unique",
          fields: ["title"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Chunk: { type: Chunk },
    Comment: { type: Comment },
    Task: { type: Task },
    Label: { type: Label },
  },
  edges: {
    hasChunk: { type: hasChunk, from: [Document], to: [Chunk] },
    aboutChunk: { type: aboutChunk, from: [Comment], to: [Chunk] },
    createdByTask: { type: createdByTask, from: [Comment], to: [Task] },
    hasLabel: {
      type: defineEdge("hasLabel"),
      from: [Document],
      to: [Label],
    },
  },
});

// ============================================================
// Projection type aliases
// ============================================================

type CoreStore = StoreProjection<
  typeof reviewGraph,
  "Document" | "Chunk" | "Comment" | "Task",
  "hasChunk" | "aboutChunk" | "createdByTask"
>;

type UniqueProjection = StoreProjection<
  typeof reviewGraphWithUnique,
  "Document" | "Chunk" | "Comment" | "Task",
  "hasChunk" | "aboutChunk" | "createdByTask"
>;

// ============================================================
// Same-graph assignability
// ============================================================

declare const reviewStore: Store<typeof reviewGraph>;
declare const reviewTx: TransactionContext<typeof reviewGraph>;

expectAssignable<CoreStore>(reviewStore);
expectAssignable<CoreStore>(reviewTx);

// ============================================================
// Cross-graph assignability — same projection alias, different graph
// ============================================================

declare const catalogStore: Store<typeof catalogGraph>;
declare const catalogTx: TransactionContext<typeof catalogGraph>;

expectAssignable<CoreStore>(catalogStore);
expectAssignable<CoreStore>(catalogTx);

// ============================================================
// Cross-graph assignability — constraint mismatch
// ============================================================

// Projection from graph WITH constraints, store from graph WITHOUT
declare const plainStore: Store<typeof reviewGraph>;
expectAssignable<UniqueProjection>(plainStore);

// Projection from graph WITHOUT constraints, store from graph WITH
declare const uniqueStore: Store<typeof reviewGraphWithUnique>;
expectAssignable<CoreStore>(uniqueStore);

// TransactionContext variant
declare const plainTx: TransactionContext<typeof reviewGraph>;
expectAssignable<UniqueProjection>(plainTx);

// ============================================================
// Partial projections
// ============================================================

type DocumentOnly = StoreProjection<typeof reviewGraph, "Document", never>;
type EdgesOnly = StoreProjection<typeof reviewGraph, never, "hasChunk">;
type Full = StoreProjection<
  typeof reviewGraph,
  "Document" | "Chunk" | "Comment" | "Task" | "Label",
  "hasChunk" | "aboutChunk" | "createdByTask" | "hasLabel"
>;

expectAssignable<DocumentOnly>(reviewStore);
expectAssignable<EdgesOnly>(reviewStore);
expectAssignable<Full>(reviewStore);

// ============================================================
// Invalid keys are rejected
// ============================================================

// @ts-expect-error — "Nonexistent" is not a node in reviewGraph
type _BadNode = StoreProjection<typeof reviewGraph, "Nonexistent", never>;

// @ts-expect-error — "fakeEdge" is not an edge in reviewGraph
type _BadEdge = StoreProjection<typeof reviewGraph, never, "fakeEdge">;
