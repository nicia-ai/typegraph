/**
 * Example 03: Subclass Hierarchy
 *
 * This example demonstrates using subClassOf to create type hierarchies:
 * - Defining parent/child relationships between node kinds
 * - Query expansion to include subclasses
 * - Polymorphic edge endpoints
 */
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineEdge,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Define a Media Hierarchy
// ============================================================

// Base type for all media
const Media = defineNode("Media", {
  schema: z.object({
    title: z.string(),
    releaseYear: z.number().int(),
    rating: z.number().min(0).max(10).optional(),
  }),
});

// Movie is a subclass of Media
const Movie = defineNode("Movie", {
  schema: z.object({
    title: z.string(),
    releaseYear: z.number().int(),
    rating: z.number().min(0).max(10).optional(),
    director: z.string(),
    runtime: z.number().int().positive(), // minutes
  }),
});

// TVShow is a subclass of Media
const TVShow = defineNode("TVShow", {
  schema: z.object({
    title: z.string(),
    releaseYear: z.number().int(),
    rating: z.number().min(0).max(10).optional(),
    seasons: z.number().int().positive(),
    episodeCount: z.number().int().positive(),
  }),
});

// Documentary is a subclass of Movie (deeper hierarchy)
const Documentary = defineNode("Documentary", {
  schema: z.object({
    title: z.string(),
    releaseYear: z.number().int(),
    rating: z.number().min(0).max(10).optional(),
    director: z.string(),
    runtime: z.number().int().positive(),
    subject: z.string(),
  }),
});

// Person who can be related to media
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
  }),
});

// ============================================================
// Define Edges
// ============================================================

// A person can watch any type of media
const watched = defineEdge("watched", {
  schema: z.object({
    watchedOn: z.string().optional(),
    completed: z.boolean().default(true),
  }),
});

// A person can recommend media to another person
const recommended = defineEdge("recommended", {
  schema: z.object({
    comment: z.string().optional(),
  }),
});

// ============================================================
// Define Graph with Ontology
// ============================================================

const graph = defineGraph({
  id: "media_library",
  nodes: {
    Media: { type: Media },
    Movie: { type: Movie },
    TVShow: { type: TVShow },
    Documentary: { type: Documentary },
    Person: { type: Person },
  },
  edges: {
    // Person can watch any Media (or subclass)
    watched: { type: watched, from: [Person], to: [Media, Movie, TVShow, Documentary] },
    // Recommendation from person to person about media
    recommended: { type: recommended, from: [Person], to: [Person] },
  },
  ontology: [
    // Define the hierarchy:
    // Media
    //   ├── Movie
    //   │     └── Documentary
    //   └── TVShow
    subClassOf(Movie, Media),
    subClassOf(TVShow, Media),
    subClassOf(Documentary, Movie),
  ],
});

// ============================================================
// Demonstrate Subclass Features
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  console.log("=== Subclass Hierarchy Examples ===\n");

  // Create some media
  console.log("Creating media items...");

  const inception = await store.nodes.Movie.create({
    title: "Inception",
    releaseYear: 2010,
    rating: 8.8,
    director: "Christopher Nolan",
    runtime: 148,
  });

  const breakingBad = await store.nodes.TVShow.create({
    title: "Breaking Bad",
    releaseYear: 2008,
    rating: 9.5,
    seasons: 5,
    episodeCount: 62,
  });

  const planetEarth = await store.nodes.Documentary.create({
    title: "Planet Earth II",
    releaseYear: 2016,
    rating: 9.5,
    director: "David Attenborough",
    runtime: 300,
    subject: "Nature and Wildlife",
  });

  const theOffice = await store.nodes.TVShow.create({
    title: "The Office",
    releaseYear: 2005,
    rating: 9.0,
    seasons: 9,
    episodeCount: 201,
  });

  console.log("  Created: Inception (Movie)");
  console.log("  Created: Breaking Bad (TVShow)");
  console.log("  Created: Planet Earth II (Documentary)");
  console.log("  Created: The Office (TVShow)");

  // Create a person who watches stuff
  const alice = await store.nodes.Person.create({ name: "Alice" });

  // Alice watches various media - pass nodes directly
  await store.edges.watched.create(alice, inception, {
    watchedOn: "2023-01-15",
    completed: true,
  });

  await store.edges.watched.create(alice, planetEarth, {
    watchedOn: "2023-02-20",
    completed: true,
  });

  await store.edges.watched.create(alice, breakingBad, {
    watchedOn: "2023-03-01",
    completed: false,
  });

  console.log("\nAlice has watched several items.\n");

  // Demonstrate registry expansion
  console.log("=== Registry Subclass Expansion ===\n");

  const registry = store.registry;

  console.log("Expanding 'Media' includes:");
  const mediaExpanded = registry.expandSubClasses("Media");
  for (const kind of mediaExpanded) {
    console.log(`  - ${kind}`);
  }

  console.log("\nExpanding 'Movie' includes:");
  const movieExpanded = registry.expandSubClasses("Movie");
  for (const kind of movieExpanded) {
    console.log(`  - ${kind}`);
  }

  console.log("\nExpanding 'Documentary' includes:");
  const docExpanded = registry.expandSubClasses("Documentary");
  for (const kind of docExpanded) {
    console.log(`  - ${kind}`);
  }

  // Query with subclass expansion
  console.log("\n=== Query with Subclass Expansion ===\n");

  // This query finds all Movies (including Documentaries) Alice watched
  console.log("Query: All Movies Alice watched (includeSubClasses: true)");
  const moviesWatched = await store
    .query()
    .from("Person", "p")
    .traverse("watched", "w")
    .to("Movie", "m", { includeSubClasses: true })
    .select((ctx) => ({
      person: ctx.p.name,
      title: ctx.m.title,
      kind: ctx.m.kind,
    }))
    .execute();

  for (const row of moviesWatched) {
    console.log(`  ${row.person} watched "${row.title}" (${row.kind})`);
  }

  // Without subclass expansion
  console.log("\nQuery: Only exact Movie type (includeSubClasses: false)");
  const exactMovies = await store
    .query()
    .from("Person", "p")
    .traverse("watched", "w")
    .to("Movie", "m", { includeSubClasses: false })
    .select((ctx) => ({
      person: ctx.p.name,
      title: ctx.m.title,
      kind: ctx.m.kind,
    }))
    .execute();

  for (const row of exactMovies) {
    console.log(`  ${row.person} watched "${row.title}" (${row.kind})`);
  }

  // Check ancestry
  console.log("\n=== Checking Ancestry ===\n");

  console.log("Is Documentary a subclass of Movie?", registry.isSubClassOf("Documentary", "Movie"));
  console.log("Is Documentary a subclass of Media?", registry.isSubClassOf("Documentary", "Media"));
  console.log("Is Movie a subclass of Documentary?", registry.isSubClassOf("Movie", "Documentary"));
  console.log("Is TVShow a subclass of Movie?", registry.isSubClassOf("TVShow", "Movie"));

  console.log("\n=== Subclass hierarchy example complete ===");

  await backend.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
