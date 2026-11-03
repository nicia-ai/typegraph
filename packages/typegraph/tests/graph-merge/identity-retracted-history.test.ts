/**
 * A base assertion a branch retracts does not vanish from the merged ledger:
 * it becomes history, holding until the retraction's own end. The merge's
 * contradiction check must judge every other branch claim against the time
 * that row still held — otherwise two branches that are each consistent on
 * their own commit a ledger that is both same and different over that span.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { IdentityMergeConflictError } from "../../src/graph-merge/errors";
import { merge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { importGraph } from "../../src/interchange";
import { storeRuntime } from "../../src/store/runtime-port";
import { backendMatrix } from "./test-utils";

const Agent = defineNode("Agent", { schema: z.object({}) });

const graph = defineGraph({
  id: "identity_retracted_history",
  nodes: { Agent: { type: Agent } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH_A = asBranchId("retracted-history-a");
const BRANCH_B = asBranchId("retracted-history-b");

function agent(id: string) {
  return { kind: "Agent" as const, id };
}

describe.each(backendMatrix())(
  "a merge judging claims against retracted base history [$name]",
  (entry) => {
    it("refuses at plan time a claim that contradicts a base row over the time it still held", async () => {
      const cleanups: (() => Promise<void>)[] = [];
      async function makeBackend(): Promise<GraphBackend> {
        const fixture = await entry.make();
        cleanups.push(fixture.cleanup);
        return fixture.backend;
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const [base] = await createStoreWithSchema(graph, await makeBackend());
        for (const id of ["n1", "n2", "n4"]) {
          await base.nodes.Agent.create(
            {},
            { id, validFrom: "2020-01-01T00:00:00.000Z" },
          );
        }
        vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
        const inherited = await base.identity.assertSame(
          agent("n1"),
          agent("n2"),
        );
        const branchA = unwrap(
          await branch(base, () => makeBackend(), { id: BRANCH_A }),
        );
        const branchB = unwrap(
          await branch(base, () => makeBackend(), { id: BRANCH_B }),
        );

        // Branch A: n2 and n4 differ from March — consistent, since n1 ~ n2
        // says nothing about n4 on this branch.
        vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
        const separated = await branchA.store.identity.assertDifferent(
          agent("n2"),
          agent("n4"),
        );
        // Branch B: n1 ~ n4 since 2024, and n1 ~ n2 ends in May — consistent,
        // since nothing on this branch separates n2 from n4.
        vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
        const imported = await importGraph(
          branchB.store,
          {
            formatVersion: "2.0",
            exportedAt: "2026-04-01T00:00:00.000Z",
            source: { type: "external" },
            nodes: [],
            edges: [],
            identity: {
              profile: "typegraph-identity-v1",
              mode: "state",
              assertions: [
                {
                  id: "backdated-same",
                  relation: "same",
                  a: agent("n1"),
                  b: agent("n4"),
                  validFrom: "2024-01-01T00:00:00.000Z",
                },
              ],
            },
          },
          { onConflict: "skip" },
        );
        expect(imported.errors).toEqual([]);
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        await branchB.store.identity.retractAssertion(inherited.assertion.id);

        // Together, n2 ~ n1 ~ n4 from March to May while n2 and n4 differ.
        vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
        const result = await merge(base, [branchA, branchB], {
          branchOrder: [BRANCH_A, BRANCH_B],
        });
        expect(isErr(result)).toBe(true);
        if (!isErr(result)) return;
        console.info("retracted-history refusal", result.error.details);
        expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
        expect(result.error.message).toBe(
          "The merged identity ledger would assert one pair of nodes is both the same and different.",
        );
        const ledger = await storeRuntime(base).identityAssertionRowsByIds([
          inherited.assertion.id,
          separated.assertion.id,
          "backdated-same",
        ]);
        expect([...ledger.keys()]).toEqual([inherited.assertion.id]);
        expect(ledger.get(inherited.assertion.id)?.validTo).toBeUndefined();
      } finally {
        vi.useRealTimers();
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    });
  },
);
