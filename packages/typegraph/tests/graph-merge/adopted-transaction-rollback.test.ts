import {
  asNodeId,
  CardinalityError,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
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

  it.each([false, true])(
    "rolls back node writes when the later edge batch fails (history: %s)",
    async (history) => {
      const { backend } = createLocalSqliteBackend();
      cleanups.push(() => backend.close());
      let attemptedEncounterWrites = 0;
      const [target] = await createAdapterStoreWithSchema(graph, backend, {
        revisionTracking: true,
        history,
        hooks: {
          onOperationStart: (operation) => {
            if (operation.entity === "node" && operation.kind === "Encounter")
              attemptedEncounterWrites += 1;
          },
        },
      });
      await target.nodes.Patient.create({ name: "Robert" }, { id: "patient" });

      async function makeBranch(id: string) {
        return unwrap(
          await branch(
            target,
            () => {
              const fixture = createLocalSqliteBackend();
              cleanups.push(() => fixture.backend.close());
              return Promise.resolve(fixture.backend);
            },
            { id: asBranchId(id) },
          ),
        );
      }

      const left = await makeBranch("left");
      const right = await makeBranch("right");
      await left.store.nodes.Encounter.create(
        { reason: "left" },
        { id: "encounter-left" },
      );
      await left.store.edges.primaryEncounter.create(
        { kind: "Patient", id: "patient" },
        { kind: "Encounter", id: "encounter-left" },
        { on: "2026-01-01" },
        { id: "edge-left" },
      );
      await right.store.nodes.Encounter.create(
        { reason: "right" },
        { id: "encounter-right" },
      );
      await right.store.edges.primaryEncounter.create(
        { kind: "Patient", id: "patient" },
        { kind: "Encounter", id: "encounter-right" },
        { on: "2026-01-02" },
        { id: "edge-right" },
      );
      const artifact = unwrap(await planMerge(target, [left, right]));
      attemptedEncounterWrites = 0;

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
      ).rejects.toMatchObject({
        name: "MergeConstraintConflictError",
        cause: expect.any(CardinalityError) as unknown,
      });

      expect(attemptedEncounterWrites).toBeGreaterThan(0);
      await expect(
        target.nodes.Encounter.getById(asNodeId("encounter-left")),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Encounter.getById(asNodeId("encounter-right")),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Patient.getById(asNodeId("application")),
      ).resolves.toBeUndefined();
    },
  );
});
