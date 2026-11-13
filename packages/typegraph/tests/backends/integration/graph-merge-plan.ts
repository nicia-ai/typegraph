import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  createStoreWithSchema,
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
  CandidatePlanningScopeError,
  MergeCompositionOrphanError,
  MergePlanCapabilityError,
  MergePlanningStaleError,
  MergePlanSchemaMismatchError,
  StaleMergePlanError,
} from "../../../src/graph-merge/errors";
import { applyMergePlan, planMerge } from "../../../src/graph-merge/merge";
import { computeMergePlanDigest } from "../../../src/graph-merge/plan-canonical";
import type {
  MergePlanArtifact,
  MergePlanArtifactInput,
} from "../../../src/graph-merge/plan-schema";
import {
  constructMergePlanArtifact,
  parseMergePlanArtifact,
} from "../../../src/graph-merge/plan-wire";
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
    it("parses legacy plans but refuses applying them without changing the graph", async () => {
      const base = await context.createStore(graph, { revisionTracking: true });
      const source = await makeBranch(context, base, "legacy");
      try {
        await source.store.nodes.Person.create(
          { name: "legacy", email: "legacy@example.test" },
          { id: "legacy" },
        );
        const current = unwrap(await planMerge(base, [source]));
        const { digest: _digest, review, ...input } = current;
        const { identityConflicts: _conflicts, ...legacyReview } = review;
        const { owner: _owner, ...revision } = input.target.revision;
        const legacyInputs = [
          {
            ...input,
            formatVersion: 1,
            target: { ...input.target, revision },
            review: legacyReview,
          },
          { ...input, formatVersion: 2, review: legacyReview },
        ] as unknown as readonly MergePlanArtifactInput[];
        const before = await base.revisionNow();
        for (const legacyInput of legacyInputs) {
          const legacy = {
            ...legacyInput,
            digest: {
              algorithm: "sha256",
              value: await computeMergePlanDigest(legacyInput),
            },
          } as MergePlanArtifact;
          // Exercise the serialized wire boundary: the legacy grammar parses,
          // and applying it is refused before any write.
          // eslint-disable-next-line unicorn/prefer-structured-clone
          const serialized = JSON.parse(
            JSON.stringify(legacy),
          ) as typeof legacy;
          expect(parseMergePlanArtifact(serialized).success).toBe(true);
          const refused = await applyMergePlan(base, serialized);
          expect(refused).toMatchObject({
            success: false,
            error: {
              code: "GRAPH_MERGE_PLAN_VERSION_UNSUPPORTED",
              details: { received: legacyInput.formatVersion },
            },
          });
        }
        expect(await base.revisionNow()).toBe(before);
        expect(
          await base.nodes.Person.getById(asNodeId("legacy")),
        ).toBeUndefined();
      } finally {
        await source.close();
      }
    });

    it("returns the exact terminal apply receipt despite a later commit before the response", async () => {
      const base = await context.createHistoryStore(graph);
      const node = await base.nodes.Person.create({
        name: "before",
        email: "before@example.test",
      });
      const source = await makeBranch(context, base, "receipt-source");
      try {
        await source.store.nodes.Person.update(node.id, { name: "applied" });
        const plan = unwrap(await planMerge(base, [source]));
        const backend = context.getBackend();
        let armed = false;
        let advanced = false;
        const [observed] = await createStoreWithSchema(
          graph,
          deriveBackend(backend, {
            async transaction(callback, options) {
              const result = await backend.transaction(callback, options);
              if (armed && !advanced) {
                advanced = true;
                await base.nodes.Person.update(node.id, { name: "later" });
              }
              return result;
            },
          }),
          { history: true },
        );
        armed = true;
        const report = unwrap(
          await applyMergePlan(observed, plan, {
            async afterApply(tx) {
              await tx.nodes.Person.create(
                { name: "callback", email: "callback@example.test" },
                { id: "callback" },
              );
            },
          }),
        );
        expect(advanced).toBe(true);
        const recorded = requireDefined(report.receipt.recorded);
        expect(await base.recordedNow()).not.toBe(recorded);
        expect(await base.nodes.Person.getById(node.id)).toMatchObject({
          name: "later",
        });
        const atApply = base.asOfRecorded(recorded);
        expect(await atApply.nodes.Person.getById(node.id)).toMatchObject({
          name: "applied",
        });
        expect(
          await atApply.nodes.Person.getById(asNodeId("callback")),
        ).toMatchObject({ name: "callback" });
        expect(report.receipt.writes.nodes["Person"]).toBe(2);
      } finally {
        await source.close();
      }
    });

    it("reports an owned no-op transaction receipt and no recorded anchor when history is disabled", async () => {
      for (const history of [true, false]) {
        const base =
          history ?
            await context.createHistoryStore(graph)
          : await context.createStore(graph, { revisionTracking: true });
        const source = await makeBranch(
          context,
          base,
          `empty-${String(history)}`,
        );
        try {
          const plan = unwrap(await planMerge(base, [source]));
          const report = unwrap(await applyMergePlan(base, plan));
          expect(report.receipt.writes.total).toBe(0);
          expect(report.receipt.recorded !== undefined).toBe(history);
        } finally {
          await source.close();
        }
      }
    });

    it("returns no successful apply receipt after callback rollback", async () => {
      const base = await context.createHistoryStore(graph);
      const source = await makeBranch(context, base, "rollback-receipt");
      try {
        await source.store.nodes.Person.create(
          { name: "staged", email: "staged@example.test" },
          { id: "staged" },
        );
        const plan = unwrap(await planMerge(base, [source]));
        const before = await base.recordedNow();
        const failed = await applyMergePlan(base, plan, {
          afterApply() {
            throw new Error("rollback receipt");
          },
        });
        expect(isErr(failed)).toBe(true);
        expect(await base.recordedNow()).toBe(before);
        expect(
          await base.nodes.Person.getById(asNodeId("staged")),
        ).toBeUndefined();
        const report = unwrap(await applyMergePlan(base, plan));
        expect(report.receipt.recorded).toBeDefined();
      } finally {
        await source.close();
      }
    });

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
      const scopedBackend = vi.fn(() => context.createIsolatedBackend());
      // The evolution planner requires `planningScope: "full"`; an untyped
      // caller that states the bounded default is refused.
      const untypedArguments = {
        target,
        evolutionPlan,
        makeBackend: scopedBackend,
        writeSet,
        planningScope: "candidate",
      } as unknown as Parameters<typeof planCandidateWriteSetForEvolution>[0];
      const scoped = await planCandidateWriteSetForEvolution(untypedArguments);
      if (!isErr(scoped))
        throw new Error("expected a candidate planning scope refusal");
      expect(scoped.error).toBeInstanceOf(CandidatePlanningScopeError);
      expect(scoped.error.details).toEqual({
        capability: "boundedCandidatePlanning",
        requiredPlanningScope: "full",
        planningScope: { scope: "full", reason: "planned-evolution" },
      });
      expect(scopedBackend).not.toHaveBeenCalled();

      const { plan: mergePlan, planningScope } = unwrap(
        await planCandidateWriteSetForEvolution({
          planningScope: "full",
          target,
          evolutionPlan,
          makeBackend: () => context.createIsolatedBackend(),
          writeSet,
        }),
      );
      expect(planningScope).toEqual({
        scope: "full",
        reason: "planned-evolution",
      });
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
          planningScope: "full",
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
      ).plan;
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
        planningScope: "full",
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

    it("refuses composition orphans under the resulting schema's registry", async () => {
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

      const planned = await planMergeForEvolution(target, evolutionPlan, [
        source,
      ]);

      // Under the baseline registry the sheet owes no whole, so a merge that
      // drops its only filing edge would plan cleanly here.
      if (!isErr(planned)) throw new Error("expected a plan-time refusal");
      expect(planned.error).toBeInstanceOf(MergeCompositionOrphanError);
      expect(planned.error.details).toEqual({
        part: { kind: "PlanSheet", id: "sheet" },
        viaEdgeKind: "planFiledIn",
        cause: "unattached",
      });
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

    it("keeps evolution branches revision-tracked without a revision journal", async () => {
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
      const result = await branchForEvolution(
        store,
        plan,
        async () =>
          deriveBackend(await context.createIsolatedBackend(), {
            ensureRevisionChangesJournal: () =>
              Promise.reject(new Error("working-copy journal DDL was invoked")),
          }),
        {
          id: asBranchId("future-tag-without-journal"),
          revisionJournal: false,
        },
      );
      const futureBranch = unwrap(result);

      expect(futureBranch.store.revisionTrackingEnabled).toBe(true);
      expect(futureBranch.store.revisionJournalEnabled).toBe(false);
      await expect(
        futureBranch.store.lineageRevisionNow(),
      ).resolves.toBeUndefined();
      await futureBranch.store.nodes.Person.create({
        name: "Ada",
        email: "ada@future.test",
      });
      await futureBranch.close();
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
