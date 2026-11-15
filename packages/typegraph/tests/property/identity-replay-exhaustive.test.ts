/**
 * The exhaustiveness property: under one schema the identity transition
 * log's cause set is exhaustive, so no membership change falls between two
 * consecutive `replay` boundaries.
 *
 * For a randomized sequence of identity-affecting operations, this asserts,
 * for EVERY reference's lineage (from the revision the reference was first
 * created at) and EVERY recorded revision the run produced:
 *
 *   - membership changed at r IFF the transition log carries a row at r
 *     touching that reference's class lineage;
 *   - `replay(ref)`'s step boundaries equal exactly the revisions at which
 *     membership changed;
 *   - every step's `after` equals brute-force membership at that revision,
 *     and every step's `before` equals it at the previous boundary.
 *
 * Brute-force membership comes from `store.asOfRecorded(r).identity.membersOf`
 * — a read path that never touches the transition log — so agreement between
 * it and `replay` is the whole equivalence pin, not a tautology. Both same-id
 * profiles run, each over a fixed-seed corpus (reproducible mutation checks)
 * and over fresh random histories. Only typed semantic refusals of a random
 * operation are skipped; any other error fails the run.
 *
 * Scope: assertSame, assertDifferent, retractAssertion, node create
 * (including same-id cross-kind folds and resurrections), soft delete, hard
 * delete, and window-end (narrowing a live member's `validTo`, the same
 * `store.nodes[kind].update(id, {}, { validTo })` shape
 * identity-transition-log.test.ts's dedicated window-end unit test uses).
 *
 * Half the runs open with the first reference joining another class and
 * leaving it again before any generated operation runs, so the class it left
 * goes on changing without it: its lineage keeps naming that class, and none
 * of that class's later history may be reported as its own.
 *
 * `kind-drop` is the one cause this generator does NOT model, and cannot:
 * it requires a SCHEMA EVOLUTION (dropping a node kind mid-run), which is a
 * fixed-graph property outside what a per-operation generator over one
 * static `graph` can express. Its own note site is guarded at unit level
 * only (identity-transition-log.test.ts's "notes a kind-drop transition"
 * test, with its own revert/mutation check) — an L2-style mutation of that
 * note call would NOT be caught here, since this generator never reaches
 * `Store.removeKinds()`. `kind-drop` is therefore an explicit, documented
 * gap in this property's exhaustiveness claim, not an oversight.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  IdentityContradictionError,
  IdentityEndpointValidityError,
  IdentityValidityWindowError,
  NodeNotFoundError,
  type Store,
  type TransitionPageCursor,
  ValidationError,
} from "../../src";
import {
  asRecordedInstant,
  createRecordedInstant,
  type RecordedInstant,
  recordedInstantRevision,
} from "../../src/core/temporal";
import {
  identityReplay,
  identityTransitionsOf,
} from "../../src/identity/replay";
import { storeRuntime } from "../../src/store/runtime-port";
import { nowIso } from "../../src/utils/date";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

const Person = defineNode("Person", { schema: z.object({}) });
const Company = defineNode("Company", { schema: z.object({}) });
const Robot = defineNode("Robot", { schema: z.object({}) });

function defineExhaustiveGraph(sameIdAcrossKinds: "fold" | "ignore") {
  return defineGraph({
    id: `identity_replay_exhaustive_${sameIdAcrossKinds}`,
    nodes: {
      Person: { type: Person },
      Company: { type: Company },
      Robot: { type: Robot },
    },
    edges: {},
    identity: { sameIdAcrossKinds },
  });
}

type ExhaustiveGraph = ReturnType<typeof defineExhaustiveGraph>;

/**
 * The refusals a random operation may legitimately meet: a contradiction, a
 * duplicate or missing node, an endpoint or window the store will not accept.
 * Anything else — a crash, a generic wrapper — fails the run instead of being
 * skipped as noise.
 */
function isSemanticRefusal(error: unknown): boolean {
  return (
    error instanceof IdentityContradictionError ||
    error instanceof IdentityValidityWindowError ||
    error instanceof IdentityEndpointValidityError ||
    error instanceof NodeNotFoundError ||
    error instanceof ValidationError
  );
}

