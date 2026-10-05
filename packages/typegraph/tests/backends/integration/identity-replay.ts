/**
 * Cross-backend replay equivalence (L1, §9.2): assert / assert / retract /
 * re-assert must replay into steps whose `after` matches the live closure at
 * each revision, on every backend `createIntegrationTestSuite` runs against —
 * the backend-parity rule (AGENTS.md) applied to the replay contract.
 *
 * Exercises the PUBLIC facade (`store.identity.replay`), not the internal
 * `identityReplay` module function it wraps: parity is asserted on what a
 * caller actually gets, and the two could in principle diverge if a future
 * change touched only the facade's own thin marshalling.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  IdentityReplayError,
  pruneIdentityTransitions,
  type TransitionPageCursor,
} from "../../../src";
import {
  createRecordedInstant,
  recordedInstantRevision,
  recordedInstantWallTime,
} from "../../../src/core/temporal";
import { exportGraph, importGraph } from "../../../src/interchange";
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

const DepartedPerson = defineNode("Person", { schema: z.object({}) });
const DepartedOrg = defineNode("Org", { schema: z.object({}) });

function departedLineageGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: DepartedPerson }, Org: { type: DepartedOrg } },
    edges: {},
    identity: { sameIdAcrossKinds: "fold" },
  });
}

const departedLineageSourceGraph = departedLineageGraph(
  "identity_departed_lineage",
);
const departedLineageRestoreGraph = departedLineageGraph(
  "identity_departed_lineage_restore",
);

async function provisionDepartedLineageStore(
  context: IntegrationTestContext,
  graph: ReturnType<typeof departedLineageGraph>,
) {
  const [store] = await createStoreWithSchema(
    graph,
    context.getStore().backend,
    { history: true },
  );
  return store;
}

type DepartedLineageStore = Awaited<
  ReturnType<typeof provisionDepartedLineageStore>
>;

const DEPARTURES = [
  {
    name: "soft-deleted",
    depart: (store: DepartedLineageStore, id: string) =>
      store.nodes.Person.delete(asNodeId(id)),
  },
  {
    name: "hard-deleted",
    depart: (store: DepartedLineageStore, id: string) =>
      store.nodes.Person.hardDelete(asNodeId(id)),
  },
] as const;

function memberKeys(
  members: readonly Readonly<{ kind: string; id: string }>[],
): readonly string[] {
  return members.map((member) => `${member.kind}:${member.id}`).toSorted();
}

async function provisionPagedLineage(context: IntegrationTestContext) {
  const store = await provisionIdentityReplayStore(context);
  const a = { kind: "Person" as const, id: "cursor-a" };
  const b = { kind: "Person" as const, id: "cursor-b" };
  await store.nodes.Person.create({}, { id: a.id });
  await store.nodes.Person.create({}, { id: b.id });
  const merge = await store.identity.assertSame(a, b);
  await store.identity.retractAssertion(merge.assertion.id);
  await store.identity.assertSame(a, b);
  const firstPage = await store.identity.transitionsOf(a, { limit: 1 });
  const cursor = requireDefined(firstPage.nextCursor);
  return { store, a, firstPage, cursor };
}

export function registerIdentityReplayIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("identity transition retention", () => {
    it("refuses a prune watermark beyond the revision the next commit takes, and accepts exactly that revision", async () => {
      const store = await provisionIdentityReplayStore(context);
      const a = { kind: "Person" as const, id: "prune-a" };
      const b = { kind: "Person" as const, id: "prune-b" };
      const c = { kind: "Person" as const, id: "prune-c" };
      const d = { kind: "Person" as const, id: "prune-d" };
      for (const ref of [a, b, c, d]) {
        await store.nodes.Person.create({}, { id: ref.id });
      }
      await store.identity.assertSame(a, b);
      const clock = requireDefined(await store.recordedNow());
      const clockRevision = recordedInstantRevision(clock);
      const wallTime = recordedInstantWallTime(clock);
      const beyondNextCommit = createRecordedInstant(
        clockRevision + 2,
        wallTime,
      );

      const refusal = await pruneIdentityTransitions(store, {
        beforeRecorded: beyondNextCommit,
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(IdentityReplayError);
      expect((refusal as IdentityReplayError).details).toEqual({
        code: "IDENTITY_PRUNE_BEYOND_RECORDED_CLOCK",
        requestedBefore: beyondNextCommit,
        requestedRevision: clockRevision + 2,
        highestPrunableRevision: clockRevision + 1,
      });

      // The refusal installed nothing and deleted nothing.
      const untouched = await store.identity.replay(a);
      expect(untouched.truncatedBefore).toBeUndefined();
      expect(untouched.steps.map((step) => step.transition.cause)).toEqual([
        "assert",
      ]);

      // The next commit's own revision is the highest truthful watermark:
      // everything recorded so far is below it, everything later is not.
      const nextCommit = createRecordedInstant(clockRevision + 1, wallTime);
      const pruned = await pruneIdentityTransitions(store, {
        beforeRecorded: nextCommit,
      });
      expect(pruned).toEqual({
        pruned: 1,
        prunedBeforeRevision: clockRevision + 1,
      });

      await store.identity.assertSame(c, d);
      const latest = requireDefined(await store.recordedNow());
      const fresh = await store.identity.replay(c, {
        fromRecorded: latest,
        toRecorded: latest,
      });
      expect(fresh.truncatedBefore).toBeUndefined();
      expect(fresh.steps.map((step) => step.transition.cause)).toEqual([
        "assert",
      ]);
    });
  });

  describe("identity lineage of a departed member", () => {
    it.each(DEPARTURES)(
      "keeps the history of a $name non-canonical member discoverable from that member",
      async ({ depart }) => {
        const store = await provisionDepartedLineageStore(
          context,
          departedLineageSourceGraph,
        );
        const a = { kind: "Person" as const, id: "departed-a" };
        const b = { kind: "Person" as const, id: "departed-b" };
        const c = { kind: "Person" as const, id: "departed-c" };
        for (const ref of [a, b, c]) {
          await store.nodes.Person.create({}, { id: ref.id });
        }
        await store.identity.assertSame(a, b);
        await store.identity.assertSame(b, c);
        await depart(store, b.id);

        // The departure is noted against the surviving canonical only, and
        // `b` is a singleton in the current closure: nothing in current state
        // leads from `b` to the class it left.
        const history = await store.identity.transitionsOf(b);
        expect(
          history.transitions.map((transition) => transition.cause),
        ).toEqual(["assert", "assert", "detach", "detach"]);
        expect(history.incompleteDiscovery).toBeUndefined();
        const survivorHistory = await store.identity.transitionsOf(a);
        expect(
          history.transitions.map((transition) => transition.transitionId),
        ).toEqual(
          survivorHistory.transitions.map(
            (transition) => transition.transitionId,
          ),
        );

        const replay = await store.identity.replay(b);
        expect(
          replay.steps.map((step) => [
            step.transition.cause,
            memberKeys(step.before),
            memberKeys(step.after),
          ]),
        ).toEqual([
          [
            "assert",
            ["Person:departed-b"],
            ["Person:departed-a", "Person:departed-b"],
          ],
          [
            "assert",
            ["Person:departed-a", "Person:departed-b"],
            ["Person:departed-a", "Person:departed-b", "Person:departed-c"],
          ],
          [
            "detach",
            ["Person:departed-a", "Person:departed-b", "Person:departed-c"],
            [],
          ],
          [
            "detach",
            ["Person:departed-a", "Person:departed-b", "Person:departed-c"],
            [],
          ],
        ]);
        expect(replay.incompleteDiscovery).toBeUndefined();
      },
    );

    it("keeps a departed same-id fold member's history discoverable when no assertion ever named it", async () => {
      const store = await provisionDepartedLineageStore(
        context,
        departedLineageSourceGraph,
      );
      const person = { kind: "Person" as const, id: "departed-fold" };
      await store.nodes.Org.create({}, { id: person.id });
      await store.nodes.Person.create({}, { id: person.id });
      await store.nodes.Person.hardDelete(asNodeId(person.id));

      const replay = await store.identity.replay(person);
      expect(
        replay.steps.map((step) => [
          step.transition.cause,
          memberKeys(step.before),
          memberKeys(step.after),
        ]),
      ).toEqual([
        ["fold", [], ["Org:departed-fold", "Person:departed-fold"]],
        ["detach", ["Org:departed-fold", "Person:departed-fold"], []],
      ]);
    });

    it("reports restored transitions it can neither attribute nor rule out, instead of a silent short page", async () => {
      const source = await provisionDepartedLineageStore(
        context,
        departedLineageSourceGraph,
      );
      const a = { kind: "Person" as const, id: "restored-a" };
      const b = { kind: "Person" as const, id: "restored-b" };
      await source.nodes.Person.create({}, { id: a.id });
      await source.nodes.Person.create({}, { id: b.id });
      await source.identity.assertSame(a, b);
      await source.nodes.Person.hardDelete(asNodeId(b.id));
      const sourceHistory = await source.identity.transitionsOf(b);
      expect(
        sourceHistory.transitions.map((transition) => transition.cause),
      ).toEqual(["assert", "detach"]);
      expect(sourceHistory.incompleteDiscovery).toBeUndefined();

      const archive = await exportGraph(source, { identityMode: "archival" });
      const target = await provisionDepartedLineageStore(
        context,
        departedLineageRestoreGraph,
      );
      const imported = await importGraph(target, archive, {
        onConflict: "skip",
      });
      expect(imported.errors).toEqual([]);

      // `b` was gone before the archive was taken, so the target holds no
      // evidence tying it to the two restored rows that explain it.
      const departed = await target.identity.transitionsOf(b);
      expect(departed.transitions).toEqual([]);
      expect(departed.incompleteDiscovery).toEqual({
        unattributedRestoredTransitions: 2,
      });
      const departedReplay = await target.identity.replay(b);
      expect(departedReplay.incompleteDiscovery).toEqual({
        unattributedRestoredTransitions: 2,
      });

      // The surviving canonical is named by both rows, so nothing is left
      // unattributed and no signal is raised.
      const survivor = await target.identity.transitionsOf(a);
      expect(
        survivor.transitions.map((transition) => transition.transitionId),
      ).toEqual(
        sourceHistory.transitions.map((transition) => transition.transitionId),
      );
      expect(survivor.incompleteDiscovery).toBeUndefined();
    });
  });

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

      const replay = await store.identity.replay(a);

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

    // Discovery-vs-window and boundary paging on EVERY backend: both moved
    // out of the reader's SQL (which no longer takes revision bounds at all)
    // and into `replay.ts`, so the shared suite is where the two dialects are
    // pinned to the same answer rather than each certifying its own.
    it("discovers lineage outside the requested window, and pages by boundary through nextCursor", async () => {
      const store = await provisionIdentityReplayStore(context);
      const a = { kind: "Person" as const, id: "page-a" };
      const b = { kind: "Person" as const, id: "page-b" };
      const c = { kind: "Person" as const, id: "page-c" };
      await store.nodes.Person.create({}, { id: a.id });
      await store.nodes.Person.create({}, { id: b.id });
      await store.nodes.Person.create({}, { id: c.id });

      const firstMerge = await store.identity.assertSame(b, c);
      const throughFirstMerge = requireDefined(await store.recordedNow());
      await store.identity.assertSame(a, b);
      // Four boundaries, not two: a page size of 1 has to be cut three times
      // for reassembly to be able to catch a cursor that skips one.
      await store.identity.retractAssertion(firstMerge.assertion.id);
      await store.identity.assertSame(b, c);

      // `a` is the class canonical now, and no note at or below the first
      // merge names it — only an unbounded walk can reach that boundary.
      const windowed = await store.identity.transitionsOf(b, {
        toRecorded: throughFirstMerge,
      });
      expect(windowed.transitions.length).toBeGreaterThan(0);

      const whole = await store.identity.transitionsOf(a);
      expect(whole.nextCursor).toBeUndefined();
      const boundaries = new Set(
        whole.transitions.map((transition) => transition.recorded),
      );
      expect(boundaries.size).toBeGreaterThan(2);

      // Reassembly, not merely "the second page differs from the first": a
      // cursor that skipped a boundary, or a page that came back empty,
      // satisfies "differs" and fails here. This is also the one place a
      // dialect-decoded `recorded_at` (PostgreSQL hands back a timestamptz,
      // SQLite a text column) round-trips back in through `cursor`.
      const paged: string[] = [];
      let cursor: TransitionPageCursor | undefined;
      for (let page = 0; page <= boundaries.size; page += 1) {
        const result = await store.identity.transitionsOf(a, {
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        });
        expect(
          new Set(result.transitions.map((transition) => transition.recorded))
            .size,
        ).toBe(1);
        paged.push(
          ...result.transitions.map((transition) => transition.transitionId),
        );
        cursor = result.nextCursor;
        if (cursor === undefined) break;
      }
      expect(cursor).toBeUndefined();
      expect(paged).toEqual(
        whole.transitions.map((transition) => transition.transitionId),
      );
    });

    // The cursor and the recorded window are different inputs. The brand is
    // type-level only, so these pin the RUNTIME separation: a cursor handed to
    // a window bound, or a bare instant handed to `cursor`, is refused rather
    // than silently read as the other.
    describe("page cursor is distinct from the recorded window", () => {
      const WINDOW_GIVEN_CURSOR =
        /must be a recorded instant, not a page cursor/;
      const CURSOR_GIVEN_NON_CURSOR = /cursor must be a page cursor/;

      it("fromRecorded and toRecorded refuse a page cursor on both reads", async () => {
        const { store, a, cursor } = await provisionPagedLineage(context);
        for (const bound of ["fromRecorded", "toRecorded"] as const) {
          const misuse = { [bound]: cursor };
          await expect(store.identity.transitionsOf(a, misuse)).rejects.toThrow(
            WINDOW_GIVEN_CURSOR,
          );
          await expect(store.identity.replay(a, misuse)).rejects.toThrow(
            WINDOW_GIVEN_CURSOR,
          );
        }
      });

      it("cursor refuses a bare recorded instant and arbitrary text", async () => {
        const { store, a, firstPage } = await provisionPagedLineage(context);
        const instant = requireDefined(firstPage.transitions[0]).recorded;
        for (const notACursor of [instant, "not-a-cursor"]) {
          const misuse = { cursor: notACursor as TransitionPageCursor };
          await expect(store.identity.transitionsOf(a, misuse)).rejects.toThrow(
            CURSOR_GIVEN_NON_CURSOR,
          );
          await expect(store.identity.replay(a, misuse)).rejects.toThrow(
            CURSOR_GIVEN_NON_CURSOR,
          );
        }
      });

      it("a cursor composes with the window by intersection", async () => {
        const { store, a, firstPage, cursor } =
          await provisionPagedLineage(context);
        const whole = await store.identity.transitionsOf(a);
        const firstBoundary = requireDefined(firstPage.transitions[0]).recorded;
        const lastBoundary = requireDefined(whole.transitions.at(-1)).recorded;
        const ids = (history: typeof whole) =>
          history.transitions.map((transition) => transition.transitionId);
        const afterFirstPage = whole.transitions.filter(
          (transition) => transition.recorded !== firstBoundary,
        );

        // A window that already contains the cursor changes nothing.
        const sameWindow = await store.identity.transitionsOf(a, {
          cursor,
          toRecorded: lastBoundary,
        });
        expect(ids(sameWindow)).toEqual(
          afterFirstPage.map((transition) => transition.transitionId),
        );

        // A window that ends before the cursor leaves nothing to read, and
        // says so without a continuation.
        const endsBeforeCursor = await store.identity.transitionsOf(a, {
          cursor,
          toRecorded: firstBoundary,
        });
        expect(endsBeforeCursor.transitions).toEqual([]);
        expect(endsBeforeCursor.nextCursor).toBeUndefined();

        // A window that starts after the cursor wins: the page begins at the
        // later of the two, on replay exactly as on transitionsOf.
        const laterStart = requireDefined(whole.transitions.at(-1)).recorded;
        const startsAfterCursor = await store.identity.transitionsOf(a, {
          cursor,
          fromRecorded: laterStart,
        });
        expect(
          startsAfterCursor.transitions.every(
            (transition) => transition.recorded === laterStart,
          ),
        ).toBe(true);
        const replayed = await store.identity.replay(a, {
          cursor,
          fromRecorded: laterStart,
        });
        expect(
          replayed.steps.map((step) => step.transition.transitionId),
        ).toEqual(ids(startsAfterCursor));
      });
    });
  });
}
