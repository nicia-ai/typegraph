/**
 * Query Builder Tests
 *
 * The query builder provides a fluent API for constructing type-safe queries.
 * Queries compile to an AST which can be compiled to SQL via compileQuery().
 *
 * Key concepts:
 *   - from(kind, alias) - Start query from a node kind
 *   - whereNode(alias, predicate) - Filter nodes by predicate
 *   - traverse(edgeKind, alias).to(nodeKind, alias) - Follow edges
 *   - select(fn) - Project fields for the result
 *   - orderBy, limit, offset - Standard SQL operations
 */
import { type SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  avg,
  buildKindRegistry,
  count,
  countDistinct,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  exists,
  field,
  fieldRef,
  havingGt,
  havingGte,
  inSubquery,
  max,
  min,
  notExists,
  notInSubquery,
  subClassOf,
  sum,
  ValidationError,
} from "../src";
import { compileQuery, compileSetOperation } from "../src/query/compiler";

/**
 * Helper to extract SQL string and params from a Drizzle SQL object for testing.
 * Handles nested SQL objects created by sql.join() and other composable methods.
 */
function sqlToStrings(
  sqlObject: SQL,
  dialect: "sqlite" | "postgres" = "sqlite",
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let parameterIndex = 1;

  function flatten(object: unknown): string {
    // String chunk: { value: string[] }
    if (
      typeof object === "object" &&
      object !== null &&
      "value" in object &&
      Array.isArray((object as { value: unknown }).value)
    ) {
      return (object as { value: string[] }).value.join("");
    }
    // Nested SQL object: { queryChunks: unknown[] }
    if (
      typeof object === "object" &&
      object !== null &&
      "queryChunks" in object &&
      Array.isArray((object as { queryChunks: unknown[] }).queryChunks)
    ) {
      return (object as { queryChunks: unknown[] }).queryChunks
        .map((c) => flatten(c))
        .join("");
    }
    // Parameter value (string, number, etc.)
    params.push(object);
    return dialect === "postgres" ? `$${parameterIndex++}` : "?";
  }

  const sqlString = flatten(sqlObject);
  return { sql: sqlString, params };
}

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().optional(),
    isActive: z.boolean().default(true),
    tags: z.array(z.string()).optional(),
    metadata: z
      .object({
        source: z.string(),
        priority: z.number(),
      })
      .optional(),
  }),
});

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    ticker: z.string().optional(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const knows = defineEdge("knows");

const graph = defineGraph({
  id: "test_graph",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Organization, Company],
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
    },
  },
  ontology: [subClassOf(Company, Organization)],
});

const registry = buildKindRegistry(graph);

