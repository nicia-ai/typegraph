/**
 * Tests for `.fuseWith()` — the query-builder API for tunable RRF, and
 * the validator shared with `store.search.hybrid({ fusion })`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  searchable,
  UnsupportedPredicateError,
  ValidationError,
} from "../src";
import { createQueryBuilder } from "../src/query/builder";
import { validateHybridFusionOptions } from "../src/query/builder/validation";
import { compileQuery } from "../src/query/compiler";
import { buildKindRegistry } from "../src/registry";
import { toSqlString } from "./sql-test-utils";

const HybridDocument = defineNode("HybridDoc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    embedding: embedding(4),
  }),
});

const HybridGraph = defineGraph({
  id: "fuse-with-test",
  nodes: { HybridDoc: { type: HybridDocument } },
  edges: {},
});

function buildHybridQuery(
  fusion?: Parameters<ReturnType<typeof makeBuilder>["fuseWith"]>[0],
): ReturnType<typeof compileQuery> {
  const builder = makeBuilder();
  let q = builder
    .from("HybridDoc", "d")
    .whereNode("d", (d) =>
      d.$fulltext
        .matches("anything", 50)
        .and(d.embedding.similarTo([0.1, 0.2, 0.3, 0.4], 50)),
    );
  if (fusion !== undefined) {
    q = q.fuseWith(fusion);
  }
  const ast = q.select((ctx) => ctx.d).toAst();
  return compileQuery(ast, HybridGraph.id, { dialect: "postgres" });
}

function makeBuilder(): ReturnType<
  typeof createQueryBuilder<typeof HybridGraph>
> {
  return createQueryBuilder<typeof HybridGraph>(
    HybridGraph.id,
    buildKindRegistry(HybridGraph),
  );
}

describe(".fuseWith()", () => {
  it("threads a custom k into the compiled RRF ORDER BY", () => {
    const compiled = buildHybridQuery({ k: 30 });
    const sqlText = toSqlString(compiled);
    expect(sqlText).toMatch(/1 \/ \(30 \+ cte_embeddings\.ord\)/);
    expect(sqlText).toMatch(/1 \/ \(30 \+ cte_fulltext\.ord\)/);
  });

  it("threads fulltext weight into the compiled RRF ORDER BY", () => {
    const compiled = buildHybridQuery({ weights: { fulltext: 2 } });
    const sqlText = toSqlString(compiled);
    expect(sqlText).toMatch(/2 \/ \(60 \+ cte_fulltext\.ord\)/);
    expect(sqlText).toMatch(/1 \/ \(60 \+ cte_embeddings\.ord\)/);
  });

  it("threads vector weight and k together", () => {
    const compiled = buildHybridQuery({
      k: 42,
      weights: { vector: 1.3, fulltext: 0.7 },
    });
    const sqlText = toSqlString(compiled);
    expect(sqlText).toMatch(/1\.3 \/ \(42 \+ cte_embeddings\.ord\)/);
    expect(sqlText).toMatch(/0\.7 \/ \(42 \+ cte_fulltext\.ord\)/);
  });

  it("rejects invalid k values via validateHybridFusionOptions", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => {
        validateHybridFusionOptions({ k: bad });
      }).toThrow(ValidationError);
    }
  });

  it("rejects negative or non-finite weights", () => {
    for (const bad of [-1, Number.NaN]) {
      expect(() => {
        validateHybridFusionOptions({ weights: { vector: bad } });
      }).toThrow(ValidationError);
      expect(() => {
        validateHybridFusionOptions({ weights: { fulltext: bad } });
      }).toThrow(ValidationError);
    }
  });

  it("rejects unsupported fusion methods", () => {
    expect(() => {
      validateHybridFusionOptions({ method: "custom" as "rrf" });
    }).toThrow(ValidationError);
  });

  it("throws at compile time when fuseWith is set without vector predicate", () => {
    const builder = makeBuilder();
    const ast = builder
      .from("HybridDoc", "d")
      .whereNode("d", (d) => d.$fulltext.matches("anything", 10))
      .fuseWith({ k: 60 })
      .select((ctx) => ctx.d)
      .toAst();
    expect(() =>
      compileQuery(ast, HybridGraph.id, { dialect: "postgres" }),
    ).toThrow(UnsupportedPredicateError);
  });

  it("throws at compile time when fuseWith is set without fulltext predicate", () => {
    const builder = makeBuilder();
    const ast = builder
      .from("HybridDoc", "d")
      .whereNode("d", (d) => d.embedding.similarTo([0.1, 0.2, 0.3, 0.4], 10))
      .fuseWith({ k: 60 })
      .select((ctx) => ctx.d)
      .toAst();
    expect(() =>
      compileQuery(ast, HybridGraph.id, { dialect: "postgres" }),
    ).toThrow(UnsupportedPredicateError);
  });

  it(".fuseWith() itself throws for bad values at call time", () => {
    const builder = makeBuilder();
    const queryBase = builder.from("HybridDoc", "d");
    expect(() => queryBase.fuseWith({ k: -1 })).toThrow(ValidationError);
    expect(() =>
      queryBase.fuseWith({ weights: { fulltext: Number.NaN } }),
    ).toThrow(ValidationError);
  });
});
