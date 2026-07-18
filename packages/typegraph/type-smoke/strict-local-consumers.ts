import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph/core";
import { createLocalPgliteStore } from "@nicia-ai/typegraph/postgres/pglite-store";
import {
  createLocalSqliteStore,
  type TypedStoreFacade,
} from "@nicia-ai/typegraph/sqlite/local-store";
import { z } from "zod";

const Fact = defineNode("Fact", {
  schema: z.object({ statement: z.string() }),
});

const Source = defineNode("Source", {
  schema: z.object({ url: z.url() }),
});

const supports = defineEdge("supports", {
  schema: z.object({ confidence: z.number().min(0).max(1) }),
});

const graph = defineGraph({
  id: "strict-local-consumers",
  nodes: { Fact: { type: Fact }, Source: { type: Source } },
  edges: {
    supports: { type: supports, from: [Source], to: [Fact] },
  },
});

type ExerciseResult = Readonly<{
  statement: string;
  confidence: number;
  factCount: number;
}>;

async function exerciseStore(
  store: TypedStoreFacade<typeof graph>,
): Promise<ExerciseResult> {
  try {
    const source = await store.nodes.Source.create({
      url: "https://example.com/source",
    });
    const fact = await store.nodes.Fact.create({ statement: "draft" });
    if (false) {
      // @ts-expect-error The Fact schema requires a string statement.
      await store.nodes.Fact.create({ statement: 42 });
      // @ts-expect-error The supports edge only accepts Source -> Fact.
      await store.edges.supports.create(fact, source, { confidence: 0.5 });
    }
    const updatedFact = await store.nodes.Fact.update(fact.id, {
      statement: "verified",
    });
    const edge = await store.edges.supports.create(source, updatedFact, {
      confidence: 0.9,
    });

    const fetchedFact = await store.nodes.Fact.getById(updatedFact.id);
    const fetchedEdge = await store.edges.supports.getById(edge.id);
    if (fetchedFact === undefined || fetchedEdge === undefined) {
      throw new Error("Packed local consumer could not read created records.");
    }

    await store.edges.supports.delete(edge.id);
    await store.nodes.Fact.delete(updatedFact.id);

    return {
      statement: fetchedFact.statement,
      confidence: fetchedEdge.confidence,
      factCount: await store.nodes.Fact.count(),
    };
  } finally {
    await store.close();
  }
}

export async function exerciseStrictLocalConsumers(): Promise<
  Readonly<{ sqlite: ExerciseResult; pglite: ExerciseResult }>
> {
  const sqliteStore = await createLocalSqliteStore(graph);
  const sqlite = await exerciseStore(sqliteStore);
  const pgliteStore = await createLocalPgliteStore(graph, { vector: false });
  const pglite = await exerciseStore(pgliteStore);
  return { sqlite, pglite };
}
