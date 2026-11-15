import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { MergeError } from "../../src/graph-merge/errors";
import {
  applyMergePlanInTransaction,
  planMerge,
} from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string() }),
});
const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});
const primaryEncounter = defineEdge("primaryEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});
const graph = defineGraph({
  id: "adopted_merge_mid_apply_rollback",
  nodes: {
    Patient: { type: Patient },
    Encounter: { type: Encounter },
  },
  edges: {
    primaryEncounter: {
      type: primaryEncounter,
      from: [Patient],
      to: [Encounter],
      cardinality: "oneActive",
    },
  },
});

describe("adopted merge mid-apply rollback", () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function mergeTarget(
    history: boolean,
    refuseEncounterWrites: () => boolean,
    ended: string[] = [],
  ) {
    const { backend } = createLocalSqliteBackend();
    cleanups.push(() => backend.close());
    let attemptedEncounterWrites = 0;
    const [target] = await createAdapterStoreWithSchema(graph, backend, {
      revisionTracking: true,
      history,
      hooks: {
        onOperationEnd: (operation) => {
          ended.push(operation.kind);
        },
        onBulkOperationEnd: (operation) => {
          ended.push(operation.kind);
        },
        onOperationStart: (operation) => {
          if (operation.entity !== "node" || operation.kind !== "Encounter")
            return;
          attemptedEncounterWrites += 1;
          // The second encounter write fails, after the first has landed.
          if (refuseEncounterWrites() && attemptedEncounterWrites > 1) {
            throw new Error("encounter writes are refused by this test");
          }
        },
      },
    });
    await target.nodes.Patient.create({ name: "Robert" }, { id: "patient" });
    const source = unwrap(
      await branch(
        target,
        () => {
          const fixture = createLocalSqliteBackend();
          cleanups.push(() => fixture.backend.close());
          return Promise.resolve(fixture.backend);
        },
        { id: asBranchId("source") },
      ),
    );
    for (const id of ["encounter-a", "encounter-b"]) {
      await source.store.nodes.Encounter.create({ reason: id }, { id });
    }
    await source.store.edges.primaryEncounter.create(
      { kind: "Patient", id: "patient" },
      { kind: "Encounter", id: "encounter-a" },
      { on: "2026-01-01" },
      { id: "edge-a" },
    );
    const artifact = unwrap(await planMerge(target, [source]));
    return {
      backend,
      target,
      artifact,
      attemptedEncounterWrites: () => attemptedEncounterWrites,
    };
  }

  it.each([false, true])(
    "rolls back every write when the apply fails after writing (history: %s)",
    async (history) => {
      let refuse = false;
      const { backend, target, artifact, attemptedEncounterWrites } =
        await mergeTarget(history, () => refuse);
      refuse = true;

      await expect(
        backend.transactionWithNative(async (_txBackend, nativeTransaction) =>
          target.withRecordedTransaction(nativeTransaction, async (tx) => {
            await applyMergePlanInTransaction(target, tx, artifact);
            await tx.nodes.Patient.create(
              { name: "Application" },
              { id: "application" },
            );
          }),
        ),
      ).rejects.toBeInstanceOf(MergeError);

      expect(attemptedEncounterWrites()).toBe(2);
      await expect(
        target.nodes.Encounter.getById(asNodeId("encounter-a")),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Patient.getById(asNodeId("application")),
      ).resolves.toBeUndefined();
    },
  );

  it.each([false, true])(
    "keeps none of a failed apply when the caller catches the refusal and commits (history: %s)",
    async (history) => {
      let refuse = false;
      const { backend, target, artifact, attemptedEncounterWrites } =
        await mergeTarget(history, () => refuse);
      const revisionBefore = await target.revisionNow();
      refuse = true;

      let refusal: unknown;
      await backend.transactionWithNative(
        async (_txBackend, nativeTransaction) =>
          target.withRecordedTransaction(nativeTransaction, async (tx) => {
            try {
              await applyMergePlanInTransaction(target, tx, artifact);
            } catch (error) {
              refusal = error;
            }
            await tx.nodes.Patient.create(
              { name: "Application" },
              { id: "application" },
            );
          }),
      );

      expect(refusal).toBeInstanceOf(MergeError);
      // The first encounter row was written before the second one failed;
      // the apply's savepoint rolled it back before the refusal reached the
      // caller, so the caller's own write is all its commit keeps.
      expect(attemptedEncounterWrites()).toBe(2);
      await expect(
        target.nodes.Encounter.getById(asNodeId("encounter-a")),
      ).resolves.toBeUndefined();
      expect(await target.edges.primaryEncounter.find()).toEqual([]);
      await expect(
        target.nodes.Patient.getById(asNodeId("application")),
      ).resolves.toBeDefined();
      expect(await target.revisionNow()).not.toEqual(revisionBefore);
      expect(await target.verifyConstraintFences()).toEqual([]);
    },
  );

  it.each(
    [false, true].flatMap((history) =>
      [false, true].flatMap((adopted) =>
        [false, true].map((continueWriting) => ({
          history,
          adopted,
          continueWriting,
        })),
      ),
    ),
  )(
    "discards failed apply hooks and revision flags (history: $history, adopted: $adopted, continue: $continueWriting)",
    async ({ history, adopted, continueWriting }) => {
      let refuse = false;
      const ended: string[] = [];
      const { backend, target, artifact } = await mergeTarget(
        history,
        () => refuse,
        ended,
      );
      const before = await target.revisionNow();
      ended.length = 0;
      refuse = true;
      const run = async (
        tx: Parameters<Parameters<typeof target.transactionWithReceipt>[0]>[0],
      ) => {
        await expect(
          applyMergePlanInTransaction(target, tx, artifact),
        ).rejects.toBeInstanceOf(MergeError);
        expect(ended).toEqual([]);
        if (continueWriting)
          await tx.nodes.Patient.create(
            { name: "Application" },
            { id: "application" },
          );
      };
      const { receipt } =
        adopted ?
          await backend.transactionWithNative(async (_target, native) =>
            target.withRecordedTransaction(native, run),
          )
        : await target.transactionWithReceipt(run);
      expect(ended).toEqual(continueWriting ? ["Patient"] : []);
      expect(receipt.writes.total).toBe(continueWriting ? 1 : 0);
      expect(await target.nodes.Encounter.find()).toEqual([]);
      if (!continueWriting) {
        expect(receipt.recorded).toBeUndefined();
        expect(await target.revisionNow()).toEqual(before);
      }
    },
  );
  // MUTATION CHECK (verified): calling `applyValidatedMergePlanInTransaction`
  // directly instead of through `withAdoptedMergeApplySavepoint` in
  // `applyMergePlanInTransaction` (src/graph-merge/merge.ts) leaves
  // `encounter-a` committed in the second case.
});