describe("Query Builder Basics", () => {
  it("creates a simple query for a single node kind", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => context.p);

    const ast = query.toAst();

    expect(ast.start.alias).toBe("p");
    expect(ast.start.kinds).toEqual(["Person"]);
  });

  it("applies predicate filters using whereNode", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((context) => context.p);

    const ast = query.toAst();

    expect(ast.predicates).toHaveLength(1);
    expect(ast.predicates[0]?.targetAlias).toBe("p");
  });

  it("supports string predicates: contains, startsWith, endsWith", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.name.contains("ali"))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
  });

  it("supports numeric predicates: gt, gte, lt, lte", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.gt(18))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("comparison");
    expect((predicate as { op: string }).op).toBe("gt");
  });

  it("supports numeric between predicate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.between(18, 65))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("between");
  });

  it("compiles numeric predicates correctly", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.gte(21))
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id, "sqlite");
    const { sql, params } = sqlToStrings(sqlObject);

    expect(sql).toContain(">=");
    expect(params).toContain(21);
  });

  it("supports boolean predicates with base operations only", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.isActive.eq(true))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("comparison");
    expect((predicate as { op: string }).op).toBe("eq");
  });

  it("supports array isEmpty predicate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")

      .whereNode("p", (p) => p.tags.isEmpty())
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("array_op");
    expect((predicate as { op: string }).op).toBe("isEmpty");
  });

  it("supports array contains predicate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")

      .whereNode("p", (p) => p.tags.contains("admin"))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("array_op");
    expect((predicate as { op: string }).op).toBe("contains");
  });

  it("supports array length predicates", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")

      .whereNode("p", (p) => p.tags.lengthGte(3))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("array_op");
    expect((predicate as { op: string }).op).toBe("lengthGte");
  });

  it("supports object hasKey predicate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")

      .whereNode("p", (p) => p.metadata.hasKey("source"))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("object_op");
    expect((predicate as { op: string }).op).toBe("hasKey");
  });

  it("supports object pathEquals predicate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")

      .whereNode("p", (p) => p.metadata.pathEquals("/source", "web"))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("object_op");
    expect((predicate as { op: string }).op).toBe("pathEquals");
  });

  it("supports object .get() for nested string field", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.metadata.get("source").eq("web"))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("comparison");
    expect((predicate as { op: string }).op).toBe("eq");
  });

  it("supports object .get() for nested number field", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.metadata.get("priority").gt(5))
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.predicates).toHaveLength(1);
    const predicate = ast.predicates[0]!.expression;
    expect(predicate.__type).toBe("comparison");
    expect((predicate as { op: string }).op).toBe("gt");
  });

  it("compiles object .get() to JSON extract", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.metadata.get("source").eq("web"))
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id, "sqlite");
    const { sql, params } = sqlToStrings(sqlObject);

    expect(sql).toContain("json_extract");
    // Path is compiled as a literal (for expression index compatibility).
    expect(sql).toContain("source");
    expect(params).toContain("web");
  });

  it("compiles array predicates to SQLite JSON functions", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")

      .whereNode("p", (p) => p.tags.contains("admin"))
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id, "sqlite");
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("json_each");
    expect(sql).toContain("EXISTS");
  });

  it("compiles object predicates to SQLite JSON functions", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")

      .whereNode("p", (p) => p.metadata.pathEquals("/source", "web"))
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id, "sqlite");
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("json_extract");
  });

  it("supports ordering results", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .orderBy("p", "name", "asc")
      .select((context) => context.p);

    const ast = query.toAst();

    expect(ast.orderBy).toHaveLength(1);
    expect(ast.orderBy?.[0]?.direction).toBe("asc");
  });

  it("supports limit and offset for pagination", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => context.p)
      .limit(10)
      .offset(20);

    const ast = query.toAst();

    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(20);
  });
});

describe("Query Builder - Traversals", () => {
  it("traverses outgoing edges to related nodes", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .select((context) => ({ person: context.p, org: context.o }));

    const ast = query.toAst();

    expect(ast.traversals).toHaveLength(1);
    const traversal = ast.traversals[0]!;
    expect(traversal.edgeKinds).toEqual(["worksAt"]);
    expect(traversal.direction).toBe("out");
    expect(traversal.nodeAlias).toBe("o");
  });

  it("traverses incoming edges with direction option", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("knows", "e", { direction: "in" })
      .to("Person", "friend")
      .select((context) => context.friend);

    const ast = query.toAst();

    expect(ast.traversals[0]!.direction).toBe("in");
  });
});

describe("Query Builder - Subclass Expansion", () => {
  it("expands queries to include subclasses when requested", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o", { includeSubClasses: true })
      .select((context) => context.o);

    const ast = query.toAst();

    expect(ast.start.kinds).toContain("Organization");
    expect(ast.start.kinds).toContain("Company");
    expect(ast.start.includeSubClasses).toBe(true);
  });

  it("does not expand subclasses by default", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => context.o);

    const ast = query.toAst();

    expect(ast.start.kinds).toEqual(["Organization"]);
    expect(ast.start.includeSubClasses).toBe(false);
  });
});

