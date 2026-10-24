/**
 * Cross-backend replay equivalence: assert / assert / retract /
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
  defineGraphExtension,
  defineNode,
  IdentityReplayError,
  pruneIdentityTransitions,
  type TransitionPageCursor,
  ValidationError,
} from "../../../src";
import {
  asRecordedInstant,
  createRecordedInstant,
  recordedInstantRevision,
  recordedInstantWallTime,
} from "../../../src/core/temporal";
import {
  exportGraph,
  exportGraphStream,
  type GraphInterchangeChunk,
  importGraph,
  importGraphStream,
} from "../../../src/interchange";
import { getActiveSchema, migrateSchema } from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import {
  completenessReason,
  truncatedBeforeOf,
} from "../../identity-history-completeness";
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

const FlipPerson = defineNode("Person", { schema: z.object({}) });
const FlipRobot = defineNode("Robot", { schema: z.object({}) });

function profileFlipGraph(sameIdAcrossKinds: "fold" | "ignore") {
  return defineGraph({
    id: "identity_replay_profile_flip",
    nodes: { Person: { type: FlipPerson }, Robot: { type: FlipRobot } },
    edges: {},
    identity: { sameIdAcrossKinds },
  });
}

/** How long a test waits for a future-dated validity window to lapse. */
const WINDOW_LAPSE_MS = 250;
const WINDOW_LAPSE_MARGIN_MS = 150;

function personRef(id: string) {
  return { kind: "Person" as const, id };
}

function uncapturedCount(count: number) {
  return {
    status: "partial",
    reasons: [{ reason: "uncaptured-members", count }],
  };
}

const DISJOINT_PAIR_COUNT = 6;

function disjointPair(index: number) {
  return [
    personRef(`attribution-${String(index)}-a`),
    personRef(`attribution-${String(index)}-b`),
  ] as const;
}

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

