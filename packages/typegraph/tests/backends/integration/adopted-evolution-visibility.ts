import { expect } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import type { AdapterBackend, GraphBackend } from "../../../src/backend/types";
import { defineGraphExtension } from "../../../src/graph-extension";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";

const Person = defineNode("VisibilityPerson", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "adopted_evolution_visibility",
  nodes: { VisibilityPerson: { type: Person } },
  edges: {},
});

async function snapshot(backend: GraphBackend) {
  const tables = requireDefined(backend.tableNames);
  const rows = await backend.execute<{
    version: number;
    count: number | string;
  }>(
    asCompiledRowsSql(sql`
      SELECT
        (SELECT version FROM ${sql.identifier(requireDefined(tables.schemaVersions))}
         WHERE graph_id = ${graph.id} AND is_active = TRUE) AS version,
        (SELECT COUNT(*) FROM ${sql.identifier(tables.nodes)}
         WHERE graph_id = ${graph.id}) AS count
    `),
  );
  const row = requireDefined(rows[0]);
  return { version: row.version, count: Number(row.count) };
}

/** The callers must supply independently opened connections to one database. */
export async function assertAdoptedEvolutionVisibility<TNativeTransaction>(
  writer: AdapterBackend<TNativeTransaction>,
  reader: GraphBackend,
): Promise<void> {
  const [store] = await createAdapterStoreWithSchema(graph, writer);
  const before = await snapshot(reader);
  const plan = await store.planEvolution(
    defineGraphExtension({
      nodes: { VisibilityTag: { properties: { label: { type: "string" } } } },
    }),
  );
  if (plan.status !== "change")
    throw new Error("Expected a fresh change plan.");
  await writer.transactionWithNative(async (_target, nativeTx) => {
    await store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
      await tx.nodes.VisibilityPerson.create({ name: "committed" });
    });
    // Even after TypeGraph returns its receipt, the outer transaction has not
    // committed. A separate connection must see neither part of the change.
    expect(await snapshot(reader)).toEqual(before);
  });
  const committed = { version: plan.resultingVersion, count: 1 };
  expect(await snapshot(reader)).toEqual(committed);

  const refreshed = await store.refreshSchema();
  const rolledBackPlan = await refreshed.planEvolution(
    defineGraphExtension({
      nodes: { VisibilityDraft: { properties: { label: { type: "string" } } } },
    }),
  );
  const abort = new Error("abort outer visibility transaction");
  await expect(
    writer.transactionWithNative(async (_target, nativeTx) => {
      await refreshed.withEvolvedTransaction(
        nativeTx,
        rolledBackPlan,
        async (tx) => {
          await tx.nodes.VisibilityPerson.create({ name: "rolled back" });
        },
      );
      expect(await snapshot(reader)).toEqual(committed);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await snapshot(reader)).toEqual(committed);
}
