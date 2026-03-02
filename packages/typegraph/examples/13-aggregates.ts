/**
 * Example 13: Aggregate Queries
 *
 * This example demonstrates SQL-style aggregation through the query builder:
 * - Basic COUNT with groupBy
 * - Multiple aggregates: SUM, AVG, MIN, MAX
 * - countDistinct for unique value counts
 * - Grouping by multiple fields
 * - groupByNode for grouping by unique nodes
 * - HAVING clauses to filter groups
 * - Combining WHERE filters with HAVING
 * - Aggregations across graph traversals
 * - Limiting aggregate results
 */
import { z } from "zod";

import {
  avg,
  count,
  countDistinct,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  havingGt,
  havingGte,
  max,
  min,
  sum,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema Definition
// ============================================================

const Book = defineNode("Book", {
  schema: z.object({
    title: z.string(),
    genre: z.string(),
    price: z.number(),
    rating: z.number().optional(),
    inStock: z.boolean(),
  }),
});

const Author = defineNode("Author", {
  schema: z.object({
    name: z.string(),
    country: z.string(),
  }),
});

const Publisher = defineNode("Publisher", {
  schema: z.object({
    name: z.string(),
  }),
});

const wrote = defineEdge("wrote");
const publishedBy = defineEdge("publishedBy");

const graph = defineGraph({
  id: "aggregate_example",
  nodes: {
    Book: { type: Book },
    Author: { type: Author },
    Publisher: { type: Publisher },
  },
  edges: {
    wrote: { type: wrote, from: [Author], to: [Book] },
    publishedBy: { type: publishedBy, from: [Book], to: [Publisher] },
  },
  ontology: [],
});

// ============================================================
// Seed Data
// ============================================================

async function seedData(store: ReturnType<typeof createStore<typeof graph>>) {
  const orwell = await store.nodes.Author.create({ name: "George Orwell", country: "UK" });
  const tolkien = await store.nodes.Author.create({ name: "J.R.R. Tolkien", country: "UK" });
  const asimov = await store.nodes.Author.create({ name: "Isaac Asimov", country: "US" });
  const leguin = await store.nodes.Author.create({ name: "Ursula K. Le Guin", country: "US" });

  const penguin = await store.nodes.Publisher.create({ name: "Penguin" });
  const harpercollins = await store.nodes.Publisher.create({ name: "HarperCollins" });
  const gnome = await store.nodes.Publisher.create({ name: "Gnome Press" });

  const books = [
    { data: { title: "1984", genre: "Fiction", price: 12.99, rating: 4.7, inStock: true }, author: orwell, publisher: penguin },
    { data: { title: "Animal Farm", genre: "Fiction", price: 9.99, rating: 4.3, inStock: true }, author: orwell, publisher: penguin },
    { data: { title: "The Hobbit", genre: "Fantasy", price: 14.99, rating: 4.8, inStock: true }, author: tolkien, publisher: harpercollins },
    { data: { title: "The Lord of the Rings", genre: "Fantasy", price: 29.99, rating: 4.9, inStock: false }, author: tolkien, publisher: harpercollins },
    { data: { title: "The Silmarillion", genre: "Fantasy", price: 18.99, rating: 4.1, inStock: true }, author: tolkien, publisher: harpercollins },
    { data: { title: "Foundation", genre: "Sci-Fi", price: 13.99, rating: 4.5, inStock: true }, author: asimov, publisher: gnome },
    { data: { title: "I, Robot", genre: "Sci-Fi", price: 11.99, rating: 4.2, inStock: false }, author: asimov, publisher: gnome },
    { data: { title: "The Left Hand of Darkness", genre: "Sci-Fi", price: 13.49, rating: 4.6, inStock: true }, author: leguin, publisher: penguin },
    { data: { title: "A Wizard of Earthsea", genre: "Fantasy", price: 11.99, rating: 4.4, inStock: true }, author: leguin, publisher: penguin },
    { data: { title: "The Dispossessed", genre: "Sci-Fi", price: 14.49, rating: 4.7, inStock: false }, author: leguin, publisher: penguin },
  ];

  for (const { data, author, publisher } of books) {
    const book = await store.nodes.Book.create(data);
    await store.edges.wrote.create(author, book);
    await store.edges.publishedBy.create(book, publisher);
  }
}

// ============================================================
// Demonstrate Aggregate Queries
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  await seedData(store);

  console.log("=== Aggregate Query Examples ===\n");

  // ============================================================
  // 1. Basic COUNT — books per genre
  // ============================================================

  console.log("--- Books per genre (COUNT) ---\n");

  const booksPerGenre = await store
    .query()
    .from("Book", "b")
    .groupBy("b", "genre")
    .aggregate({
      genre: field("b", "genre"),
      bookCount: count("b"),
    })
    .execute();

  for (const row of booksPerGenre) {
    console.log(`  ${row.genre}: ${row.bookCount} books`);
  }

  // ============================================================
  // 2. Multiple aggregates — price statistics per genre
  // ============================================================

  console.log("\n--- Price statistics per genre (SUM, AVG, MIN, MAX) ---\n");

  const priceStats = await store
    .query()
    .from("Book", "b")
    .groupBy("b", "genre")
    .aggregate({
      genre: field("b", "genre"),
      totalValue: sum("b", "price"),
      avgPrice: avg("b", "price"),
      cheapest: min("b", "price"),
      mostExpensive: max("b", "price"),
    })
    .execute();

  for (const row of priceStats) {
    console.log(`  ${row.genre}:`);
    console.log(`    Total: $${row.totalValue.toFixed(2)}`);
    console.log(`    Avg:   $${row.avgPrice.toFixed(2)}`);
    console.log(`    Range: $${row.cheapest.toFixed(2)} – $${row.mostExpensive.toFixed(2)}`);
  }

  // ============================================================
  // 3. countDistinct — unique authors per genre
  // ============================================================

  console.log("\n--- Unique authors per genre (COUNT DISTINCT) ---\n");

  // countDistinct counts unique node IDs within each group,
  // useful when joins might produce duplicates
  const authorsPerGenre = await store
    .query()
    .from("Author", "a")
    .traverse("wrote", "e")
    .to("Book", "b")
    .groupBy("b", "genre")
    .aggregate({
      genre: field("b", "genre"),
      totalBooks: count("b"),
      uniqueAuthors: countDistinct("a"),
    })
    .execute();

  for (const row of authorsPerGenre) {
    console.log(`  ${row.genre}: ${row.totalBooks} books by ${row.uniqueAuthors} authors`);
  }

  // ============================================================
  // 4. Multiple groupBy fields — genre × availability
  // ============================================================

  console.log("\n--- Books by genre and availability (multiple GROUP BY) ---\n");

  const breakdown = await store
    .query()
    .from("Book", "b")
    .groupBy("b", "genre")
    .groupBy("b", "inStock")
    .aggregate({
      genre: field("b", "genre"),
      inStock: field("b", "inStock"),
      bookCount: count("b"),
    })
    .execute();

  for (const row of breakdown) {
    const status = row.inStock ? "in stock" : "out of stock";
    console.log(`  ${row.genre} (${status}): ${row.bookCount}`);
  }

  // ============================================================
  // 5. groupByNode — books per author via traversal
  // ============================================================

  console.log("\n--- Books per author (groupByNode + traversal) ---\n");

  const booksPerAuthor = await store
    .query()
    .from("Author", "a")
    .traverse("wrote", "e")
    .to("Book", "b")
    .groupByNode("a")
    .aggregate({
      author: field("a", "name"),
      bookCount: count("b"),
      avgRating: avg("b", "rating"),
    })
    .execute();

  for (const row of booksPerAuthor) {
    console.log(`  ${row.author}: ${row.bookCount} books (avg rating: ${row.avgRating.toFixed(1)})`);
  }

  // ============================================================
  // 6. HAVING — genres with 3+ books
  // ============================================================

  console.log("\n--- Genres with 3+ books (HAVING) ---\n");

  const popularGenres = await store
    .query()
    .from("Book", "b")
    .groupBy("b", "genre")
    .having(havingGte(count("b"), 3))
    .aggregate({
      genre: field("b", "genre"),
      bookCount: count("b"),
    })
    .execute();

  for (const row of popularGenres) {
    console.log(`  ${row.genre}: ${row.bookCount} books`);
  }

  if (popularGenres.length === 0) {
    console.log("  (no genres matched)");
  }

  // ============================================================
  // 7. WHERE + HAVING — in-stock genres worth over $20
  // ============================================================

  console.log("\n--- In-stock books: genres with total value > $20 (WHERE + HAVING) ---\n");

  const valuableInStock = await store
    .query()
    .from("Book", "b")
    .whereNode("b", (b) => b.inStock.eq(true))
    .groupBy("b", "genre")
    .having(havingGt(sum("b", "price"), 20))
    .aggregate({
      genre: field("b", "genre"),
      bookCount: count("b"),
      totalValue: sum("b", "price"),
    })
    .execute();

  for (const row of valuableInStock) {
    console.log(`  ${row.genre}: ${row.bookCount} books, $${row.totalValue.toFixed(2)} total`);
  }

  // ============================================================
  // 8. Traversal aggregates — revenue per publisher
  // ============================================================

  console.log("\n--- Revenue per publisher (traversal + aggregates) ---\n");

  const publisherRevenue = await store
    .query()
    .from("Book", "b")
    .traverse("publishedBy", "e")
    .to("Publisher", "p")
    .groupByNode("p")
    .aggregate({
      publisher: field("p", "name"),
      bookCount: count("b"),
      totalRevenue: sum("b", "price"),
      avgPrice: avg("b", "price"),
      topRating: max("b", "rating"),
    })
    .execute();

  for (const row of publisherRevenue) {
    console.log(`  ${row.publisher}:`);
    console.log(`    ${row.bookCount} books, $${row.totalRevenue.toFixed(2)} total, avg $${row.avgPrice.toFixed(2)}`);
    console.log(`    Highest rating: ${row.topRating}`);
  }

  // ============================================================
  // 9. Limit on aggregate results
  // ============================================================

  console.log("\n--- Top 2 authors by book count (limit) ---\n");

  const topAuthors = await store
    .query()
    .from("Author", "a")
    .traverse("wrote", "e")
    .to("Book", "b")
    .groupByNode("a")
    .aggregate({
      author: field("a", "name"),
      bookCount: count("b"),
    })
    .limit(2)
    .execute();

  for (const row of topAuthors) {
    console.log(`  ${row.author}: ${row.bookCount} books`);
  }

  console.log("\n=== Aggregate query example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
