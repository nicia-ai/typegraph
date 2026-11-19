/**
 * Fragment Composition Tests
 *
 * A `createFragment()` fragment declares the node aliases it requires and is
 * written away from the query it is piped into. These tests pin both halves
 * of that contract: the fragment body is typed against the declared aliases,
 * and `pipe()` keeps every alias of the host query while adding the
 * fragment's, refusing (at compile time) a host that cannot take it. The
 * execution cases run on every backend in the shared integration suite
 * (`tests/backends/integration/query-fragments.ts`).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
  ValidationError,
} from "../src";
import { createQueryBuilder } from "../src/query";
import { compileQuery } from "../src/query/compiler";
import {
  composeFragments,
  createFragment,
  limitFragment,
  offsetFragment,
  orderByFragment,
  type QueryFragment,
} from "../src/query-entry";
import { buildKindRegistry } from "../src/registry";
import { toSqlWithParams } from "./sql-test-utils";

const User = defineNode("User", {
  schema: z.object({
    name: z.string(),
    email: z.email(),
    status: z.enum(["active", "inactive", "pending"]),
    createdAt: z.string(),
  }),
});

// A subclass makes the default `from("User", "u")` polymorphic, so the tests
// below cover the widened alias type that expansion produces.
const Admin = defineNode("Admin", {
  schema: z.object({
    name: z.string(),
    email: z.email(),
    status: z.enum(["active", "inactive", "pending"]),
    createdAt: z.string(),
    level: z.number(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({
    title: z.string(),
    content: z.string(),
    published: z.boolean(),
  }),
});

const authored = defineEdge("authored", {
  schema: z.object({ role: z.enum(["author", "editor"]) }),
});

const follows = defineEdge("follows", {
  schema: z.object({}),
});

const graph = defineGraph({
  id: "fragment_graph",
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

const registry = buildKindRegistry(graph);

function query() {
  return createQueryBuilder<Graph>(graph.id, registry);
}

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

const firstTen = fragment((q) => q.limit(10));

// The same kinds as `graph`, but its `User` has no `status`: a fragment
// written for `graph` reads a property this graph's users do not have.
const LegacyUser = defineNode("User", {
  schema: z.object({
    name: z.string(),
    email: z.email(),
    createdAt: z.string(),
  }),
});

const legacyGraph = defineGraph({
  id: "legacy_fragment_graph",
  nodes: {
    User: { type: LegacyUser },
    Post: { type: Post },
  },
  edges: {
    authored: { type: authored, from: [LegacyUser], to: [Post] },
  },
});

type LegacyGraph = typeof legacyGraph;

const legacyRegistry = buildKindRegistry(legacyGraph);

function legacyQuery() {
  return createQueryBuilder<LegacyGraph>(legacyGraph.id, legacyRegistry);
}

/** A boolean the type checker cannot narrow, for conditional fragments. */
const runtimeFlag = Date.now() < 0;

type UnionKindFragment = QueryFragment<Graph, Readonly<{ u: "User" | "Post" }>>;

type LegacyUserFragment = QueryFragment<LegacyGraph, Readonly<{ u: "User" }>>;

/** Checks `fragment` against an annotation, as a variable declaration would. */
function annotate<Fragment>(fragment: Fragment): Fragment {
  return fragment;
}

