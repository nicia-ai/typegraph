import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  SchemaContentConflictError,
  TransactionClosedError,
  UnsupportedBackendCapabilityError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { defineGraphExtension } from "../../../src/graph-extension";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../../src/query/sql-intent";
import type { EvolutionPlan } from "../../../src/schema";
import type { EvolvedTransactionOptions } from "../../../src/store/evolution";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const Person = defineNode("AdoptedPerson", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "shared_adopted_evolution",
  nodes: { AdoptedPerson: { type: Person } },
  edges: {},
});
const extension = defineGraphExtension({
  nodes: {
    AdoptedTag: { properties: { label: { type: "string", optional: true } } },
  },
});
const requiredTag = defineGraphExtension({
  nodes: { AdoptedTag: { properties: { label: { type: "string" } } } },
});

async function assertUnsupportedAdoption(
  run: () => Promise<unknown>,
): Promise<void> {
  await expect(run()).rejects.toThrow(UnsupportedBackendCapabilityError);
}

export function registerAdoptedEvolutionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Adopted schema evolution", () => {
    it("commits schema, graph writes, and an exact receipt in one native transaction", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
        revisionTracking: true,
      });
      const plan = await store.planEvolution(extension);
      expect(plan.status).toBe("change");
      if (plan.status !== "change") return;
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
              return "unreached";
            }),
          ),
        );
        return;
      }
      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            tx.requestRecordedRevision();
            await tx.nodes.AdoptedPerson.create({ name: "Ada" });
            return "applied";
          }),
      );
      expect(outcome.result).toBe("applied");
      expect(outcome.receipt.schema).toEqual({
        version: plan.resultingVersion,
        hash: plan.resultingHash,
      });
      expect(outcome.receipt.writes.nodes).toEqual({ AdoptedPerson: 1 });
      expect(outcome.receipt.recorded).toBeDefined();
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.resultingVersion);
      expect(active?.schema_hash).toBe(plan.resultingHash);
      expect(store.getNodeCollection("AdoptedTag")).toBeUndefined();
      const refreshed = await store.refreshSchema({
        expectedVersion: plan.resultingVersion,
      });
      expect(refreshed.getNodeCollection("AdoptedTag")).toBeDefined();
    });

    it("allocates a recorded checkpoint for a schema-only evolution", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
        revisionTracking: true,
      });
      const plan = await store.planEvolution(extension);
      if (plan.status !== "change") throw new Error("Expected change plan.");
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            tx.requestRecordedRevision();
            await Promise.resolve();
          }),
      );
      expect(outcome.receipt.writes.total).toBe(0);
      expect(outcome.receipt.recorded).toBeDefined();
      expect(outcome.receipt.schema).toEqual({
        version: plan.resultingVersion,
        hash: plan.resultingHash,
      });
    });

    it("rolls back caller application SQL with schema and graph writes", async () => {
      const backend = context.getBackend();
      if (
        backend.executeDdl === undefined ||
        backend.executeRaw === undefined ||
        backend.compileSql === undefined
      )
        return;
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const tableName = "shared_evolution_app_events";
      await backend.executeDdl(
        `CREATE TABLE IF NOT EXISTS ${tableName} (graph_id TEXT, label TEXT)`,
      );
      const before = await backend.getActiveSchema(graph.id);
      await expect(
        backend.transactionWithNative(async (target, nativeTx) => {
          await store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "atomic" });
          });
          if (target.executeStatement === undefined)
            throw new Error("Native target lacks application SQL execution.");
          await target.executeStatement(
            asCompiledStatementSql(sql`
              INSERT INTO ${sql.raw(tableName)} (graph_id, label)
              VALUES (${graph.id}, ${"rolled back"})
            `),
          );
          throw new Error("application rollback");
        }),
      ).rejects.toThrow("application rollback");
      const query = backend.compileSql(sql`
        SELECT graph_id, label FROM ${sql.raw(tableName)} WHERE graph_id = ${graph.id}
      `);
      const events = await backend.executeRaw<{
        graph_id: string;
        label: string;
      }>(query.sql, query.params);
      expect(events).toEqual([]);
      expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
      const after = await backend.getActiveSchema(graph.id);
      expect(after?.version).toBe(before?.version);
    });

    it("rolls back schema and callback writes when the outer unit fails", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const before = await backend.getActiveSchema(graph.id);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) => {
          await store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "Rolled back" });
          });
          throw new Error("outer application failure");
        }),
      ).rejects.toThrow("outer application failure");
      const after = await backend.getActiveSchema(graph.id);
      expect(after?.version).toBe(before?.version);
      expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
    });

    it("refuses forged and stale plans before callback writes", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const forged: EvolutionPlan = { ...plan };
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, forged, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "Forged" });
          }),
        ),
      ).rejects.toThrow();
      expect(await store.nodes.AdoptedPerson.find()).toEqual([]);

      await store.evolve(extension);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "Stale" });
          }),
        ),
      ).rejects.toThrow();
      expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
    });

    it("refuses unsupported options before callback execution", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      const runtimeOptions = {
        waitBudgetMs: 5000,
        ref: { current: store },
      } as unknown as EvolvedTransactionOptions;
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(
            nativeTx,
            plan,
            async (tx) => {
              await tx.nodes.AdoptedPerson.create({
                name: "unsupported option",
              });
            },
            runtimeOptions,
          ),
        ),
      ).rejects.toThrow(ConfigurationError);
      expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
    });

    it("rejects a same-version schema hash conflict under the fence", async () => {
      const backend = context.getBackend();
      if (backend.executeStatement === undefined) return;
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const tableName =
        backend.tableNames?.schemaVersions ?? "typegraph_schema_versions";
      await backend.executeStatement(
        asCompiledStatementSql(sql`
          UPDATE ${sql.raw(tableName)} SET schema_hash = ${"0".repeat(64)}
          WHERE graph_id = ${graph.id} AND version = ${plan.baselineVersion}
        `),
      );
      try {
        await expect(
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
              await tx.nodes.AdoptedPerson.create({ name: "wrong hash" });
            }),
          ),
        ).rejects.toThrow(SchemaContentConflictError);
        expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
      } finally {
        await backend.executeStatement(
          asCompiledStatementSql(sql`
            UPDATE ${sql.raw(tableName)} SET schema_hash = ${plan.baselineHash}
            WHERE graph_id = ${graph.id} AND version = ${plan.baselineVersion}
          `),
        );
      }
    });

    it("dispatches a satisfied no-op through ordinary adopted capture", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const evolved = await store.evolve(extension);
      const plan = await evolved.planEvolution(extension);
      expect(plan.status).toBe("noop");
      const version = requireDefined(
        await backend.getActiveSchema(graph.id),
      ).version;
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          evolved.withEvolvedTransaction(
            nativeTx,
            plan,
            async (tx) => {
              await tx.nodes.AdoptedPerson.create({ name: "budget ignored" });
            },
            { waitBudgetMs: 10 },
          ),
        ),
      ).rejects.toMatchObject({
        code: "CONFIGURATION_ERROR",
        details: { code: "EVOLUTION_NOOP_FENCE_BUDGET_UNSUPPORTED" },
      });
      expect(await evolved.nodes.AdoptedPerson.find()).toEqual([]);
      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          evolved.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "No-op" });
          }),
      );
      expect(outcome.receipt.schema.version).toBe(version);
      expect(
        requireDefined(await backend.getActiveSchema(graph.id)).version,
      ).toBe(version);
    });

    it("expires escaped callback reads after success and failure", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      let escapedRead: (() => Promise<unknown>) | undefined;
      let escapedPrepared: (() => Promise<unknown>) | undefined;
      let escapedBatch: (() => Promise<unknown>) | undefined;
      await backend.transactionWithNative(async (_target, nativeTx) => {
        await store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
          escapedRead = () => tx.nodes.AdoptedPerson.find();
          const prepared = tx
            .query()
            .from("AdoptedPerson", "person")
            .select((select) => select.person.name)
            .prepare();
          escapedPrepared = () => prepared.execute();
          escapedBatch = () =>
            tx.batchOnce(
              () =>
                [
                  tx
                    .query()
                    .from("AdoptedPerson", "person")
                    .select((select) => select.person.name),
                ] as const,
            );
          await Promise.resolve();
        });
        // The caller's SQL transaction is still open; the callback scope is sealed.
        await expect(
          Promise.resolve().then(() => requireDefined(escapedRead)()),
        ).rejects.toThrow(TransactionClosedError);
        await expect(
          Promise.resolve().then(() => requireDefined(escapedPrepared)()),
        ).rejects.toThrow(TransactionClosedError);
        await expect(
          Promise.resolve().then(() => requireDefined(escapedBatch)()),
        ).rejects.toThrow(TransactionClosedError);
      });

      const caughtUp = await store.refreshSchema({ expectedVersion: 2 });
      const noOp = await caughtUp.planEvolution(extension);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) => {
          await caughtUp.withEvolvedTransaction(nativeTx, noOp, async (tx) => {
            escapedRead = () => tx.nodes.AdoptedPerson.find();
            await Promise.resolve();
            throw new Error("callback failed");
          });
        }),
      ).rejects.toThrow("callback failed");
      await expect(
        Promise.resolve().then(() => requireDefined(escapedRead)()),
      ).rejects.toThrow(TransactionClosedError);
    });

    it("rechecks required-empty tightening against current rows", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const evolved = await store.evolve(extension);
      await evolved
        .getNodeCollectionOrThrow("AdoptedTag")
        .create({ label: "present" });
      const plan = await evolved.planEvolution(requiredTag);
      if (plan.status !== "change")
        throw new Error("Expected tightening plan.");
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            evolved.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      expect(plan.requirements.requireEmpty).toEqual([
        { entity: "node", kindName: "AdoptedTag" },
      ]);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          evolved.withEvolvedTransaction(nativeTx, plan, async () => {
            await Promise.resolve();
            return "unreached";
          }),
        ),
      ).rejects.toThrow();
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.baselineVersion);
    });

    it("accepts required-empty tightening when the kind has no rows", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const evolved = await store.evolve(extension);
      const plan = await evolved.planEvolution(requiredTag);
      if (plan.status !== "change")
        throw new Error("Expected tightening plan.");
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            evolved.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          evolved.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "after tightening" });
          }),
      );
      expect(outcome.receipt.schema.version).toBe(plan.resultingVersion);
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.resultingVersion);
    });

    it("refuses vector provisioning before adopting the native transaction", async () => {
      const backend = context.getBackend();
      const originalAdopt = backend.adoptSchemaWriteTransaction;
      let adoptCalls = 0;
      const guarded = deriveBackend(
        backend,
        originalAdopt === undefined ?
          {}
        : {
            adoptSchemaWriteTransaction: async (nativeTx, graphId, options) => {
              adoptCalls += 1;
              return originalAdopt(nativeTx, graphId, options);
            },
          },
      );
      const [store] = await createAdapterStoreWithSchema(graph, guarded);
      const vectorExtension = defineGraphExtension({
        nodes: {
          AdoptedVector: {
            properties: {
              vector: {
                type: "array",
                items: { type: "number" },
                embedding: { dimensions: 3 },
                optional: true,
              },
            },
          },
        },
      });
      const plan = await store.planEvolution(vectorExtension);
      if (plan.status !== "change") return;
      expect(plan.requirements.vectorSlots).toEqual([
        { kindName: "AdoptedVector", fieldName: "vector" },
      ]);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async () => {
            await Promise.resolve();
            return "unreached";
          }),
        ),
      ).rejects.toThrow(UnsupportedBackendCapabilityError);
      expect(adoptCalls).toBe(0);
    });

    it("refuses an evolved boundary entered inside an active recorded callback", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withRecordedTransaction(nativeTx, async () =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
              return "nested";
            }),
          ),
        ),
      ).rejects.toThrow();
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.baselineVersion);
    });
  });
}