// A 6-node, 3-kind universe: two bare ids, each realized under all three
// kinds — the shared bare id is what makes same-id folding reachable.
const BARE_IDS = ["x", "y"] as const;
const KINDS = ["Person", "Company", "Robot"] as const;
type Ref = Readonly<{
  kind: (typeof KINDS)[number];
  id: (typeof BARE_IDS)[number];
}>;
const UNIVERSE: readonly Ref[] = KINDS.flatMap((kind) =>
  BARE_IDS.map((id) => ({ kind, id })),
);

type OpIntent =
  | Readonly<{ type: "create"; refIndex: number }>
  | Readonly<{ type: "assertSame"; aIndex: number; bIndex: number }>
  | Readonly<{ type: "assertDifferent"; aIndex: number; bIndex: number }>
  | Readonly<{ type: "retract"; pick: number }>
  | Readonly<{ type: "softDelete"; refIndex: number }>
  | Readonly<{ type: "hardDelete"; refIndex: number }>
  | Readonly<{ type: "windowEnd"; refIndex: number; daysFromNow: number }>;

const opIntentArbitrary: fc.Arbitrary<OpIntent> = fc.oneof(
  fc.record({
    type: fc.constant("create" as const),
    refIndex: fc.nat({ max: UNIVERSE.length - 1 }),
  }),
  fc.record({
    type: fc.constant("assertSame" as const),
    aIndex: fc.nat({ max: UNIVERSE.length - 1 }),
    bIndex: fc.nat({ max: UNIVERSE.length - 1 }),
  }),
  fc.record({
    type: fc.constant("assertDifferent" as const),
    aIndex: fc.nat({ max: UNIVERSE.length - 1 }),
    bIndex: fc.nat({ max: UNIVERSE.length - 1 }),
  }),
  fc.record({
    type: fc.constant("retract" as const),
    pick: fc.nat({ max: 63 }),
  }),
  fc.record({
    type: fc.constant("softDelete" as const),
    refIndex: fc.nat({ max: UNIVERSE.length - 1 }),
  }),
  fc.record({
    type: fc.constant("hardDelete" as const),
    refIndex: fc.nat({ max: UNIVERSE.length - 1 }),
  }),
  fc.record({
    type: fc.constant("windowEnd" as const),
    refIndex: fc.nat({ max: UNIVERSE.length - 1 }),
    // Days from now, narrow enough to repeatedly re-narrow across a run —
    // a WIDENING update (a later, larger offset than an earlier one already
    // applied) is refused by `requireNodeValidityEndCompatible` and simply
    // skipped by the blanket try/catch below, exactly like any other
    // semantically-refused random operation.
    daysFromNow: fc.nat({ max: 3650 }),
  }),
);

function refKeyOf(ref: Ref): string {
  return `${ref.kind} ${ref.id}`;
}

function normalizeMembers(
  members: readonly Readonly<{ kind: string; id: string }>[],
): string {
  return members
    .map((member) => `${member.kind} ${member.id}`)
    .toSorted()
    .join(",");
}

/** A page size small enough that most lineages span several pages. */
const PAGE_LIMIT = 2;

function revisionOf(recorded: string): number {
  return recordedInstantRevision(asRecordedInstant(recorded));
}

