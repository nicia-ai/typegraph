/**
 * Composition reads report OWNERSHIP, on every backend: `subgraph({
 * composition })`, `parts()` and `wholes()` follow the composition rows that
 * bind a part to its whole — the same membership the cascade deletes by —
 * never the read's validity window.
 *
 * Fixture shape, one graph per whole-side population P:
 *
 *   MrWhole <-(mrPartOf, partOf, population P)-- MrPart
 *   MrPart --(mrHasSub, hasPart, population P)--> MrSub
 *
 * The two levels mix orientation, so the recursive walks compile their
 * `inverseEdgeKinds` union. Each cell changes the state of the top edge
 * (open / ended / soft-deleted) between two instants and reads at one
 * coordinate; the expected answer is ALWAYS the cascade's own plan
 * (`planDelete`) taken when the store stood at the coordinate's instant:
 *
 * - a valid-time read at the instant BEFORE the change sees the plan captured
 *   then — except a soft-delete, which removes the row from every valid-time
 *   read retroactively, so that cell sees the plan after;
 * - every other valid-time read (current, includeEnded, includeTombstones,
 *   asOf after the change) sees the plan after: includeEnded and
 *   includeTombstones widen what a read may see, not what a whole owns;
 * - a recorded read sees the plan captured at its pinned revision.
 *
 * MUTATION CHECK: reverting the composition readers to the read's validity
 * window (`TemporalFilterPass.forTraversalEdges` returning `forAlias(...)`,
 * `prepareReachableFilters` ignoring `edgeMembership`, and
 * `subgraphEdgeRowFilter` returning its window arm) fails the ended-"one"
 * cells of every reader and the ended-"oneActive" includeEnded /
 * includeTombstones cells — verified and reverted.
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
import { type IntegrationTestContext } from "./test-context";

const MrWhole = defineNode("MrWhole", {
  schema: z.object({ name: z.string() }),
});
const MrPart = defineNode("MrPart", { schema: z.object({ name: z.string() }) });
const MrSub = defineNode("MrSub", { schema: z.object({ name: z.string() }) });
const mrPartOf = defineEdge("mrPartOf", { schema: z.object({}) });
const mrHasSub = defineEdge("mrHasSub", { schema: z.object({}) });

type Population = "one" | "oneActive";
type EdgeState = "open" | "ended" | "softDeleted";

const POPULATIONS: readonly Population[] = ["one", "oneActive"];
const EDGE_STATES: readonly EdgeState[] = ["open", "ended", "softDeleted"];

let graphIdCounter = 0;

function buildGraph(population: Population) {
  graphIdCounter += 1;
  return defineGraph({
    id: `composition_membership_reads_${graphIdCounter}`,
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
        cardinality: population,
      },
      mrHasSub: {
        type: mrHasSub,
        from: [MrPart],
        to: [MrSub],
        targetCardinality: population,
      },
    },
    ontology: [
      partOf(MrPart, MrWhole, { via: mrPartOf }),
      hasPart(MrPart, MrSub, { via: mrHasSub }),
    ],
  });
}

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

export function registerCompositionMembershipReadIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Composition reads report membership (subgraph / parts / wholes)", () => {
    for (const population of POPULATIONS) {
      for (const state of EDGE_STATES) {
        it(`population "${population}", top edge ${state}: every reader at every coordinate matches the cascade plan`, async () => {
          const graph = buildGraph(population);
          const store = await context.createHistoryStore(graph);
          const whole = await store.nodes.MrWhole.create({ name: "w" });
          const part = await store.nodes.MrPart.create({ name: "p" });
          const sub = await store.nodes.MrSub.create({ name: "s" });
          const topEdge = await store.edges.mrPartOf.create(part, whole, {});
          await store.edges.mrHasSub.create(part, sub, {});
          await pause();

          const before = nowIso();
          const pinBefore: RecordedInstant = requireDefined(
            await store.recordedNow(),
          );
          const planBefore = requireDefined(
            await store.nodes.MrWhole.planDelete(whole.id),
          );
          await pause();

          if (state === "ended") {
            await store.edges.mrPartOf.update(
              topEdge.id,
              {},
              { validTo: nowIso() },
            );
          } else if (state === "softDeleted") {
            await store.edges.mrPartOf.delete(topEdge.id);
          }
          await pause();

          const after = nowIso();
          const pinAfter: RecordedInstant = requireDefined(
            await store.recordedNow(),
          );
          const planAfter = requireDefined(
            await store.nodes.MrWhole.planDelete(whole.id),
          );

          // `rowVersion` is which version of the top edge row the read sees: a
          // valid-time read reads the one live row (already changed), a
          // recorded read the version its revision pins.
          const coordinates = [
            {
              label: "current",
              view: store.view({ mode: "current" }),
              plan: planAfter,
              rowVersion: "after",
            },
            {
              label: "includeEnded",
              view: store.view({ mode: "includeEnded" }),
              plan: planAfter,
              rowVersion: "after",
            },
            {
              label: "includeTombstones",
              view: store.view({ mode: "includeTombstones" }),
              plan: planAfter,
              rowVersion: "after",
            },
            {
              label: "asOf before the change",
              view: store.asOf(before),
              plan: state === "softDeleted" ? planAfter : planBefore,
              rowVersion: "after",
            },
            {
              label: "asOf after the change",
              view: store.asOf(after),
              plan: planAfter,
              rowVersion: "after",
            },
            {
              label: "asOfRecorded before the change",
              view: store.asOfRecorded(pinBefore),
              plan: planBefore,
              rowVersion: "before",
            },
            {
              label: "asOfRecorded after the change",
              view: store.asOfRecorded(pinAfter),
              plan: planAfter,
              rowVersion: "after",
            },
          ] as const;

          for (const { label, view, plan, rowVersion } of coordinates) {
            const cell = `${population} / ${state} / ${label}`;
            const partIsMember = plannedParts(plan).includes(keyOf(part));

            const unit = await view.subgraph(whole, {
              edges: [],
              composition: true,
            });
            expect(
              keys(unit.nodes.filter((node) => keyOf(node) !== keyOf(whole))),
              `${cell}: subgraph closure`,
            ).toEqual(plannedParts(plan));
            const returnedTopEdge = unit.edges.find(
              (edge) => edge.id === topEdge.id,
            );
            expect(
              returnedTopEdge === undefined ? "absent" : (
                returnedTopEdge.meta.validTo !== undefined
              ),
              `${cell}: subgraph returns the binding edge with its own validTo`,
            ).toBe(
              partIsMember ?
                state === "ended" && rowVersion === "after"
              : "absent",
            );

            const parts = await view
              .query()
              .from("MrWhole", "w")
              .whereNode("w", (node) => node.id.eq(whole.id))
              .parts("p")
              .select((ctx) => ({ kind: ctx.p.kind, id: ctx.p.id }))
              .execute();
            expect(keys(parts), `${cell}: parts()`).toEqual(plannedParts(plan));

            const directParts = await view
              .query()
              .from("MrWhole", "w")
              .whereNode("w", (node) => node.id.eq(whole.id))
              .parts("p", { maxHops: 1 })
              .select((ctx) => ({ kind: ctx.p.kind, id: ctx.p.id }))
              .execute();
            expect(keys(directParts), `${cell}: parts({ maxHops: 1 })`).toEqual(
              plannedDirectParts(plan, whole),
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
            ).toBe(plannedDirectParts(plan, whole).length);

            const partWholes = await view
              .query()
              .from("MrPart", "p")
              .whereNode("p", (node) => node.id.eq(part.id))
              .wholes("w")
              .select((ctx) => ({ kind: ctx.w.kind, id: ctx.w.id }))
              .execute();
            expect(keys(partWholes), `${cell}: wholes() of the part`).toEqual(
              partIsMember ? [keyOf(whole)] : [],
            );

            const subWholes = await view
              .query()
              .from("MrSub", "s")
              .whereNode("s", (node) => node.id.eq(sub.id))
              .wholes("w")
              .select((ctx) => ({ kind: ctx.w.kind, id: ctx.w.id }))
              .execute();
            expect(
              keys(subWholes),
              `${cell}: wholes() of the sub-part`,
            ).toEqual(keys(partIsMember ? [part, whole] : [part]));
          }
        });
      }
    }
  });
}