describe("createFragment()", () => {
  describe("fragment body", () => {
    it("types a declared alias by its kind", () => {
      fragment({ u: "User" }, (q) =>
        q.whereNode("u", (user) => {
          expectTypeOf(user).toHaveProperty("status");
          // `title` is a Post property, not a User one
          expectTypeOf(user).not.toHaveProperty("title");
          return user.status.eq("active");
        }),
      );
    });

    it("sees only the declared aliases", () => {
      fragment({ u: "User" }, (q) => {
        expectTypeOf<Parameters<typeof q.whereNode>[0]>().toEqualTypeOf<"u">();
        return q;
      });

      fragment((q) => {
        expectTypeOf<
          Parameters<typeof q.whereNode>[0]
        >().toEqualTypeOf<never>();
        return q;
      });
    });

    it("refuses to add an alias it declared", () => {
      fragment({ u: "User" }, (q) =>
        // @ts-expect-error -- `u` is the declared alias
        q.traverse("follows", "f").to("User", "u"),
      );
    });
  });

  describe("pipe()", () => {
    it("keeps the host alias's row type for a filter fragment", () => {
      const piped = query()
        .from("User", "u")
        .pipe(activeUsers)
        .select((ctx) => ctx.u);
      const plain = query()
        .from("User", "u")
        .select((ctx) => ctx.u);

      expectTypeOf<RowOf<typeof piped>>().toEqualTypeOf<RowOf<typeof plain>>();

      const ast = piped.toAst();
      expect(ast.predicates).toHaveLength(1);
      expect(ast.predicates[0]?.targetAlias).toBe("u");
      expect(ast.projection).toEqual(plain.toAst().projection);
    });

    it("exposes the node and edge aliases an alias-adding fragment adds", () => {
      const piped = query()
        .from("User", "u")
        .pipe(withPosts)
        .select((ctx) => ({ user: ctx.u, post: ctx.p, edge: ctx.a }));

      type Row = RowOf<typeof piped>;
      expectTypeOf<Row["post"]["title"]>().toEqualTypeOf<string>();
      expectTypeOf<Row["post"]["published"]>().toEqualTypeOf<boolean>();
      expectTypeOf<Row["edge"]["role"]>().toEqualTypeOf<"author" | "editor">();

      const ast = piped.toAst();
      expect(ast.traversals).toHaveLength(1);
      expect(ast.traversals[0]?.joinFromAlias).toBe("u");
      expect(ast.traversals[0]?.nodeAlias).toBe("p");
    });

    it("keeps the host query's other node, edge and recursive aliases", () => {
      const piped = query()
        .from("User", "u")
        .traverse("follows", "f")
        .recursive({ depth: "hops", maxHops: 2 })
        .to("User", "friend")
        .pipe(activeUsers)
        .pipe(withPosts)
        .select((ctx) => ({
          friend: ctx.friend,
          follow: ctx.f,
          hops: ctx.hops,
          post: ctx.p,
        }));
      const plain = query()
        .from("User", "u")
        .traverse("follows", "f")
        .recursive({ depth: "hops", maxHops: 2 })
        .to("User", "friend")
        .select((ctx) => ({
          friend: ctx.friend,
          follow: ctx.f,
          hops: ctx.hops,
        }));

      type Row = RowOf<typeof piped>;
      type PlainRow = RowOf<typeof plain>;
      expectTypeOf<Row["friend"]>().toEqualTypeOf<PlainRow["friend"]>();
      expectTypeOf<Row["follow"]>().toEqualTypeOf<PlainRow["follow"]>();
      expectTypeOf<Row["hops"]>().toEqualTypeOf<number>();
      expectTypeOf<Row["post"]["title"]>().toEqualTypeOf<string>();

      const ast = piped.toAst();
      expect(ast.traversals.map((traversal) => traversal.nodeAlias)).toEqual([
        "friend",
        "p",
      ]);
      expect(ast.traversals[0]).toEqual(plain.toAst().traversals[0]);
    });

    it("accepts the declared kind under every typed expansion", () => {
      query().from("User", "u").pipe(activeUsers);
      query().from("User", "u", { expansion: "exact" }).pipe(activeUsers);
      query().from("User", "u", { expansion: "subclasses" }).pipe(activeUsers);
      query()
        .from("Post", "p")
        .traverse("authored", "a", { direction: "in" })
        .to("User", "u")
        .pipe(activeUsers);
      query()
        .from("Post", "p")
        .optionalTraverse("authored", "a", { direction: "in" })
        .to("User", "u")
        .pipe(activeUsers);
    });

    // Each refusal below is a compile error, and the same host is refused at
    // runtime too, which is what a caller the type check cannot reach meets.

    it("refuses a host that lacks a required alias", () => {
      expectRequirementUnmet(
        () =>
          // @ts-expect-error -- fragment requires alias 'u', which this query does not have
          query().from("User", "member").pipe(activeUsers),
        "u",
        undefined,
      );
    });

    it("refuses a host that binds a required alias at another kind", () => {
      // A Post has no `status`, but the fragment's own `whereNode` would not
      // say so: it would filter on a property no row has and match nothing.
      expectRequirementUnmet(
        () =>
          // @ts-expect-error -- fragment requires alias 'u' to be a 'User' node
          query().from("Post", "u").pipe(activeUsers),
        "u",
        ["Post"],
      );
      expectRequirementUnmet(
        () =>
          // @ts-expect-error -- a list source can bind a kind other than 'User'
          query().from(["User", "Post"], "u").pipe(activeUsers),
        "u",
        ["User", "Admin", "Post"],
      );
      // An untyped alias may bind any kind, so the compile-time check refuses
      // it; at runtime it is held to the kinds it actually binds.
      // @ts-expect-error -- an untyped (narrower) alias is not a 'User' node
      query().from("User", "u", { expansion: "narrower" }).pipe(activeUsers);
    });

    it("admits a subclass host at runtime, which the compile-time check cannot", () => {
      const ast = query()
        .from("Admin", "u")
        // @ts-expect-error -- the compile-time check does not follow subClassOf
        .pipe(activeUsers)
        .select((ctx) => ctx["u"])
        .toAst();
      expect(ast.predicates).toHaveLength(1);
    });

    it("refuses a required alias that names an edge", () => {
      const edgeAsUser = fragment({ f: "User" }, (q) => q);
      expectRequirementUnmet(
        () =>
          query()
            .from("User", "u")
            .traverse("follows", "f")
            .to("User", "friend")
            // @ts-expect-error -- 'f' is an edge alias here, not a 'User' node
            .pipe(edgeAsUser),
        "f",
        undefined,
      );
    });

    it("refuses a fragment written for another graph", () => {
      // This graph's users have no `status`, so the fragment's filter reads
      // a property no row has: it matches nothing rather than failing.
      const filtered = legacyQuery()
        .from("User", "u")
        // @ts-expect-error -- fragment is written for another graph
        .pipe(activeUsers)
        .select((ctx) => ctx["u"])
        .toAst();
      expect(filtered.predicates).toHaveLength(1);
      // @ts-expect-error -- a composition is written for its fragments' graph
      legacyQuery().from("User", "u").pipe(composeFragments(activeUsers));
      // A fragment written for any graph applies to every graph.
      const ast = legacyQuery()
        .from("User", "u")
        .pipe(limitFragment(5))
        .select((ctx) => ctx.u.name)
        .toAst();
      expect(ast.limit).toBe(5);
    });

    it("refuses a requirement typed as a union of kinds", () => {
      const kind: "User" | "Post" = runtimeFlag ? "Post" : "User";
      // @ts-expect-error -- fragment requirement 'u' must name one node kind
      fragment({ u: kind }, (q) => q);
      // The same requirement reached by a cast is refused where it is piped.
      const cast = activeUsers as unknown as UnionKindFragment;
      // @ts-expect-error -- fragment requirement 'u' must name one node kind
      query().from("User", "u").pipe(cast);
    });

    it("refuses an annotation that misstates what a fragment requires", () => {
      // @ts-expect-error -- drops the requirement on 'u'
      annotate<QueryFragment<Graph>>(activeUsers);
      // @ts-expect-error -- widens 'u' to a union of kinds
      annotate<UnionKindFragment>(activeUsers);
      // @ts-expect-error -- moves the fragment to another graph
      annotate<LegacyUserFragment>(activeUsers);
    });

    it("refuses, at runtime, a requirement on an unstarted builder's placeholder alias", () => {
      // An unstarted builder holds `""` as its source alias with no kinds;
      // that placeholder names no alias, so an untyped declaration of it is
      // refused before the body runs.
      let bodyRan = false;
      const untypedFactory = fragment as unknown as (
        requires: Readonly<Record<string, string>>,
        body: (builder: unknown) => unknown,
      ) => never;
      const placeholder = untypedFactory({ "": "User" }, (builder) => {
        bodyRan = true;
        return builder;
      });
      expectRequirementUnmet(() => query().pipe(placeholder), "", undefined);
      expect(bodyRan).toBe(false);
    });

    it("refuses a host that already uses an alias the fragment adds", () => {
      expect(() =>
        query()
          .from("User", "u")
          .traverse("follows", "f")
          .to("User", "p")
          // @ts-expect-error -- fragment adds alias 'p', which this query already uses
          .pipe(withPosts),
      ).toThrow(ValidationError);
      expect(() =>
        query()
          .from("User", "u")
          .traverse("follows", "a")
          .to("User", "friend")
          // @ts-expect-error -- fragment adds alias 'a' (an edge), which this query already uses
          .pipe(withPosts),
      ).toThrow(ValidationError);
    });

    it("applies a fragment that requires no alias to any query", () => {
      const piped = query()
        .from("Post", "p")
        .pipe(firstTen)
        .select((ctx) => ctx.p.title);

      expectTypeOf<RowOf<typeof piped>>().toEqualTypeOf<string>();
      expect(piped.toAst().limit).toBe(10);
    });

    it("applies an inline fragment typed by the host query", () => {
      const piped = query()
        .from("User", "u")
        .pipe((q) => q.traverse("authored", "a").to("Post", "post"))
        .select((ctx) => ({ name: ctx.u.name, title: ctx.post.title }));

      expectTypeOf<RowOf<typeof piped>>().toEqualTypeOf<{
        name: string;
        title: string;
      }>();
      expect(piped.toAst().traversals).toHaveLength(1);
    });

    it("can be annotated with QueryFragment", () => {
      const annotated: QueryFragment<
        Graph,
        Readonly<{ u: "User" }>
      > = activeUsers;
      query().from("User", "u").pipe(annotated);
    });
  });
});