describe("Query Compilation to SQL", () => {
  it("compiles a simple query to SQL with CTEs", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id, "sqlite");
    const { sql, params } = sqlToStrings(sqlObject);

    expect(sql).toContain("WITH");
    expect(sql).toContain("cte_p");
    expect(sql).toContain('FROM "typegraph_nodes"');
    expect(params).toContain(graph.id);
    expect(params).toContain("Person");
  });

  it("compiles predicates with parameterized values", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id, "sqlite");
    const { sql, params } = sqlToStrings(sqlObject);

    expect(sql).toContain("?"); // SQLite parameter placeholder
    expect(params).toContain("Alice");
  });

  it("uses raw column names in CTE WHERE clauses for SQL standard compliance", () => {
    // Bug: CTE WHERE clauses must use raw column names (e.g., "props")
    // not SELECT aliases (e.g., "p_props") for SQL standard compliance.
    // Standard SQL doesn't allow referencing SELECT aliases in WHERE.
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    // In the CTE WHERE clause, should use raw column "props" not alias "p_props"
    // The predicate should be: json_extract(props, '$.name') = 'Alice'
    expect(sql).toMatch(/WHERE.*json_extract\(props,/);
    expect(sql).not.toMatch(/WHERE.*json_extract\(p_props,/);
  });

  it("uses table-qualified column names in traversal CTE WHERE clauses", () => {
    // In traversal CTEs, predicates should use n.props (node table alias)
    // not the SELECT alias (e.g., "friend_props")
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("knows", "k")
      .to("Person", "friend")
      .whereNode("friend", (f) => f.name.eq("Bob"))
      .select((context) => ({ p: context.p, friend: context.friend }));

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    // In traversal CTE WHERE, should use n.props not friend_props
    expect(sql).toMatch(
      /cte_friend AS[\s\S]*?WHERE[\s\S]*?json_extract\(n\.props,/,
    );
  });

  it("compiles traversals using JOINs", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .select((context) => ({ p: context.p, o: context.o }));

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("cte_o");
    expect(sql).toContain("typegraph_edges");
    expect(sql).toContain("INNER JOIN");
  });

  it("compiles LIMIT and OFFSET", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => context.p)
      .limit(10)
      .offset(5);

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql, params } = sqlToStrings(sqlObject);

    expect(sql).toContain("LIMIT");
    expect(sql).toContain("OFFSET");
    expect(params).toContain(10);
    expect(params).toContain(5);
  });

  it("uses postgres parameter syntax when dialect is postgres", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Bob"))
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id, "postgres");
    const { sql } = sqlToStrings(sqlObject, "postgres");

    expect(sql).toMatch(/\$\d+/); // Postgres parameter syntax: $1, $2, etc.
  });

  it("keeps boolean parameters for postgres", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.isActive.eq(true))
      .select((context) => ({ id: context.p.id }));

    const sqlObject = compileQuery(query.toAst(), graph.id, "postgres");
    const { params } = sqlToStrings(sqlObject, "postgres");

    expect(params).toContain(true);
    expect(params).not.toContain(1);
  });
});

describe("Query Builder - Temporal Modes", () => {
  it("defaults to current temporal mode", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.temporalMode.mode).toBe("current");
  });

  it("allows setting asOf temporal mode with a timestamp", () => {
    const timestamp = "2024-01-01T00:00:00.000Z";
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .temporal("asOf", timestamp)
      .select((context) => context.p);

    const ast = query.toAst();
    expect(ast.temporalMode.mode).toBe("asOf");
    expect(ast.temporalMode.asOf).toBe(timestamp);
  });

  it("throws ValidationError when asOf mode is used without timestamp", () => {
    expect(() => {
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .temporal("asOf");
    }).toThrow(ValidationError);

    expect(() => {
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .temporal("asOf");
    }).toThrow(/requires a timestamp/);
  });

  it("compiles temporal filters into WHERE clauses", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .temporal("current")
      .select((context) => context.p);

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("deleted_at IS NULL");
    expect(sql).toContain("valid_from");
    expect(sql).toContain("valid_to");
  });
});

