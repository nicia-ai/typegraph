import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
  UnsupportedBackendCapabilityError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { defineGraphExtension } from "../../../src/graph-extension/define-graph-extension";
import {
  applyMergePlanInTransaction,
  branchForEvolution,
  captureCandidateWriteSetTargetForEvolution,
  planCandidateWriteSetForEvolution,
  planMergeForEvolution,
} from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import {
  BranchError,
  MergePlanCapabilityError,
  MergePlanningStaleError,
  MergePlanSchemaMismatchError,
  StaleMergePlanError,
} from "../../../src/graph-merge/errors";
import { applyMergePlan, planMerge } from "../../../src/graph-merge/merge";
import { constructMergePlanArtifact } from "../../../src/graph-merge/plan-wire";
import { isErr, isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../../src/graph-merge/types";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const graph = defineGraph({
  id: "graph_merge_plan_integration",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

type TestStore = Store<typeof graph>;

const Binder = defineNode("PlanBinder", { schema: z.object({}) });
const Sheet = defineNode("PlanSheet", { schema: z.object({}) });
const filedIn = defineEdge("planFiledIn", { schema: z.object({}) });
/** No composition yet: the evolution below is what declares the pair. */
const compositionEvolutionGraph = defineGraph({
  id: "graph_merge_plan_composition_evolution",
  nodes: {
    PlanBinder: { type: Binder },
    PlanSheet: { type: Sheet },
  },
  edges: {
    planFiledIn: {
      type: filedIn,
      from: [Sheet],
      to: [Binder],
      cardinality: "one",
    },
  },
});
const requiredFilingExtension = defineGraphExtension({
  ontology: [
    {
      metaEdge: "partOf",
      from: "PlanSheet",
      to: "PlanBinder",
      via: "planFiledIn",
      existence: "required",
    },
  ],
});

async function makeBranch(
  context: IntegrationTestContext,
  base: TestStore,
  id: string,
): Promise<GraphBranch<typeof graph>> {
  return unwrap(
    await branch(base, () => context.createIsolatedBackend(), {
      id: asBranchId(id),
    }),
  );
}

export function registerGraphMergePlanIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("graph merge plan lifecycle", () => {
    it("preserves multi-source evidence through JSON and applies exactly once", async () => {
      const base = await context.createStore(graph, { revisionTracking: true });
      const left = await makeBranch(context, base, "left");
      const right = await makeBranch(context, base, "right");
      await left.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada-left" },
      );
      await right.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada-right" },
      );

      const artifact = unwrap(
        await planMerge(base, [left, right], {
          resolve: {
            Person: {
              block: (node) => node.email,
              similarity: { kind: "fulltext", fields: ["name"] },
              threshold: 1,
            },
          },
        }),
      );
      const evidence = requireDefined(
        requireDefined(artifact.review.resolutions[0]).decisiveEdges[0],
      );
      expect(evidence.sources.map((source) => source.kind)).toEqual([
        "block",
        "unique",
      ]);

      // The lifecycle contract specifically requires a JSON serialization boundary.
      // eslint-disable-next-line unicorn/prefer-structured-clone
      const parsed = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
      const results = await Promise.all([
        applyMergePlan(base, parsed),
        applyMergePlan(base, parsed),
      ]);
      expect(results.filter((result) => isOk(result))).toHaveLength(1);
      expect(results.filter((result) => isErr(result))).toHaveLength(1);
      expect(
        await base.nodes.Person.getById(asNodeId("ada-left")),
      ).toBeDefined();
    });

    it("preflights every rehashed write before mutating the target", async () => {
      const base = await context.createStore(graph, { revisionTracking: true });
      const source = await makeBranch(context, base, "source");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(base, [source]));
      const { digest: _digest, ...input } = artifact;
      const malformed = await constructMergePlanArtifact({
        ...input,
        writes: {
          ...input.writes,
          edgeDeletes: [{ kind: "MissingEdgeKind", id: "missing" }],
        },
        proposed: {
          ...input.proposed,
          edges: { ...input.proposed.edges, deletions: 1 },
        },
      });

      expect(isErr(await applyMergePlan(base, malformed))).toBe(true);
      expect(await base.nodes.Person.getById(asNodeId("ada"))).toBeUndefined();
    });

    it("applies in a caller-owned transaction and records the merge at its receipt revision", async () => {
      const backend = context.getBackend();
      let nestedTransactions = 0;
      const guardedBackend = deriveBackend(backend, {
        transaction: (fn, options) => {
          nestedTransactions += 1;
          return backend.transaction(fn, options);
        },
      });
      const [target] = await createAdapterStoreWithSchema(
        graph,
        guardedBackend,
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-success");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));
      nestedTransactions = 0;

      const outcome = await backend.transactionWithNative(
        async (_txBackend, nativeTransaction) =>
          target.withRecordedTransaction(nativeTransaction, async (tx) =>
            applyMergePlanInTransaction(target, tx, artifact),
          ),
      );

      expect(outcome.receipt.writes.nodes).toEqual({ Person: 1 });
      expect(outcome.receipt.writes.total).toBe(1);
      expect(nestedTransactions).toBe(0);
      expect(outcome.receipt.recorded).toBeDefined();
      if (outcome.receipt.recorded === undefined)
        throw new Error(
          "Expected adopted merge to allocate a recorded revision.",
        );
      await expect(
        target
          .asOfRecorded(outcome.receipt.recorded)
          .nodes.Person.getById(asNodeId("ada")),
      ).resolves.toMatchObject({ name: "Ada" });
    });

    it("prepares a resulting-schema merge and applies it after evolution in the same caller transaction", async () => {
      const backend = context.getBackend();
      const [target] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
        revisionTracking: true,
      });
      const source = await makeBranch(context, target, "evolved-merge-source");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@evolved.test" },
        { id: "evolved-ada" },
      );
      const oldSchemaArtifact = unwrap(await planMerge(target, [source]));
      const evolutionPlan = await target.planEvolution(
        defineGraphExtension({
          nodes: {
            Tag: { properties: { label: { type: "string", optional: true } } },
          },
        }),
      );
      const resultingSchemaArtifact = unwrap(
        await planMergeForEvolution(target, evolutionPlan, [source]),
      );
      if (backend.adoptSchemaWriteTransaction === undefined) {
        let callbackCalled = false;
        // eslint-disable-next-line vitest/no-conditional-expect -- backend capability refusal is one parity branch
        await expect(
          backend.transactionWithNative(async (_txBackend, nativeTransaction) =>
            target.withEvolvedTransaction(
              nativeTransaction,
              evolutionPlan,
              () => {
                callbackCalled = true;
                return Promise.resolve(undefined);
              },
            ),
          ),
        ).rejects.toBeInstanceOf(UnsupportedBackendCapabilityError);
        // eslint-disable-next-line vitest/no-conditional-expect -- asserts the unsupported path never runs the callback
        expect(callbackCalled).toBe(false);
        return;
      }
      await expect(
        backend.transactionWithNative(async (_txBackend, nativeTransaction) =>
          target.withEvolvedTransaction(
            nativeTransaction,
            evolutionPlan,
            (tx) => applyMergePlanInTransaction(target, tx, oldSchemaArtifact),
          ),
        ),
      ).rejects.toBeInstanceOf(MergePlanSchemaMismatchError);

      const outcome = await backend.transactionWithNative(
        async (_txBackend, nativeTransaction) =>
          target.withEvolvedTransaction(
            nativeTransaction,
            evolutionPlan,
            (tx) =>
              applyMergePlanInTransaction(target, tx, resultingSchemaArtifact),
          ),
      );
      expect(outcome.receipt.writes.nodes).toEqual({ Person: 1 });
      expect(
        await target.nodes.Person.getById(asNodeId("evolved-ada")),
      ).toBeDefined();
    });

    it("plans candidate data against an evolved schema and applies both changes in one revision", async () => {
      const backend = context.getBackend();
      const [target] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
        revisionTracking: true,
      });
      const evolutionPlan = await target.planEvolution(
        defineGraphExtension({
          nodes: {
            Tag: { properties: { label: { type: "string" } } },
          },
        }),
      );
      const writeSet = {
        formatVersion: 1 as const,
        sourceId: "candidate-tags",
        target: captureCandidateWriteSetTargetForEvolution(
          target,
          evolutionPlan,
        ),
        nodes: [
          {
            kind: "Tag",
            id: "candidate-tag",
            properties: { label: "Accepted candidate" },
            validFrom: "2026-01-01T00:00:00.000Z",
          },
        ],
        edges: [],
      };
      const mergePlan = unwrap(
        await planCandidateWriteSetForEvolution({
          target,
          evolutionPlan,
          makeBackend: () => context.createIsolatedBackend(),
          writeSet,
        }),
      );
      expect(mergePlan.target.schema).toEqual({
        managed: true,
        version: evolutionPlan.result.version,
        hash: evolutionPlan.result.hash,
      });
      if (backend.adoptSchemaWriteTransaction === undefined) {
        let callbackCalled = false;
        // eslint-disable-next-line vitest/no-conditional-expect -- backend capability refusal is one parity branch
        await expect(
          backend.transactionWithNative(async (_txBackend, nativeTransaction) =>
            target.withEvolvedTransaction(
              nativeTransaction,
              evolutionPlan,
              () => {
                callbackCalled = true;
                return Promise.resolve(undefined);
              },
            ),
          ),
        ).rejects.toBeInstanceOf(UnsupportedBackendCapabilityError);
        // eslint-disable-next-line vitest/no-conditional-expect -- callback must be untouched on refusal
        expect(callbackCalled).toBe(false);
        return;
      }

      const outcome = await backend.transactionWithNative(
        async (_txBackend, nativeTransaction) =>
          target.withEvolvedTransaction(
            nativeTransaction,
            evolutionPlan,
            (tx) => applyMergePlanInTransaction(target, tx, mergePlan),
          ),
      );
      expect(outcome.receipt.schema).toEqual({
        version: evolutionPlan.result.version,
        hash: evolutionPlan.result.hash,
      });
      expect(outcome.result.merged.nodes).toBe(1);
      expect(outcome.receipt.recorded).toBeDefined();
      const evolved = await target.refreshSchema({
        minVersion: evolutionPlan.result.version,
      });
      expect(
        await evolved.getNodeCollectionOrThrow("Tag").getById("candidate-tag"),
      ).toMatchObject({ label: "Accepted candidate" });
    });

    it("resolves evolved candidates against committed nodes before applying", async () => {
      const backend = context.getBackend();
      const [target] = await createAdapterStoreWithSchema(graph, backend, {
        history: true,
        revisionTracking: true,
      });
      await target.nodes.Person.create(
        { name: "Accepted", email: "shared@example.test" },
        { id: "accepted" },
      );
      const evolutionPlan = await target.planEvolution(
        defineGraphExtension({
          nodes: {
            Tag: { properties: { label: { type: "string" } } },
          },
        }),
      );
      const mergePlan = unwrap(
        await planCandidateWriteSetForEvolution({
          target,
          evolutionPlan,
          makeBackend: () => context.createIsolatedBackend(),
          writeSet: {
            formatVersion: 1,
            sourceId: "committed-person-candidate",
            target: captureCandidateWriteSetTargetForEvolution(
              target,
              evolutionPlan,
            ),
            nodes: [
              {
                kind: "Person",
                id: "incoming-person",
                properties: {
                  name: "Incoming",
                  email: "shared@example.test",
                },
                validFrom: "2026-01-01T00:00:00.000Z",
              },
            ],
            edges: [],
          },
          options: {
            resolve: {
              Person: {
                similarity: { kind: "custom", score: () => 1 },
                threshold: 1,
              },
            },
          },
        }),
      );
      expect(mergePlan.review.conflicts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "Person",
            property: "name",
            resolution: "Accepted",
          }),
        ]),
      );
      expect(
        mergePlan.review.resolutions.some(
          (resolution) => resolution.canonicalId === "accepted",
        ),
      ).toBe(true);
      if (backend.adoptSchemaWriteTransaction === undefined) return;

      const outcome = await backend.transactionWithNative(
        async (_txBackend, nativeTransaction) =>
          target.withEvolvedTransaction(
            nativeTransaction,
            evolutionPlan,
            (tx) => applyMergePlanInTransaction(target, tx, mergePlan),
          ),
      );
      expect(outcome.result.merged.nodes).toBe(1);
      expect(
        await target.nodes.Person.getById(asNodeId("incoming-person")),
      ).toBeUndefined();
      expect(
        await target.nodes.Person.getById(asNodeId("accepted")),
      ).toMatchObject({ name: "Accepted", email: "shared@example.test" });
    });

    it("refuses candidate planning when the evolution baseline becomes stale", async () => {
      const target = await context.createStore(graph, {
        revisionTracking: true,
      });
      const evolutionPlan = await target.planEvolution(
        defineGraphExtension({
          nodes: {
            Tag: { properties: { label: { type: "string" } } },
          },
        }),
      );
      const writeSet = {
        formatVersion: 1 as const,
        sourceId: "stale-candidate-tags",
        target: captureCandidateWriteSetTargetForEvolution(
          target,
          evolutionPlan,
        ),
        nodes: [
          {
            kind: "Tag",
            id: "stale-candidate-tag",
            properties: { label: "Stale" },
            validFrom: "2026-01-01T00:00:00.000Z",
          },
        ],
        edges: [],
      };
      let advanced = false;
      const planned = await planCandidateWriteSetForEvolution({
        target,
        evolutionPlan,
        makeBackend: async () => {
          const isolated = await context.createIsolatedBackend();
          if (!advanced) {
            advanced = true;
            await target.nodes.Person.create(
              { name: "Concurrent", email: "concurrent@example.test" },
              { id: "concurrent-person" },
            );
          }
          return isolated;
        },
        writeSet,
      });
      expect(isErr(planned)).toBe(true);
      if (!isErr(planned)) throw new Error("Expected stale planning refusal.");
      expect(planned.error).toBeInstanceOf(MergePlanningStaleError);
      expect(advanced).toBe(true);
      expect(await target.nodes.Person.count()).toBe(1);
    });

    it("refuses an evolved merge when the durable target revision changes after planning", async () => {
      const backend = context.getBackend();
      const [target] = await createAdapterStoreWithSchema(graph, backend, {
        revisionTracking: true,
      });
      const source = await makeBranch(context, target, "evolved-stale-source");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@stale.test" },
        { id: "stale-source-ada" },
      );
      const evolutionPlan = await target.planEvolution(
        defineGraphExtension({
          nodes: {
            Tag: { properties: { label: { type: "string", optional: true } } },
          },
        }),
      );
      const mergePlan = unwrap(
        await planMergeForEvolution(target, evolutionPlan, [source]),
      );
      if (backend.adoptSchemaWriteTransaction === undefined) {
        // eslint-disable-next-line vitest/no-conditional-expect -- backend capability refusal is one parity branch
        await expect(
          backend.transactionWithNative(async (_txBackend, nativeTransaction) =>
            target.withEvolvedTransaction(
              nativeTransaction,
              evolutionPlan,
              (tx) => applyMergePlanInTransaction(target, tx, mergePlan),
            ),
          ),
        ).rejects.toBeInstanceOf(UnsupportedBackendCapabilityError);
        return;
      }
      await target.nodes.Person.create(
        { name: "Other", email: "other@stale.test" },
        { id: "other-after-plan" },
      );

      await expect(
        backend.transactionWithNative(async (_txBackend, nativeTransaction) =>
          target.withEvolvedTransaction(
            nativeTransaction,
            evolutionPlan,
            (tx) => applyMergePlanInTransaction(target, tx, mergePlan),
          ),
        ),
      ).rejects.toBeInstanceOf(StaleMergePlanError);
      expect(
        await target.nodes.Person.getById(asNodeId("stale-source-ada")),
      ).toBeUndefined();
    });

    it("reports composition orphans under the resulting schema's registry", async () => {
      const [target] = await createAdapterStoreWithSchema(
        compositionEvolutionGraph,
        context.getBackend(),
        { revisionTracking: true },
      );
      const binder = await target.nodes.PlanBinder.create({}, { id: "binder" });
      const sheet = await target.nodes.PlanSheet.create({}, { id: "sheet" });
      const filing = await target.edges.planFiledIn.create(sheet, binder, {});
      const source = unwrap(
        await branch(target, () => context.createIsolatedBackend(), {
          id: asBranchId("drops-filing"),
        }),
      );
      await source.store.edges.planFiledIn.delete(filing.id);
      const evolutionPlan = await target.planEvolution(requiredFilingExtension);

      const artifact = unwrap(
        await planMergeForEvolution(target, evolutionPlan, [source]),
      );

      // Under the baseline registry the sheet owes no whole, so a merge that
      // drops its only filing edge would report nothing here.
      expect(artifact.review.compositionOrphans).toEqual([
        {
          part: { kind: "PlanSheet", id: "sheet" },
          viaEdgeKind: "planFiledIn",
          cause: "unattached",
        },
      ]);
    });

    it("preserves branch failures when forking a resulting-schema branch", async () => {
      const store = await context.createStore(graph, {
        revisionTracking: true,
      });
      const plan = await store.planEvolution(
        defineGraphExtension({
          nodes: {
            Tag: { properties: { label: { type: "string", optional: true } } },
          },
        }),
      );
      const failure = new Error("working-copy backend unavailable");

      const result = await branchForEvolution(store, plan, () =>
        Promise.reject(failure),
      );

      if (!isErr(result)) throw new Error("Expected a branch failure.");
      expect(result.error).toBeInstanceOf(BranchError);
      expect(result.error.cause).toBe(failure);
    });

    it("merges a newly added kind from a resulting-schema branch", async () => {
      const backend = context.getBackend();
      const [target] = await createAdapterStoreWithSchema(graph, backend, {
        revisionTracking: true,
      });
      const evolutionPlan = await target.planEvolution(
        defineGraphExtension({
          nodes: {
            Tag: { properties: { label: { type: "string", optional: true } } },
          },
        }),
      );
      const futureBranch = unwrap(
        await branchForEvolution(
          target,
          evolutionPlan,
          () => context.createIsolatedBackend(),
          { id: asBranchId("future-tag") },
        ),
      );
      await futureBranch.store
        .getNodeCollectionOrThrow("Tag")
        .create({ label: "New" });
      const mergePlan = unwrap(
        await planMergeForEvolution(target, evolutionPlan, [futureBranch]),
      );
      if (backend.adoptSchemaWriteTransaction === undefined) {
        let callbackCalled = false;
        // eslint-disable-next-line vitest/no-conditional-expect -- unsupported adapter parity branch
        await expect(
          backend.transactionWithNative(async (_txBackend, nativeTransaction) =>
            target.withEvolvedTransaction(
              nativeTransaction,
              evolutionPlan,
              () => {
                callbackCalled = true;
                return Promise.resolve(undefined);
              },
            ),
          ),
        ).rejects.toBeInstanceOf(UnsupportedBackendCapabilityError);
        // eslint-disable-next-line vitest/no-conditional-expect -- callback must be untouched on refusal
        expect(callbackCalled).toBe(false);
        return;
      }
      await backend.transactionWithNative(
        async (_txBackend, nativeTransaction) =>
          target.withEvolvedTransaction(
            nativeTransaction,
            evolutionPlan,
            (tx) => applyMergePlanInTransaction(target, tx, mergePlan),
          ),
      );
      const refreshed = await target.refreshSchema({ minVersion: 2 });
      expect(
        await refreshed.getNodeCollectionOrThrow("Tag").find(),
      ).toHaveLength(1);
    });

    it("rolls back merge and caller writes with the caller-owned transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-rollback");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));
      const rollback = new Error("caller rollback");

      await expect(
        context
          .getBackend()
          .transactionWithNative(async (_txBackend, nativeTransaction) => {
            await target.withRecordedTransaction(
              nativeTransaction,
              async (tx) => {
                await applyMergePlanInTransaction(target, tx, artifact);
                await tx.nodes.Person.create(
                  { name: "Application", email: "app@example.test" },
                  { id: "application" },
                );
              },
            );
            throw rollback;
          }),
      ).rejects.toBe(rollback);

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Person.getById(asNodeId("application")),
      ).resolves.toBeUndefined();
      await expect(target.recordedNow()).resolves.toBeUndefined();
    });

    it("refuses a merge after a target graph write in the adopted transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-pristine");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const outcome = await target.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await tx.nodes.Person.create(
                { name: "Application", email: "app@example.test" },
                { id: "application" },
              );
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toMatchObject({
                name: "MergePlanCapabilityError",
                details: { capability: "mergeTransactionPristine" },
              });
            },
          );
          expect(outcome.receipt.writes.total).toBe(1);
        });

      await expect(
        target.nodes.Person.getById(asNodeId("application")),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses a stale plan inside an otherwise pristine adopted transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-stale");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));
      await target.nodes.Person.create(
        { name: "Concurrent", email: "concurrent@example.test" },
        { id: "concurrent" },
      );

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          await target.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toBeInstanceOf(StaleMergePlanError);
            },
          );
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses a transaction context bound to a different target store", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const [otherTarget] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-owner");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          await otherTarget.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toBeInstanceOf(MergePlanCapabilityError);
            },
          );
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses persisted provenance before writing in an adopted transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-provenance");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(
        await planMerge(target, [source], { persistProvenance: true }),
      );

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          await target.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toBeInstanceOf(MergePlanCapabilityError);
            },
          );
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
      await expect(target.recordedNow()).resolves.toBeUndefined();
    });

    it("refuses a retained adopted context after capture has sealed it", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-sealed");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const { result: applyAfterReturn } =
            await target.withRecordedTransaction(nativeTransaction, (tx) =>
              Promise.resolve(() =>
                applyMergePlanInTransaction(target, tx, artifact),
              ),
            );
          await expect(applyAfterReturn()).rejects.toMatchObject({
            name: "MergePlanCapabilityError",
            details: { capability: "mergeTransactionStore" },
          });
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
      await expect(target.recordedNow()).resolves.toBeUndefined();
    });

    it("refuses a retained non-history recorded transaction context", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { revisionTracking: true },
      );
      const source = await makeBranch(
        context,
        target,
        "adopted-non-history-retained",
      );
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const { result: applyAfterReturn } =
            await target.withRecordedTransaction(nativeTransaction, (tx) =>
              Promise.resolve(() =>
                applyMergePlanInTransaction(target, tx, artifact),
              ),
            );
          await expect(applyAfterReturn()).rejects.toMatchObject({
            name: "MergePlanCapabilityError",
            details: { capability: "mergeTransactionStore" },
          });
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses an unscoped withTransaction context", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-unscoped");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const tx = target.withTransaction(nativeTransaction);
          await expect(
            applyMergePlanInTransaction(target, tx, artifact),
          ).rejects.toMatchObject({
            name: "MergePlanCapabilityError",
            details: { capability: "mergeTransactionStore" },
          });
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("accepts an active store-managed transaction callback", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { revisionTracking: true },
      );
      const source = await makeBranch(context, target, "managed-active");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      const report = await target.transaction((tx) =>
        applyMergePlanInTransaction(target, tx, artifact),
      );

      expect(report.merged.nodes).toBe(1);
      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeDefined();
    });
  });
}
