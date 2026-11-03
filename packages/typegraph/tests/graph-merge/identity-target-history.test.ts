/**
 * A merge's identity claims are judged against the target's whole history,
 * not only its current rows, and at plan time:
 *
 *  - a base assertion a branch retracts becomes history holding until the
 *    retraction's own end, so another branch's claim over that span is
 *    checked against it (otherwise the merge commits a ledger that is both
 *    same and different there);
 *  - a row the target ended before the fork — which a branch does not carry,
 *    so the branch accepted a backdated claim over it — refuses the plan with
 *    the contradiction and its window, instead of passing review and failing
 *    inside the commit.
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
import {
  BaseVersionMismatchError,
  IdentityMergeConflictError,
} from "../../src/graph-merge/errors";
import {
  merge,
  mergeIncremental,
  planMerge,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
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
const TARGET_CLONE = asBranchId("target-history-target");

const OPPOSING =
  "Branches asserted opposing identity relations for one endpoint pair.";
const CONTRADICTION =
  "The merged identity ledger would assert one pair of nodes is both the same and different.";

/** A state import of one `same` assertion valid since 2024 — a backdated claim. */
function backdatedSame(id: string, left: string, right: string) {
  return {
    formatVersion: "2.0" as const,
    exportedAt: "2026-04-01T00:00:00.000Z",
    source: { type: "external" as const },
    nodes: [],
    edges: [],
    identity: {
      profile: "typegraph-identity-v1" as const,
      mode: "state" as const,
      assertions: [
        {
          id,
          relation: "same" as const,
          a: agent(left),
          b: agent(right),
          validFrom: "2024-01-01T00:00:00.000Z",
        },
      ],
    },
  };
}

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
        expect(result.error.message).toBe(CONTRADICTION);
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

    it("refuses at plan time a branch claim over a row the target ended before the fork", async () => {
      const cleanups: (() => Promise<void>)[] = [];
      async function makeBackend(): Promise<GraphBackend> {
        const fixture = await entry.make();
        cleanups.push(fixture.cleanup);
        return fixture.backend;
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const [base] = await createStoreWithSchema(graph, await makeBackend(), {
          revisionTracking: true,
        });
        for (const id of ["n1", "n2"]) {
          await base.nodes.Agent.create(
            {},
            { id, validFrom: "2020-01-01T00:00:00.000Z" },
          );
        }
        vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
        const separated = await base.identity.assertDifferent(
          agent("n1"),
          agent("n2"),
        );
        vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
        await base.identity.retractAssertion(separated.assertion.id);

        // The branch does not carry the ended row, so on its own ledger a
        // `same` valid since 2024 contradicts nothing.
        const branchA = unwrap(
          await branch(base, () => makeBackend(), { id: BRANCH_A }),
        );
        vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
        const imported = await importGraph(
          branchA.store,
          backdatedSame("backdated-same", "n1", "n2"),
          { onConflict: "skip" },
        );
        expect(imported.errors).toEqual([]);

        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const expectedDetails = {
          assertion: {
            id: separated.assertion.id,
            relation: "different",
            a: agent("n1"),
            b: agent("n2"),
            validFrom: "2026-02-01T00:00:00.000Z",
            validTo: "2026-03-01T00:00:00.000Z",
          },
          sameClass: [agent("n1"), agent("n2")],
          window: {
            validFrom: "2026-02-01T00:00:00.000Z",
            validTo: "2026-03-01T00:00:00.000Z",
          },
        };
        const planned = await planMerge(base, [branchA]);
        expect(isErr(planned)).toBe(true);
        if (!isErr(planned)) return;
        console.info("ended-history plan refusal", planned.error.details);
        expect(planned.error).toBeInstanceOf(IdentityMergeConflictError);
        expect(planned.error.message).toBe(CONTRADICTION);
        expect(planned.error.details).toEqual(expectedDetails);

        const merged = await merge(base, [branchA]);
        expect(isErr(merged) && merged.error.message).toBe(CONTRADICTION);
        expect(
          [
            ...(
              await storeRuntime(base).identityAssertionRowsByIds([
                "backdated-same",
              ])
            ).keys(),
          ],
          "nothing was written",
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    });

    it("refuses at plan time an incremental branch claim over a row the target ended before the fork", async () => {
      const cleanups: (() => Promise<void>)[] = [];
      async function makeBackend(): Promise<GraphBackend> {
        const fixture = await entry.make();
        cleanups.push(fixture.cleanup);
        return fixture.backend;
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const [target] = await createStoreWithSchema(
          graph,
          await makeBackend(),
          {
            revisionTracking: true,
          },
        );
        for (const id of ["n1", "n2"]) {
          await target.nodes.Agent.create(
            {},
            { id, validFrom: "2020-01-01T00:00:00.000Z" },
          );
        }
        vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
        const separated = await target.identity.assertDifferent(
          agent("n1"),
          agent("n2"),
        );
        vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
        await target.identity.retractAssertion(separated.assertion.id);
        // An incremental merge into the fork point itself: the branch does not
        // carry the ended row, the target holds it as its own history.
        const forkPoint = target;
        const branchA = unwrap(
          await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
        );
        vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
        const imported = await importGraph(
          branchA.store,
          backdatedSame("backdated-same", "n1", "n2"),
          { onConflict: "skip" },
        );
        expect(imported.errors).toEqual([]);

        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const args = { forkPoint, target, branches: [branchA] };
        const planned = await planMergeIncremental(args);
        expect(isErr(planned)).toBe(true);
        if (!isErr(planned)) return;
        expect(planned.error).toBeInstanceOf(IdentityMergeConflictError);
        expect(planned.error.message).toBe(CONTRADICTION);
        expect(planned.error.details).toMatchObject({
          assertion: { id: separated.assertion.id },
          window: {
            validFrom: "2026-02-01T00:00:00.000Z",
            validTo: "2026-03-01T00:00:00.000Z",
          },
        });
        const merged = await mergeIncremental(args);
        expect(isErr(merged) && merged.error.message).toBe(CONTRADICTION);
      } finally {
        vi.useRealTimers();
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    });

    it("refuses at plan time an incremental branch claim over a row the advanced target ended", async () => {
      const cleanups: (() => Promise<void>)[] = [];
      async function makeBackend(): Promise<GraphBackend> {
        const fixture = await entry.make();
        cleanups.push(fixture.cleanup);
        return fixture.backend;
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const [forkPoint] = await createStoreWithSchema(
          graph,
          await makeBackend(),
          { revisionTracking: true },
        );
        for (const id of ["n1", "n2"]) {
          await forkPoint.nodes.Agent.create(
            {},
            { id, validFrom: "2020-01-01T00:00:00.000Z" },
          );
        }
        const target = unwrap(
          await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
        ).store;
        const branchA = unwrap(
          await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
        );
        // The target, after the fork: n1 and n2 differ from February to March.
        vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
        const separated = await target.identity.assertDifferent(
          agent("n1"),
          agent("n2"),
        );
        vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
        await target.identity.retractAssertion(separated.assertion.id);
        vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
        const imported = await importGraph(
          branchA.store,
          backdatedSame("backdated-same", "n1", "n2"),
          { onConflict: "skip" },
        );
        expect(imported.errors).toEqual([]);

        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        // The target's own post-fork rows are staged as a side of the merge,
        // so the ended `different` meets the backdated `same` as an opposing
        // pair over overlapping windows.
        const args = { forkPoint, target, branches: [branchA] };
        const planned = await planMergeIncremental(args);
        expect(isErr(planned)).toBe(true);
        if (!isErr(planned)) return;
        expect(planned.error).toBeInstanceOf(IdentityMergeConflictError);
        expect(planned.error.message).toBe(OPPOSING);
        expect(planned.error.details).toMatchObject({
          assertions: [
            { id: "backdated-same" },
            { id: separated.assertion.id },
          ],
        });
        const merged = await mergeIncremental(args);
        expect(isErr(merged) && merged.error.message).toBe(OPPOSING);
      } finally {
        vi.useRealTimers();
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    });

    it("refuses as a re-plan a target history row committed and ended between planning and commit", async () => {
      const cleanups: (() => Promise<void>)[] = [];
      async function makeBackend(): Promise<GraphBackend> {
        const fixture = await entry.make();
        cleanups.push(fixture.cleanup);
        return fixture.backend;
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const [forkPoint] = await createStoreWithSchema(
          graph,
          await makeBackend(),
          { revisionTracking: true },
        );
        for (const id of ["n1", "n2"]) {
          await forkPoint.nodes.Agent.create(
            {},
            { id, validFrom: "2020-01-01T00:00:00.000Z" },
          );
        }
        const target = unwrap(
          await branch(forkPoint, () => makeBackend(), { id: TARGET_CLONE }),
        ).store;
        const branchA = unwrap(
          await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
        );
        vi.setSystemTime(new Date("2026-04-01T00:00:00.000Z"));
        const imported = await importGraph(
          branchA.store,
          backdatedSame("backdated-same", "n1", "n2"),
          { onConflict: "skip" },
        );
        expect(imported.errors).toEqual([]);

        // After planning, before the commit transaction: the target holds n1
        // and n2 different for a day and ends it — no current row changes.
        vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
        const original = target.transaction.bind(target);
        let injected = false;
        (target as { transaction: unknown }).transaction = async (
          fn: unknown,
          options: unknown,
        ) => {
          if (!injected) {
            injected = true;
            const window = await target.identity.assertDifferent(
              agent("n1"),
              agent("n2"),
            );
            vi.setSystemTime(new Date("2026-05-02T00:00:00.000Z"));
            await target.identity.retractAssertion(window.assertion.id);
          }
          return (original as (f: unknown, o: unknown) => unknown)(fn, options);
        };
        try {
          const result = await mergeIncremental({
            forkPoint,
            target,
            branches: [branchA],
          });
          expect(injected).toBe(true);
          expect(isErr(result)).toBe(true);
          if (!isErr(result)) return;
          console.info("window history refusal", result.error.message);
          expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
        } finally {
          (target as { transaction: unknown }).transaction = original;
        }
        expect(
          [
            ...(
              await storeRuntime(target).identityAssertionRowsByIds([
                "backdated-same",
              ])
            ).keys(),
          ],
          "nothing was written",
        ).toEqual([]);
      } finally {
        vi.useRealTimers();
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    });
  },
);
