import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  count,
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  ValidationError,
} from "../src";
import { buildKindRegistry } from "../src/registry";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows");
const graph = defineGraph({
  id: "query-state-contracts",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});
function query() {
  return createQueryBuilder<typeof graph>(graph.id, buildKindRegistry(graph));
}

describe("query state contracts", () => {
  it("refuses unsupported legacy sort directions", () => {
    expect(() =>
      // @ts-expect-error JavaScript callers can provide invalid directions.
      query().from("Person", "person").orderBy("person", "name", "sideways"),
    ).toThrow(ConfigurationError);
  });
  it("refuses empty expression grouping", () => {
    expect(() =>
      query()
        .from("Person", "person")
        .groupBy(() => []),
    ).toThrow(ConfigurationError);
  });
  it("refuses symbol-keyed SQL projections rather than dropping fields", () => {
    const output = Symbol("output");
    expect(() =>
      query()
        .from("Person", "person")
        .project((expressions) => ({
          name: expressions.person.name,
          [output]: expressions.person.id,
        })),
    ).toThrow(ConfigurationError);
  });
  it("refuses replacing a query source", () => {
    expect(() => query().from("Person", "p").from("Person", "q")).toThrow(
      ValidationError,
    );
    expect(() =>
      query().from("Person", "p").fromDynamic("Person", "q"),
    ).toThrow(ValidationError);
  });
  it("refuses collisions across node, edge and recursive aliases", () => {
    expect(() =>
      query().from("Person", "p").traverse("knows", "p").to("Person", "q"),
    ).toThrow(ValidationError);
    expect(() =>
      query().from("Person", "p").traverse("knows", "e").to("Person", "e"),
    ).toThrow(ValidationError);
    expect(() =>
      query()
        .from("Person", "p")
        .traverse("knows", "e")
        .recursive({ path: "p" })
        .to("Person", "q"),
    ).toThrow(ValidationError);
  });
  it.each([
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("refuses invalid bound %s on each stage", (value) => {
    const base = query().from("Person", "p");
    const selected = base.select((ctx) => ctx.p);
    const aggregated = base
      .groupBy("p", "name")
      .aggregate({ name: field("p", "name"), total: count("p") });
    const combined = selected.unionAll(selected);
    for (const stage of [base, selected, aggregated, combined]) {
      expect(() => stage.limit(value)).toThrow(ValidationError);
      expect(() => stage.offset(value)).toThrow(ValidationError);
    }
  });
});
