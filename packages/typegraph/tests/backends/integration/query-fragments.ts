/**
 * `createFragment()` fragments executed against every backend: a declared
 * filter fragment over a polymorphic alias, a composition that adds node and
 * edge aliases, and a traversal that starts at the declared alias rather
 * than the host query's last node.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, subClassOf } from "../../../src";
import { composeFragments, createFragment } from "../../../src/query-entry";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    status: z.enum(["active", "inactive"]),
  }),
});

const Admin = defineNode("Admin", {
  schema: z.object({
    name: z.string(),
    status: z.enum(["active", "inactive"]),
    level: z.number(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({ title: z.string(), published: z.boolean() }),
});

const authored = defineEdge("authored", {
  schema: z.object({ role: z.enum(["author", "editor"]) }),
});

const follows = defineEdge("follows", { schema: z.object({}) });

const graph = defineGraph({
  id: "integration_query_fragments",
  nodes: {
    User: { type: User },
    Admin: { type: Admin },
    Post: { type: Post },
  },
  edges: {
    authored: { type: authored, from: [User], to: [Post] },
    follows: { type: follows, from: [User], to: [User] },
  },
  ontology: [subClassOf(Admin, User)],
});

type Graph = typeof graph;

const fragment = createFragment<Graph>();

const activeUsers = fragment({ u: "User" }, (q) =>
  q.whereNode("u", ({ status }) => status.eq("active")),
);

const withPosts = fragment({ u: "User" }, (q) =>
  q.traverse("authored", "a", { from: "u" }).to("Post", "p"),
);

const publishedPosts = fragment({ p: "Post" }, (q) =>
  q.whereNode("p", ({ published }) => published.eq(true)),
);

const byName = fragment({ u: "User" }, (q) => q.orderBy("u", "name", "asc"));

async function seededStore(
  context: IntegrationTestContext,
): Promise<InspectableStore<Graph>> {
  const store = await context.createStore(graph);
  const alice = await store.nodes.User.create({
    name: "Alice",
    status: "active",
  });
  const bob = await store.nodes.User.create({
    name: "Bob",
    status: "inactive",
  });
  const carol = await store.nodes.Admin.create({
    name: "Carol",
    status: "active",
    level: 2,
  });
  const drafts = await store.nodes.Post.create({
    title: "Drafts",
    published: false,
  });
  const graphs = await store.nodes.Post.create({
    title: "Graphs",
    published: true,
  });
  const sql = await store.nodes.Post.create({ title: "SQL", published: true });

  await store.edges.authored.create(alice, graphs, { role: "author" });
  await store.edges.authored.create(alice, drafts, { role: "author" });
  await store.edges.authored.create(bob, sql, { role: "author" });
  await store.edges.authored.create(carol, sql, { role: "editor" });
  await store.edges.follows.create(bob, alice, {});
  return store;
}

export function registerQueryFragmentIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("query fragments", () => {
    it("filters with a declared filter fragment, subclasses included", async () => {
      const store = await seededStore(context);
      const rows = await store
        .query()
        .from("User", "u")
        .pipe(activeUsers)
        .pipe(byName)
        .select((ctx) => ({ name: ctx.u.name, kind: ctx.u.kind }))
        .execute();

      expect(rows).toEqual([
        { name: "Alice", kind: "User" },
        { name: "Carol", kind: "Admin" },
      ]);
    });

    it("returns the aliases a composed alias-adding fragment adds", async () => {
      const store = await seededStore(context);
      const rows = await store
        .query()
        .from("User", "u")
        .pipe(composeFragments(activeUsers, withPosts, publishedPosts))
        .select((ctx) => ({
          user: ctx.u.name,
          post: ctx.p.title,
          role: ctx.a.role,
        }))
        .orderBy("u", "name", "asc")
        .execute();

      expect(rows).toEqual([
        { user: "Alice", post: "Graphs", role: "author" },
        { user: "Carol", post: "SQL", role: "editor" },
      ]);
    });

    it("starts a fragment's traversal at the declared alias, not the host's last node", async () => {
      // The host's current node is `followed` (Alice); `withPosts` traverses
      // `from: "u"`, so it reads the follower's (Bob's) posts.
      const store = await seededStore(context);
      const rows = await store
        .query()
        .from("User", "u")
        .traverse("follows", "f")
        .to("User", "followed")
        .pipe(withPosts)
        .select((ctx) => ({
          follower: ctx.u.name,
          followed: ctx.followed.name,
          post: ctx.p.title,
        }))
        .execute();

      expect(rows).toEqual([
        { follower: "Bob", followed: "Alice", post: "SQL" },
      ]);
    });
  });
}
