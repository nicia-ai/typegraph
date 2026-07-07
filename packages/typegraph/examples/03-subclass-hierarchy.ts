/**
 * Example 03: Subclass Hierarchy
 *
 * This example demonstrates using subClassOf to create type hierarchies:
 * - Sharing a base schema across subclasses with Zod's .extend()
 * - Polymorphic edge endpoints: runtime endpoint validation uses
 *   subsumption, so a `to: [Media]` edge accepts every subclass
 *   instance (subclasses are also listed in the declaration purely
 *   for TypeScript's benefit — see the edge definition below)
 * - Query expansion with includeSubClasses — and what it excludes
 * - Inspecting the hierarchy through the registry
 *
 * Run with:
 *   npx tsx examples/03-subclass-hierarchy.ts
 */
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import { createExampleBackend } from "./_helpers";

// ============================================================
// Define a Media Hierarchy
// ============================================================
//
// Subclass schemas must include the parent's fields. Rather than
// repeating them, extend a shared base object — this is the intended
// pattern for subclass schemas.

const mediaFields = z.object({
  title: z.string(),
  releaseYear: z.number().int(),
  rating: z.number().min(0).max(10).optional(),
});

// Base type for all media
const Media = defineNode("Media", {
  schema: mediaFields,
});

const movieFields = mediaFields.extend({
  director: z.string(),
  runtime: z.number().int().positive(), // minutes
});

// Movie is a subclass of Media
const Movie = defineNode("Movie", {
  schema: movieFields,
});

// TVShow is a subclass of Media
const TVShow = defineNode("TVShow", {
  schema: mediaFields.extend({
    seasons: z.number().int().positive(),
    episodeCount: z.number().int().positive(),
  }),
});

// Documentary is a subclass of Movie (deeper hierarchy)
const Documentary = defineNode("Documentary", {
  schema: movieFields.extend({
    subject: z.string(),
  }),
});

// Person who watches media
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
    // At runtime, `to: [Media]` alone is enough: endpoint validation
    // uses subsumption, so subClassOf makes instances of Movie,
    // TVShow, and Documentary valid targets automatically.
    //
    // The subclasses are listed anyway for TypeScript's benefit. The
    // ontology is invisible to the type system, so the declared list
    // is what lets `watched.create(alice, someMovie)` and
    // `.to("Movie", ...)` in the query builder typecheck. Omitting
    // them changes nothing at runtime — only the static types.
    watched: {
      type: watched,
      from: [Person],
      to: [Media, Movie, TVShow, Documentary],
    },
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

export async function main(): Promise<void> {
  const backend = createExampleBackend();

  try {
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

    // None of these targets has the exact kind "Media", yet all are
    // valid `watched` targets: endpoint validation accepts any
    // subclass of a declared endpoint kind.
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

    await store.edges.watched.create(alice, theOffice, {
      watchedOn: "2023-04-10",
      completed: true,
    });

    console.log(
      "\nAlice watched all four — subsumption makes every subclass of\n" +
        "Media a valid target for the watched edge.\n",
    );

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

    // Querying at the top of the hierarchy answers "what has Alice
    // watched?" without caring about concrete kinds.
    console.log("Query: All Media Alice watched (includeSubClasses: true)");
    const allWatched = await store
      .query()
      .from("Person", "p")
      .traverse("watched", "w")
      .to("Media", "m", { includeSubClasses: true })
      .select((ctx) => ({
        person: ctx.p.name,
        title: ctx.m.title,
        kind: ctx.m.kind,
      }))
      .execute();

    for (const row of allWatched) {
      console.log(`  ${row.person} watched "${row.title}" (${row.kind})`);
    }
    console.log(
      "  ^ All four items, including both TVShows — Media expands to\n" +
        "    every kind in the hierarchy.",
    );

    // Expansion follows the hierarchy, so it also excludes: a Movie
    // query pulls in Documentary but NOT TVShow, which sits on the
    // other branch under Media.
    console.log("\nQuery: All Movies Alice watched (includeSubClasses: true)");
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
    console.log(
      '  ^ "Breaking Bad" and "The Office" are excluded: TVShow is a\n' +
        "    sibling of Movie, not a subclass of it.",
    );

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
    console.log(
      '  ^ Now "Planet Earth II" drops out too: only nodes whose exact\n' +
        "    kind is Movie match.",
    );

    // Check ancestry
    console.log("\n=== Checking Ancestry ===\n");

    console.log(
      "Is Documentary a subclass of Movie?",
      registry.isSubClassOf("Documentary", "Movie"),
    );
    console.log(
      "Is Documentary a subclass of Media?",
      registry.isSubClassOf("Documentary", "Media"),
    );
    console.log(
      "Is Movie a subclass of Documentary?",
      registry.isSubClassOf("Movie", "Documentary"),
    );
    console.log(
      "Is TVShow a subclass of Movie?",
      registry.isSubClassOf("TVShow", "Movie"),
    );

    // isAssignableTo is the relation endpoint validation uses: it is
    // why a Documentary node satisfies a Media endpoint at runtime.
    console.log(
      "\nCan a Documentary target an edge endpoint declared as Media?",
      registry.isAssignableTo("Documentary", "Media"),
    );
    console.log(
      "Can a Person target an edge endpoint declared as Media?",
      registry.isAssignableTo("Person", "Media"),
    );

    console.log("\n=== Subclass hierarchy example complete ===");
  } finally {
    await backend.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
