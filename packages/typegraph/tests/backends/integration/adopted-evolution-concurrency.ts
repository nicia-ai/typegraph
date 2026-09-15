import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  SchemaFenceTimeoutError,
  StaleVersionError,
} from "../../../src/errors";
import { defineGraphExtension } from "../../../src/graph-extension";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";
import type {
  IntegrationTestContext,
  SerializedBackendHandle,
} from "./test-context";

const Person = defineNode("FencePerson", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "adopted_evolution_contention",
  nodes: { FencePerson: { type: Person } },
  edges: {},
});
const extension = defineGraphExtension({
  nodes: {
    FenceTag: { properties: { label: { type: "string", optional: true } } },
  },
});

function quoteSqlIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function readSchemaAndNodes(
  handle: SerializedBackendHandle,
): Promise<Readonly<{ version: number; nodes: number }>> {
  const executeRaw = handle.backend.executeRaw;
  const schemaTable = handle.backend.tableNames?.schemaVersions;
  const nodesTable = handle.backend.tableNames?.nodes;
  if (
    executeRaw === undefined ||
    schemaTable === undefined ||
    nodesTable === undefined
  ) {
    throw new Error(
      "The server concurrency lane must expose raw SQL and table names.",
    );
  }
  const rows = await executeRaw<Readonly<{ version: number; nodes: string }>>(
    `SELECT (SELECT version FROM ${quoteSqlIdentifier(schemaTable)} WHERE graph_id = $1 AND is_active = TRUE) AS version, ` +
      `(SELECT COUNT(*) FROM ${quoteSqlIdentifier(nodesTable)} WHERE graph_id = $1) AS nodes`,
    [graph.id],
  );
  const row = rows[0];
  if (row === undefined)
    throw new Error("The snapshot statement returned no row.");
  return { version: row.version, nodes: Number(row.nodes) };
}

