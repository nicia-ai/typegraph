import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createQueryBuilder,
  createStore,
  defineGraph,
  defineNode,
  expr,
  UnsupportedPredicateError,
} from "../src";
import { buildKindRegistry } from "../src/registry";
import { createTestBackend } from "./test-utils";

const Product = defineNode("Product", {
  schema: z.object({
    category: z.string(),
    name: z.string(),
    score: z.number(),
  }),
});
const graph = defineGraph({
  id: "partitioned-top-n-validation",
  nodes: { Product: { type: Product } },
  edges: {},
});

function productRelation() {
  return createQueryBuilder<typeof graph>(graph.id, buildKindRegistry(graph))
    .from("Product", "product")
    .project((fields) => ({
      category: fields.product.category,
      name: fields.product.name,
      score: fields.product.score,
    }))
    .asRelation();
}

describe("partitioned top-N validation", () => {
  it("refuses malformed dynamic options and callback results before execution", () => {
    const relation = productRelation();
    type Options = Parameters<typeof relation.topPerPartition>[0];
    const valid: Options = {
      partitionBy: (columns) => [columns.category],
      orderBy: (columns) => [{ expression: columns.score }],
      limit: 1,
    };
    for (const dynamic of [
      undefined,
      // eslint-disable-next-line unicorn/no-null -- Exercise an untyped caller passing SQL/JSON null.
      null,
      { ...valid, unknown: true },
      { ...valid, partitionBy: () => "category" },
      { ...valid, partitionBy: () => [undefined] },
      { ...valid, orderBy: () => "score" },
      { ...valid, orderBy: () => [undefined] },
      { ...valid, orderBy: () => [{ expression: undefined }] },
      {
        ...valid,
        orderBy: () => [{ expression: expr.literal(1), extra: true }],
      },
      {
        ...valid,
        orderBy: () => [{ expression: expr.literal(1), direction: "up" }],
      },
      {
        ...valid,
        orderBy: () => [{ expression: expr.literal(1), nulls: "middle" }],
      },
    ])
      expect(() =>
        relation.topPerPartition(dynamic as unknown as Options),
      ).toThrow(ConfigurationError);
  });

  it("refuses aggregate partition and ordering expressions", () => {
    const relation = productRelation();
    expect(() =>
      relation
        .topPerPartition({
          partitionBy: (columns) => [expr.sum(columns.score)],
          orderBy: (columns) => [{ expression: columns.name }],
          limit: 1,
        })
        .compile(),
    ).toThrow(UnsupportedPredicateError);
    expect(() =>
      relation
        .topPerPartition({
          partitionBy: (columns) => [columns.category],
          orderBy: (columns) => [{ expression: expr.sum(columns.score) }],
          limit: 1,
        })
        .compile(),
    ).toThrow(UnsupportedPredicateError);
  });

  it("copies callback key arrays when the stage is created", async () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);
    for (const product of [
      { category: "A", name: "a-low", score: 10 },
      { category: "A", name: "a-high", score: 20 },
      { category: "B", name: "b-high", score: 30 },
    ])
      await store.nodes.Product.create(product);
    const relation = store
      .query()
      .from("Product", "product")
      .project((fields) => ({
        category: fields.product.category,
        name: fields.product.name,
        score: fields.product.score,
      }))
      .asRelation();
    type Options = Parameters<typeof relation.topPerPartition>[0];
    let partitionKeys: unknown[] = [];
    let orderKeys: unknown[] = [];
    const ranked = relation
      .topPerPartition({
        partitionBy: (columns) => {
          partitionKeys = [columns.category];
          return partitionKeys as unknown as ReturnType<Options["partitionBy"]>;
        },
        orderBy: (columns) => {
          orderKeys = [{ expression: columns.score, direction: "desc" }];
          return orderKeys as unknown as ReturnType<Options["orderBy"]>;
        },
        limit: 1,
      })
      .orderBy((columns) => columns.category);
    partitionKeys.length = 0;
    orderKeys.length = 0;
    expect(await ranked.execute()).toEqual([
      { category: "A", name: "a-high", score: 20 },
      { category: "B", name: "b-high", score: 30 },
    ]);
  });
});
