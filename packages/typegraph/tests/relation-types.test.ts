import { expectTypeOf, test } from "vitest";
import { z } from "zod";

import { createQueryBuilder, defineGraph, defineNode, expr } from "../src";
import { buildKindRegistry } from "../src/registry";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});
const graph = defineGraph({
  id: "relation-types",
  nodes: { Person: { type: Person } },
  edges: {},
});

test("derived projections retain column types and inferred prepared declarations", () => {
  const names = createQueryBuilder<typeof graph>(
    graph.id,
    buildKindRegistry(graph),
  )
    .from("Person", "person")
    .project((fields) => ({ name: fields.person.name, age: fields.person.age }))
    .asRelation();
  const derived = names.project((columns) => ({
    name: columns.name,
    age: expr.add(columns.age, expr.literal(1)),
  }));
  const otherAlias = createQueryBuilder<typeof graph>(
    graph.id,
    buildKindRegistry(graph),
  )
    .from("Person", "other")
    .project((fields) => ({ name: fields.other.name, age: fields.other.age }))
    .asRelation();
  const combined = names.union(otherAlias);
  expectTypeOf<Awaited<ReturnType<typeof combined.execute>>>().toEqualTypeOf<
    readonly { name: string; age: number | undefined }[]
  >();
  void combined;
  expectTypeOf<Awaited<ReturnType<typeof derived.execute>>>().toEqualTypeOf<
    readonly { name: string; age: number | undefined }[]
  >();
  const parameters = { minimum: expr.param("minimum", "number") };
  const prepared = derived
    .where((columns) => expr.gt(columns.age, parameters.minimum))
    .prepare(parameters);
  expectTypeOf<Parameters<typeof prepared.execute>[0]>().toEqualTypeOf<
    Readonly<{ minimum: number }>
  >();
  expectTypeOf<Awaited<ReturnType<typeof prepared.execute>>>().toEqualTypeOf<
    readonly { name: string; age: number | undefined }[]
  >();
  const bound = prepared.bind({ minimum: 18 });
  expectTypeOf<Awaited<ReturnType<typeof bound.execute>>>().toEqualTypeOf<
    readonly { name: string; age: number | undefined }[]
  >();
  void bound;

  function assertInvalidRelationTypes(): void {
    derived.where((columns) =>
      // @ts-expect-error A derived scope contains output columns, not graph aliases.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
      expr.eq(columns.person.name, expr.literal("Ada")),
    );
    // @ts-expect-error Missing binding.
    void prepared.execute({});
    // @ts-expect-error Wrong binding type.
    void prepared.execute({ minimum: "18" });
    // @ts-expect-error Undeclared binding.
    void prepared.execute({ minimum: 18, maximum: 40 });
    // @ts-expect-error Wrong column operand type.
    derived.where((columns) => expr.eq(columns.age, expr.literal("18")));
  }
  void assertInvalidRelationTypes;
});
