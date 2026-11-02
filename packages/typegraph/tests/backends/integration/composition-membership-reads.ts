/**
 * Composition reads report OWNERSHIP for their edges, on every backend:
 * `subgraph({ composition })`, `parts()` and `wholes()` follow the composition
 * rows that bind a part to its whole — the same membership the cascade
 * deletes by — never those edges' validity windows. NODES follow the read's
 * temporal filter at every hop, so a part node the read cannot see is not
 * returned, and neither is anything reachable only through it.
 *
 * Fixture shape, one graph per pair of whole-side populations (TOP, SUB):
 *
 *   MrWhole <-(mrPartOf, partOf, population TOP)-- MrPart
 *   MrPart --(mrHasSub, hasPart, population SUB)--> MrSub
 *
 * The two levels mix orientation, so the recursive walks compile their
 * `inverseEdgeKinds` union, and a graph with TOP != SUB holds an "allRows"
 * and an "openRows" kind in one relation. Each matrix cell changes the state
 * of the top edge (open / ended / soft-deleted) and reads at one coordinate,
 * with every part node visible there; the expected answer is ALWAYS the
 * cascade's own plan (`planDelete`) taken when the store stood at the
 * coordinate's instant:
 *
 * - a valid-time read sees the plan captured at its instant — except that a
 *   soft-delete removes the row from every valid-time read retroactively;
 * - current, includeEnded and includeTombstones see the plan now: those modes
 *   widen what a read may see, not what a whole owns;
 * - a recorded read sees the plan captured at its pinned revision.
 *
 * MUTATION CHECK: reverting the composition readers to the edges' validity
 * window (`TemporalFilterPass.forTraversalEdges` returning `forAlias(...)`,
 * `prepareReachableFilters` ignoring `edgeMembership`, and
 * `subgraphEdgeRowFilter` returning its window arm) fails the ended-"one"
 * cells and the ended-"oneActive" includeEnded / includeTombstones cells.
 * In `compileEdgeMembershipFilters` (src/query/compiler/temporal.ts):
 * deleting the `valid_from <= asOf` term fails the "asOf before the binding
 * edge existed" cells and the reparent case; turning `valid_to > asOf` into
 * `>=` fails the "asOf at the end instant" cells and the reparent case; and
 * dropping the per-kind `NOT (kind IN openRows)` guard fails the TOP "one" /
 * SUB "oneActive" ended cells — each verified and reverted.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  count,
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  type NodeDeletePlan,
  partOf,
} from "../../../src";
import { type RecordedInstant } from "../../../src/core/temporal";
import { requireDefined } from "../../../src/utils/presence";
import {
  type InspectableHistoryStore,
  type IntegrationTestContext,
} from "./test-context";

const MrWhole = defineNode("MrWhole", {
  schema: z.object({ name: z.string() }),
});
const MrPart = defineNode("MrPart", { schema: z.object({ name: z.string() }) });
const MrSub = defineNode("MrSub", { schema: z.object({ name: z.string() }) });
const mrPartOf = defineEdge("mrPartOf", { schema: z.object({}) });
const mrHasSub = defineEdge("mrHasSub", { schema: z.object({}) });

type Population = "one" | "oneActive";
type EdgeState = "open" | "ended" | "softDeleted";

const POPULATION_PAIRS: readonly Readonly<{
  top: Population;
  sub: Population;
}>[] = [
  { top: "one", sub: "one" },
  { top: "oneActive", sub: "oneActive" },
  { top: "one", sub: "oneActive" },
  { top: "oneActive", sub: "one" },
];
const EDGE_STATES: readonly EdgeState[] = ["open", "ended", "softDeleted"];

let graphIdCounter = 0;

function nextGraphId(): string {
  graphIdCounter += 1;
  return `composition_membership_reads_${graphIdCounter}`;
}

function buildGraph(top: Population, sub: Population) {
  return defineGraph({
    id: nextGraphId(),
    nodes: {
      MrWhole: { type: MrWhole },
      MrPart: { type: MrPart },
      MrSub: { type: MrSub },
    },
    edges: {
      mrPartOf: {
        type: mrPartOf,
        from: [MrPart],
        to: [MrWhole],
        cardinality: top,
      },
      mrHasSub: {
        type: mrHasSub,
        from: [MrPart],
        to: [MrSub],
        targetCardinality: sub,
      },
    },
    ontology: [
      partOf(MrPart, MrWhole, { via: mrPartOf }),
      hasPart(MrPart, MrSub, { via: mrHasSub }),
    ],
  });
}

type MembershipGraph = ReturnType<typeof buildGraph>;
type MembershipStore = InspectableHistoryStore<MembershipGraph>;
type MembershipView =
  | ReturnType<MembershipStore["view"]>
  | ReturnType<MembershipStore["asOfRecorded"]>;

type NodeKey = Readonly<{ kind: string; id: string }>;

function keyOf(node: NodeKey): string {
  return `${node.kind}:${node.id}`;
}

function keys(nodes: readonly NodeKey[]): readonly string[] {
  return nodes.map((node) => keyOf(node)).toSorted();
}

/** What the cascade would remove with the whole: the oracle every reader is held to. */
function plannedParts(plan: NodeDeletePlan): readonly string[] {
  return keys(plan.cascadedParts);
}