async function provisionDisjointPairs(context: IntegrationTestContext) {
  const store = await provisionIdentityReplayStore(context);
  const pairs = Array.from({ length: DISJOINT_PAIR_COUNT }, (_, index) =>
    disjointPair(index),
  );
  for (const [a, b] of pairs) {
    await store.nodes.Person.create({}, { id: a.id });
    await store.nodes.Person.create({}, { id: b.id });
  }
  const asserted = await store.identity.bulkAssertSame(
    pairs.map(([a, b]) => ({ a, b })),
  );
  return { store, pairs, asserted };
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
      expect(truncatedBeforeOf(untouched)).toBeUndefined();
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
      expect(truncatedBeforeOf(fresh)).toBeUndefined();
      expect(fresh.steps.map((step) => step.transition.cause)).toEqual([
        "assert",
      ]);
    });

    it("prunes restored transitions whose revisions sit above the destination clock, without raising the watermark past it", async () => {
      const source = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_prune_restored_source"),
      );
      const ids = ["pr-a", "pr-b", "pr-c", "pr-d", "pr-e"];
      for (const id of ids) await source.nodes.Person.create({}, { id });
      for (const [left, right] of [
        ["pr-a", "pr-b"],
        ["pr-b", "pr-c"],
        ["pr-c", "pr-d"],
        ["pr-d", "pr-e"],
      ] as const) {
        await source.identity.assertSame(personRef(left), personRef(right));
      }
      const archive = await exportGraph(source, { identityMode: "archival" });

      const target = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_prune_restored_target"),
      );
      await target.nodes.Person.create({}, { id: "pr-native" });
      const imported = await importGraph(target, archive, {
        onConflict: "skip",
      });
      expect(imported.errors).toEqual([]);

      const targetClock = requireDefined(await target.recordedNow());
      const nextRevision = recordedInstantRevision(targetClock) + 1;
      const restoredHistory = await target.identity.transitionsOf(
        personRef("pr-a"),
      );
      const restoredRevisions = restoredHistory.transitions
        .filter((transition) => transition.restored !== undefined)
        .map((transition) =>
          recordedInstantRevision(asRecordedInstant(transition.recorded)),
        );
      const highestRestored = Math.max(...restoredRevisions);
      expect(highestRestored).toBeGreaterThanOrEqual(nextRevision);

      const beyondEverything = createRecordedInstant(
        highestRestored + 2,
        recordedInstantWallTime(targetClock),
      );
      const refusal = await pruneIdentityTransitions(target, {
        beforeRecorded: beyondEverything,
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(IdentityReplayError);
      expect((refusal as IdentityReplayError).details).toMatchObject({
        code: "IDENTITY_PRUNE_BEYOND_RECORDED_CLOCK",
        highestPrunableRevision: highestRestored + 1,
      });

      const pruned = await pruneIdentityTransitions(target, {
        beforeRecorded: createRecordedInstant(
          highestRestored + 1,
          recordedInstantWallTime(targetClock),
        ),
      });
      expect(pruned.prunedBeforeRevision).toBe(nextRevision);
      expect(pruned.pruned).toBeGreaterThanOrEqual(restoredRevisions.length);
      const after = await target.identity.transitionsOf(personRef("pr-a"));
      expect(after.transitions).toEqual([]);
      expect(
        completenessReason(after, "unattributed-restored"),
      ).toBeUndefined();

      // The watermark stays on the destination's own axis, so its next
      // commit is not reported as pruned.
      await target.nodes.Person.create({}, { id: "pr-later-a" });
      await target.nodes.Person.create({}, { id: "pr-later-b" });
      await target.identity.assertSame(
        personRef("pr-later-a"),
        personRef("pr-later-b"),
      );
      const latest = requireDefined(await target.recordedNow());
      const fresh = await target.identity.replay(personRef("pr-later-a"), {
        fromRecorded: latest,
        toRecorded: latest,
      });
      expect(truncatedBeforeOf(fresh)).toBeUndefined();
    });
  });

  describe("archival restore sets one watermark on either entry point", () => {
    for (const variant of ["unpruned", "pruned"] as const) {
      it(`importGraph and importGraphStream agree on the retention cut for an ${variant} source`, async () => {
        const source = await provisionDepartedLineageStore(
          context,
          departedLineageGraph(`identity_restore_parity_source_${variant}`),
        );
        const alice = personRef("rp-alice");
        const bob = personRef("rp-bob");
        await source.nodes.Person.create({}, { id: alice.id });
        await source.nodes.Person.create({}, { id: bob.id });
        const first = await source.identity.assertSame(alice, bob);
        await source.identity.retractAssertion(first.assertion.id);
        await source.identity.assertSame(alice, bob);
        if (variant === "pruned") {
          const history = await source.identity.transitionsOf(alice);
          await pruneIdentityTransitions(source, {
            beforeRecorded: requireDefined(history.transitions.at(-1)).recorded,
          });
        }
        const archive = await exportGraph(source, {
          identityMode: "archival",
        });
        // Collected before any import: one backend serves source and targets.
        const chunks: GraphInterchangeChunk[] = [];
        for await (const chunk of exportGraphStream(source, {
          identityMode: "archival",
        })) {
          chunks.push(chunk);
        }
        expect(chunks.map((chunk) => chunk.type)).toContain("identity");
        expect(chunks.at(-1)?.type).toBe("identity-transitions");

        const documentTarget = await provisionDepartedLineageStore(
          context,
          departedLineageGraph(`identity_restore_parity_document_${variant}`),
        );
        const streamTarget = await provisionDepartedLineageStore(
          context,
          departedLineageGraph(`identity_restore_parity_stream_${variant}`),
        );
        const documentResult = await importGraph(documentTarget, archive, {
          onConflict: "skip",
        });
        const streamResult = await importGraphStream(
          streamTarget,
          (async function* replayChunks() {
            await Promise.resolve();
            yield* chunks;
          })(),
          { onConflict: "skip" },
        );
        expect(documentResult.errors).toEqual([]);
        expect(streamResult.errors).toEqual([]);

        const documentReplay = await documentTarget.identity.replay(alice);
        const documentFloor = requireDefined(truncatedBeforeOf(documentReplay));
        const streamReplay = await streamTarget.identity.replay(alice);
        expect(
          recordedInstantRevision(
            requireDefined(truncatedBeforeOf(streamReplay)),
          ),
        ).toBe(recordedInstantRevision(documentFloor));
        // The floor sits at the restore's first commit, so the union the
        // restore itself recorded is still a replayable step.
        expect(streamReplay.steps.map((step) => step.transition.cause)).toEqual(
          ["assert"],
        );
      });
    }

    it("leaves a destination's own earlier history unfloored on a streamed restore", async () => {
      const source = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_restore_native_source"),
      );
      await source.nodes.Person.create({}, { id: "rn-a" });
      await source.nodes.Person.create({}, { id: "rn-b" });
      await source.identity.assertSame(personRef("rn-a"), personRef("rn-b"));
      const chunks: GraphInterchangeChunk[] = [];
      for await (const chunk of exportGraphStream(source, {
        identityMode: "archival",
      })) {
        chunks.push(chunk);
      }

      const target = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_restore_native_target"),
      );
      await target.nodes.Person.create({}, { id: "rn-own-a" });
      await target.nodes.Person.create({}, { id: "rn-own-b" });
      await target.identity.assertSame(
        personRef("rn-own-a"),
        personRef("rn-own-b"),
      );
      const streamResult = await importGraphStream(
        target,
        (async function* replayChunks() {
          await Promise.resolve();
          yield* chunks;
        })(),
        { onConflict: "skip" },
      );
      expect(streamResult.errors).toEqual([]);

      const own = await target.identity.replay(personRef("rn-own-a"));
      expect(truncatedBeforeOf(own)).toBeUndefined();
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
        expect(
          completenessReason(history, "unattributed-restored"),
        ).toBeUndefined();
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
        expect(
          completenessReason(replay, "unattributed-restored"),
        ).toBeUndefined();
      },
    );

    it("stops a member's history where it left its class, though that class goes on changing", async () => {
      const store = await provisionDepartedLineageStore(
        context,
        departedLineageSourceGraph,
      );
      const [a, b, c, d] = ["left-a", "left-b", "left-c", "left-d"].map(
        (id) => ({ kind: "Person" as const, id }),
      ) as [
        ReturnType<typeof personRef>,
        ReturnType<typeof personRef>,
        ReturnType<typeof personRef>,
        ReturnType<typeof personRef>,
      ];
      for (const ref of [a, b, c, d]) {
        await store.nodes.Person.create({}, { id: ref.id });
      }
      const joined = await store.identity.assertSame(a, b);
      await store.identity.retractAssertion(joined.assertion.id);
      const left = requireDefined(await store.recordedNow());
      // `a` is alone from here on; the class it left keeps merging.
      await store.identity.assertSame(b, c);
      await store.identity.assertSame(c, d);

      const history = await store.identity.transitionsOf(a);
      const replay = await store.identity.replay(a);
      expect(history.transitions.map((transition) => transition.cause)).toEqual(
        ["assert", "retract", "retract"],
      );
      expect(
        history.transitions.every(
          (transition) =>
            recordedInstantRevision(asRecordedInstant(transition.recorded)) <=
            recordedInstantRevision(left),
        ),
      ).toBe(true);
      expect(
        replay.steps.map((step) => [
          step.transition.cause,
          memberKeys(step.before),
          memberKeys(step.after),
        ]),
      ).toEqual([
        ["assert", ["Person:left-a"], ["Person:left-a", "Person:left-b"]],
        ["retract", ["Person:left-a", "Person:left-b"], ["Person:left-a"]],
        ["retract", ["Person:left-a", "Person:left-b"], ["Person:left-a"]],
      ]);
      // Every step changed `a`'s class.
      for (const step of replay.steps) {
        expect(memberKeys(step.before)).not.toEqual(memberKeys(step.after));
      }

      // The class `a` left still reports its own later merges.
      const remainingHistory = await store.identity.transitionsOf(b);
      expect(
        remainingHistory.transitions.map((transition) => transition.cause),
      ).toEqual(["assert", "retract", "retract", "assert", "assert"]);
    });

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

    it("keeps the history that put a member in a class after the class's kind is dropped", async () => {
      const store = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_replay_kind_drop"),
      );
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: { Alias: { properties: { label: { type: "string" } } } },
        }),
      );
      const person = personRef("dropped-p");
      await evolved.nodes.Person.create({}, { id: person.id });
      const alias = await evolved
        .getNodeCollectionOrThrow("Alias")
        .create({ label: "alias" }, { id: "dropped-a" });
      await evolved.identity.assertSame(person, alias);
      const removed = await evolved.removeKinds(["Alias"]);

      const history = await removed.identity.transitionsOf(person);
      expect(history.transitions.map((transition) => transition.cause)).toEqual(
        ["assert", "kind-drop"],
      );
      const replay = await removed.identity.replay(person);
      expect(replay.steps.map((step) => step.transition.cause)).toEqual([
        "assert",
        "kind-drop",
      ]);
    });

    it("keeps the history that put a member in a class after same-id folding is switched off", async () => {
      const backend = context.getStore().backend;
      const foldGraph = departedLineageGraph(
        "identity_replay_fold_switched_off",
      );
      const ignoreGraph = defineGraph({
        id: foldGraph.id,
        nodes: { Person: { type: DepartedPerson }, Org: { type: DepartedOrg } },
        edges: {},
        identity: { sameIdAcrossKinds: "ignore" },
      });
      const [foldStore] = await createStoreWithSchema(foldGraph, backend, {
        history: true,
      });
      const shared = personRef("switched-off");
      await foldStore.nodes.Person.create({}, { id: shared.id });
      await foldStore.nodes.Org.create({}, { id: shared.id });
      const active = requireDefined(
        await getActiveSchema(backend, foldGraph.id),
      );
      await migrateSchema(backend, ignoreGraph, active.version);
      const [ignoreStore] = await createStoreWithSchema(ignoreGraph, backend, {
        history: true,
      });

      const history = await ignoreStore.identity.transitionsOf(shared);
      const causes = history.transitions.map((transition) => transition.cause);
      expect(causes).toEqual([
        "fold",
        "schema-transition",
        "schema-transition",
      ]);
      const replay = await ignoreStore.identity.replay(shared);
      expect(replay.steps.map((step) => step.transition.transitionId)).toEqual(
        history.transitions.map((transition) => transition.transitionId),
      );
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
      expect(
        completenessReason(sourceHistory, "unattributed-restored"),
      ).toBeUndefined();

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
      expect(completenessReason(departed, "unattributed-restored")).toEqual({
        reason: "unattributed-restored",
        count: 2,
      });
      const departedReplay = await target.identity.replay(b);
      expect(
        completenessReason(departedReplay, "unattributed-restored"),
      ).toEqual({ reason: "unattributed-restored", count: 2 });

      // The surviving canonical is named by both rows, so nothing is left
      // unattributed and no signal is raised.
      const survivor = await target.identity.transitionsOf(a);
      expect(
        survivor.transitions.map((transition) => transition.transitionId),
      ).toEqual(
        sourceHistory.transitions.map((transition) => transition.transitionId),
      );
      expect(
        completenessReason(survivor, "unattributed-restored"),
      ).toBeUndefined();
    });
  });

  describe("identity history completeness", () => {
    it("reports a fully read lineage as complete on both transitionsOf and replay", async () => {
      const store = await provisionIdentityReplayStore(context);
      const a = personRef("complete-a");
      const b = personRef("complete-b");
      await store.nodes.Person.create({}, { id: a.id });
      await store.nodes.Person.create({}, { id: b.id });
      const joined = await store.identity.assertSame(a, b);
      await store.identity.retractAssertion(joined.assertion.id);

      const history = await store.identity.transitionsOf(a);
      const replay = await store.identity.replay(a);
      console.log(
        "complete lineage:",
        history.completeness,
        replay.completeness,
      );
      expect(history.transitions[0]?.cause).toBe("assert");
      expect(history.completeness).toEqual({ status: "complete" });
      expect(replay.completeness).toEqual({ status: "complete" });
    });

    it("reports more pages with the cursor that reads the next one, until the last page", async () => {
      const { store, a, firstPage, cursor } =
        await provisionPagedLineage(context);
      console.log("first page completeness:", firstPage.completeness);
      expect(firstPage.completeness).toEqual({
        status: "partial",
        reasons: [{ reason: "more-pages", nextCursor: cursor }],
      });
      const firstReplayPage = await store.identity.replay(a, { limit: 1 });
      expect(completenessReason(firstReplayPage, "more-pages")).toEqual({
        reason: "more-pages",
        nextCursor: requireDefined(firstReplayPage.nextCursor),
      });

      const rest = await store.identity.transitionsOf(a, { cursor });
      expect(rest.nextCursor).toBeUndefined();
      expect(rest.completeness).toEqual({ status: "complete" });
    });

    it("reports the retention cut on transitionsOf as on replay, without refusing a range below it", async () => {
      const store = await provisionIdentityReplayStore(context);
      const a = personRef("retention-a");
      const b = personRef("retention-b");
      await store.nodes.Person.create({}, { id: a.id });
      await store.nodes.Person.create({}, { id: b.id });
      const joined = await store.identity.assertSame(a, b);
      const joinedAt = requireDefined(await store.recordedNow());
      await store.identity.retractAssertion(joined.assertion.id);
      const retractedAt = requireDefined(await store.recordedNow());
      const pruned = await pruneIdentityTransitions(store, {
        beforeRecorded: retractedAt,
      });
      expect(pruned.pruned).toBe(1);

      const history = await store.identity.transitionsOf(a);
      console.log("pruned lineage completeness:", history.completeness);
      expect(
        history.transitions.every(
          (transition) => transition.cause === "retract",
        ),
      ).toBe(true);
      const cut = requireDefined(
        completenessReason(history, "retention-truncated"),
      );
      expect(recordedInstantRevision(cut.before)).toBe(
        pruned.prunedBeforeRevision,
      );
      expect(history.completeness).toEqual({
        status: "partial",
        reasons: [cut],
      });
      const replay = await store.identity.replay(a);
      expect(replay.completeness).toEqual(history.completeness);

      // `replay` refuses a range wholly below the watermark; `transitionsOf`
      // answers it, empty, and says why it is empty.
      const belowWatermark = await store.identity.transitionsOf(a, {
        toRecorded: joinedAt,
      });
      expect(belowWatermark.transitions).toEqual([]);
      expect(belowWatermark.completeness).toEqual({
        status: "partial",
        reasons: [cut],
      });

      // A range that starts at the watermark is untouched by it.
      const aboveWatermark = await store.identity.transitionsOf(a, {
        fromRecorded: retractedAt,
      });
      expect(aboveWatermark.completeness).toEqual({ status: "complete" });
    });

    it("counts the restored transitions of a replay page that are not steps", async () => {
      const source = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_completeness_restored_source"),
      );
      const alice = personRef("nr-alice");
      const bob = personRef("nr-bob");
      await source.nodes.Person.create({}, { id: alice.id });
      await source.nodes.Person.create({}, { id: bob.id });
      const first = await source.identity.assertSame(alice, bob);
      await source.identity.retractAssertion(first.assertion.id);
      await source.identity.assertSame(alice, bob);
      const archive = await exportGraph(source, { identityMode: "archival" });

      const target = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_completeness_restored_target"),
      );
      const imported = await importGraph(target, archive, {
        onConflict: "skip",
      });
      expect(imported.errors).toEqual([]);

      const history = await target.identity.transitionsOf(alice);
      const restored = history.transitions.filter(
        (transition) => transition.restored !== undefined,
      );
      const replay = await target.identity.replay(alice);
      console.log(
        "restored lineage:",
        history.transitions.length,
        "transitions,",
        replay.steps.length,
        "steps,",
        replay.completeness,
      );
      expect(restored.length).toBeGreaterThan(0);
      expect(replay.steps.length).toBe(
        history.transitions.length - restored.length,
      );
      expect(completenessReason(replay, "restored-not-reconstructed")).toEqual({
        reason: "restored-not-reconstructed",
        count: restored.length,
      });
      // `transitionsOf` returns every restored row, so it has nothing to report.
      expect(
        completenessReason(history, "restored-not-reconstructed"),
      ).toBeUndefined();
    });

    it("reports current class members history capture never saw, instead of an empty page that looks complete", async () => {
      const backend = context.getStore().backend;
      const graph = departedLineageGraph("identity_completeness_uncaptured");
      const [untracked] = await createStoreWithSchema(graph, backend, {
        history: false,
      });
      const [store] = await createStoreWithSchema(graph, backend, {
        history: true,
      });
      // A node capture never saw that is alone in its class has no
      // membership to explain.
      const lone = personRef("uncaptured-lone");
      await untracked.nodes.Person.create({}, { id: lone.id });
      const loneHistory = await store.identity.transitionsOf(lone);
      expect(loneHistory.completeness).toEqual({ status: "complete" });

      // Merged before capture was enabled: neither node nor assertion recorded.
      const a = personRef("uncaptured-a");
      const b = personRef("uncaptured-b");
      await untracked.nodes.Person.create({}, { id: a.id });
      await untracked.nodes.Person.create({}, { id: b.id });
      await untracked.identity.assertSame(a, b);
      expect(await store.identity.membersOf(a)).toHaveLength(2);
      for (const ref of [a, b]) {
        const history = await store.identity.transitionsOf(ref);
        const replay = await store.identity.replay(ref);
        console.log(
          `pre-capture merge read from ${ref.id}:`,
          history.transitions.length,
          "transitions,",
          JSON.stringify(history.completeness),
        );
        expect(history.transitions).toEqual([]);
        expect(history.completeness).toEqual(uncapturedCount(2));
        expect(replay.completeness).toEqual(uncapturedCount(2));
      }

      // Both nodes rewritten under capture: the nodes are recorded, the
      // assertion that joined them still is not.
      await store.nodes.Person.update(asNodeId(a.id), {});
      await store.nodes.Person.update(asNodeId(b.id), {});
      const rewritten = await store.identity.transitionsOf(a);
      console.log(
        "nodes rewritten, assertion not:",
        JSON.stringify(rewritten.completeness),
      );
      expect(rewritten.completeness).toEqual(uncapturedCount(1));

      // Created before capture, merged under it: the merge is logged, but the
      // historical reader has no record of either node, so the page cannot
      // show it.
      const c = personRef("uncaptured-c");
      const d = personRef("uncaptured-d");
      await untracked.nodes.Person.create({}, { id: c.id });
      await untracked.nodes.Person.create({}, { id: d.id });
      await store.identity.assertSame(c, d);
      const capturedMerge = await store.identity.transitionsOf(c);
      console.log(
        "captured merge of pre-capture nodes:",
        capturedMerge.transitions.length,
        "transitions,",
        JSON.stringify(capturedMerge.completeness),
      );
      expect(capturedMerge.transitions).toEqual([]);
      expect(capturedMerge.completeness).toEqual(uncapturedCount(2));

      // A pre-capture node written again under capture, then merged with one
      // created under it: fully captured, so complete.
      const f = personRef("uncaptured-f");
      const g = personRef("uncaptured-g");
      await untracked.nodes.Person.create({}, { id: f.id });
      await store.nodes.Person.update(asNodeId(f.id), {});
      await store.nodes.Person.create({}, { id: g.id });
      await store.identity.assertSame(f, g);
      const captured = await store.identity.transitionsOf(f);
      expect(
        captured.transitions.map((transition) => transition.cause),
      ).toEqual(["assert"]);
      expect(captured.completeness).toEqual({ status: "complete" });
      const capturedReplay = await store.identity.replay(f);
      expect(capturedReplay.completeness).toEqual({ status: "complete" });
    });

    it("reports a transaction's own pending identity changes on tx.identity reads, and nothing once committed", async () => {
      const store = await provisionIdentityReplayStore(context);
      const a = personRef("pending-a");
      const b = personRef("pending-b");
      await store.nodes.Person.create({}, { id: a.id });
      await store.nodes.Person.create({}, { id: b.id });

      await store.transaction(async (tx) => {
        const txIdentity = requireDefined(tx.identity);
        // A write that changes no class notes nothing.
        await tx.nodes.Person.create({}, { id: "pending-unrelated" });
        const beforeIdentityWrite = await txIdentity.transitionsOf(a);
        expect(beforeIdentityWrite.completeness).toEqual({
          status: "complete",
        });

        await txIdentity.assertSame(a, b);
        const history = await txIdentity.transitionsOf(a);
        const replay = await txIdentity.replay(a);
        console.log("in-transaction completeness:", history.completeness);
        expect(history.transitions).toEqual([]);
        expect(history.completeness).toEqual({
          status: "partial",
          reasons: [{ reason: "pending-transaction-notes" }],
        });
        expect(replay.completeness).toEqual(history.completeness);
      });

      const committed = await store.identity.transitionsOf(a);
      expect(
        committed.transitions.map((transition) => transition.cause),
      ).toEqual(["assert"]);
      expect(committed.completeness).toEqual({ status: "complete" });
    });
  });

  describe("identity transition attribution", () => {
    it("gives each class a bulk assert changed only the assertion that changed it", async () => {
      const { store, pairs, asserted } = await provisionDisjointPairs(context);

      const idsPerPair = await Promise.all(
        pairs.map(async ([a]) => {
          const history = await store.identity.transitionsOf(a);
          return history.transitions.map(
            (transition) => transition.assertionIds,
          );
        }),
      );

      console.log("bulk assert transition ids per pair:", idsPerPair);
      expect(idsPerPair).toEqual(
        asserted.map((result) => [[result.assertion.id]]),
      );
    });

    it("gives each class a bulk retraction split only the assertion that held it, and never an unrelated different assertion", async () => {
      const { store, pairs, asserted } = await provisionDisjointPairs(context);
      const [firstA] = requireDefined(pairs[0]);
      const [secondA] = requireDefined(pairs[1]);
      const different = await store.identity.assertDifferent(firstA, secondA);

      await store.identity.bulkRetractAssertions([
        ...asserted.map((result) => result.assertion.id),
        different.assertion.id,
      ]);

      const retractIdsPerPair = await Promise.all(
        pairs.map(async ([a]) => {
          const history = await store.identity.transitionsOf(a);
          return history.transitions
            .filter((transition) => transition.cause === "retract")
            .map((transition) => transition.assertionIds);
        }),
      );

      console.log("bulk retract transition ids per pair:", retractIdsPerPair);
      for (const [index, result] of asserted.entries()) {
        const idsPerTransition = requireDefined(retractIdsPerPair[index]);
        expect(idsPerTransition.length).toBeGreaterThan(0);
        for (const ids of idsPerTransition) {
          expect(ids).toEqual([result.assertion.id]);
        }
      }
    });
  });

  describe("identity replay reads each step at its own coordinate", () => {
    it("reconstructs `before` at the revision before each step, even where an unnoted write changed the class", async () => {
      const backend = context.getStore().backend;
      const ignoreGraph = profileFlipGraph("ignore");
      const foldGraph = profileFlipGraph("fold");
      const [ignoreStore] = await createStoreWithSchema(ignoreGraph, backend, {
        history: true,
      });
      const x = personRef("flip-x");
      const y = personRef("flip-y");
      await ignoreStore.nodes.Person.create({}, { id: x.id });
      await ignoreStore.nodes.Person.create({}, { id: y.id });
      const same = await ignoreStore.identity.assertSame(x, y);
      // Under `ignore` a same-id node of another kind joins no class, so
      // nothing is noted; under `fold` it is a member from this revision on.
      await ignoreStore.nodes.Robot.create({}, { id: x.id });
      await ignoreStore.identity.retractAssertion(same.assertion.id);

      const active = requireDefined(
        await getActiveSchema(backend, ignoreGraph.id),
      );
      await migrateSchema(backend, foldGraph, active.version);
      const [store] = await createStoreWithSchema(foldGraph, backend, {
        history: true,
      });

      const replay = await store.identity.replay(x);
      const retract = requireDefined(
        replay.steps.find((step) => step.transition.cause === "retract"),
      );
      const retractRevision = recordedInstantRevision(
        retract.transition.recorded,
      );
      const retractWallTime = recordedInstantWallTime(
        retract.transition.recorded,
      );

      // What the store itself answers one revision earlier and at the
      // step's own revision, from the valid instant the step was recorded at.
      const membersBefore = await store
        .asOfRecorded(
          createRecordedInstant(retractRevision - 1, retractWallTime),
        )
        .identity.membersOf(x);
      const membersAfter = await store
        .asOfRecorded(retract.transition.recorded)
        .identity.membersOf(x);

      expect(memberKeys(retract.before)).toEqual(memberKeys(membersBefore));
      expect(memberKeys(retract.before)).toEqual([
        "Person:flip-x",
        "Person:flip-y",
        "Robot:flip-x",
      ]);
      expect(memberKeys(retract.after)).toEqual(memberKeys(membersAfter));
    });
    // MUTATION CHECK: reusing the previous step's `after` as this step's
    // `before` reports [Person:flip-x, Person:flip-y] for the retraction, so
    // the Robot appears to join BECAUSE of it.

    it("answers the same step identically after a future-dated window lapses", async () => {
      const store = await provisionDepartedLineageStore(
        context,
        departedLineageGraph("identity_replay_window_lapse"),
      );
      const person = personRef("lapse-x");
      await store.nodes.Person.create({}, { id: person.id });
      await store.nodes.Org.create({}, { id: person.id });
      const lapsesAt = new Date(Date.now() + WINDOW_LAPSE_MS).toISOString();
      await store.nodes.Org.update(
        asNodeId(person.id),
        {},
        {
          validTo: lapsesAt,
        },
      );

      const earlyReplay = await store.identity.replay(person);
      const early = requireDefined(earlyReplay.steps.at(-1));
      await new Promise((resolve) =>
        setTimeout(resolve, WINDOW_LAPSE_MS + WINDOW_LAPSE_MARGIN_MS),
      );
      expect(Date.now()).toBeGreaterThan(Date.parse(lapsesAt));
      const lateReplay = await store.identity.replay(person);
      const late = requireDefined(lateReplay.steps.at(-1));
      const live = await store
        .asOfRecorded(late.transition.recorded)
        .identity.membersOf(person);

      expect(late.transition.transitionId).toBe(early.transition.transitionId);
      expect(memberKeys(late.after)).toEqual(memberKeys(early.after));
      expect(memberKeys(late.before)).toEqual(memberKeys(early.before));
      expect(memberKeys(late.after)).toEqual(memberKeys(live));
      expect(memberKeys(live)).toEqual(["Org:lapse-x", "Person:lapse-x"]);
    });
    // MUTATION CHECK: pairing each revision with the wall clock's "now" as
    // its valid instant drops Org:lapse-x from the late read's `after`.
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

      // The replay contract, at BOUNDARY granularity: four boundaries, causes
      // assert/assert/retract/assert. The retract boundary itself carries TWO
      // transition rows — one per resulting component (a's own departure,
      // and b+c's continuation) — exactly as the replay contract documents ("several
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

      it("a cursor refuses a read of another reference's lineage", async () => {
        const { store, cursor } = await provisionPagedLineage(context);
        const other = personRef("cursor-b");
        await expect(
          store.identity.transitionsOf(other, { cursor }),
        ).rejects.toThrow(
          /pages the lineage of Person\/cursor-a, not Person\/cursor-b/,
        );
        await expect(store.identity.replay(other, { cursor })).rejects.toThrow(
          ValidationError,
        );
      });

      it("cursor refuses text that looks like a cursor but cannot be decoded", async () => {
        const { store, a, cursor } = await provisionPagedLineage(context);
        const revision = requireDefined(cursor.split(":").at(-1));
        const undecodable = `tpc1:%:x:${revision}` as TransitionPageCursor;
        await expect(
          store.identity.transitionsOf(a, { cursor: undecodable }),
        ).rejects.toThrow(ValidationError);
        await expect(
          store.identity.replay(a, { cursor: undecodable }),
        ).rejects.toThrow(/Malformed transition page cursor/);
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