describe("Query Builder - Aggregations", () => {
  it("creates GROUP BY AST", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupBy("o", "name")
      .selectAggregate({
        orgName: field("o", "name"),
        employeeCount: count("p"),
      });

    const ast = query.toAst();

    expect(ast.groupBy).toBeDefined();
    expect(ast.groupBy?.fields).toHaveLength(1);
    expect(ast.groupBy?.fields[0]?.alias).toBe("o");
  });

  it("supports multiple GROUP BY fields", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .groupBy("p", "name")
      .groupBy("p", "age")
      .selectAggregate({
        name: field("p", "name"),
        age: field("p", "age"),
        total: count("p"),
      });

    const ast = query.toAst();

    expect(ast.groupBy?.fields).toHaveLength(2);
  });

  it("supports groupByNode for grouping by node ID", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupByNode("o")
      .selectAggregate({
        orgId: field("o", "id"),
        employeeCount: count("p"),
      });

    const ast = query.toAst();

    expect(ast.groupBy?.fields).toHaveLength(1);
    expect(ast.groupBy?.fields[0]?.path).toEqual(["id"]);
  });

  it("field() throws error when 'props' is included in path", () => {
    expect(() => field("p", "props", "name")).toThrow(
      'field(): Do not include "props" in the path. Use field("p", "name") instead.',
    );

    // Correct usage works fine
    const ref = field("p", "name");
    expect(ref.jsonPointer).toBe("/name");
    expect(ref.path).toEqual(["props"]);
  });

  it("compiles COUNT aggregate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupBy("o", "name")
      .selectAggregate({
        orgName: field("o", "name"),
        employeeCount: count("p"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("COUNT");
    expect(sql).toContain("GROUP BY");
  });

  it("compiles COUNT DISTINCT aggregate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupBy("o", "name")
      .selectAggregate({
        orgName: field("o", "name"),
        uniquePeople: countDistinct("p"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("COUNT(DISTINCT");
    expect(sql).toContain("GROUP BY");
  });

  it("compiles SUM aggregate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .groupBy("p", "isActive")
      .selectAggregate({
        isActive: field("p", "isActive"),
        totalAge: sum("p", "age"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("SUM");
    expect(sql).toContain("GROUP BY");
  });

  it("compiles AVG aggregate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .groupBy("p", "isActive")
      .selectAggregate({
        isActive: field("p", "isActive"),
        avgAge: avg("p", "age"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("AVG");
    expect(sql).toContain("GROUP BY");
  });

  it("compiles MIN aggregate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .groupBy("p", "isActive")
      .selectAggregate({
        isActive: field("p", "isActive"),
        youngestAge: min("p", "age"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("MIN");
    expect(sql).toContain("GROUP BY");
  });

  it("compiles MAX aggregate", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .groupBy("p", "isActive")
      .selectAggregate({
        isActive: field("p", "isActive"),
        oldestAge: max("p", "age"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("MAX");
    expect(sql).toContain("GROUP BY");
  });

  it("supports multiple aggregates in one query", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupBy("o", "name")
      .selectAggregate({
        orgName: field("o", "name"),
        employeeCount: count("p"),
        avgAge: avg("p", "age"),
        minAge: min("p", "age"),
        maxAge: max("p", "age"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("COUNT");
    expect(sql).toContain("AVG");
    expect(sql).toContain("MIN");
    expect(sql).toContain("MAX");
    expect(sql).toContain("GROUP BY");
  });

  it("supports limit and offset on aggregate queries", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .groupBy("p", "name")
      .selectAggregate({
        name: field("p", "name"),
        total: count("p"),
      })
      .limit(10)
      .offset(5);

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql, params } = sqlToStrings(sqlObject);

    expect(sql).toContain("LIMIT");
    expect(sql).toContain("OFFSET");
    expect(params).toContain(10);
    expect(params).toContain(5);
  });

  it("supports HAVING clause to filter groups", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupBy("o", "name")
      .having(havingGt(count("p"), 10))
      .selectAggregate({
        orgName: field("o", "name"),
        employeeCount: count("p"),
      });

    const ast = query.toAst();

    expect(ast.having).toBeDefined();
    expect(ast.having?.__type).toBe("aggregate_comparison");
  });

  it("compiles HAVING clause to SQL", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .groupBy("o", "name")
      .having(havingGte(count("p"), 5))
      .selectAggregate({
        orgName: field("o", "name"),
        employeeCount: count("p"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql, params } = sqlToStrings(sqlObject);

    expect(sql).toContain("HAVING");
    expect(sql).toContain("COUNT");
    expect(sql).toContain(">=");
    expect(params).toContain(5);
  });

  it("qualifies GROUP BY columns in self-referential traversals", () => {
    // Bug: When source and destination are the same node type (self-join),
    // the GROUP BY clause must qualify column names to avoid ambiguity.
    // Without qualification, "p_id" appears in multiple CTEs causing:
    // SqliteError: ambiguous column name: p_id
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .optionalTraverse("knows", "k", { direction: "in" })
      .to("Person", "knower")
      .groupByNode("p")
      .selectAggregate({
        name: field("p", "name"),
        knowerCount: count("knower"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    // The GROUP BY clause must use qualified column name "cte_p.p_id"
    // to distinguish from "cte_knower.p_id" (which also exists since
    // the knower CTE carries the p_id for the join)
    // GROUP BY includes both projected fields and the node ID
    expect(sql).toContain("cte_p.p_id");
  });

  it("qualifies COUNT columns in self-referential traversals", () => {
    // Bug: COUNT(alias_id) must be qualified with CTE name to avoid ambiguity
    // when the same node type appears multiple times (self-join).
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .optionalTraverse("knows", "k", { direction: "in" })
      .to("Person", "knower")
      .groupByNode("p")
      .selectAggregate({
        name: field("p", "name"),
        knowerCount: count("knower"),
      });

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    // COUNT must use qualified column name to avoid ambiguity
    expect(sql).toContain("COUNT(cte_knower.knower_id)");
  });

  it("qualifies ORDER BY columns in self-referential traversals", () => {
    // Bug: ORDER BY field references must be qualified with CTE name
    // to avoid ambiguity in self-referential joins.
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("knows", "k")
      .to("Person", "friend")
      .orderBy("p", "name", "asc")
      .select((ctx) => ({ p: ctx.p, friend: ctx.friend }));

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    // ORDER BY must use qualified column reference
    expect(sql).toMatch(/ORDER BY.*cte_p\.p_props/);
  });
});

describe("Query Builder - Optional Matches", () => {
  it("creates optional traversal AST with LEFT JOIN flag", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .optionalTraverse("worksAt", "e")
      .to("Organization", "o")
      .select((context) => ({ p: context.p, o: context.o }));

    const ast = query.toAst();

    expect(ast.traversals).toHaveLength(1);
    expect(ast.traversals[0]?.optional).toBe(true);
  });

  it("compiles optional traversals to LEFT JOIN", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .optionalTraverse("worksAt", "e")
      .to("Organization", "o")
      .select((context) => ({ p: context.p, o: context.o }));

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("LEFT JOIN");
  });

  it("compiles regular traversals to INNER JOIN", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .to("Organization", "o")
      .select((context) => ({ p: context.p, o: context.o }));

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("INNER JOIN");
    expect(sql).not.toContain("LEFT JOIN");
  });

  it("supports optional incoming edge traversals", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .optionalTraverse("worksAt", "e", { direction: "in" })
      .to("Person", "p")
      .select((context) => ({ o: context.o, p: context.p }));

    const ast = query.toAst();

    expect(ast.traversals[0]?.optional).toBe(true);
    expect(ast.traversals[0]?.direction).toBe("in");
  });

  it("allows mixing optional and required traversals", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e1")
      .to("Organization", "o")
      .optionalTraverse("knows", "e2")
      .to("Person", "friend")
      .select((context) => ({
        p: context.p,
        o: context.o,
        friend: context.friend,
      }));

    const ast = query.toAst();

    expect(ast.traversals).toHaveLength(2);
    expect(ast.traversals[0]?.optional).toBe(false);
    expect(ast.traversals[1]?.optional).toBe(true);
  });

  it("compiles mixed traversals with correct join types", () => {
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e1")
      .to("Organization", "o")
      .optionalTraverse("knows", "e2")
      .to("Person", "friend")
      .select((context) => ({
        p: context.p,
        o: context.o,
        friend: context.friend,
      }));

    const sqlObject = compileQuery(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    // Should have both INNER JOIN (for worksAt) and LEFT JOIN (for knows)
    expect(sql).toContain("INNER JOIN");
    expect(sql).toContain("LEFT JOIN");
  });
});

describe("Query Builder - Set Operations (UNION/INTERSECT/EXCEPT)", () => {
  it("supports UNION of two queries", () => {
    const active = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.isActive.eq(true))
      .select((context) => ({ id: context.p.id, name: context.p.name }));

    const adults = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.gte(18))
      .select((context) => ({ id: context.p.id, name: context.p.name }));

    const unionQuery = active.union(adults);
    const ast = unionQuery.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("union");
  });

  it("supports UNION ALL of two queries", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const unionQuery = q1.unionAll(q2);
    const ast = unionQuery.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("unionAll");
  });

  it("supports INTERSECT of two queries", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.isActive.eq(true))
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.gte(21))
      .select((context) => ({ id: context.p.id }));

    const query = q1.intersect(q2);
    const ast = query.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("intersect");
  });

  it("supports EXCEPT of two queries", () => {
    const all = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const inactive = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.isActive.eq(false))
      .select((context) => ({ id: context.p.id }));

    const query = all.except(inactive);
    const ast = query.toAst();

    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("except");
  });

  it("supports chaining multiple set operations", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.lt(18))
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.gte(65))
      .select((context) => ({ id: context.p.id }));

    const q3 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.isActive.eq(false))
      .select((context) => ({ id: context.p.id }));

    // q1 UNION q2 EXCEPT q3
    const query = q1.union(q2).except(q3);
    const ast = query.toAst();

    // The outermost operation should be EXCEPT
    expect(ast.__type).toBe("set_operation");
    expect(ast.operator).toBe("except");

    // The left side should be a UNION
    const leftAst = ast.left;
    expect(leftAst).toHaveProperty("__type", "set_operation");
    expect(leftAst).toHaveProperty("operator", "union");
  });

  it("supports limit on set operations", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const query = q1.union(q2).limit(10);
    const ast = query.toAst();

    expect(ast.limit).toBe(10);
  });

  it("supports offset on set operations", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const query = q1.union(q2).offset(5).limit(10);
    const ast = query.toAst();

    expect(ast.limit).toBe(10);
    expect(ast.offset).toBe(5);
  });

  it("compiles UNION to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.isActive.eq(true))
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", (p) => p.age.gte(21))
      .select((context) => ({ id: context.p.id }));

    const query = q1.union(q2);
    const sqlObject = compileSetOperation(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("UNION");
    expect(sql).not.toContain("UNION ALL");
  });

  it("compiles UNION ALL to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const query = q1.unionAll(q2);
    const sqlObject = compileSetOperation(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("UNION ALL");
  });

  it("compiles INTERSECT to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const query = q1.intersect(q2);
    const sqlObject = compileSetOperation(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("INTERSECT");
  });

  it("compiles EXCEPT to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const query = q1.except(q2);
    const sqlObject = compileSetOperation(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("EXCEPT");
  });

  it("compiles set operations with LIMIT/OFFSET to SQL", () => {
    const q1 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const q2 = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .select((context) => ({ id: context.p.id }));

    const query = q1.union(q2).limit(10).offset(5);
    const sqlObject = compileSetOperation(query.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("UNION");
    expect(sql).toContain("LIMIT");
    expect(sql).toContain("OFFSET");
  });
});

