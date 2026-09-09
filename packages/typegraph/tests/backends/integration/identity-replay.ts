/**
 * Cross-backend replay equivalence (L1, §9.2): assert / assert / retract /
 * re-assert must replay into steps whose `after` matches the live closure at
 * each revision, on every backend `createIntegrationTestSuite` runs against —
 * the backend-parity rule (AGENTS.md) applied to the replay contract.
 *
 * Internal for PR-1: `identityReplay` is reached by module path, not through
 * a public `store.identity.replay` (that lands with PR-3).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { identityReplay } from "../../../src/identity/replay";
import { storeRuntime } from "../../../src/store/runtime-port";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const ReplayPerson = defineNode("Person", { schema: z.object({}) });

const identityReplayGraph = defineGraph({
  id: "identity_replay_parity",
  nodes: { Person: { type: ReplayPerson } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

async function provisionIdentityReplayStore(context: IntegrationTestContext) {
  const backend = context.getStore().backend;
  const [store] = await createStoreWithSchema(identityReplayGraph, backend, {
    history: true,
  });
  return store;
}

export function registerIdentityReplayIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("identity replay equivalence", () => {
    it("replays merge / split / re-merge: four steps, causes assert/assert/retract/assert, after matching the live closure at EVERY revision", async () => {
      const store = await provisionIdentityReplayStore(context);
      const a = { kind: "Person" as const, id: "replay-a" };
      const b = { kind: "Person" as const, id: "replay-b" };
      const c = { kind: "Person" as const, id: "replay-c" };
      await store.nodes.Person.create({}, { id: a.id });
      await store.nodes.Person.create({}, { id: b.id });
      await store.nodes.Person.create({}, { id: c.id });

      const same1 = await store.identity.assertSame(a, b);
      await store.identity.assertSame(b, c);
      await store.identity.retractAssertion(same1.assertion.id);
      await store.identity.assertSame(a, b);

      const ctx = storeRuntime(store).identityContext();
      const replay = await identityReplay(ctx, a);

      // §9.2 L1's contract, at BOUNDARY granularity: four boundaries, causes
      // assert/assert/retract/assert. The retract boundary itself carries TWO
      // transition rows — one per resulting component (a's own departure,
      // and b+c's continuation) — exactly as §3.2 point 6 documents ("several
      // transitions at one revision... emitted as several steps with
      // identical before/after"), so this groups by revision first rather
      // than asserting step count and cause sequence directly against the
      // (boundary-count-exceeding) step list.
      const revisionsInOrder = [
        ...new Set(replay.steps.map((step) => step.transition.recorded)),
      ];
      expect(revisionsInOrder.length).toBe(4);
      const causesByBoundary = revisionsInOrder.map((recorded) => {
        const stepsAtBoundary = replay.steps.filter(
          (step) => step.transition.recorded === recorded,
        );
        const causesAtBoundary = new Set(
          stepsAtBoundary.map((step) => step.transition.cause),
        );
        // Every row at one boundary shares the SAME cause (this fixture never
        // mixes causes within a commit) — asserted so a future generator
        // change that violates it fails loudly here, not as a silent
        // `.at(0)` truncation.
        expect(causesAtBoundary.size).toBe(1);
        return requireDefined([...causesAtBoundary][0]);
      });
      expect(causesByBoundary).toEqual([
        "assert",
        "assert",
        "retract",
        "assert",
      ]);

      // before(i) == after(i-1) for every step whose revision differs from
      // the previous step's (several notes can share one revision).
      for (let index = 1; index < replay.steps.length; index += 1) {
        const previous = requireDefined(replay.steps[index - 1]);
        const current = requireDefined(replay.steps[index]);
        if (previous.transition.recorded === current.transition.recorded) {
          continue;
        }
        expect(current.before.map((ref) => ref.id).toSorted()).toEqual(
          previous.after.map((ref) => ref.id).toSorted(),
        );
      }

      // EVERY step's `after` equals the LIVE closure as of that step's own
      // revision — not only the final one — via `asOfRecorded`, a read path
      // that never touches the transition log, so agreement is the whole
      // equivalence pin.
      for (const step of replay.steps) {
        const liveMembersAtStep = await store
          .asOfRecorded(step.transition.recorded)
          .identity.membersOf(a);
        expect(step.after.map((ref) => ref.id).toSorted()).toEqual(
          liveMembersAtStep.map((ref) => ref.id).toSorted(),
        );
      }

      const lastStep = requireDefined(replay.steps.at(-1));
      const liveMembers = await store.identity.membersOf(a);
      expect(lastStep.after.map((ref) => ref.id).toSorted()).toEqual(
        liveMembers.map((ref) => ref.id).toSorted(),
      );
    });
  });
}
