/**
 * Equivalence coverage for identity-expanded traversal at the **current** read
 * coordinate (typegraph#270).
 *
 * The current path used to test class membership per candidate edge with a
 * correlated subquery over the materialized closure; it now joins a
 * once-per-statement class relation built from that same closure. The rewrite
 * moved *where* membership is decided, so what has to be pinned is that it still
 * decides the same thing — including the parts a correlated `EXISTS` got for free
 * and a join does not: member visibility, and one row per physical edge no matter
 * how many members a class has.
 *
 * The check is against the identity semantics, not against the closure table:
 * the shared TS model in `identity-traversal-model.ts` reads the persisted node,
 * edge and assertion rows back out of the backend and re-derives the rows an
 * identity-expanded hop must return. It shares no code with the compiler and
 * passes unchanged on `main`. See that module for the fixture and what each of
 * its cases is there to catch; the historical half of the same contract lives in
 * `identity-historical-traversal.ts`.
 */
import { describe, expect, it } from "vitest";

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

/**
 * The instant a current read resolves to. Every window the fixture opens or
 * closes lies at least fifteen seconds in the past by the time provisioning
 * returns, so the model is stable across the drift between this sample and the
 * query that follows it.
 */
function currentInstant(): number {
  return Date.now();
}

export function registerCurrentIdentityTraversalTests(
  context: IntegrationTestContext,
): void {
  describe("current identity-expanded traversal equivalence", () => {
    for (const profile of ["fold", "ignore"] as const) {
      describe(`sameIdAcrossKinds: "${profile}"`, () => {
        const fold = profile === "fold";

        it("matches the identity semantics for a single hop", async () => {
          const { store } = await provisionIdentityFixture(context, profile);
          const ledger = await readLedger(store);
          const instant = currentInstant();

          const rows = await store
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
            expectedOneHopRows(ledger, instant, fold),
            "single hop at the current coordinate",
          );
        });

        it("matches the identity semantics across a two-hop chain", async () => {
          const { store } = await provisionIdentityFixture(context, profile);
          const ledger = await readLedger(store);
          const instant = currentInstant();

          const rows = await store
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

          expectRowsMatchModel(
            rows.map(
              (row) => `${row.start}|${row.first}|${row.second}|${row.friend}`,
            ),
            expectedTwoHopRows(ledger, instant, fold),
            "two-hop chain at the current coordinate",
          );
        });

        it("matches the identity semantics across a recursive traversal", async () => {
          const { store } = await provisionIdentityFixture(context, profile);
          const ledger = await readLedger(store);
          const instant = currentInstant();
          const maxHops = 3;

          const rows = await store
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

          expectRowsMatchModel(
            rows.map((row) => `${row.start}|${row.friend}`),
            expectedRecursiveRows(ledger, instant, fold, maxHops),
            "recursive traversal at the current coordinate",
          );
        });

        /**
         * The multiplicity property stated on its own terms, because the
         * whole-graph comparisons above would also pass if a duplicate were
         * matched by a duplicate in the model. A class of four members reaching
         * one physical edge must produce that edge once per start row — not once
         * per member, and not once per identity path through the class.
         */
        it("yields each physical edge once however many members its class has", async () => {
          const { store } = await provisionIdentityFixture(context, profile);

          const rows = await store
            .query()
            .from("Person", "person")
            .whereNode("person", (node) => node.id.eq("wide-b"))
            .traverse("link", "edge", {
              expand: "none",
              includeIdentityMembers: true,
            })
            .to("Person", "friend")
            .select((queryContext) => ({
              edge: queryContext.edge.id,
              friend: queryContext.friend.id,
            }))
            .execute();

          // `wide-b` is asserted same as `wide-a` and `wide-c`; under "fold"
          // Company `wide-a` joins the class too and carries the only outgoing
          // edge. Under "ignore" the Company stays outside, so nothing is
          // reachable at all.
          expect(rows.map((row) => `${row.edge}|${row.friend}`)).toEqual(
            fold ? ["wide-company-c|target-c"] : [],
          );
        });

        /**
         * The cyclic class reaches one member two ways round, and two of its
         * members carry an edge to the *same* target. Both are row-multiplying
         * shapes for a join that a boolean membership test could not produce.
         */
        it("yields one row per traversed edge through a cyclic class", async () => {
          const { store } = await provisionIdentityFixture(context, profile);

          const rows = await store
            .query()
            .from("Person", "person")
            .whereNode("person", (node) => node.id.eq("cycle-a"))
            .traverse("link", "edge", {
              expand: "none",
              includeIdentityMembers: true,
            })
            .to("Person", "friend")
            .select((queryContext) => ({
              edge: queryContext.edge.id,
              friend: queryContext.friend.id,
            }))
            .execute();

          expect(
            rows
              .map((row) => `${row.edge}|${row.friend}`)
              .toSorted((left, right) => compareStrings(left, right)),
          ).toEqual(["cycle-b-a|target-a", "cycle-c-a|target-a"]);
        });
      });
    }

    /**
     * Two start rows in one class must not turn one edge into a cross product.
     * The class relation is keyed by seed, so each start row pairs only with its
     * own class — a relation keyed by class instead would fan out here.
     */
    it("keeps two start rows sharing a class independent", async () => {
      const { store } = await provisionIdentityFixture(context, "fold");

      const rows = await store
        .query()
        .from("Person", "person")
        .whereNode("person", (node) =>
          node.id.in(["claim-person", "twin-person"]),
        )
        .traverse("link", "edge", {
          expand: "none",
          includeIdentityMembers: true,
        })
        .to("Person", "friend")
        .select((queryContext) => ({
          edge: queryContext.edge.id,
          start: queryContext.person.id,
        }))
        .execute();

      // The `claim-company` assertion is retracted by the end of the fixture, so
      // the class is {claim-person, twin-person, ghost-claim} — and `ghost-claim`
      // has ended, so its edge is dropped for lack of a visible member. Nothing
      // is reachable, and in particular nothing is reachable twice.
      expect(rows).toEqual([]);
    });

    /**
     * The class relation carries the read instant its member-visibility filter
     * compares against, so a reused query must bind a fresh one per execution or
     * it freezes `now` into cached SQL (the #246 regression). A peer whose window
     * closes between two executions of the same query object is the sharpest form
     * of that: nothing about the graph changes, only the clock.
     */
    it("binds a fresh read instant per execution of a reused query", async () => {
      const store = await context.createStore(IGNORE_GRAPH);
      const alice = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "instant-alice" },
      );
      const peer = await store.nodes.Person.create(
        { name: "Peer" },
        {
          id: "instant-peer",
          validTo: new Date(Date.now() + 500).toISOString(),
        },
      );
      const target = await store.nodes.Person.create(
        { name: "Target" },
        { id: "instant-target" },
      );
      // The edge leaves the peer and outlives it, so only a stale read instant
      // could keep returning the target after the peer's window closes.
      await store.edges.link.create(peer, target, {}, { id: "instant-peer-t" });
      await store.identity.assertSame(alice, peer);

      const query = store
        .query()
        .from("Person", "person")
        .whereNode("person", (node) => node.name.eq("Alice"))
        .traverse("link", "edge", {
          expand: "none",
          includeIdentityMembers: true,
        })
        .to("Person", "friend")
        .select((queryContext) => queryContext.friend.id);

      expect(await query.execute()).toEqual([target.id]);
      await settle(700);
      expect(await query.execute()).toEqual([]);
    });
  });
}