function plannedDirectParts(
  plan: NodeDeletePlan,
  whole: NodeKey,
): readonly string[] {
  return keys(
    plan.cascadedParts.filter((part) => keyOf(part.whole) === keyOf(whole)),
  );
}

async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

function nowIso(): string {
  return new Date().toISOString();
}

type Created<T extends (...args: never[]) => Promise<unknown>> = Awaited<
  ReturnType<T>
>;
type Fixture = Readonly<{
  whole: Created<MembershipStore["nodes"]["MrWhole"]["create"]>;
  part: Created<MembershipStore["nodes"]["MrPart"]["create"]>;
  sub: Created<MembershipStore["nodes"]["MrSub"]["create"]>;
  topEdgeId: Created<MembershipStore["edges"]["mrPartOf"]["create"]>["id"];
}>;

/** What every reader at one coordinate must answer. */
type Expected = Readonly<{
  /** The closure under the whole, root excluded. */
  parts: readonly string[];
  /** The whole's direct parts. */
  directParts: readonly string[];
  /** `wholes()` of the part. */
  partWholes: readonly string[];
  /** `wholes()` of the sub-part. */
  subWholes: readonly string[];
  /** The top edge as `subgraph` returns it: absent, or whether it carries `validTo`. */
  topEdge: "absent" | Readonly<{ ended: boolean }>;
}>;

async function expectReaders(
  view: MembershipView,
  fixture: Fixture,
  expected: Expected,
  cell: string,
): Promise<void> {
  const { whole, part, sub } = fixture;

  const unit = await view.subgraph(whole, { edges: [], composition: true });
  expect(
    keys(unit.nodes.filter((node) => keyOf(node) !== keyOf(whole))),
    `${cell}: subgraph closure`,
  ).toEqual(expected.parts);
  const returnedTopEdge = unit.edges.find(
    (edge) => edge.id === fixture.topEdgeId,
  );
  expect(
    returnedTopEdge === undefined ? "absent" : (
      { ended: returnedTopEdge.meta.validTo !== undefined }
    ),
    `${cell}: subgraph's binding edge`,
  ).toEqual(expected.topEdge);

  const parts = await view
    .query()
    .from("MrWhole", "w")
    .whereNode("w", (node) => node.id.eq(whole.id))
    .parts("p")
    .select((ctx) => ({ kind: ctx.p.kind, id: ctx.p.id }))
    .execute();
  expect(keys(parts), `${cell}: parts()`).toEqual(expected.parts);

  const directParts = await view
    .query()
    .from("MrWhole", "w")
    .whereNode("w", (node) => node.id.eq(whole.id))
    .parts("p", { maxHops: 1 })
    .select((ctx) => ({ kind: ctx.p.kind, id: ctx.p.id }))
    .execute();
  expect(keys(directParts), `${cell}: parts({ maxHops: 1 })`).toEqual(
    expected.directParts,
  );

  const counted = await view
    .query()
    .from("MrWhole", "w")
    .whereNode("w", (node) => node.id.eq(whole.id))
    .parts("p", { maxHops: 1, via: mrPartOf })
    .groupByNode("w")
    .aggregate({ partCount: count("p") })
    .execute();
  expect(
    counted[0]?.partCount ?? 0,
    `${cell}: count over parts({ maxHops: 1 })`,
  ).toBe(expected.directParts.length);

  const partWholes = await view
    .query()
    .from("MrPart", "p")
    .whereNode("p", (node) => node.id.eq(part.id))
    .wholes("w")
    .select((ctx) => ({ kind: ctx.w.kind, id: ctx.w.id }))
    .execute();
  expect(keys(partWholes), `${cell}: wholes() of the part`).toEqual(
    expected.partWholes,
  );

  const subWholes = await view
    .query()
    .from("MrSub", "s")
    .whereNode("s", (node) => node.id.eq(sub.id))
    .wholes("w")
    .select((ctx) => ({ kind: ctx.w.kind, id: ctx.w.id }))
    .execute();
  expect(keys(subWholes), `${cell}: wholes() of the sub-part`).toEqual(
    expected.subWholes,
  );
}

