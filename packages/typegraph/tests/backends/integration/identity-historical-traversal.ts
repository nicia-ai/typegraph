/**
 * Equivalence coverage for identity-expanded traversal under a **historical**
 * read coordinate.
 *
 * A historical read has no closure table to check itself against, so it is
 * checked against the identity semantics directly: the shared TS model in
 * `identity-traversal-model.ts` reads the persisted rows back out of the backend
 * and re-derives the rows an identity-expanded hop must return at an instant.
 * See that module for the model, the fixture, and what each fixture case is
 * there to catch. The current-coordinate half of the same contract lives in
 * `identity-current-traversal.ts`.
 *
 * Three deliberate breaks confirm this suite bites: dropping the `COALESCE` self
 * fallback, dropping member visibility from the class relation, and turning the
 * outer join inner each fail it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import { compareStrings } from "../../../src/utils/compare";
import {
  expectedOneHopRows,
  expectedRecursiveRows,
  expectedTwoHopRows,
  expectRowsMatchModel,
  IGNORE_GRAPH,
  provisionIdentityFixture,
  readLedger,
  settle,
} from "./identity-traversal-model";
import { type IntegrationTestContext } from "./test-context";

const HistoricalA = defineNode("HistoricalA", {
  schema: z.object({ name: z.string() }),
});
const HistoricalRetired = defineNode("HistoricalRetired", {
  schema: z.object({ name: z.string() }),
});
const HistoricalB = defineNode("HistoricalB", {
  schema: z.object({ name: z.string() }),
});
const HistoricalTarget = defineNode("HistoricalTarget", {
  schema: z.object({ name: z.string() }),
});
const historicalLink = defineEdge("historicalLink", {
  schema: z.object({}),
});
const historicalRetiredKindGraph = defineGraph({
  id: "historical_retired_identity_kind",
  nodes: {
    HistoricalA: { type: HistoricalA },
    HistoricalRetired: { type: HistoricalRetired },
    HistoricalB: { type: HistoricalB },
    HistoricalTarget: { type: HistoricalTarget },
  },
  edges: {
    historicalLink: {
      type: historicalLink,
      from: [HistoricalB],
      to: [HistoricalTarget],
    },
  },
  identity: { sameIdAcrossKinds: "ignore" },
});
const historicalCurrentKindGraph = defineGraph({
  id: "historical_retired_identity_kind",
  nodes: {
    HistoricalA: { type: HistoricalA },
    HistoricalB: { type: HistoricalB },
    HistoricalTarget: { type: HistoricalTarget },
  },
  edges: {
    historicalLink: {
      type: historicalLink,
      from: [HistoricalB],
      to: [HistoricalTarget],
    },
  },
  identity: { sameIdAcrossKinds: "ignore" },
});

export function registerHistoricalIdentityTraversalTests(
  context: IntegrationTestContext,
): void {
  describe("historical identity-expanded traversal equivalence", () => {
    for (const profile of ["fold", "ignore"] as const) {
      describe(`sameIdAcrossKinds: "${profile}"`, () => {
        const fold = profile === "fold";

        it("matches the identity semantics for a single hop at every coordinate", async () => {
          const { coordinates, store } = await provisionIdentityFixture(
            context,
            profile,
          );
          const ledger = await readLedger(store);

          for (const coordinate of coordinates) {
            const rows = await store
              .asOf(coordinate.asOf)
              .query()
              .from("Person", "person")
              .traverse("link", "edge", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .to("Person", "friend")
              .select((queryContext) => ({
                edge: queryContext.edge.id,
                friend: queryContext.friend.id,
                start: queryContext.person.id,
              }))
              .execute();

            expectRowsMatchModel(
              rows.map((row) => `${row.start}|${row.edge}|${row.friend}`),
              expectedOneHopRows(
                ledger,
                new Date(coordinate.asOf).getTime(),
                fold,
              ),
              `single hop at ${coordinate.label} (${coordinate.asOf})`,
            );
          }
        });

        it("matches the identity semantics across a two-hop chain", async () => {
          const { coordinates, store } = await provisionIdentityFixture(
            context,
            profile,
          );
          const ledger = await readLedger(store);

          for (const coordinate of coordinates) {
            const rows = await store
              .asOf(coordinate.asOf)
              .query()
              .from("Person", "person")
              .traverse("link", "first", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .to("Person", "middle")
              .traverse("link", "second", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .to("Person", "friend")
              .select((queryContext) => ({
                first: queryContext.first.id,
                friend: queryContext.friend.id,
                second: queryContext.second.id,
                start: queryContext.person.id,
              }))
              .execute();
            const actual = rows
              .map(
                (row) =>
                  `${row.start}|${row.first}|${row.second}|${row.friend}`,
              )
              .toSorted((left, right) => compareStrings(left, right));
            const expected = expectedTwoHopRows(
              ledger,
              new Date(coordinate.asOf).getTime(),
              fold,
            );

            expect(
              actual,
              `two-hop chain at ${coordinate.label} (${coordinate.asOf})`,
            ).toEqual(expected);
          }
        });

        it("matches the identity semantics across a recursive traversal", async () => {
          const { coordinates, store } = await provisionIdentityFixture(
            context,
            profile,
          );
          const ledger = await readLedger(store);
          const maxHops = 3;

          for (const coordinate of coordinates) {
            const rows = await store
              .asOf(coordinate.asOf)
              .query()
              .from("Person", "person")
              .traverse("link", "edge", {
                expand: "none",
                includeIdentityMembers: true,
              })
              .recursive({ maxHops })
              .to("Person", "friend")
              .select((queryContext) => ({
                friend: queryContext.friend.id,
                start: queryContext.person.id,
              }))
              .execute();
            const actual = rows
              .map((row) => `${row.start}|${row.friend}`)
              .toSorted((left, right) => compareStrings(left, right));
            const expected = expectedRecursiveRows(
              ledger,
              new Date(coordinate.asOf).getTime(),
              fold,
              maxHops,
            );

            expect(
              actual,
              `recursive traversal at ${coordinate.label} (${coordinate.asOf})`,
            ).toEqual(expected);
          }
        });
      });
    }

    it("does not conduct identity through a kind removed from the current graph", async () => {
      const historicalStore = await context.createStore(
        historicalRetiredKindGraph,
      );
      const first = await historicalStore.nodes.HistoricalA.create(
        { name: "First" },
        { id: "retired-bridge-first" },
      );
      const retired = await historicalStore.nodes.HistoricalRetired.create(
        { name: "Retired bridge" },
        { id: "retired-bridge-middle" },
      );
      const second = await historicalStore.nodes.HistoricalB.create(
        { name: "Second" },
        { id: "retired-bridge-second" },
      );
      const target = await historicalStore.nodes.HistoricalTarget.create(
        { name: "Target" },
        { id: "retired-bridge-target" },
      );
      await historicalStore.identity.assertSame(first, retired);
      await historicalStore.identity.assertSame(retired, second);
      await historicalStore.edges.historicalLink.create(second, target, {});
      const instant = "2100-01-01T00:00:00.000Z";
      expect(
        await historicalStore.asOf(instant).identity.areSame(first, second),
      ).toBe(true);

      const currentStore = createStore(
        historicalCurrentKindGraph,
        historicalStore.backend,
      );
      const historical = currentStore.asOf(instant);
      const firstRef = { kind: "HistoricalA", id: first.id } as const;

      expect(await historical.identity.membersOf(firstRef)).toEqual([firstRef]);
      expect(await historical.identity.representativeOf(firstRef)).toEqual(
        firstRef,
      );
      expect(
        await historical.identity.areSame(firstRef, {
          kind: "HistoricalB",
          id: second.id,
        }),
      ).toBe(false);
      expect(
        await historical.identity.explainSame(firstRef, {
          kind: "HistoricalB",
          id: second.id,
        }),
      ).toBeUndefined();
      expect(
        await historical.identity.classes({ kinds: ["HistoricalA"], limit: 5 }),
      ).toMatchObject({
        classes: [
          {
            representative: firstRef,
            members: [firstRef],
          },
        ],
      });

      const traversed = await historical
        .query()
        .from("HistoricalA", "first")
        .traverse("historicalLink", "edge", {
          expand: "none",
          includeIdentityMembers: true,
        })
        .to("HistoricalTarget", "target")
        .select((queryContext) => queryContext.target.id)
        .execute();
      expect(traversed).toEqual([]);
    });

    /**
     * `includeEnded` and `includeTombstones` drop node validity but keep
     * assertion validity, so the class relation still binds the "current" read
     * instant — for the assertion window alone. That is the one historical mode
     * where the reconstruction depends on the wall clock, and the compiled
     * template cache's freshness guard does not cover it: the guard only fires
     * for `mode: "current"` reads, so nothing but this test stands between the
     * relation and the frozen-`now` regression of typegraph#246. Re-executing a
     * reused query has to see an assertion made after the first execution.
     */
    it("binds a fresh read instant per execution under includeEnded", async () => {
      const store = await context.createStore(IGNORE_GRAPH);
      const alice = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "instant-alice" },
      );
      const peer = await store.nodes.Person.create(
        { name: "Peer" },
        { id: "instant-peer" },
      );
      const target = await store.nodes.Person.create(
        { name: "Target" },
        { id: "instant-target" },
      );
      // The edge leaves the peer, so only the expansion can reach the target.
      await store.edges.link.create(peer, target, {}, { id: "instant-peer-t" });

      const query = store
        .view({ mode: "includeEnded" })
        .query()
        .from("Person", "person")
        .whereNode("person", (node) => node.name.eq("Alice"))
        .traverse("link", "edge", {
          expand: "none",
          includeIdentityMembers: true,
        })
        .to("Person", "friend")
        .select((queryContext) => queryContext.friend.id);

      expect(await query.execute()).toEqual([]);
      await settle();
      await store.identity.assertSame(alice, peer);
      await settle();
      expect(await query.execute()).toEqual([target.id]);
    });
  });
}
