/**
 * Example 07: Delete Behaviors
 *
 * This example demonstrates the three delete behaviors:
 * - restrict: Block deletion if edges exist (default)
 * - cascade: Delete all connected edges when node is deleted
 * - disconnect: Soft-delete edges, leaving orphan references
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineEdge,
  defineNode,
  RestrictedDeleteError,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Define Nodes with Different Delete Behaviors
// ============================================================

// Author with RESTRICT (default) - cannot delete if they have books
const Author = defineNode("Author", {
  schema: z.object({
    name: z.string(),
    bio: z.string().optional(),
  }),
});

// Book with CASCADE - deleting a book also deletes all reviews
const Book = defineNode("Book", {
  schema: z.object({
    title: z.string(),
    isbn: z.string(),
    publishedYear: z.number().int(),
  }),
});

// Review with DISCONNECT - deleting leaves orphan edges
const Review = defineNode("Review", {
  schema: z.object({
    rating: z.number().min(1).max(5),
    text: z.string(),
    reviewedAt: z.string(),
  }),
});

// Reader who writes reviews
const Reader = defineNode("Reader", {
  schema: z.object({
    name: z.string(),
    username: z.string(),
  }),
});

// ============================================================
// Define Edges
// ============================================================

const wrote = defineEdge("wrote", {
  schema: z.object({}),
});

const hasReview = defineEdge("hasReview", {
  schema: z.object({}),
});

const writtenBy = defineEdge("writtenBy", {
  schema: z.object({}),
});

// ============================================================
// Define Graph with Delete Behaviors
// ============================================================

const graph = defineGraph({
  id: "bookstore",
  nodes: {
    // Author: default restrict - must delete books first
    Author: { type: Author }, // onDelete defaults to "restrict"

    // Book: cascade - deleting book deletes its reviews
    Book: { type: Book, onDelete: "cascade" },

    // Review: disconnect - edges become orphaned
    Review: { type: Review, onDelete: "disconnect" },

    // Reader: restrict by default
    Reader: { type: Reader },
  },
  edges: {
    wrote: { type: wrote, from: [Author], to: [Book] },
    hasReview: { type: hasReview, from: [Book], to: [Review] },
    writtenBy: { type: writtenBy, from: [Review], to: [Reader] },
  },
  ontology: [],
});

// ============================================================
// Demonstrate Delete Behaviors
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Delete Behaviors Examples ===\n");

  // Create an author
  const author = await store.nodes.Author.create({
    name: "Jane Austen",
    bio: "English novelist",
  });
  console.log("Created author:", author.name);

  // Create a book
  const book = await store.nodes.Book.create({
    title: "Pride and Prejudice",
    isbn: "978-0141439518",
    publishedYear: 1813,
  });
  console.log("Created book:", book.title);

  // Create a reader
  const reader = await store.nodes.Reader.create({
    name: "Alice Reader",
    username: "alice_reads",
  });
  console.log("Created reader:", reader.name);

  // Create reviews
  const review1 = await store.nodes.Review.create({
    rating: 5,
    text: "A timeless classic!",
    reviewedAt: "2023-01-15",
  });

  const review2 = await store.nodes.Review.create({
    rating: 4,
    text: "Wonderful characters.",
    reviewedAt: "2023-02-20",
  });
  console.log("Created 2 reviews\n");

  // Connect everything - pass nodes directly
  // For edges with empty schemas, no props argument needed
  await store.edges.wrote.create(author, book);
  await store.edges.hasReview.create(book, review1);
  await store.edges.hasReview.create(book, review2);
  await store.edges.writtenBy.create(review1, reader);

  console.log("Connected: Author -> Book -> Reviews -> Reader\n");

  // ============================================================
  // Demonstrate RESTRICT (default)
  // ============================================================

  console.log("=== RESTRICT Behavior (Author) ===\n");
  console.log("Trying to delete author who has written books...");

  try {
    await store.nodes.Author.delete(author.id);
    console.log("ERROR: Should have been blocked!");
  } catch (error) {
    if (error instanceof RestrictedDeleteError) {
      console.log("Deletion BLOCKED!");
      console.log(`  Reason: ${error.message}`);
      const details = error.details as { edgeCount: number; edgeKinds: string[] };
      console.log(`  Connected edges: ${details.edgeCount}`);
      console.log(`  Edge kinds: [${details.edgeKinds.join(", ")}]`);
    } else {
      throw error;
    }
  }

  // ============================================================
  // Demonstrate CASCADE
  // ============================================================

  console.log("\n=== CASCADE Behavior (Book) ===\n");

  // First verify reviews exist
  const reviewsBefore = await store.nodes.Review.getById(review1.id);
  console.log("Review exists before book deletion:", reviewsBefore !== undefined);

  // Check edges before
  const edgesBefore = await backend.findEdgesConnectedTo({
    graphId: "bookstore",
    nodeKind: "Book",
    nodeId: book.id,
  });
  console.log("Edges connected to book:", edgesBefore.length);

  // Delete book - should cascade and delete hasReview edges
  console.log("\nDeleting book (cascade)...");
  await store.nodes.Book.delete(book.id);
  console.log("Book deleted!");

  // Check edges after
  const edgesAfter = await backend.findEdgesConnectedTo({
    graphId: "bookstore",
    nodeKind: "Book",
    nodeId: book.id,
  });
  console.log("Edges connected to book after deletion:", edgesAfter.length);

  // Reviews still exist (only edges were deleted, not target nodes)
  const reviewsAfter = await store.nodes.Review.getById(review1.id);
  console.log("Review still exists after cascade:", reviewsAfter !== undefined);

  // Now author can be deleted (no more edges)
  console.log("\nNow deleting author (no edges remain)...");
  await store.nodes.Author.delete(author.id);
  console.log("Author deleted successfully!");

  // ============================================================
  // Demonstrate DISCONNECT
  // ============================================================

  console.log("\n=== DISCONNECT Behavior (Review) ===\n");

  // Check edges to reader before
  const readerEdgesBefore = await backend.findEdgesConnectedTo({
    graphId: "bookstore",
    nodeKind: "Reader",
    nodeId: reader.id,
  });
  console.log("Edges connected to reader before:", readerEdgesBefore.length);

  // Delete review - should disconnect (soft-delete edges)
  console.log("Deleting review (disconnect)...");
  await store.nodes.Review.delete(review1.id);
  console.log("Review deleted!");

  // Edge should be soft-deleted (gone from active queries)
  const readerEdgesAfter = await backend.findEdgesConnectedTo({
    graphId: "bookstore",
    nodeKind: "Reader",
    nodeId: reader.id,
  });
  console.log("Active edges connected to reader after:", readerEdgesAfter.length);

  // Reader still exists
  const readerAfter = await store.nodes.Reader.getById(reader.id);
  console.log("Reader still exists:", readerAfter !== undefined);

  // ============================================================
  // Summary
  // ============================================================

  console.log("\n=== Delete Behavior Summary ===\n");
  console.log("RESTRICT (default):");
  console.log("  - Blocks deletion if any edges exist");
  console.log("  - Use for entities that must be cleaned up manually");
  console.log("  - Example: Authors must have books removed first\n");

  console.log("CASCADE:");
  console.log("  - Automatically deletes all connected edges");
  console.log("  - Use for aggregate roots that own their relationships");
  console.log("  - Example: Deleting a book removes its review links\n");

  console.log("DISCONNECT:");
  console.log("  - Soft-deletes edges, leaving them as historical records");
  console.log("  - Use when you need to preserve relationship history");
  console.log("  - Example: Reviews deleted but history preserved");

  console.log("\n=== Delete behaviors example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
