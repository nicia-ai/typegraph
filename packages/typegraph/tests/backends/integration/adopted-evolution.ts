import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
  resolveGraphVectorSlots,
  SchemaContentConflictError,
  TransactionClosedError,
  UnsupportedBackendCapabilityError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type {
  AdapterBackend,
  IdentityTableNames,
} from "../../../src/backend/types";
import { defineGraphExtension } from "../../../src/graph-extension";
import { mergeGraphExtension } from "../../../src/graph-extension/merge";
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
const otherGraph = defineGraph({
  id: "shared_adopted_evolution_other_graph",
  nodes: { AdoptedPerson: { type: Person } },
  edges: {},
});
const rollbackVectorGraph = defineGraph({
  id: "shared_adopted_vector_rollback",
  nodes: { AdoptedPerson: { type: Person } },
  edges: {},
});
const driftVectorGraph = defineGraph({
  id: "shared_adopted_vector_drift",
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
const widerVectorExtension = defineGraphExtension({
  nodes: {
    AdoptedVector: {
      properties: {
        vector: {
          type: "array",
          items: { type: "number" },
          embedding: { dimensions: 4 },
          optional: true,
        },
      },
    },
  },
});
const IdentityPerson = defineNode("AdoptedIdentityPerson", {
  schema: z.object({ name: z.string() }),
});
const IdentityAuthor = defineNode("AdoptedIdentityAuthor", {
  schema: z.object({ penName: z.string() }),
});
const identityGraph = defineGraph({
  id: "shared_adopted_identity_evolution",
  nodes: {
    AdoptedIdentityPerson: { type: IdentityPerson },
    AdoptedIdentityAuthor: { type: IdentityAuthor },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
const identityExtension = defineGraphExtension({
  ontology: [
    {
      metaEdge: "disjointWith",
      from: "AdoptedIdentityPerson",
      to: "AdoptedIdentityAuthor",
    },
  ],
});
const UnrelatedVector = defineNode("AdoptedUnrelatedVector", {
  schema: z.object({ vector: embedding(3).optional() }),
});
const unrelatedFeatureGraph = defineGraph({
  id: "shared_adopted_unrelated_features",
  nodes: {
    AdoptedIdentityPerson: { type: IdentityPerson },
    AdoptedIdentityAuthor: { type: IdentityAuthor },
    AdoptedUnrelatedVector: { type: UnrelatedVector },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
const standaloneKindExtension = defineGraphExtension({
  nodes: {
    AdoptedStandaloneTag: {
      properties: { label: { type: "string", optional: true } },
    },
  },
});

async function assertUnsupportedAdoption(
  run: () => Promise<unknown>,
): Promise<void> {
  await expect(run()).rejects.toThrow(UnsupportedBackendCapabilityError);
}

function identityTablesForBackend(
  backend: AdapterBackend<unknown>,
): IdentityTableNames {
  const names = requireDefined(backend.tableNames);
  return {
    identityAssertions: requireDefined(names.identityAssertions),
    recordedIdentityAssertions: requireDefined(
      names.recordedIdentityAssertions,
    ),
    identityClosure: requireDefined(names.identityClosure),
    identitySeparation: requireDefined(names.identitySeparation),
  };
}

export function registerAdoptedEvolutionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Adopted schema evolution", () => {
    it("applies a cached Store's plan through a compatible rebound Store", async () => {
      const backend = context.getBackend();
      const [cachedStore] = await createAdapterStoreWithSchema(graph, backend);
      await cachedStore.planEvolution(extension);
      const plan = await cachedStore.planEvolution(extension, {
        source: "cached",
      });
      if (plan.status !== "change") throw new Error("Expected change plan.");
      const writerStore = cachedStore.withBackend(deriveBackend(backend, {}));
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await assertUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            writerStore.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          writerStore.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "portable plan" });
          }),
      );
      expect(outcome.receipt.schema).toEqual(plan.result);
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.result.version);
    });

    it("refuses copied plans and plans for another graph before the callback", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const [otherStore] = await createAdapterStoreWithSchema(
        otherGraph,
        backend,
      );
      const plan = await store.planEvolution(extension);
      const copiedPlan: EvolutionPlan = { ...plan };
      for (const [target, candidate] of [
        [store, copiedPlan],
        [otherStore, plan],
      ] as const) {
        await expect(
          backend.transactionWithNative(async (_target, nativeTx) =>
            target.withEvolvedTransaction(nativeTx, candidate, async () => {
              await Promise.resolve();
              throw new Error("Callback must not run.");
            }),
          ),
        ).rejects.toMatchObject({
          details: { code: "EVOLUTION_PLAN_OWNER_MISMATCH" },
        });
      }
      const active = await backend.getActiveSchema(graph.id);
      const otherActive = await backend.getActiveSchema(otherGraph.id);
      expect(active?.version).toBe(1);
      expect(otherActive?.version).toBe(1);
    });

    it("refuses unknown evolved transaction options before the callback", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const plan = await store.planEvolution(extension);
      const options = { waitBudgetMs: 5000, future: true };
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(
            nativeTx,
            plan,
            async () => {
              await Promise.resolve();
              throw new Error("Callback must not run.");
            },
            options,
          ),
        ),
      ).rejects.toMatchObject({
        details: { code: "EVOLUTION_OPTIONS_UNSUPPORTED" },
      });
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(1);
    });

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
        version: plan.result.version,
        hash: plan.result.hash,
      });
      expect(outcome.receipt.writes.nodes).toEqual({ AdoptedPerson: 1 });
      expect(outcome.receipt.recorded).toBeDefined();
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.result.version);
      expect(active?.schema_hash).toBe(plan.result.hash);
      expect(store.getNodeCollection("AdoptedTag")).toBeUndefined();
      const refreshed = await store.refreshSchema({
        minVersion: plan.result.version,
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
        version: plan.result.version,
        hash: plan.result.hash,
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

    it("rolls back schema and graph writes when the evolved callback fails", async () => {
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
      const before = await backend.getActiveSchema(graph.id);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            tx.requestRecordedRevision();
            await tx.nodes.AdoptedPerson.create({ name: "callback failure" });
            throw new Error("evolved callback failed");
          }),
        ),
      ).rejects.toThrow("evolved callback failed");
      expect(await backend.getActiveSchema(graph.id)).toEqual(before);
      expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
    });

    it("rolls back schema and live rows when recorded capture fails", async () => {
      const backend = context.getBackend();
      const originalAdopt = backend.adoptSchemaWriteTransaction;
      if (originalAdopt === undefined) return;
      const recordedNodesTable =
        backend.tableNames?.recordedNodes ?? "typegraph_recorded_nodes";
      const capture = { callbackWriteCompleted: false, insertObserved: false };
      const captureFailureBackend = deriveBackend(backend, {
        adoptSchemaWriteTransaction: async (nativeTx, graphId, options) => {
          const adopted = await originalAdopt(nativeTx, graphId, options);
          const executeStatement = adopted.backend.executeStatement;
          return {
            ...adopted,
            backend: deriveBackend(adopted.backend, {
              executeStatement: async (statement) => {
                const text = statement.chunks
                  .filter((chunk) => chunk.kind === "text")
                  .map((chunk) => chunk.value)
                  .join(" ");
                const recordedTable = statement.chunks.some(
                  (chunk) =>
                    chunk.kind === "identifier" &&
                    chunk.value === recordedNodesTable,
                );
                if (text.includes("INSERT INTO") && recordedTable) {
                  capture.insertObserved = true;
                  throw new Error("forced recorded capture failure");
                }
                return executeStatement(statement);
              },
            }),
          };
        },
      });
      const [store] = await createAdapterStoreWithSchema(
        graph,
        captureFailureBackend,
        { history: true, revisionTracking: true },
      );
      const plan = await store.planEvolution(extension);
      if (plan.status !== "change") throw new Error("Expected change plan.");
      const before = await backend.getActiveSchema(graph.id);
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await tx.nodes.AdoptedPerson.create({ name: "capture failure" });
            capture.callbackWriteCompleted = true;
          }),
        ),
      ).rejects.toThrow("forced recorded capture failure");
      expect(capture).toEqual({
        callbackWriteCompleted: true,
        insertObserved: true,
      });
      expect(await backend.getActiveSchema(graph.id)).toEqual(before);
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
          WHERE graph_id = ${graph.id} AND version = ${plan.baseline.version}
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
            UPDATE ${sql.raw(tableName)} SET schema_hash = ${plan.baseline.hash}
            WHERE graph_id = ${graph.id} AND version = ${plan.baseline.version}
          `),
        );
      }
    });

    it("refuses a no-op plan when the fenced version has a different hash", async () => {
      const backend = context.getBackend();
      if (backend.executeStatement === undefined) return;
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      await store.evolve(extension);
      const plan = await store.planEvolution(extension);
      if (plan.status !== "noop") throw new Error("Expected no-op plan.");
      const tableName =
        backend.tableNames?.schemaVersions ?? "typegraph_schema_versions";
      await backend.executeStatement(
        asCompiledStatementSql(sql`
          UPDATE ${sql.raw(tableName)} SET schema_hash = ${"0".repeat(64)}
          WHERE graph_id = ${graph.id} AND version = ${plan.baseline.version}
        `),
      );
      try {
        await expect(
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
              await tx.nodes.AdoptedPerson.create({ name: "wrong no-op hash" });
            }),
          ),
        ).rejects.toThrow(SchemaContentConflictError);
        expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
      } finally {
        await backend.executeStatement(
          asCompiledStatementSql(sql`
            UPDATE ${sql.raw(tableName)} SET schema_hash = ${plan.baseline.hash}
            WHERE graph_id = ${graph.id} AND version = ${plan.baseline.version}
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

      const caughtUp = await store.refreshSchema({ minVersion: 2 });
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
      expect(
        plan.requirements.filter(
          (requirement) => requirement.kind === "require-empty",
        ),
      ).toEqual([
        { kind: "require-empty", entity: "node", kindName: "AdoptedTag" },
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
      expect(active?.version).toBe(plan.baseline.version);
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
      expect(outcome.receipt.schema.version).toBe(plan.result.version);
      const active = await backend.getActiveSchema(graph.id);
      expect(active?.version).toBe(plan.result.version);
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
      const plan = await store.planEvolution(vectorExtension);
      if (plan.status !== "change") return;
      expect(
        plan.requirements.filter(
          (requirement) => requirement.kind === "vector-slot",
        ),
      ).toEqual([
        { kind: "vector-slot", nodeKind: "AdoptedVector", fieldPath: "vector" },
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

    it("evolves a metadata-only kind without provisioning unrelated identity or vector storage", async () => {
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(
        unrelatedFeatureGraph,
        backend,
      );
      const first = await store.nodes.AdoptedIdentityPerson.create({
        name: "unrelated first",
      });
      const second = await store.nodes.AdoptedIdentityPerson.create({
        name: "unrelated second",
      });
      await store.identity.assertSame(first, second);
      const plan = await store.planEvolution(standaloneKindExtension);
      if (plan.status !== "change")
        throw new Error("Expected standalone kind change plan.");
      expect(
        plan.requirements.filter(
          (requirement) => requirement.kind === "vector-slot",
        ),
      ).toEqual([]);
      expect(
        plan.requirements.filter(
          (requirement) => requirement.kind === "identity",
        ),
      ).toEqual([]);
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
            await tx.nodes.AdoptedIdentityPerson.create({
              name: "metadata only",
            });
          }),
      );
      expect(outcome.receipt.schema.version).toBe(plan.result.version);
      const refreshed = await store.refreshSchema({
        minVersion: plan.result.version,
      });
      expect(refreshed.getNodeCollection("AdoptedStandaloneTag")).toBeDefined();
      expect(await refreshed.identity.membersOf(first)).toEqual(
        expect.arrayContaining([
          { kind: "AdoptedIdentityPerson", id: first.id },
          { kind: "AdoptedIdentityPerson", id: second.id },
        ]),
      );
    });

    it("provisions a vector slot with schema and callback writes on a privileged session", async (ctx) => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        if (
          backend.capabilities.vector?.supported !== true ||
          backend.adoptSchemaWriteTransaction === undefined ||
          backend.probeContributions === undefined ||
          backend.schemaWriteTransaction === undefined ||
          backend.vectorStrategy === undefined
        ) {
          ctx.skip();
          return;
        }
        expect(backend.schemaProvisioning).toBe("transactional");
        const [store] = await createAdapterStoreWithSchema(graph, backend, {
          history: true,
          revisionTracking: true,
        });
        const plan = await store.planEvolution(vectorExtension);
        if (plan.status !== "change")
          throw new Error("Expected vector change plan.");
        const slots = resolveGraphVectorSlots(
          mergeGraphExtension(graph, vectorExtension),
        );
        expect(slots).toHaveLength(1);
        const vectorTable = backend.vectorStrategy.tableName(
          graph.id,
          "AdoptedVector",
          "vector",
        );
        expect(
          await backend.schemaWriteTransaction(graph.id, (tx) =>
            tx.tableExists(vectorTable),
          ),
        ).toBe(false);
        const outcome = await backend.transactionWithNative(
          async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
              tx.requestRecordedRevision();
              await tx.nodes.AdoptedPerson.create({
                name: "vector provisioned",
              });
              return "provisioned";
            }),
        );
        expect(outcome.result).toBe("provisioned");
        expect(outcome.receipt.schema.version).toBe(plan.result.version);
        expect(outcome.receipt.recorded).toBeDefined();
        expect(
          await backend.schemaWriteTransaction(graph.id, (tx) =>
            tx.tableExists(vectorTable),
          ),
        ).toBe(true);
        expect(await backend.probeContributions(graph.id, slots)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ contribution: "vector", state: "ready" }),
          ]),
        );
        const refreshed = await store.refreshSchema({
          minVersion: plan.result.version,
        });
        expect(await refreshed.nodes.AdoptedPerson.find()).toHaveLength(1);
      } finally {
        await handle.close();
      }
    });

    it("rolls back vector storage with schema and callback writes on a privileged session", async (ctx) => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        if (
          backend.capabilities.vector?.supported !== true ||
          backend.adoptSchemaWriteTransaction === undefined ||
          backend.probeContributions === undefined ||
          backend.schemaWriteTransaction === undefined ||
          backend.vectorStrategy === undefined
        ) {
          ctx.skip();
          return;
        }
        const [store] = await createAdapterStoreWithSchema(
          rollbackVectorGraph,
          backend,
        );
        const plan = await store.planEvolution(vectorExtension);
        if (plan.status !== "change")
          throw new Error("Expected vector change plan.");
        const slots = resolveGraphVectorSlots(
          mergeGraphExtension(rollbackVectorGraph, vectorExtension),
        );
        const vectorTable = backend.vectorStrategy.tableName(
          rollbackVectorGraph.id,
          "AdoptedVector",
          "vector",
        );
        const beforeSchema = await backend.getActiveSchema(
          rollbackVectorGraph.id,
        );
        const beforeVector = await backend.probeContributions(
          rollbackVectorGraph.id,
          slots,
        );
        expect(
          await backend.schemaWriteTransaction(rollbackVectorGraph.id, (tx) =>
            tx.tableExists(vectorTable),
          ),
        ).toBe(false);
        await expect(
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
              await tx.nodes.AdoptedPerson.create({ name: "rollback vector" });
              throw new Error("roll back provisioned vector");
            }),
          ),
        ).rejects.toThrow("roll back provisioned vector");
        expect(await backend.getActiveSchema(rollbackVectorGraph.id)).toEqual(
          beforeSchema,
        );
        expect(
          await backend.probeContributions(rollbackVectorGraph.id, slots),
        ).toEqual(beforeVector);
        expect(
          await backend.schemaWriteTransaction(rollbackVectorGraph.id, (tx) =>
            tx.tableExists(vectorTable),
          ),
        ).toBe(false);
        expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
      } finally {
        await handle.close();
      }
    });

    it("refuses a vector slot whose physical shape drifted after planning", async (ctx) => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        if (
          backend.capabilities.vector?.supported !== true ||
          backend.adoptSchemaWriteTransaction === undefined ||
          backend.ensureVectorSlotContributions === undefined
        ) {
          ctx.skip();
          return;
        }
        const [store] = await createAdapterStoreWithSchema(
          driftVectorGraph,
          backend,
        );
        const plan = await store.planEvolution(vectorExtension);
        if (plan.status !== "change")
          throw new Error("Expected vector slot change plan.");
        expect(
          plan.requirements.filter(
            (requirement) => requirement.kind === "vector-slot",
          ),
        ).not.toEqual([]);
        const widerSlots = resolveGraphVectorSlots(
          mergeGraphExtension(driftVectorGraph, widerVectorExtension),
        );
        await backend.ensureVectorSlotContributions(widerSlots);
        const beforeSchema = await backend.getActiveSchema(driftVectorGraph.id);
        await expect(
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
              await tx.nodes.AdoptedPerson.create({ name: "drift refused" });
            }),
          ),
        ).rejects.toThrow(/already materialized with a different signature/);
        expect(await backend.getActiveSchema(driftVectorGraph.id)).toEqual(
          beforeSchema,
        );
        expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
      } finally {
        await handle.close();
      }
    });

    it("refuses a missing vector marker table before callback or sidecar provisioning", async (ctx) => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        if (
          backend.capabilities.vector?.supported !== true ||
          backend.adoptSchemaWriteTransaction === undefined
        ) {
          ctx.skip();
          return;
        }
        // The shared lane factories use the default materialization schema.
        const markerTable = "typegraph_contribution_materializations";
        const [store] = await createAdapterStoreWithSchema(
          driftVectorGraph,
          backend,
        );
        const plan = await store.planEvolution(vectorExtension);
        if (plan.status !== "change")
          throw new Error("Expected vector slot change plan.");
        const beforeSchema = await backend.getActiveSchema(driftVectorGraph.id);
        const callback = { reached: false };
        await expect(
          backend.transactionWithNative(async (target, nativeTx) => {
            if (target.executeStatement === undefined)
              throw new Error("Native target lacks statement execution.");
            await target.executeStatement(
              asCompiledStatementSql(sql`
                DROP TABLE ${sql.identifier(markerTable)}
              `),
            );
            await expect(
              store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
                callback.reached = true;
                await tx.nodes.AdoptedPerson.create({ name: "marker missing" });
              }),
            ).rejects.toMatchObject({
              details: { capability: "schemaProvisioning.vectorMarkers" },
            });
            throw new Error("restore dropped marker through outer rollback");
          }),
        ).rejects.toThrow("restore dropped marker through outer rollback");
        expect(callback.reached).toBe(false);
        expect(await backend.getActiveSchema(driftVectorGraph.id)).toEqual(
          beforeSchema,
        );
        expect(await store.nodes.AdoptedPerson.find()).toEqual([]);
        const schemaWriteTransaction = requireDefined(
          backend.schemaWriteTransaction,
        );
        expect(
          await schemaWriteTransaction(driftVectorGraph.id, (tx) =>
            tx.tableExists(markerTable),
          ),
        ).toBe(true);
      } finally {
        await handle.close();
      }
    });

    it("revalidates identity on a privileged adopted evolution with graph writes", async () => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        const [store] = await createAdapterStoreWithSchema(
          identityGraph,
          backend,
          { history: true, revisionTracking: true },
        );
        const first = await store.nodes.AdoptedIdentityPerson.create({
          name: "first",
        });
        const second = await store.nodes.AdoptedIdentityPerson.create({
          name: "second",
        });
        await store.identity.assertSame(first, second);
        const plan = await store.planEvolution(identityExtension);
        if (plan.status !== "change")
          throw new Error("Expected identity ontology change plan.");
        expect(
          plan.requirements.filter(
            (requirement) => requirement.kind === "identity",
          ),
        ).not.toEqual([]);
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
              await tx.nodes.AdoptedIdentityAuthor.create({ penName: "new" });
              return "identity validated";
            }),
        );
        expect(outcome.result).toBe("identity validated");
        expect(outcome.receipt.schema.version).toBe(plan.result.version);
        const refreshed = await store.refreshSchema({
          minVersion: plan.result.version,
        });
        expect(await refreshed.identity.membersOf(first)).toEqual(
          expect.arrayContaining([
            { kind: "AdoptedIdentityPerson", id: first.id },
            { kind: "AdoptedIdentityPerson", id: second.id },
          ]),
        );
        expect(await refreshed.nodes.AdoptedIdentityAuthor.find()).toHaveLength(
          1,
        );
      } finally {
        await handle.close();
      }
    });

    it("rolls back privileged identity evolution and callback writes", async () => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        const [store] = await createAdapterStoreWithSchema(
          identityGraph,
          backend,
        );
        const first = await store.nodes.AdoptedIdentityPerson.create({
          name: "first",
        });
        const second = await store.nodes.AdoptedIdentityPerson.create({
          name: "second",
        });
        await store.identity.assertSame(first, second);
        const plan = await store.planEvolution(identityExtension);
        if (plan.status !== "change")
          throw new Error("Expected identity ontology change plan.");
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
        const beforeSchema = await backend.getActiveSchema(identityGraph.id);
        const beforeMembers = await store.identity.membersOf(first);
        await expect(
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
              await tx.nodes.AdoptedIdentityAuthor.create({
                penName: "rolled back",
              });
              throw new Error("roll back identity evolution");
            }),
          ),
        ).rejects.toThrow("roll back identity evolution");
        expect(await backend.getActiveSchema(identityGraph.id)).toEqual(
          beforeSchema,
        );
        expect(await store.identity.membersOf(first)).toEqual(beforeMembers);
        expect(await store.nodes.AdoptedIdentityAuthor.find()).toEqual([]);
      } finally {
        await handle.close();
      }
    });

    it("rolls back a newly provisioned identity relation with the adopted schema", async () => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        if (
          backend.adoptSchemaWriteTransaction === undefined ||
          backend.executeDdl === undefined ||
          backend.schemaWriteTransaction === undefined ||
          backend.ensureIdentityTables === undefined
        )
          return;
        const identityTables = identityTablesForBackend(backend);
        const [store] = await createAdapterStoreWithSchema(
          identityGraph,
          backend,
        );
        const plan = await store.planEvolution(identityExtension);
        if (plan.status !== "change")
          throw new Error("Expected identity ontology change plan.");
        const beforeSchema = await backend.getActiveSchema(identityGraph.id);
        await backend.executeDdl(
          `DROP TABLE IF EXISTS "${identityTables.identitySeparation.replaceAll('"', '""')}"`,
        );
        try {
          await expect(
            backend.transactionWithNative(async (_target, nativeTx) => {
              await store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
                await tx.nodes.AdoptedIdentityPerson.create({
                  name: "identity DDL rolled back",
                });
              });
              throw new Error("outer identity DDL rollback");
            }),
          ).rejects.toThrow("outer identity DDL rollback");
          expect(await backend.getActiveSchema(identityGraph.id)).toEqual(
            beforeSchema,
          );
          expect(await store.nodes.AdoptedIdentityPerson.find()).toEqual([]);
          expect(
            await backend.schemaWriteTransaction(identityGraph.id, (tx) =>
              tx.tableExists(identityTables.identitySeparation),
            ),
          ).toBe(false);
          const committed = await backend.transactionWithNative(
            async (_target, nativeTx) =>
              store.withEvolvedTransaction(nativeTx, plan, async () => {
                await Promise.resolve();
              }),
          );
          expect(committed.receipt.schema.version).toBe(plan.result.version);
          expect(
            await backend.schemaWriteTransaction(identityGraph.id, (tx) =>
              tx.tableExists(identityTables.identitySeparation),
            ),
          ).toBe(true);
        } finally {
          await backend.ensureIdentityTables(identityTables, {
            provisionMissing: true,
          });
        }
      } finally {
        await handle.close();
      }
    });

    it("refuses missing identity ledger storage without publishing a schema", async () => {
      const handle = await context.createSerializedBackend({
        schemaProvisioning: "transactional",
      });
      try {
        const backend = handle.backend;
        if (
          backend.adoptSchemaWriteTransaction === undefined ||
          backend.executeDdl === undefined ||
          backend.schemaWriteTransaction === undefined ||
          backend.ensureIdentityTables === undefined
        )
          return;
        const identityTables = identityTablesForBackend(backend);
        const [store] = await createAdapterStoreWithSchema(
          identityGraph,
          backend,
        );
        const plan = await store.planEvolution(identityExtension);
        if (plan.status !== "change")
          throw new Error("Expected identity ontology change plan.");
        const beforeSchema = await backend.getActiveSchema(identityGraph.id);
        await backend.executeDdl(
          `DROP TABLE IF EXISTS "${identityTables.identityAssertions.replaceAll('"', '""')}"`,
        );
        try {
          await expect(
            backend.transactionWithNative(async (_target, nativeTx) =>
              store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
                await tx.nodes.AdoptedIdentityPerson.create({
                  name: "missing ledger",
                });
              }),
            ),
          ).rejects.toMatchObject({
            code: "CONFIGURATION_ERROR",
            details: { code: "IDENTITY_STORAGE_MISSING" },
          });
          expect(await backend.getActiveSchema(identityGraph.id)).toEqual(
            beforeSchema,
          );
          expect(await store.nodes.AdoptedIdentityPerson.find()).toEqual([]);
          expect(
            await backend.schemaWriteTransaction(identityGraph.id, (tx) =>
              tx.tableExists(identityTables.identityAssertions),
            ),
          ).toBe(false);
        } finally {
          await backend.ensureIdentityTables(identityTables, {
            provisionMissing: true,
          });
        }
      } finally {
        await handle.close();
      }
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
      expect(active?.version).toBe(plan.baseline.version);
    });
  });
}