describe("Query Builder - Subqueries (EXISTS/IN)", () => {
  it("supports EXISTS subquery predicate", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => ({ id: context.o.id }));

    const existsPred = exists(subquery.toAst());

    expect(existsPred.__expr.__type).toBe("exists");
    expect((existsPred.__expr as { negated: boolean }).negated).toBe(false);
  });

  it("supports NOT EXISTS subquery predicate", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => ({ id: context.o.id }));

    const notExistsPred = notExists(subquery.toAst());

    expect(notExistsPred.__expr.__type).toBe("exists");
    expect((notExistsPred.__expr as { negated: boolean }).negated).toBe(true);
  });

  it("supports IN subquery predicate", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => ({ id: context.o.id }));

    const inPred = inSubquery(fieldRef("p", ["id"]), subquery.toAst());

    expect(inPred.__expr.__type).toBe("in_subquery");
    expect((inPred.__expr as { negated: boolean }).negated).toBe(false);
  });

  it("supports NOT IN subquery predicate", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => ({ id: context.o.id }));

    const notInPred = notInSubquery(fieldRef("p", ["id"]), subquery.toAst());

    expect(notInPred.__expr.__type).toBe("in_subquery");
    expect((notInPred.__expr as { negated: boolean }).negated).toBe(true);
  });

  it("compiles EXISTS subquery to SQL", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .whereNode("o", (o) => o.name.contains("Corp"))
      .select((context) => ({ id: context.o.id }));

    const existsPred = exists(subquery.toAst());

    // Use whereNode with the exists predicate - combining with a truthy check on the node
    const mainQuery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", () => existsPred)
      .select((context) => ({ id: context.p.id }));

    const sqlObject = compileQuery(mainQuery.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("EXISTS");
    expect(sql).not.toContain("NOT EXISTS");
  });

  it("compiles NOT EXISTS subquery to SQL", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => ({ id: context.o.id }));

    const notExistsPred = notExists(subquery.toAst());

    const mainQuery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", () => notExistsPred)
      .select((context) => ({ id: context.p.id }));

    const sqlObject = compileQuery(mainQuery.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("NOT EXISTS");
  });

  it("compiles IN subquery to SQL", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => ({ id: context.o.id }));

    const inPred = inSubquery(fieldRef("p", ["id"]), subquery.toAst());

    const mainQuery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", () => inPred)
      .select((context) => ({ name: context.p.name }));

    const sqlObject = compileQuery(mainQuery.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain(" IN (");
    expect(sql).not.toContain("NOT IN");
  });

  it("compiles NOT IN subquery to SQL", () => {
    const subquery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Organization", "o")
      .select((context) => ({ id: context.o.id }));

    const notInPred = notInSubquery(fieldRef("p", ["id"]), subquery.toAst());

    const mainQuery = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .whereNode("p", () => notInPred)
      .select((context) => ({ name: context.p.name }));

    const sqlObject = compileQuery(mainQuery.toAst(), graph.id);
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("NOT IN");
  });
});