/** The cascade's plans for the whole and for the part, at one instant. */
type Plans = Readonly<{ whole: NodeDeletePlan; part: NodeDeletePlan }>;

async function capturePlans(
  store: MembershipStore,
  fixture: Pick<Fixture, "whole" | "part">,
): Promise<Plans> {
  return {
    whole: requireDefined(
      await store.nodes.MrWhole.planDelete(fixture.whole.id),
    ),
    part: requireDefined(await store.nodes.MrPart.planDelete(fixture.part.id)),
  };
}

function wholeOwnsPart(plans: Plans, fixture: Fixture): boolean {
  return plannedParts(plans.whole).includes(keyOf(fixture.part));
}

/** The answer every reader owes when each part node is visible: the plans'. */
function expectedFromPlans(
  plans: Plans,
  fixture: Fixture,
  topEdge: Expected["topEdge"],
): Expected {
  const partIsMember = wholeOwnsPart(plans, fixture);
  const subIsMember = plannedParts(plans.part).includes(keyOf(fixture.sub));
  return {
    parts: plannedParts(plans.whole),
    directParts: plannedDirectParts(plans.whole, fixture.whole),
    partWholes: partIsMember ? [keyOf(fixture.whole)] : [],
    subWholes: keys([
      ...(subIsMember ? [fixture.part] : []),
      ...(subIsMember && partIsMember ? [fixture.whole] : []),
    ]),
    topEdge,
  };
}

async function seed(store: MembershipStore): Promise<
  Fixture &
    Readonly<{
      beforeEdges: string;
      pinBeforeEdges: RecordedInstant;
      plansBeforeEdges: Plans;
    }>
> {
  const whole = await store.nodes.MrWhole.create({ name: "w" });
  const part = await store.nodes.MrPart.create({ name: "p" });
  const sub = await store.nodes.MrSub.create({ name: "s" });
  await pause();
  const beforeEdges = nowIso();
  const pinBeforeEdges = requireDefined(await store.recordedNow());
  const plansBeforeEdges = await capturePlans(store, { whole, part });
  await pause();
  const topEdge = await store.edges.mrPartOf.create(part, whole, {});
  await store.edges.mrHasSub.create(part, sub, {});
  return {
    whole,
    part,
    sub,
    topEdgeId: topEdge.id,
    beforeEdges,
    pinBeforeEdges,
    plansBeforeEdges,
  };
}

export function registerCompositionMembershipReadIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Composition reads report membership (subgraph / parts / wholes)", () => {
    for (const { top, sub } of POPULATION_PAIRS) {
      for (const state of EDGE_STATES) {
        it(`top "${top}" / sub "${sub}", top edge ${state}: with every part node visible, each reader matches the cascade plan at its coordinate`, async () => {
          const store = await context.createHistoryStore(buildGraph(top, sub));
          const seeded = await seed(store);
          const { topEdgeId } = seeded;
          await pause();

          const before = nowIso();
          const pinBefore = requireDefined(await store.recordedNow());
          const planBefore = await capturePlans(store, seeded);
          await pause();

          let endInstant: string | undefined;
          if (state === "ended") {
            endInstant = nowIso();
            await store.edges.mrPartOf.update(
              topEdgeId,
              {},
              { validTo: endInstant },
            );
          } else if (state === "softDeleted") {
            await store.edges.mrPartOf.delete(topEdgeId);
          }
          await pause();

          const after = nowIso();
          const pinAfter = requireDefined(await store.recordedNow());
          const planAfter = await capturePlans(store, seeded);

          // A valid-time read reads the one live row, already changed, so an
          // ended binding edge comes back with its `validTo`; a recorded read
          // sees the version its revision pins.
          const changedRow = { ended: state === "ended" };
          const unchangedRow = { ended: false };
          const deletedRetroactively = state === "softDeleted";
          const coordinates: readonly Readonly<{
            label: string;
            view: MembershipView;
            plan: Plans;
            topEdgeRow: Readonly<{ ended: boolean }>;
          }>[] = [
            {
              label: "current",
              view: store.view({ mode: "current" }),
              plan: planAfter,
              topEdgeRow: changedRow,
            },
            {
              label: "includeEnded",
              view: store.view({ mode: "includeEnded" }),
              plan: planAfter,
              topEdgeRow: changedRow,
            },
            {
              label: "includeTombstones",
              view: store.view({ mode: "includeTombstones" }),
              plan: planAfter,
              topEdgeRow: changedRow,
            },
            {
              label: "asOf before the binding edge existed",
              view: store.asOf(seeded.beforeEdges),
              plan: seeded.plansBeforeEdges,
              topEdgeRow: changedRow,
            },
            {
              label: "asOf before the change",
              view: store.asOf(before),
              plan: deletedRetroactively ? planAfter : planBefore,
              topEdgeRow: changedRow,
            },
            ...(endInstant === undefined ?
              []
            : [
                {
                  label: "asOf at the end instant",
                  view: store.asOf(endInstant),
                  plan: planAfter,
                  topEdgeRow: changedRow,
                },
              ]),
            {
              label: "asOf after the change",
              view: store.asOf(after),
              plan: planAfter,
              topEdgeRow: changedRow,
            },
            {
              label: "asOfRecorded before the binding edge existed",
              view: store.asOfRecorded(seeded.pinBeforeEdges),
              plan: seeded.plansBeforeEdges,
              topEdgeRow: unchangedRow,
            },
            {
              label: "asOfRecorded before the change",
              view: store.asOfRecorded(pinBefore),
              plan: planBefore,
              topEdgeRow: unchangedRow,
            },
            {
              label: "asOfRecorded after the change",
              view: store.asOfRecorded(pinAfter),
              plan: planAfter,
              topEdgeRow: changedRow,
            },
          ];

          for (const { label, view, plan, topEdgeRow } of coordinates) {
            await expectReaders(
              view,
              seeded,
              expectedFromPlans(
                plan,
                seeded,
                wholeOwnsPart(plan, seeded) ? topEdgeRow : "absent",
              ),
              `${top}/${sub} / ${state} / ${label}`,
            );
          }
        });
      }
    }

    it("hides a part whose own window has ended, and everything reachable only through it, while planDelete still lists them", async () => {
      const store = await context.createHistoryStore(buildGraph("one", "one"));
      const seeded = await seed(store);
      const { part, sub } = seeded;
      await pause();
      const beforeEnd = nowIso();
      await pause();
      await store.nodes.MrPart.update(part.id, {}, { validTo: nowIso() });
      await pause();

      // The delete still owns both: membership is a property of the edges.
      const plans = await capturePlans(store, seeded);
      expect(plannedParts(plans.whole)).toEqual(keys([part, sub]));

      const owned = expectedFromPlans(plans, seeded, { ended: false });
      const hidden: Expected = {
        parts: [],
        directParts: [],
        partWholes: [],
        subWholes: [],
        topEdge: "absent",
      };
      // MUTATION CHECK: drop the node temporal filter from the recursive
      // step of `prepareExhaustiveReachableCte` (src/store/recursive-cte.ts)
      // and the current subgraph walks through the hidden part to its
      // sub-part — verified and reverted.
      await expectReaders(
        store.view({ mode: "current" }),
        seeded,
        hidden,
        "current",
      );
      await expectReaders(
        store.asOf(nowIso()),
        seeded,
        hidden,
        "asOf after the part ended",
      );
      // A read that can see the part node sees everything its edges own.
      await expectReaders(
        store.view({ mode: "includeEnded" }),
        seeded,
        owned,
        "includeEnded",
      );
      await expectReaders(
        store.asOf(beforeEnd),
        seeded,
        owned,
        "asOf before the part ended",
      );
    });

    it("hands a reparented part from one whole to the next at the move instant", async () => {
      const store = await context.createHistoryStore(
        buildGraph("oneActive", "oneActive"),
      );
      const seeded = await seed(store);
      const { whole, part } = seeded;
      const nextWhole = await store.nodes.MrWhole.create({ name: "next" });
      await pause();
      const before = nowIso();
      const plansBefore = [
        requireDefined(await store.nodes.MrWhole.planDelete(whole.id)),
        requireDefined(await store.nodes.MrWhole.planDelete(nextWhole.id)),
      ] as const;
      await pause();
      await store.nodes.MrPart.reparent(part.id, { whole: nextWhole });
      const [retired] = await store.edges.mrPartOf.find(
        { to: whole },
        { temporalMode: "includeEnded" },
      );
      const moveInstant = requireDefined(requireDefined(retired).meta.validTo);
      const plansAfter = [
        requireDefined(await store.nodes.MrWhole.planDelete(whole.id)),
        requireDefined(await store.nodes.MrWhole.planDelete(nextWhole.id)),
      ] as const;

      for (const [label, view, [planFirst, planNext]] of [
        ["asOf before the move", store.asOf(before), plansBefore],
        ["asOf at the move instant", store.asOf(moveInstant), plansAfter],
        ["current", store.view({ mode: "current" }), plansAfter],
        ["includeEnded", store.view({ mode: "includeEnded" }), plansAfter],
      ] as const) {
        const ownedByFirst = plannedParts(planFirst).includes(keyOf(part));
        const ownedByNext = plannedParts(planNext).includes(keyOf(part));
        expect(ownedByFirst !== ownedByNext, `${label}: one owner`).toBe(true);

        for (const [owner, plan] of [
          [whole, planFirst],
          [nextWhole, planNext],
        ] as const) {
          const unit = await view.subgraph(owner, {
            edges: [],
            composition: true,
          });
          expect(
            keys(unit.nodes.filter((node) => keyOf(node) !== keyOf(owner))),
            `${label}: subgraph of ${owner.id === whole.id ? "first" : "next"} whole`,
          ).toEqual(plannedParts(plan));
          const parts = await view
            .query()
            .from("MrWhole", "w")
            .whereNode("w", (node) => node.id.eq(owner.id))
            .parts("p")
            .select((ctx) => ({ kind: ctx.p.kind, id: ctx.p.id }))
            .execute();
          expect(
            keys(parts),
            `${label}: parts() of ${owner.id === whole.id ? "first" : "next"} whole`,
          ).toEqual(plannedParts(plan));
        }
        const partWholes = await view
          .query()
          .from("MrPart", "p")
          .whereNode("p", (node) => node.id.eq(part.id))
          .wholes("w")
          .select((ctx) => ({ kind: ctx.w.kind, id: ctx.w.id }))
          .execute();
        expect(keys(partWholes), `${label}: wholes() of the part`).toEqual([
          keyOf(ownedByFirst ? whole : nextWhole),
        ]);
      }
    });
  });
}
