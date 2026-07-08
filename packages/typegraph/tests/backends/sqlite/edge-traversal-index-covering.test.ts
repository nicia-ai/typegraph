/**
 * The default edge traversal indexes (`typegraph_edges_from_idx` /
 * `typegraph_edges_to_idx`) must serve a compiled traversal join fully
 * index-only, not just seek the edge and then fall back to a heap-row
 * fetch. Two gaps used to defeat this: `valid_from` was missing from both
 * indexes (one of the three system columns every compiled query's
 * soft-delete/temporal-validity predicate checks), and neither index
 * carried the *other* endpoint's id column the join itself reads
 * (`n.id = e.to_id` for an outgoing traversal, `n.id = e.from_id` for an
 * incoming one — see standard-builders.ts). Both are cheap while a table
 * fits in the page cache; once it doesn't, every uncovered column turns
 * into a random disk read per candidate row.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import type { GraphBackend } from "../../../src/backend/types";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Post = defineNode("Post", {
  schema: z.object({ content: z.string(), creationDate: z.string() }),
});
const hasCreator = defineEdge("hasCreator");

function buildGraph() {
  return defineGraph({
    id: "edge-index-covering",
    nodes: { Person: { type: Person }, Post: { type: Post } },
    edges: {
      hasCreator: { type: hasCreator, from: [Post], to: [Person] },
    },
  });
}

type CapturedStatement = Readonly<{ sql: string; params: readonly unknown[] }>;

async function withCapturingStore<T>(
  run: (
    store: ReturnType<typeof createStore<ReturnType<typeof buildGraph>>>,
    captured: CapturedStatement[],
    client: Database.Database,
  ) => Promise<T>,
): Promise<T> {
  const { backend: raw, db } = createLocalSqliteBackend();
  try {
    const captured: CapturedStatement[] = [];
    const backend: GraphBackend = {
      ...raw,
      async execute(query) {
        const compiled = raw.compileSql?.(query);
        if (compiled) {
          captured.push({ sql: compiled.sql, params: compiled.params });
        }
        return raw.execute(query);
      },
    };
    const store = createStore(buildGraph(), backend);
    const client = (db as unknown as { $client: Database.Database }).$client;
    return await run(store, captured, client);
  } finally {
    await raw.close();
  }
}

function explainPlan(
  client: Database.Database,
  statement: CapturedStatement,
): string {
  const rows = client
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...statement.params) as readonly { detail: string }[];
  return rows.map((row) => row.detail).join("\n");
}

describe("default edge traversal indexes serve compiled joins index-only", () => {
  it("covers an incoming traversal (to_idx) with USING COVERING INDEX", async () => {
    await withCapturingStore(async (store, captured, client) => {
      const author = await store.nodes.Person.create({ name: "author" });
      const post = await store.nodes.Post.create({
        content: "hello",
        creationDate: "2020-01-01T00:00:00Z",
      });
      await store.edges.hasCreator.create(post, author);
      await store.refreshStatistics();

      captured.length = 0;
      await store
        .query()
        .from("Person", "person")
        .whereNode("person", (person) => person.id.in([author.id]))
        .traverse("hasCreator", "e", { expand: "none", direction: "in" })
        .to("Post", "post")
        .select((ctx) => ({
          id: ctx.post.id,
          creationDate: ctx.post.creationDate,
        }))
        .orderBy("post", "creationDate", "desc")
        .limit(10)
        .execute();

      const edgeStatement = captured.find((statement) =>
        statement.sql.includes('"typegraph_edges"'),
      );
      expect(edgeStatement).toBeDefined();
      const plan = explainPlan(client, edgeStatement!);
      expect(plan).toContain(
        "SEARCH e USING COVERING INDEX typegraph_edges_to_idx",
      );
    });
  });

  it("covers an outgoing traversal (from_idx) with USING COVERING INDEX", async () => {
    await withCapturingStore(async (store, captured, client) => {
      const author = await store.nodes.Person.create({ name: "author" });
      const post = await store.nodes.Post.create({
        content: "hello",
        creationDate: "2020-01-01T00:00:00Z",
      });
      await store.edges.hasCreator.create(post, author);
      await store.refreshStatistics();

      captured.length = 0;
      await store
        .query()
        .from("Post", "post")
        .whereNode("post", (postNode) => postNode.id.in([post.id]))
        .traverse("hasCreator", "e", { expand: "none", direction: "out" })
        .to("Person", "author")
        .select((ctx) => ({ id: ctx.author.id }))
        .execute();

      const edgeStatement = captured.find((statement) =>
        statement.sql.includes('"typegraph_edges"'),
      );
      expect(edgeStatement).toBeDefined();
      const plan = explainPlan(client, edgeStatement!);
      expect(plan).toContain(
        "SEARCH e USING COVERING INDEX typegraph_edges_from_idx",
      );
    });
  });
});