export function registerAdoptedEvolutionConcurrencyTests(
  context: IntegrationTestContext,
): void {
  describe("adopted evolution on independent PostgreSQL sessions", () => {
    it.skipIf(!context.serverLaneConcurrency)(
      "returns success or its typed deadline while finite ordinary writers keep arriving",
      async () => {
        const writer = await context.createSerializedBackend();
        const evolver = await context.createSerializedBackend();
        const firstWrite = createGate();
        const writerState = { active: true, completedWrites: 0 };
        try {
          const [writerStore] = await createAdapterStoreWithSchema(
            graph,
            writer.backend,
          );
          const [evolverStore] = await createAdapterStoreWithSchema(
            graph,
            evolver.backend,
          );
          const plan = await evolverStore.planEvolution(extension);
          const writerLoop = (async (): Promise<void> => {
            while (writerState.active) {
              try {
                await writer.backend.transactionWithNative(
                  async (_target, nativeTx) => {
                    await writerStore.withRecordedTransaction(
                      nativeTx,
                      async (tx) => {
                        await tx.nodes.FencePerson.create({
                          name: `writer ${writerState.completedWrites}`,
                        });
                      },
                    );
                  },
                );
                writerState.completedWrites += 1;
                firstWrite.open();
                await new Promise<void>((resolve) => setImmediate(resolve));
              } catch (error) {
                // Once evolution wins, a Store still bound to the old schema
                // must stop issuing writes rather than refreshing under load.
                if (error instanceof StaleVersionError) return;
                throw error;
              }
            }
          })();
          await firstWrite.opened;
          const startedAt = performance.now();
          const acquisition = await evolver.backend
            .transactionWithNative((_target, nativeTx) =>
              evolverStore.withEvolvedTransaction(
                nativeTx,
                plan,
                () => Promise.resolve("applied"),
                { waitBudgetMs: 200 },
              ),
            )
            .then(
              () => ({ status: "success" as const }),
              (error: unknown) => ({ status: "failure" as const, error }),
            );
          writerState.active = false;
          expect(
            acquisition.status === "success" ||
              acquisition.error instanceof SchemaFenceTimeoutError,
          ).toBe(true);
          expect(performance.now() - startedAt).toBeLessThan(2000);
          await writerLoop;
          expect(writerState.completedWrites).toBeGreaterThan(0);
        } finally {
          writerState.active = false;
          await Promise.all([writer.close(), evolver.close()]);
        }
      },
    );

    it.skipIf(!context.serverLaneConcurrency)(
      "times out within a finite budget while an ordinary writer holds the schema row",
      async () => {
        const holder = await context.createSerializedBackend();
        const evolver = await context.createSerializedBackend();
        const held = createGate();
        const release = createGate();
        try {
          const [writerStore] = await createAdapterStoreWithSchema(
            graph,
            holder.backend,
          );
          const [evolverStore] = await createAdapterStoreWithSchema(
            graph,
            evolver.backend,
          );
          const plan = await evolverStore.planEvolution(extension);
          const holdingTransaction = holder.backend.transactionWithNative(
            async (_target, nativeTx) => {
              await writerStore.withRecordedTransaction(
                nativeTx,
                async (tx) => {
                  await tx.nodes.FencePerson.create({ name: "holder" });
                },
              );
              held.open();
              await release.opened;
            },
          );
          await held.opened;
          const startedAt = Date.now();
          await expect(
            evolver.backend.transactionWithNative((_target, nativeTx) =>
              evolverStore.withEvolvedTransaction(
                nativeTx,
                plan,
                () => Promise.resolve("unreached"),
                { waitBudgetMs: 150 },
              ),
            ),
          ).rejects.toBeInstanceOf(SchemaFenceTimeoutError);
          expect(Date.now() - startedAt).toBeLessThan(2000);
          release.open();
          await holdingTransaction;
        } finally {
          release.open();
          await Promise.all([holder.close(), evolver.close()]);
        }
      },
    );

    it.skipIf(!context.serverLaneConcurrency)(
      "acquires after the holder releases and exposes schema plus graph writes in one snapshot",
      async () => {
        const holder = await context.createSerializedBackend();
        const evolver = await context.createSerializedBackend();
        const reader = await context.createSerializedBackend();
        const held = createGate();
        const release = createGate();
        const applied = createGate();
        const commit = createGate();
        try {
          const [writerStore] = await createAdapterStoreWithSchema(
            graph,
            holder.backend,
          );
          const [evolverStore] = await createAdapterStoreWithSchema(
            graph,
            evolver.backend,
          );
          const plan = await evolverStore.planEvolution(extension);
          const holdingTransaction = holder.backend.transactionWithNative(
            async (_target, nativeTx) => {
              await writerStore.withRecordedTransaction(
                nativeTx,
                async (tx) => {
                  await tx.nodes.FencePerson.create({ name: "holder" });
                },
              );
              held.open();
              await release.opened;
            },
          );
          await held.opened;
          const evolution = evolver.backend.transactionWithNative(
            async (_target, nativeTx) => {
              const outcome = await evolverStore.withEvolvedTransaction(
                nativeTx,
                plan,
                async (tx) => {
                  await tx.nodes.FencePerson.create({ name: "evolved" });
                },
                { waitBudgetMs: 2000 },
              );
              applied.open();
              await commit.opened;
              return outcome;
            },
          );
          expect(await raceTimeout(applied.opened, 50)).toBe(TIMEOUT_SENTINEL);
          release.open();
          await holdingTransaction;
          await applied.opened;
          // One statement on a genuinely independent session sees the
          // pre-commit schema and graph rows together.
          expect(await readSchemaAndNodes(reader)).toEqual({
            version: 1,
            nodes: 1,
          });
          commit.open();
          await evolution;
          expect(await readSchemaAndNodes(reader)).toEqual({
            version: 2,
            nodes: 2,
          });
        } finally {
          release.open();
          commit.open();
          await Promise.all([holder.close(), evolver.close(), reader.close()]);
        }
      },
    );

    it.skipIf(!context.serverLaneConcurrency)(
      "releases the adopted schema fence when the outer native transaction rolls back",
      async () => {
        const holder = await context.createSerializedBackend();
        const follower = await context.createSerializedBackend();
        const applied = createGate();
        const rollback = createGate();
        try {
          const [holderStore] = await createAdapterStoreWithSchema(
            graph,
            holder.backend,
          );
          const [followerStore] = await createAdapterStoreWithSchema(
            graph,
            follower.backend,
          );
          const holderPlan = await holderStore.planEvolution(extension);
          const followerPlan = await followerStore.planEvolution(extension);
          const holdingTransaction = holder.backend.transactionWithNative(
            async (_target, nativeTx) => {
              await holderStore.withEvolvedTransaction(
                nativeTx,
                holderPlan,
                () => Promise.resolve("provisional"),
              );
              applied.open();
              await rollback.opened;
              throw new Error("roll back schema fence holder");
            },
          );
          await applied.opened;
          const followingTransaction = follower.backend.transactionWithNative(
            (_target, nativeTx) =>
              followerStore.withEvolvedTransaction(
                nativeTx,
                followerPlan,
                () => Promise.resolve("committed"),
                { waitBudgetMs: 2000 },
              ),
          );
          expect(await raceTimeout(followingTransaction, 50)).toBe(
            TIMEOUT_SENTINEL,
          );
          rollback.open();
          await expect(holdingTransaction).rejects.toThrow(
            "roll back schema fence holder",
          );
          const outcome = await followingTransaction;
          expect(outcome.result).toBe("committed");
          const activeSchema = await follower.backend.getActiveSchema(graph.id);
          expect(activeSchema?.version).toBe(2);
        } finally {
          rollback.open();
          await Promise.all([holder.close(), follower.close()]);
        }
      },
    );
  });
}