describe("composeFragments()", () => {
  it("composes declared fragments and keeps what each adds", () => {
    const composed = composeFragments(activeUsers, withPosts, publishedPosts);
    const piped = query()
      .from("User", "u")
      .pipe(composed)
      .select((ctx) => ({ user: ctx.u.name, post: ctx.p.title }));

    expectTypeOf<RowOf<typeof piped>>().toEqualTypeOf<{
      user: string;
      post: string;
    }>();

    const ast = piped.toAst();
    expect(ast.predicates.map((predicate) => predicate.targetAlias)).toEqual([
      "u",
      "p",
    ]);
    expect(ast.traversals).toHaveLength(1);
  });

  it("passes a requirement no earlier fragment holds to the query", () => {
    const composed = composeFragments(firstTen, activeUsers);

    query().from("User", "u").pipe(composed);
    expectRequirementUnmet(
      () =>
        // @ts-expect-error -- the composition still requires alias 'u'
        query().from("Post", "p").pipe(composed),
      "u",
      undefined,
    );
  });

  it("refuses a later fragment that adds an alias an earlier one added", () => {
    // @ts-expect-error -- fragment adds alias 'a' and 'p', which the first already added
    composeFragments(withPosts, withPosts);
  });

  it("refuses a later fragment that requires an earlier alias at another kind", () => {
    const postAsUser = fragment({ p: "User" }, (q) =>
      q.whereNode("p", ({ name }) => name.eq("x")),
    );
    // @ts-expect-error -- fragment requires alias 'p' to be a 'User' node
    composeFragments(withPosts, postAsUser);
  });

  it("refuses a union of fragments", () => {
    const conditional = runtimeFlag ? activeUsers : publishedPosts;
    // @ts-expect-error -- composeFragments() takes a fragment, not a union of fragments
    composeFragments(conditional);
    // @ts-expect-error -- composeFragments() takes a fragment, not a union of fragments
    composeFragments(firstTen, conditional);
    expect(() =>
      // @ts-expect-error -- pipe() refuses one as well
      query().from("User", "u").pipe(conditional),
    ).toThrow(ConfigurationError);
  });

  it("refuses a requirement for an alias an earlier fragment adds as an edge or recursive alias", () => {
    const edgeAsUser = fragment({ a: "User" }, (q) => q);
    // @ts-expect-error -- 'a' is the edge alias withPosts adds
    composeFragments(withPosts, edgeAsUser);

    const withFriends = fragment({ u: "User" }, (q) =>
      q
        .traverse("follows", "f", { from: "u" })
        .recursive({ depth: "hops", maxHops: 2 })
        .to("User", "friend"),
    );
    const hopsAsUser = fragment({ hops: "User" }, (q) => q);
    // @ts-expect-error -- 'hops' is the recursive alias withFriends adds
    composeFragments(withFriends, hopsAsUser);
  });

  it("refuses fragments written for unrelated graphs", () => {
    const legacyNamed = createFragment<LegacyGraph>()({ u: "User" }, (q) =>
      q.whereNode("u", ({ name }) => name.eq("x")),
    );
    // @ts-expect-error -- fragment is written for another graph
    composeFragments(activeUsers, legacyNamed);
  });

  it("composes a graph-agnostic helper placed first", () => {
    const firstPage = composeFragments(limitFragment(20), activeUsers);
    const ast = query()
      .from("User", "u")
      .pipe(firstPage)
      .select((ctx) => ctx.u)
      .toAst();
    expect(ast.limit).toBe(20);
    expect(ast.predicates).toHaveLength(1);
    // The composition is written for activeUsers's graph, not for any graph.
    // @ts-expect-error -- fragment is written for another graph
    legacyQuery().from("User", "u").pipe(firstPage);
  });

  it("composes any number of fragments", () => {
    const composed = composeFragments(
      activeUsers,
      withPosts,
      publishedPosts,
      byName,
      firstTen,
    );
    const ast = query()
      .from("User", "u")
      .pipe(composed)
      .select((ctx) => ({ user: ctx.u.name, post: ctx.p.title }))
      .toAst();
    expect(ast.predicates).toHaveLength(2);
    expect(ast.orderBy).toHaveLength(1);
    expect(ast.limit).toBe(10);
  });

  it("composes the helper fragments", () => {
    const paginated = composeFragments(
      orderByFragment<Graph, "u">("u", "createdAt", "desc"),
      limitFragment<Graph>(20),
      offsetFragment<Graph>(40),
    );

    const ast = query()
      .from("User", "u")
      .pipe(paginated)
      .select((ctx) => ctx.u)
      .toAst();
    expect(ast.orderBy).toHaveLength(1);
    expect(ast.orderBy?.[0]?.direction).toBe("desc");
    expect(ast.limit).toBe(20);
    expect(ast.offset).toBe(40);
  });
});

