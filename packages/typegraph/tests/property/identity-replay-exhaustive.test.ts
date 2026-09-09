/**
 * The exhaustiveness property (§9.3): the identity transition log's cause set
 * is exhaustive, so `replay`'s `before(b_i) := after(b_{i-1})` reuse is sound.
 *
 * For a randomized sequence of identity-affecting operations, this asserts,
 * for EVERY recorded revision the run produced:
 *
 *   - membership changed at r IFF the transition log carries a row at r
 *     touching the seed's class lineage;
 *   - `replay(seed)`'s step boundaries equal exactly the revisions at which
 *     membership changed;
 *   - every step's `after` equals brute-force membership at that revision,
 *     and every step's `before` equals it at the previous boundary.
 *
 * Brute-force membership comes from `store.asOfRecorded(r).identity.membersOf`
 * — a read path that never touches the transition log — so agreement between
 * it and `replay` is the whole equivalence pin, not a tautology.
 *
 * Scope for PR-1: assertSame, assertDifferent, retractAssertion, node create
 * (including same-id cross-kind folds and resurrections), soft delete, hard
 * delete, and window-end (narrowing a live member's `validTo`, the same
 * `store.nodes[kind].update(id, {}, { validTo })` shape
 * identity-transition-log.test.ts's dedicated window-end unit test uses).
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

import { defineGraph, defineNode } from "../../src";
import { createAdapterStoreWithSchema } from "../../src";
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

const Person = defineNode("Person", { schema: z.object({}) });
const Company = defineNode("Company", { schema: z.object({}) });
const Robot = defineNode("Robot", { schema: z.object({}) });

const graph = defineGraph({
  id: "identity_replay_exhaustive",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Robot: { type: Robot },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

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

// `UNIVERSE[0]` is the replay seed (created once, before any generated
// intent runs — see the worked comment below) and this harness's own design
// depends on it staying live for the ENTIRE observed revision range: once
// the seed itself departs its class, `identityTransitionsOf`/`identityReplay`
// seed their lineage walk from the seed's OWN (now-trivial, post-departure)
// canonical, which a departing member's own detach record never names —
// only a SURVIVING class-mate's record does (`diffClosureTransitions`'s
// "absent from the new state" branch) — so the walk cannot discover rows
// about a class the seed has already left. That is a real, separate gap in
// how a departed member's OWN lineage is queried, not a #9 exhaustiveness
// defect; `softDelete`/`hardDelete` intents are scoped to the OTHER five
// universe members so this property stays focused on cause exhaustiveness
// rather than tripping over it.
const NON_SEED_REF_INDEX = fc.integer({ min: 1, max: UNIVERSE.length - 1 });

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
    refIndex: NON_SEED_REF_INDEX,
  }),
  fc.record({
    type: fc.constant("hardDelete" as const),
    refIndex: NON_SEED_REF_INDEX,
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

function referencesEqual(
  left: Readonly<{ kind: string; id: string }>,
  right: Readonly<{ kind: string; id: string }>,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

describe("identity replay exhaustiveness property", () => {
  it("membership changes iff the transition log carries a boundary, and replay reconstructs every boundary correctly", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opIntentArbitrary, { minLength: 1, maxLength: 40 }),
        async (intents) => {
          const [store] = await createAdapterStoreWithSchema(
            graph,
            createTestBackend(),
            { history: true },
          );
          const live = new Set<string>();
          const assertionIds: string[] = [];
          const recordedByRevision = new Map<number, RecordedInstant>();

          async function recordCheckpoint(): Promise<void> {
            const now = await store.recordedNow();
            if (now === undefined) return;
            recordedByRevision.set(recordedInstantRevision(now), now);
          }

          // The replay seed exists for the ENTIRE observed revision range,
          // created before any fc-generated intent runs — matching the
          // scenario every one of these assertions is actually specified
          // against (§9.3's own worked example, and G1-01's probe, both
          // create every lineage member before the first identity-affecting
          // op). A seed that a LATER "create" intent brings into existence
          // partway through the run legitimately sees an empty `membersOf`
          // for every revision before its own creation — including
          // revisions where the transition log records a REAL event among
          // OTHER, already-existing members of what will become its class —
          // which is a fact about that generator shape, not about replay,
          // and would make the "changed iff touched" and boundary-equality
          // assertions below fail for a reason unrelated to what this test
          // exists to guard.
          const seed = requireDefined(UNIVERSE[0]);
          await store.nodes[seed.kind].create({}, { id: seed.id });
          live.add(refKeyOf(seed));
          await recordCheckpoint();

          // Revisions at which a `windowEnd` intent narrowed a REAL (>=2
          // member) class the seed itself currently belongs to — the
          // precondition `requireNodeValidityEndCompatible` notes under.
          // Tracked independently of the transition log (via `membersOf`,
          // a read path the log never touches) so the positive check below
          // — "this op must have produced a window-end row" — can catch an
          // L2-style removal of that note call, which the diagonal
          // `changed iff touched` checks alone cannot (see the
          // self-referential exemption below).
          const expectedWindowEndRevisions: number[] = [];
          let pendingWindowEndCheck = false;

          for (const intent of intents) {
            try {
              switch (intent.type) {
                case "create": {
                  const ref = requireDefined(UNIVERSE[intent.refIndex]);
                  await store.nodes[ref.kind].create({}, { id: ref.id });
                  live.add(refKeyOf(ref));
                  break;
                }
                case "assertSame": {
                  const a = requireDefined(UNIVERSE[intent.aIndex]);
                  const b = requireDefined(UNIVERSE[intent.bIndex]);
                  if (refKeyOf(a) === refKeyOf(b)) break;
                  if (!live.has(refKeyOf(a)) || !live.has(refKeyOf(b))) break;
                  const result = await store.identity.assertSame(a, b);
                  if (result.action === "created") {
                    assertionIds.push(result.assertion.id);
                  }
                  break;
                }
                case "assertDifferent": {
                  const a = requireDefined(UNIVERSE[intent.aIndex]);
                  const b = requireDefined(UNIVERSE[intent.bIndex]);
                  if (refKeyOf(a) === refKeyOf(b)) break;
                  if (!live.has(refKeyOf(a)) || !live.has(refKeyOf(b))) break;
                  const result = await store.identity.assertDifferent(a, b);
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
                  await store.nodes[ref.kind].update(
                    ref.id as never,
                    {},
                    { validTo },
                  );
                  // Only tracked when `ref`'s class ALSO contains the seed —
                  // `identityTransitionsOf(ctx, seed, ...)` walks the seed's
                  // OWN lineage, so a window-end note on an unrelated class
                  // (however real) would never surface there, and tracking
                  // it here would make the positive check below fail for a
                  // reason unrelated to any regression.
                  if (
                    currentMembers.length >= 2 &&
                    currentMembers.some(
                      (member) =>
                        member.kind === seed.kind && member.id === seed.id,
                    )
                  ) {
                    pendingWindowEndCheck = true;
                  }
                  break;
                }
              }
            } catch {
              // Semantic refusals (contradictions, self-assertions, etc.) are
              // expected noise from randomly generated operations — skip and
              // continue the sequence, exactly as sibling property suites do.
              continue;
            }
            await recordCheckpoint();
            if (pendingWindowEndCheck) {
              pendingWindowEndCheck = false;
              const latestRevision = requireDefined(
                [...recordedByRevision.keys()].toSorted(
                  (left, right) => right - left,
                )[0],
              );
              expectedWindowEndRevisions.push(latestRevision);
            }
          }

          if (recordedByRevision.size === 0) return;

          const ctx = storeRuntime(store).identityContext();
          const revisions = [...recordedByRevision.keys()].toSorted(
            (left, right) => left - right,
          );
          const lastRevision = requireDefined(revisions.at(-1));

          // Brute-force membership at ANY revision, via a read path the
          // transition log never touches — memoized, and able to answer for a
          // revision this run never checkpointed (a replay step's `before` is
          // read at `boundary - 1`, which is not necessarily one of the
          // revisions a write actually landed at). When a real captured
          // instant exists for `revision` it is used; otherwise one is
          // fabricated exactly as `reconstructAt` (replay.ts) fabricates its
          // own reconstruction instant — the recorded filter is keyed on the
          // revision integer alone, never on the paired wall clock.
          const bruteForce = new Map<number, readonly string[]>([[0, []]]);
          async function bruteForceMembersAt(
            revision: number,
          ): Promise<readonly string[]> {
            const cached = bruteForce.get(revision);
            if (cached !== undefined) return cached;
            if (revision <= 0) {
              bruteForce.set(revision, []);
              return [];
            }
            const instant =
              recordedByRevision.get(revision) ??
              createRecordedInstant(revision, nowIso());
            const members = await store
              .asOfRecorded(instant)
              .identity.membersOf(seed);
            const normalized = members
              .map((member) => `${member.kind} ${member.id}`)
              .toSorted();
            bruteForce.set(revision, normalized);
            return normalized;
          }
          for (const revision of revisions) {
            await bruteForceMembersAt(revision);
          }

          // A bare singleton coming into or out of existence (create/delete
          // with no fold or assertion partner) is NOT an identity transition
          // by design (§2.3): the closure table carries no row for a
          // singleton, so nothing changes there. `membersOf` still reports
          // the node's own trivial self-membership, though, so "did
          // membership change" is asked with the seed's OWN id excluded from
          // both sides — isolating whether its CLASS (its relationship to
          // OTHER members) changed, which is what a transition explains.
          const seedKey = `${seed.kind} ${seed.id}`;
          function withoutSeed(ids: readonly string[]): readonly string[] {
            return ids.filter((id) => id !== seedKey);
          }
          const changedRevisions = revisions.filter((revision, index) => {
            const previousRevision =
              index === 0 ? 0 : requireDefined(revisions[index - 1]);
            const previous = withoutSeed(
              requireDefined(bruteForce.get(previousRevision)),
            );
            const current = withoutSeed(
              requireDefined(bruteForce.get(revision)),
            );
            return previous.join(",") !== current.join(",");
          });

          const changedRevisionSet = new Set(changedRevisions);

          // §9.3, assertion 1: membership changed at r IFF the transition log
          // (walked through `identityTransitionsOf` — the seed's own class
          // lineage, not a hand-rolled scan of the whole universe) carries a
          // row at r. Checked in BOTH directions, for every recorded revision
          // the run produced, not only the ones already believed to have
          // changed.
          //
          // ONE exception, by design, not by omission: `window-end` schedules
          // a FUTURE valid-time boundary (§2.3), so a row it notes is
          // deliberately SELF-REFERENTIAL (`class === priorClass`) — the
          // `asOfRecorded` diagonal read this test's brute force uses (same
          // wall-time as the recorded revision) cannot see a change that has
          // not happened yet. A revision touched ONLY by self-referential
          // rows is therefore exempt from the "changed" requirement; a
          // revision touched by any OTHER row is not, and the positive check
          // below independently confirms `window-end` still fires when it
          // must — closing the gap a blanket exemption would leave for L2.
          const transitions = await identityTransitionsOf(ctx, seed, {
            limit: 2000,
          });
          const selfReferentialRevisions = new Set(
            transitions
              .filter(
                (transition) =>
                  transition.priorClass !== undefined &&
                  referencesEqual(transition.priorClass, transition.class),
              )
              .map((transition) =>
                recordedInstantRevision(asRecordedInstant(transition.recorded)),
              ),
          );
          const touchedRevisions = new Set(
            transitions.map((transition) =>
              recordedInstantRevision(asRecordedInstant(transition.recorded)),
            ),
          );
          for (const revision of revisions) {
            const changed = changedRevisionSet.has(revision);
            const touched = touchedRevisions.has(revision);
            // A changed revision must be touched; an untouched revision must
            // be unchanged; a touched-but-unchanged revision must be
            // self-referential-only (window-end's documented exception).
            expect(!changed || touched).toBe(true);
            expect(
              changed || !touched || selfReferentialRevisions.has(revision),
            ).toBe(true);
          }

          // The positive half `window-end`'s exemption above needs: every
          // tracked `windowEnd` intent that narrowed a real class the seed
          // belongs to (tracked independently, via `membersOf` — a read path
          // the transition log never touches) must have produced a
          // `window-end` row at the resulting revision. Reverting the note
          // call in `requireNodeValidityEndCompatible` (L2) fails exactly
          // this loop, not the diagonal checks above, since removing the
          // note leaves `touched` false without ever touching `changed`.
          for (const revision of expectedWindowEndRevisions) {
            expect(
              transitions.some(
                (transition) =>
                  transition.cause === "window-end" &&
                  recordedInstantRevision(
                    asRecordedInstant(transition.recorded),
                  ) === revision,
              ),
            ).toBe(true);
          }

          const replay = await identityReplay(ctx, seed, { limit: 2000 });

          // §9.3, assertion 2: `replay(seed)`'s step boundaries equal EXACTLY
          // the revisions at which membership changed, UNION the
          // self-referential `window-end` revisions above (each of which
          // legitimately produces a step whose `before` and `after` are
          // identical — see assertion 1's comment) — no missing boundary,
          // and no phantom one beyond that documented exception.
          const replayBoundaries = [
            ...new Set(
              replay.steps.map((step) =>
                recordedInstantRevision(
                  asRecordedInstant(step.transition.recorded),
                ),
              ),
            ),
          ].toSorted((left, right) => left - right);
          const expectedBoundaries = [
            ...new Set([...changedRevisions, ...selfReferentialRevisions]),
          ].toSorted((left, right) => left - right);
          expect(replayBoundaries).toEqual(expectedBoundaries);

          // §9.3, assertion 3: every step's `after` equals brute-force
          // membership at that revision, and every step's `before` equals it
          // at the PREVIOUS boundary — `boundary - 1` for the very first step
          // (matching `before(b0) := reconstruct(ref, b0 - 1)`, §3.2 step 4;
          // NOT revision 0, which is only right when `b0` itself is 1), and
          // the previous replay boundary's `after` for every step thereafter.
          for (const step of replay.steps) {
            const revision = recordedInstantRevision(
              asRecordedInstant(step.transition.recorded),
            );
            const boundaryIndex = replayBoundaries.indexOf(revision);
            const previousRevision =
              boundaryIndex <= 0 ?
                revision - 1
              : requireDefined(replayBoundaries[boundaryIndex - 1]);
            const expectedBefore = await bruteForceMembersAt(previousRevision);
            const expectedAfter = await bruteForceMembersAt(revision);
            expect(normalizeMembers(step.before)).toBe(
              expectedBefore.join(","),
            );
            expect(normalizeMembers(step.after)).toBe(expectedAfter.join(","));
          }

          void lastRevision;
        },
      ),
      // Pinned so the load-bearing mutation check (§9.2 L2 / this file's own
      // header) is reproducible: the same seed must fail the same way every
      // time `diffClosureTransitions` (or any other exhaustiveness-owning
      // predicate) regresses, not fail on some invocations and pass on
      // others. numRuns raised from 40 alongside the pin so the fixed
      // exploration still covers a meaningful span of sequences.
      { numRuns: 100, seed: 20_260_908 },
    );
  }, 60_000);
});
