/**
 * Keyset pagination as a property: for a random population and a random
 * partial order, walking `paginate()` forward (`first`/`after`) and backward
 * (`last`/`before`) at random page sizes concatenates to exactly the rows
 * `execute()` returns for the same query ordered by its full keyset — the
 * caller's keys followed by the row identity spelled out explicitly (start
 * `kind` and `id`, then each traversal's edge `id`).
 *
 * The plain query's own `execute()` is the second reference: same row
 * multiset, same caller-key sequence. Ties in the caller's keys are where a
 * keyset without a unique tail skips or repeats rows, so the generator keeps
 * them dense: two start kinds sharing ids, sort keys drawn from a two-value
 * set plus NULL, parallel edges between one pair, and an optional traversal
 * whose unmatched rows carry a NULL edge id.
 *
 * Each run writes under a fresh graph id over the already-provisioned backend
 * (a bare `createStore` issues no DDL), so runs and shrinks are hermetic.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../../src";
import type { GraphBackend } from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { propertyRuns } from "../../property/run-budget";
import { type IntegrationTestContext } from "./test-context";

const KpItem = defineNode("KpItem", {
  schema: z.object({ rank: z.number().optional() }),
});
const KpPart = defineNode("KpPart", {
  schema: z.object({ rank: z.number().optional() }),
});
const KpTarget = defineNode("KpTarget", {
  schema: z.object({ rank: z.number().optional() }),
});
const kpLinks = defineEdge("kpLinks", { schema: z.object({}) });

function keysetGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      KpItem: { type: KpItem },
      KpPart: { type: KpPart },
      KpTarget: { type: KpTarget },
    },
    edges: {
      kpLinks: {
        type: kpLinks,
        from: [KpItem, KpPart],
        to: [KpTarget],
        cardinality: "many",
      },
    },
  });
}

let runSequence = 0;

function freshStore(backend: GraphBackend) {
  runSequence += 1;
  return createStore(keysetGraph(`keyset_property_${runSequence}`), backend);
}

type KeysetStore = ReturnType<typeof freshStore>;

const START_KINDS = ["KpItem", "KpPart"] as const;
type StartKind = (typeof START_KINDS)[number];

/** Two sort values plus NULL: every key is tied with something. */
const rankArb = fc.constantFrom<number | undefined>(undefined, 1, 2);

type Population = Readonly<{
  starts: readonly Readonly<{
    kind: StartKind;
    id: string;
    rank: number | undefined;
  }>[];
  targets: readonly (number | undefined)[];
  links: readonly Readonly<{ start: number; target: number }>[];
}>;

/**
 * Start ids come from a pool of three, so the same id recurs across both
 * kinds; within one kind ids stay unique. Links repeat freely, giving
 * parallel edges between one pair.
 */
const populationArb: fc.Arbitrary<Population> = fc
  .record({
    starts: fc.uniqueArray(
      fc.record({
        kind: fc.constantFrom(...START_KINDS),
        id: fc.constantFrom("s0", "s1", "s2"),
        rank: rankArb,
      }),
      {
        minLength: 1,
        maxLength: 6,
        selector: (start) => `${start.kind}:${start.id}`,
      },
    ),
    targets: fc.array(rankArb, { minLength: 1, maxLength: 3 }),
    linkPicks: fc.array(fc.record({ start: fc.nat(), target: fc.nat() }), {
      maxLength: 8,
    }),
  })
  .map(({ starts, targets, linkPicks }) => ({
    starts,
    targets,
    links: linkPicks.map((pick) => ({
      start: pick.start % starts.length,
      target: pick.target % targets.length,
    })),
  }));

type Shape = "start-only" | "fan-out" | "optional";
type Direction = "asc" | "desc";
type OrderKey = Readonly<{ alias: "s" | "t"; direction: Direction }>;

type QueryPlan = Readonly<{ shape: Shape; order: readonly OrderKey[] }>;

const directionArb = fc.constantFrom<Direction>("asc", "desc");

/**
 * The caller's order names only `rank` fields, never an identity column, so
 * the keyset always has to append its own tiebreaker.
 */
const queryPlanArb: fc.Arbitrary<QueryPlan> = fc
  .constantFrom<Shape>("start-only", "fan-out", "optional")
  .chain((shape) =>
    fc.record({
      shape: fc.constant(shape),
      order:
        shape === "start-only" ?
          fc
            .tuple(directionArb)
            .map(([direction]) => [{ alias: "s" as const, direction }])
        : fc.subarray(["s", "t"] as const, { minLength: 1 }).chain((aliases) =>
            fc
              .array(directionArb, {
                minLength: aliases.length,
                maxLength: aliases.length,
              })
              .map((directions) =>
                aliases.map((alias, index) => ({
                  alias,
                  direction: requireDefined(directions[index], "direction"),
                })),
              ),
          ),
    }),
  );

const walkArb = fc.array(fc.integer({ min: 1, max: 4 }), {
  minLength: 1,
  maxLength: 4,
});

type Row = Readonly<{ identity: string; sortKey: string }>;

function rankText(rank: number | undefined): string {
  return rank === undefined ? "null" : String(rank);
}

