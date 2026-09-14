import { expectTypeOf, test } from "vitest";
import { z } from "zod";

import {
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  expr,
  type QualifiedRecursivePath,
} from "../src";
import { buildKindRegistry } from "../src/registry";

const Person = defineNode("Person", {
  schema: z.object({
    active: z.boolean(),
    age: z.number(),
    joinedAt: z.date().optional(),
    metadata: z.object({
      author: z.string(),
      node: z.string(),
      rank: z.number().optional(),
    }),
    name: z.string(),
    profile: z.object({ label: z.string() }).nullable(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const graph = defineGraph({
  id: "query_expression_types",
  nodes: { Company: { type: Company }, Person: { type: Person } },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
});
const registry = buildKindRegistry(graph);

test("recursive path options preserve legacy IDs and infer qualified references", () => {
  createQueryBuilder<typeof graph>(graph.id, registry)
    .from("Person", "person")
    .traverse("worksAt", "employment")
    .recursive({ path: "ids", maxHops: 1 })
    .to("Company", "company")
    .select((context) => {
      expectTypeOf(context.ids).toEqualTypeOf<readonly string[]>();
      return context.ids;
    });

  createQueryBuilder<typeof graph>(graph.id, registry)
    .from("Person", "person")
    .traverse("worksAt", "employment")
    .recursive({
      path: { alias: "route", format: "qualified" },
      maxHops: 1,
    })
    .to("Company", "company")
    .select((context) => {
      expectTypeOf(context.route).toEqualTypeOf<QualifiedRecursivePath>();
      return context.route;
    });

  createQueryBuilder<typeof graph>(graph.id, registry)
    .from("Person", "person")
    .optionalTraverse("worksAt", "employment")
    .recursive({
      depth: "depth",
      path: { alias: "route", format: "qualified" },
      maxHops: 1,
    })
    .to("Company", "company")
    .select((context) => {
      expectTypeOf(context.depth).toEqualTypeOf<number | undefined>();
      expectTypeOf(context.route).toEqualTypeOf<
        QualifiedRecursivePath | undefined
      >();
      return context.route;
    });
});

test("project and map infer database and JavaScript result types", () => {
  const projected = createQueryBuilder<typeof graph>(graph.id, registry)
    .from("Person", "person")
    .project((expressions) => ({
      author: expressions.person.metadata.author,
      doubledAge: expr.multiply(expressions.person.age, expr.literal(2)),
      joinedAt: expressions.person.joinedAt,
      metadataNode: expressions.person.metadata.$get("node"),
      profileLabel: expressions.person.profile.label,
      validFrom: expressions.person.$meta.validFrom,
    }));
  type ProjectedRow = Awaited<ReturnType<typeof projected.execute>>[number];
  expectTypeOf<ProjectedRow>().toEqualTypeOf<{
    author: string;
    doubledAge: number;
    joinedAt: Date | undefined;
    metadataNode: string;
    profileLabel: string | undefined;
    validFrom: string | undefined;
  }>();

  const mapped = projected.map((row) => `${row.author}:${row.doubledAge}`);
  type MappedRow = Awaited<ReturnType<typeof mapped.execute>>[number];
  expectTypeOf<MappedRow>().toEqualTypeOf<string>();
  void mapped;
});

test("expression callbacks expose only in-scope aliases and schema fields", () => {
  const query = createQueryBuilder<typeof graph>(graph.id, registry).from(
    "Person",
    "person",
  );

  query.whereNode("person", (_person, expressions) =>
    expr.gt(expressions.person.age, expr.literal(18)),
  );
  query.orderBy((expressions) => expressions.person.joinedAt, "desc");
  query.where((expressions) =>
    expr.gt(expressions.person.age, expr.literal(18)),
  );

  function assertInvalidQueryExpressions(): void {
    // @ts-expect-error completed-match predicates must be Boolean
    query.where((expressions) => expressions.person.age);
    // @ts-expect-error completed-match filters do not expose unknown aliases
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    query.where((expressions) => expr.isNull(expressions.company));
    query.project((expressions) => ({
      // @ts-expect-error nonexistent schema properties are rejected
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      invalid: expressions.person.nonexistent,
    }));
    query.project((expressions) => ({
      // @ts-expect-error aliases absent from this query are rejected
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      invalid: expressions.company.name,
    }));
    query.whereNode("person", (_person, expressions) =>
      // @ts-expect-error numeric comparisons reject string operands
      expr.gt(expressions.person.age, expr.literal("18")),
    );
    query.project((expressions) => ({
      // @ts-expect-error arithmetic rejects Boolean operands
      invalid: expr.add(expressions.person.active, expressions.person.active),
    }));
  }
  void assertInvalidQueryExpressions;
});

test("typed grouping, aggregates, and having infer nullable SQL results", () => {
  const aggregate = createQueryBuilder<typeof graph>(graph.id, registry)
    .from("Person", "person")
    .groupBy((expressions) => [expressions.person.metadata.author])
    .having((expressions) =>
      expr.gt(expr.count(expressions.person.id), expr.literal(1)),
    )
    .aggregate((expressions) => ({
      author: expressions.person.metadata.author,
      averageAge: expr.avg(expressions.person.age),
      people: expr.count(expressions.person.id),
    }));

  type AggregateRow = Awaited<ReturnType<typeof aggregate.execute>>[number];
  expectTypeOf<AggregateRow>().toEqualTypeOf<{
    author: string;
    averageAge: number | undefined;
    people: number;
  }>();
  void aggregate;
});

test("optional aliases make required fields and metadata nullable", () => {
  const projected = createQueryBuilder<typeof graph>(graph.id, registry)
    .from("Person", "person")
    .optionalTraverse("worksAt", "employment")
    .to("Company", "company")
    .project((expressions) => ({
      companyCreatedAt: expressions.company.$meta.createdAt,
      companyName: expressions.company.name,
      edgeCreatedAt: expressions.employment.$meta.createdAt,
      role: expressions.employment.role,
    }));

  type Row = Awaited<ReturnType<typeof projected.execute>>[number];
  expectTypeOf<Row>().toEqualTypeOf<{
    companyCreatedAt: string | undefined;
    companyName: string | undefined;
    edgeCreatedAt: string | undefined;
    role: string | undefined;
  }>();
  void projected;
});