function referencesEqual(
  left: Readonly<{ kind: string; id: string }>,
  right: Readonly<{ kind: string; id: string }>,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

type ExhaustiveStore = Store<ExhaustiveGraph>;

/** What one generated run left behind, for the per-reference lineage checks. */
type ExhaustiveRun = Readonly<{
  store: ExhaustiveStore;
  recordedByRevision: ReadonlyMap<number, RecordedInstant>;
  /** The revision at which each reference first became live. */
  bornAt: ReadonlyMap<string, number>;
  /**
   * Revisions at which a `windowEnd` narrowed a real (>=2 member) class, per
   * member of that class — tracked through `membersOf`, a read path the
   * transition log never touches.
   */
  windowEndRevisions: ReadonlyMap<string, readonly number[]>;
}>;

async function runExhaustiveScenario(
  graph: ExhaustiveGraph,
  intents: readonly OpIntent[],
  seedLeavesAClass: boolean,
): Promise<ExhaustiveRun> {
  const [store] = await createAdapterStoreWithSchema(
    graph,
    createTestBackend(),
    { history: true },
  );
  const live = new Set<string>();
  const assertionIds: string[] = [];
  const recordedByRevision = new Map<number, RecordedInstant>();
  const bornAt = new Map<string, number>();
  const windowEndRevisions = new Map<string, number[]>();

  async function recordCheckpoint(): Promise<number | undefined> {
    const now = await store.recordedNow();
    if (now === undefined) return undefined;
    const revision = recordedInstantRevision(now);
    recordedByRevision.set(revision, now);
    for (const key of live) {
      if (!bornAt.has(key)) bornAt.set(key, revision);
    }
    return revision;
  }

  // The first reference exists from the FIRST observed revision, created
  // before any generated intent runs, so at least one lineage is checked over
  // the whole run; every other reference is checked from the revision it was
  // first created at.
  const first = requireDefined(UNIVERSE[0]);
  await store.nodes[first.kind].create({}, { id: first.id });
  live.add(refKeyOf(first));
  await recordCheckpoint();

  if (seedLeavesAClass) {
    const partner = requireDefined(UNIVERSE[1]);
    await store.nodes[partner.kind].create({}, { id: partner.id });
    live.add(refKeyOf(partner));
    await recordCheckpoint();
    const joined = await store.identity.assertSame(first, partner);
    await recordCheckpoint();
    await store.identity.retractAssertion(joined.assertion.id);
    await recordCheckpoint();
  }

  for (const intent of intents) {
    let narrowedClass: readonly string[] = [];
    try {
      switch (intent.type) {
        case "create": {
          const ref = requireDefined(UNIVERSE[intent.refIndex]);
          await store.nodes[ref.kind].create({}, { id: ref.id });
          live.add(refKeyOf(ref));
          break;
        }
        case "assertSame":
        case "assertDifferent": {
          const a = requireDefined(UNIVERSE[intent.aIndex]);
          const b = requireDefined(UNIVERSE[intent.bIndex]);
          if (refKeyOf(a) === refKeyOf(b)) break;
          if (!live.has(refKeyOf(a)) || !live.has(refKeyOf(b))) break;
          const result =
            intent.type === "assertSame" ?
              await store.identity.assertSame(a, b)
            : await store.identity.assertDifferent(a, b);
          if (result.action === "created") {
            assertionIds.push(result.assertion.id);
          }
          break;
        }
        case "retract": {
          if (assertionIds.length === 0) break;
          const id = requireDefined(
            assertionIds[intent.pick % assertionIds.length],
          );
          await store.identity.retractAssertion(
            id as Parameters<typeof store.identity.retractAssertion>[0],
          );
          break;
        }
        case "softDelete": {
          const ref = requireDefined(UNIVERSE[intent.refIndex]);
          if (!live.has(refKeyOf(ref))) break;
          await store.nodes[ref.kind].delete(ref.id as never);
          live.delete(refKeyOf(ref));
          break;
        }
        case "hardDelete": {
          const ref = requireDefined(UNIVERSE[intent.refIndex]);
          if (!live.has(refKeyOf(ref))) break;
          await store.nodes[ref.kind].hardDelete(ref.id as never);
          live.delete(refKeyOf(ref));
          break;
        }
        case "windowEnd": {
          const ref = requireDefined(UNIVERSE[intent.refIndex]);
          if (!live.has(refKeyOf(ref))) break;
          const currentMembers = await store.identity.membersOf(ref);
          const validTo = new Date(
            Date.now() + intent.daysFromNow * 86_400_000,
          ).toISOString();
          // A WIDENING update (a later end than one already applied) is
          // refused by `requireNodeValidityEndCompatible` — a typed refusal.
          await store.nodes[ref.kind].update(ref.id as never, {}, { validTo });
          if (currentMembers.length >= 2) {
            narrowedClass = currentMembers.map(
              (member) => `${member.kind} ${member.id}`,
            );
          }
          break;
        }
      }
    } catch (error) {
      if (!isSemanticRefusal(error)) throw error;
      continue;
    }
    const revision = await recordCheckpoint();
    if (revision === undefined) continue;
    for (const member of narrowedClass) {
      const revisions = windowEndRevisions.get(member) ?? [];
      revisions.push(revision);
      windowEndRevisions.set(member, revisions);
    }
  }
  return { store, recordedByRevision, bornAt, windowEndRevisions };
}

/**
 * The exhaustiveness pins for ONE reference's lineage, from the revision the
 * reference was first created at: membership changed at r IFF the log carries
 * a row at r on that lineage; replay's boundaries are exactly the changed
 * revisions; and every step's before/after match brute-force membership.
 */
async function expectExhaustiveLineage(
  run: ExhaustiveRun,
  ref: Ref,
): Promise<void> {
  const { store, recordedByRevision } = run;
  const key = refKeyOf(ref);
  const bornAt = run.bornAt.get(key);
  if (bornAt === undefined) return;
  const born: number = bornAt;
  const ctx = storeRuntime(store).identityContext();
  const revisions = [...recordedByRevision.keys()]
    .filter((revision) => revision >= born)
    .toSorted((left, right) => left - right);

  // Brute-force membership at ANY revision, via a read path the transition
  // log never touches — memoized, and able to answer for a revision this run
  // never checkpointed (a replay step's `before` is read at `boundary - 1`).
  // A missing captured instant is fabricated exactly as `reconstructAt`
  // (replay.ts) fabricates its own: the recorded filter keys on the revision.
  const bruteForce = new Map<number, readonly string[]>();
  async function bruteForceMembersAt(
    revision: number,
  ): Promise<readonly string[]> {
    const cached = bruteForce.get(revision);
    if (cached !== undefined) return cached;
    if (revision < born) {
      bruteForce.set(revision, []);
      return [];
    }
    const instant =
      recordedByRevision.get(revision) ??
      createRecordedInstant(revision, nowIso(), await store.allocationOwner());
    const members = await store.asOfRecorded(instant).identity.membersOf(ref);
    const normalized = members
      .map((member) => `${member.kind} ${member.id}`)
      .toSorted();
    bruteForce.set(revision, normalized);
    return normalized;
  }

  // A bare singleton coming into or out of existence is NOT an identity
  // transition by design (the closure carries no row for a singleton), so
  // "did membership change" excludes the reference's own id on both sides.
  function withoutSelf(ids: readonly string[]): string {
    return ids.filter((id) => id !== key).join(",");
  }
  const changedRevisions: number[] = [];
  for (const [index, revision] of revisions.entries()) {
    const previousRevision =
      index === 0 ? revision - 1 : requireDefined(revisions[index - 1]);
    if (
      withoutSelf(await bruteForceMembersAt(previousRevision)) !==
      withoutSelf(await bruteForceMembersAt(revision))
    ) {
      changedRevisions.push(revision);
    }
  }
  const changedRevisionSet = new Set(changedRevisions);

  // `window-end` schedules a FUTURE valid-time boundary, so its row is
  // SELF-REFERENTIAL (`class === priorClass`) and the diagonal `asOfRecorded`
  // read cannot see the change yet: a revision touched ONLY by such rows is
  // exempt from "changed", and the positive check below confirms the note
  // still fires where it must.
  const { transitions } = await identityTransitionsOf(ctx, ref, {
    limit: 2000,
  });
  // `transitionsOf` and `replay` answer ascending by recorded revision.
  const lineageRevisions = transitions.map((transition) =>
    revisionOf(transition.recorded),
  );
  expect(lineageRevisions, `${key}: transitions in revision order`).toEqual(
    lineageRevisions.toSorted((left, right) => left - right),
  );
  // Paging through the lineage yields the same transitions, in order.
  const paged: string[] = [];
  let cursor: TransitionPageCursor | undefined;
  do {
    const page = await store.identity.transitionsOf(ref, {
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    });
    paged.push(
      ...page.transitions.map((transition) => transition.transitionId),
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  expect(paged, `${key}: paged lineage`).toEqual(
    transitions.map((transition) => transition.transitionId),
  );
  const ownTransitions = transitions.filter(
    (transition) => revisionOf(transition.recorded) >= born,
  );
  const selfReferentialRevisions = new Set(
    ownTransitions
      .filter(
        (transition) =>
          transition.priorClass !== undefined &&
          referencesEqual(transition.priorClass, transition.class),
      )
      .map((transition) => revisionOf(transition.recorded)),
  );
  const touchedRevisions = new Set(
    ownTransitions.map((transition) => revisionOf(transition.recorded)),
  );
  for (const revision of revisions) {
    const changed = changedRevisionSet.has(revision);
    const touched = touchedRevisions.has(revision);
    expect(
      !changed || touched,
      `${key}: membership changed at ${String(revision)} with no transition`,
    ).toBe(true);
    expect(
      changed || !touched || selfReferentialRevisions.has(revision),
      `${key}: a transition at ${String(revision)} changed nothing`,
    ).toBe(true);
  }

  for (const revision of run.windowEndRevisions.get(key) ?? []) {
    expect(
      ownTransitions.some(
        (transition) =>
          transition.cause === "window-end" &&
          revisionOf(transition.recorded) === revision,
      ),
      `${key}: no window-end transition at ${String(revision)}`,
    ).toBe(true);
  }

  const replay = await identityReplay(ctx, ref, { limit: 2000 });
  const stepRevisions = replay.steps.map((step) =>
    revisionOf(step.transition.recorded),
  );
  expect(stepRevisions, `${key}: replay steps in revision order`).toEqual(
    stepRevisions.toSorted((left, right) => left - right),
  );
  const ownSteps = replay.steps.filter(
    (step) => revisionOf(step.transition.recorded) >= born,
  );
  const replayBoundaries = [
    ...new Set(ownSteps.map((step) => revisionOf(step.transition.recorded))),
  ].toSorted((left, right) => left - right);
  const expectedBoundaries = [
    ...new Set([...changedRevisions, ...selfReferentialRevisions]),
  ].toSorted((left, right) => left - right);
  expect(replayBoundaries, `${key}: replay boundaries`).toEqual(
    expectedBoundaries,
  );

  // Each step's `before` is the same read one revision earlier — not the
  // previous boundary, since an unnoted write (a bare singleton coming back)
  // can change membership in between.
  for (const step of ownSteps) {
    const revision = revisionOf(step.transition.recorded);
    const previousRevision = revision - 1;
    const expectedBefore = await bruteForceMembersAt(previousRevision);
    const expectedAfter = await bruteForceMembersAt(revision);
    expect(
      normalizeMembers(step.before),
      `${key}: before at ${String(revision)}`,
    ).toBe(expectedBefore.join(","));
    expect(
      normalizeMembers(step.after),
      `${key}: after at ${String(revision)}`,
    ).toBe(expectedAfter.join(","));
  }
}

const scenarioArbitraries = [
  fc.array(opIntentArbitrary, { minLength: 1, maxLength: 40 }),
  fc.boolean(),
] as const;

describe.each(["fold", "ignore"] as const)(
  "identity replay exhaustiveness property [%s]",
  (profile) => {
    const graph = defineExhaustiveGraph(profile);
    const property = fc.asyncProperty(
      ...scenarioArbitraries,
      async (intents, seedLeavesAClass) => {
        const run = await runExhaustiveScenario(
          graph,
          intents,
          seedLeavesAClass,
        );
        for (const ref of UNIVERSE) await expectExhaustiveLineage(run, ref);
      },
    );

    // A fixed corpus, so a mutation check fails the same way on every run.
    it("membership changes iff the transition log carries a boundary, on every lineage of a fixed corpus", async () => {
      await fc.assert(property, { numRuns: 100, seed: 20_260_908 });
    }, 120_000);

    it("membership changes iff the transition log carries a boundary, on every lineage of random histories", async () => {
      await fc.assert(property, {
        numRuns: propertyRuns({ ci: 50, local: 100 }),
      });
    }, 120_000);
  },
);