describe("helper fragments", () => {
  it("limitFragment() adds a limit", () => {
    const ast = query()
      .from("User", "u")
      .pipe(limitFragment<Graph>(25))
      .select((ctx) => ctx.u)
      .toAst();
    expect(ast.limit).toBe(25);
  });

  it("offsetFragment() adds an offset", () => {
    const ast = query()
      .from("User", "u")
      .pipe(offsetFragment<Graph>(50))
      .select((ctx) => ctx.u)
      .toAst();
    expect(ast.offset).toBe(50);
  });

  it("orderByFragment() adds ordering", () => {
    const ast = query()
      .from("User", "u")
      .pipe(orderByFragment<Graph, "u">("u", "name", "asc"))
      .select((ctx) => ctx.u)
      .toAst();
    expect(ast.orderBy).toHaveLength(1);
    expect(ast.orderBy?.[0]?.direction).toBe("asc");
  });
});

describe("ExecutableQuery.pipe()", () => {
  it("applies transformations after select", () => {
    const ast = query()
      .from("User", "u")
      .select((ctx) => ctx.u)
      .pipe((q) => q.orderBy("u", "createdAt", "desc").limit(10))
      .toAst();
    expect(ast.orderBy).toHaveLength(1);
    expect(ast.limit).toBe(10);
  });
});

describe("SQL compilation with fragments", () => {
  it("compiles fragments to correct SQL", () => {
    const ast = query()
      .from("User", "u")
      .pipe(activeUsers)
      .pipe(byName)
      .pipe(firstTen)
      .select((ctx) => ctx.u)
      .toAst();
    const { sql, params } = toSqlWithParams(
      compileQuery(ast, graph.id, "sqlite"),
    );

    expect(sql).toContain("WHERE");
    expect(sql).toContain("ORDER BY");
    expect(sql).toContain("LIMIT");
    expect(params).toContain("active");
    expect(params).toContain(10);
  });
});

function expectRequirementUnmet(
  pipeFragment: () => unknown,
  alias: string,
  boundKinds: readonly string[] | undefined,
): void {
  let thrown: unknown;
  try {
    pipeFragment();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigurationError);
  expect(thrown).toMatchObject({
    details: {
      code: "QUERY_FRAGMENT_REQUIREMENT_UNMET",
      alias,
      requiredKind: "User",
      boundKinds,
    },
  });
}

type RowOf<Query> =
  Query extends Readonly<{ execute: () => Promise<readonly (infer Row)[]> }> ?
    Row
  : never;