// ============================================================
// Variable-Length Paths (Recursive Traversals)
// ============================================================

describe("QueryBuilder Variable-Length Paths", () => {
  it("builds AST with recursive() option", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const ast = q.toAst();
    expect(ast.traversals).toHaveLength(1);
    const vl = ast.traversals[0]!.variableLength;
    expect(vl).toBeDefined();
    expect(vl!.minDepth).toBe(1);
    expect(vl!.maxDepth).toBe(-1); // unlimited
    expect(vl!.collectPath).toBe(false);
  });

  it("builds AST with maxHops() limit", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .maxHops(5)
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const ast = q.toAst();
    expect(ast.traversals[0]!.variableLength!.maxDepth).toBe(5);
  });

  it("builds AST with minHops() option", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .minHops(2)
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const ast = q.toAst();
    expect(ast.traversals[0]!.variableLength!.minDepth).toBe(2);
  });

  it("builds AST with collectPath() option", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .collectPath("my_path")
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const ast = q.toAst();
    expect(ast.traversals[0]!.variableLength!.collectPath).toBe(true);
    expect(ast.traversals[0]!.variableLength!.pathAlias).toBe("my_path");
  });

  it("builds AST with withDepth() option", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .withDepth("level")
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const ast = q.toAst();
    expect(ast.traversals[0]!.variableLength!.depthAlias).toBe("level");
  });

  it("can chain multiple options", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .minHops(1)
      .maxHops(10)
      .collectPath()
      .withDepth()
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const ast = q.toAst();
    const vl = ast.traversals[0]!.variableLength!;
    expect(vl).toBeDefined();
    expect(vl.minDepth).toBe(1);
    expect(vl.maxDepth).toBe(10);
    expect(vl.collectPath).toBe(true);
    expect(vl.pathAlias).toBe("o_path"); // default alias
    expect(vl.depthAlias).toBe("o_depth"); // default alias
  });

  it("compiles recursive query to SQL with WITH RECURSIVE", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const sqlObject = q.compile();
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("WITH RECURSIVE");
    expect(sql).toContain("recursive_cte");
    expect(sql).toContain("UNION ALL");
  });

  it("compiles SQLite cycle check correctly", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry, {
      dialect: "sqlite",
    })
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const sqlObject = q.compile();
    const { sql } = sqlToStrings(sqlObject);

    // SQLite uses INSTR for cycle detection
    expect(sql).toContain("INSTR");
    // SQLite uses string-based path
    expect(sql).toContain("|| n0.id ||");
  });

  it("compiles PostgreSQL cycle check correctly", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry, {
      dialect: "postgres",
    })
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const sqlObject = q.compile();
    const { sql } = sqlToStrings(sqlObject);

    // PostgreSQL uses ARRAY and != ALL for cycle detection
    expect(sql).toContain("!= ALL");
    expect(sql).toContain("ARRAY");
  });

  it("includes depth filter when minHops > 0", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .minHops(2)
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const sqlObject = q.compile();
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("WHERE depth >= ?");
  });

  it("includes maxHops in recursive condition", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .maxHops(5)
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const sqlObject = q.compile();
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("r.depth < ?");
  });

  it("includes path in projection when collectPath is true", () => {
    const q = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("worksAt", "e")
      .recursive()
      .collectPath("my_path")
      .to("Organization", "o")
      .select((context) => ({
        person: context.p.name,
        org: context.o.name,
      }));

    const sqlObject = q.compile();
    const { sql } = sqlToStrings(sqlObject);

    expect(sql).toContain("path AS my_path");
  });

  it("throws for maxHops < 1", () => {
    expect(() => {
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .recursive()
        .maxHops(0);
    }).toThrow("maxHops must be >= 1");
  });

  it("throws for minHops < 0", () => {
    expect(() => {
      createQueryBuilder<typeof graph>(graph.id, registry)
        .from("Person", "p")
        .traverse("worksAt", "e")
        .recursive()
        .minHops(-1);
    }).toThrow("minHops must be >= 0");
  });
});
