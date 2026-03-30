import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type NodeId,
  type StoreProjection,
} from "../src";
import { createTestBackend } from "./test-utils";

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

const hasChunk = defineEdge("hasChunk", {
  from: [Document],
  to: [Chunk],
});

const aboutChunk = defineEdge("aboutChunk", {
  from: [Comment],
  to: [Chunk],
});

const createdByTask = defineEdge("createdByTask");

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

type CoreStore = StoreProjection<
  typeof reviewGraph,
  "Document" | "Chunk" | "Comment" | "Task",
  "hasChunk" | "aboutChunk" | "createdByTask"
>;

async function addComment(
  store: CoreStore,
  chunkId: NodeId<typeof Chunk>,
  taskId: NodeId<typeof Task>,
  text: string,
) {
  const comment = await store.nodes.Comment.create({ text });
  await store.edges.aboutChunk.create(comment, { kind: "Chunk", id: chunkId });
  await store.edges.createdByTask.create(comment, {
    kind: "Task",
    id: taskId,
  });
  return comment;
}

describe("StoreProjection", () => {
  describe("runtime usage with real store", () => {
    it("helper typed against projection works with a real store", async () => {
      const backend = createTestBackend();
      const store = createStore(reviewGraph, backend);

      const document = await store.nodes.Document.create({
        title: "Test Doc",
      });
      const chunk = await store.nodes.Chunk.create({ text: "chunk text" });
      const task = await store.nodes.Task.create({ type: "review" });

      await store.edges.hasChunk.create(document, chunk);

      const comment = await addComment(store, chunk.id, task.id, "looks good");

      expect(comment.text).toBe("looks good");
      expect(comment.kind).toBe("Comment");

      const edges = await store.edges.aboutChunk.find({ to: chunk });
      expect(edges).toHaveLength(1);
    });

    it("helper typed against projection works inside a transaction", async () => {
      const backend = createTestBackend();
      const store = createStore(reviewGraph, backend);

      const chunk = await store.nodes.Chunk.create({ text: "chunk text" });
      const task = await store.nodes.Task.create({ type: "ingest" });

      await store.transaction(async (tx) => {
        const comment = await addComment(tx, chunk.id, task.id, "tx comment");
        expect(comment.text).toBe("tx comment");
      });

      const comments = await store.nodes.Comment.find();
      expect(comments).toHaveLength(1);
      expect(comments[0]?.text).toBe("tx comment");
    });

    it("helper works with a store whose graph adds unique constraints", async () => {
      const backend = createTestBackend();
      const store = createStore(reviewGraphWithUnique, backend);

      const chunk = await store.nodes.Chunk.create({ text: "chunk" });
      const task = await store.nodes.Task.create({ type: "review" });

      const comment = await addComment(store, chunk.id, task.id, "cross-graph");
      expect(comment.text).toBe("cross-graph");
    });
  });
});
