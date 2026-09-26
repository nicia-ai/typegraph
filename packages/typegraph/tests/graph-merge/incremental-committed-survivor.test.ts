/**
 * Survivor choice when two branches fork from one point and both add the same
 * entity. The first branch's merge commits its node and an edge onto it; the
 * second branch's copy of that entity then resolves against a node the live
 * target committed AFTER the fork point. That committed node reaches the
 * cluster as a member of the synthetic committed-target branch, not as a base
 * member, and must still survive: its id anchors a committed edge.
 *
 * The ids are pinned so the second branch's node sorts before the committed
 * one, which is the order in which a plain id tie-break picked the branch node,
 * repointed the committed edge, and produced a plan apply refused.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import {
  applyMergePlan,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import type { MergeOptions } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Org = defineNode("Org", { schema: z.object({ name: z.string() }) });
const founded = defineEdge("founded", { schema: z.object({}) });

const COMMITTED_PERSON_ID = "zz-person-first-branch";
const LATER_PERSON_ID = "aa-person-second-branch";

function graphWith(cardinality: "many" | "unique") {
  return defineGraph({
    id: `incremental-committed-survivor-${cardinality}`,
    nodes: { Person: { type: Person }, Org: { type: Org } },
    edges: {
      founded: { type: founded, from: [Person], to: [Org], cardinality },
    },
  });
}

describe.each(backendMatrix())(
  "incremental merge survivor after a sibling branch committed [$name]",
  (entry) => {
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    it.each(["many", "unique"] as const)(
      "keeps the committed node and its edge when the later branch's copy sorts first (cardinality %s)",
      async (cardinality) => {
        const graph = graphWith(cardinality);
        const options = {
          resolve: {
            Person: {
              block: (node) => node.name,
              similarity: {
                kind: "custom",
                score: (left, right) => (left.name === right.name ? 1 : 0),
              },
              threshold: 0.9,
            },
          },
          onBasePropertyConflict: "flag",
        } satisfies MergeOptions<typeof graph>;
        const [target] = await createStoreWithSchema(
          graph,
          await makeBackend(),
          { history: true },
        );
        const org = await target.nodes.Org.create({ name: "Helio" });
        const recorded = await target.recordedNow();
        if (recorded === undefined) throw new Error("history not captured");
        const first = unwrap(await branch(target, makeBackend));
        const second = unwrap(await branch(target, makeBackend));
        const forkPoint = { recorded, base: first.base };

        const committedPerson = await first.store.nodes.Person.create(
          { name: "Mara" },
          { id: COMMITTED_PERSON_ID },
        );
        const committedEdge = await first.store.edges.founded.create(
          committedPerson,
          org,
          {},
        );
        const laterPerson = await second.store.nodes.Person.create(
          { name: "Mara" },
          { id: LATER_PERSON_ID },
        );
        await second.store.edges.founded.create(laterPerson, org, {});

        for (const branchToMerge of [first, second]) {
          const plan = unwrap(
            await planMergeIncremental({
              forkPoint,
              target,
              branches: [branchToMerge],
              options,
            }),
          );
          unwrap(await applyMergePlan(target, plan));
        }

        expect(
          (await target.nodes.Person.find()).map((node) => node.id),
        ).toEqual([COMMITTED_PERSON_ID]);
        const edges = await target.edges.founded.find();
        expect(
          edges.map((edge) => ({ id: edge.id, from: edge.fromId })),
        ).toEqual([{ id: committedEdge.id, from: COMMITTED_PERSON_ID }]);
        await first.close();
        await second.close();
      },
    );
  },
);