async function seed(store: KeysetStore, population: Population) {
  const starts = [];
  for (const start of population.starts) {
    const props = start.rank === undefined ? {} : { rank: start.rank };
    starts.push(
      start.kind === "KpItem" ?
        await store.nodes.KpItem.create(props, { id: start.id })
      : await store.nodes.KpPart.create(props, { id: start.id }),
    );
  }
  const targets = [];
  for (const [index, rank] of population.targets.entries()) {
    targets.push(
      await store.nodes.KpTarget.create(rank === undefined ? {} : { rank }, {
        id: `t${index}`,
      }),
    );
  }
  for (const [index, link] of population.links.entries()) {
    await store.edges.kpLinks.create(
      requireDefined(starts[link.start], "link start"),
      requireDefined(targets[link.target], "link target"),
      {},
      { id: `e${index}` },
    );
  }
}

interface OrderableTraversal {
  orderBy(alias: "s" | "t" | "e", field: string, direction?: Direction): this;
}

/** The caller's keys, then — with `explicitIdentity` — the full row identity. */
function applyOrder<Q extends OrderableTraversal>(
  builder: Q,
  order: readonly OrderKey[],
  explicitIdentity: boolean,
): Q {
  let callerOrdered = builder;
  for (const key of order) {
    callerOrdered = callerOrdered.orderBy(key.alias, "rank", key.direction);
  }
  return explicitIdentity ?
      callerOrdered
        .orderBy("s", "kind", "asc")
        .orderBy("s", "id", "asc")
        .orderBy("e", "id", "asc")
    : callerOrdered;
}

/**
 * The query under test, and — with `explicitIdentity` — the same query with
 * its full keyset spelled out, whose `execute()` is the order reference.
 */
function buildQuery(
  store: KeysetStore,
  plan: QueryPlan,
  explicitIdentity: boolean,
) {
  const start = store.query().from(START_KINDS, "s");
  const orderedStart = (
    builder: ReturnType<typeof start.orderBy>,
  ): typeof builder =>
    explicitIdentity ?
      builder.orderBy("s", "kind", "asc").orderBy("s", "id", "asc")
    : builder;

  if (plan.shape === "start-only") {
    const [key] = plan.order;
    return orderedStart(
      start.orderBy("s", "rank", requireDefined(key, "order key").direction),
    ).select((ctx): Row => ({
      identity: `${ctx.s.kind}:${ctx.s.id}`,
      sortKey: rankText(ctx.s.rank),
    }));
  }

  const traversed =
    plan.shape === "optional" ?
      applyOrder(
        start.optionalTraverse("kpLinks", "e").to("KpTarget", "t"),
        plan.order,
        explicitIdentity,
      )
    : applyOrder(
        start.traverse("kpLinks", "e").to("KpTarget", "t"),
        plan.order,
        explicitIdentity,
      );
  return traversed.select((ctx): Row => ({
    identity: `${ctx.s.kind}:${ctx.s.id}>${ctx.e?.id ?? "-"}`,
    sortKey: plan.order
      .map((key) =>
        key.alias === "s" ? rankText(ctx.s.rank) : rankText(ctx.t?.rank),
      )
      .join("|"),
  }));
}

type PagedQuery = ReturnType<typeof buildQuery>;

/** Hard stop: a cursor that never reaches the end fails instead of hanging. */
const MAX_PAGES = 64;

async function walkForward(
  query: PagedQuery,
  sizes: readonly number[],
): Promise<readonly Row[]> {
  const rows: Row[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await query.paginate({
      first: requireDefined(sizes[page % sizes.length], "page size"),
      ...(after === undefined ? {} : { after }),
    });
    rows.push(...result.data);
    if (!result.hasNextPage) return rows;
    after = requireDefined(result.nextCursor, "next cursor of a non-last page");
  }
  throw new Error("forward pagination did not terminate");
}

async function walkBackward(
  query: PagedQuery,
  sizes: readonly number[],
): Promise<readonly Row[]> {
  const pages: (readonly Row[])[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await query.paginate({
      last: requireDefined(sizes[page % sizes.length], "page size"),
      ...(before === undefined ? {} : { before }),
    });
    pages.unshift(result.data);
    if (!result.hasPrevPage) return pages.flat();
    before = requireDefined(
      result.prevCursor,
      "prev cursor of a non-first page",
    );
  }
  throw new Error("backward pagination did not terminate");
}

function identities(rows: readonly Row[]): readonly string[] {
  return rows.map((row) => row.identity);
}

export function registerKeysetPaginationPropertyTests(
  context: IntegrationTestContext,
): void {
  describe("Keyset pagination property", () => {
    it("pages walked forward and backward at random sizes concatenate to the fully ordered execute()", async () => {
      await fc.assert(
        fc.asyncProperty(
          populationArb,
          queryPlanArb,
          walkArb,
          walkArb,
          async (population, plan, forwardSizes, backwardSizes) => {
            const store = freshStore(context.getBackend());
            await seed(store, population);
            const query = buildQuery(store, plan, false);

            const reference = await buildQuery(store, plan, true).execute();
            const plain = await query.execute();
            const forward = await walkForward(query, forwardSizes);
            const backward = await walkBackward(query, backwardSizes);

            const rowSet = identities(plain).toSorted();
            // A skip or a repeat across a page boundary shows up here first.
            expect(identities(forward).toSorted()).toEqual(rowSet);
            expect(identities(backward).toSorted()).toEqual(rowSet);
            expect(identities(reference).toSorted()).toEqual(rowSet);
            expect(plain.map((row) => row.sortKey)).toEqual(
              reference.map((row) => row.sortKey),
            );
            expect(identities(forward)).toEqual(identities(reference));
            expect(identities(backward)).toEqual(identities(reference));
          },
        ),
        { numRuns: propertyRuns({ ci: 60, local: 150 }) },
      );
    });
  });
}
