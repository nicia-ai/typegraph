/**
 * Example 09: Pagination and Streaming
 *
 * This example demonstrates efficient data access patterns:
 * - Cursor-based pagination for UI pagination
 * - Forward and backward pagination
 * - Streaming for batch processing large datasets
 * - Combining pagination with graph traversals
 */
import { z } from "zod";

import { createStore, defineGraph, defineEdge, defineNode } from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema Definition
// ============================================================

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    email: z.string().email(),
    createdAt: z.string(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    publishedAt: z.string(),
    views: z.number().int().default(0),
  }),
});

const authored = defineEdge("authored");

const graph = defineGraph({
  id: "pagination_example",
  nodes: {
    User: { type: User },
    Post: { type: Post },
  },
  edges: {
    authored: { type: authored, from: [User], to: [Post] },
  },
  ontology: [],
});

// ============================================================
// Demonstrate Pagination and Streaming
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Pagination and Streaming Examples ===\n");

  // Create sample data
  console.log("Creating sample data (100 posts)...\n");

  const author = await store.nodes.User.create({
    name: "Alice Author",
    email: "alice@example.com",
    createdAt: new Date().toISOString(),
  });

  const posts: Array<{ id: string; title: string }> = [];
  for (let i = 1; i <= 100; i++) {
    const post = await store.nodes.Post.create({
      title: `Post ${i.toString().padStart(3, "0")}`,
      content: `Content for post ${i}`,
      publishedAt: new Date(Date.now() - (100 - i) * 60000).toISOString(),
      views: Math.floor(Math.random() * 1000),
    });
    posts.push({ id: post.id, title: post.title });

    await store.edges.authored.create(author, post);
  }

  // ============================================================
  // Basic Cursor Pagination
  // ============================================================

  console.log("=== Basic Cursor Pagination ===\n");

  const query = store
    .query()
    .from("Post", "p")
    .select((ctx) => ({
      id: ctx.p.id,
      title: ctx.p.title,
      views: ctx.p.views,
    }))
    .orderBy("p", "title", "asc");

  // Get first page
  const page1 = await query.paginate({ first: 10 });
  console.log("Page 1 (first 10 posts):");
  for (const post of page1.data) {
    console.log(`  - ${post.title} (${post.views} views)`);
  }
  console.log(`  hasNextPage: ${page1.hasNextPage}`);
  console.log(`  hasPrevPage: ${page1.hasPrevPage}`);

  // Get second page using the cursor
  if (page1.nextCursor) {
    console.log("\nPage 2 (next 10 posts):");
    const page2 = await query.paginate({ first: 10, after: page1.nextCursor });
    for (const post of page2.data) {
      console.log(`  - ${post.title} (${post.views} views)`);
    }
    console.log(`  hasNextPage: ${page2.hasNextPage}`);
  }

  // ============================================================
  // Backward Pagination
  // ============================================================

  console.log("\n=== Backward Pagination ===\n");

  // Get last page
  const lastPage = await query.paginate({ last: 10 });
  console.log("Last 10 posts:");
  for (const post of lastPage.data) {
    console.log(`  - ${post.title}`);
  }
  console.log(`  hasPrevPage: ${lastPage.hasPrevPage}`);

  // Go back one page
  if (lastPage.prevCursor) {
    console.log("\nPrevious 10 posts:");
    const prevPage = await query.paginate({
      last: 10,
      before: lastPage.prevCursor,
    });
    for (const post of prevPage.data) {
      console.log(`  - ${post.title}`);
    }
  }

  // ============================================================
  // Pagination with Graph Traversal
  // ============================================================

  console.log("\n=== Pagination with Graph Traversal ===\n");

  const authorPostsQuery = store
    .query()
    .from("User", "u")
    .traverse("authored", "e")
    .to("Post", "p")
    .select((ctx) => ({
      author: ctx.u.name,
      postId: ctx.p.id,
      title: ctx.p.title,
    }))
    .orderBy("p", "publishedAt", "desc");

  const authorPage = await authorPostsQuery.paginate({ first: 5 });
  console.log("Most recent 5 posts by author:");
  for (const row of authorPage.data) {
    console.log(`  - ${row.author}: "${row.title}"`);
  }

  // ============================================================
  // Streaming Large Datasets
  // ============================================================

  console.log("\n=== Streaming Large Datasets ===\n");

  const stream = store
    .query()
    .from("Post", "p")
    .select((ctx) => ({
      title: ctx.p.title,
      views: ctx.p.views,
    }))
    .orderBy("p", "views", "desc")
    .stream({ batchSize: 25 });

  console.log("Streaming all posts (sorted by views):");
  let count = 0;
  let totalViews = 0;

  for await (const post of stream) {
    count++;
    totalViews += post.views;

    // Show first 5 and last 5
    if (count <= 5) {
      console.log(`  ${count}. ${post.title} - ${post.views} views`);
    } else if (count === 6) {
      console.log("  ...");
    }
  }

  console.log(`\nProcessed ${count} posts`);
  console.log(`Total views: ${totalViews}`);
  console.log(`Average views: ${Math.round(totalViews / count)}`);

  // ============================================================
  // Streaming with Early Exit
  // ============================================================

  console.log("\n=== Streaming with Early Exit ===\n");

  const highViewsStream = store
    .query()
    .from("Post", "p")
    .select((ctx) => ({
      title: ctx.p.title,
      views: ctx.p.views,
    }))
    .orderBy("p", "views", "desc")
    .stream({ batchSize: 10 });

  console.log("Finding top 3 posts with most views:");
  let found = 0;
  for await (const post of highViewsStream) {
    console.log(`  ${found + 1}. ${post.title} - ${post.views} views`);
    found++;
    if (found >= 3) break; // Early exit - only first batch is fetched
  }

  // ============================================================
  // Comparing Pagination Strategies
  // ============================================================

  console.log("\n=== Pagination Strategy Comparison ===\n");

  console.log("Cursor Pagination (recommended):");
  console.log("  - Uses ORDER BY columns as cursor values");
  console.log("  - O(1) performance regardless of page number");
  console.log("  - Stable results even when data changes");
  console.log("  - Requires ORDER BY clause\n");

  console.log("Offset Pagination (simple but slow):");
  console.log("  - Uses LIMIT/OFFSET");
  console.log("  - O(N) performance where N = offset");
  console.log("  - Results may shift as data changes");
  console.log("  - Good for small datasets only\n");

  console.log("Streaming (for batch processing):");
  console.log("  - Uses cursor pagination internally");
  console.log("  - Processes results one at a time");
  console.log("  - Low memory usage for large datasets");
  console.log("  - Supports early exit");

  console.log("\n=== Pagination and streaming example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
