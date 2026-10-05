import { beforeEach, describe, expect, it } from "vitest";

import { expr } from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { seedProductsForCursorPagination } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

async function seedFanOut(context: IntegrationTestContext) {
  const store = context.getStore();
  const hub = await store.nodes.Person.create({ name: "hub" });
  const names = ["n1", "n2", "n3", "n4", "n5"];
  for (const name of names) {
    const neighbor = await store.nodes.Person.create({ name });
    await store.edges.knows.create(hub, neighbor);
  }
  const fanOut = () =>
    store
      .query()
      .from("Person", "source")
      .whereNode("source", (source) => source.id.eq(hub.id))
      .traverse("knows", "edge")
      .to("Person", "neighbor");
  return { store, hub, names, fanOut };
}

export function registerPaginationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Cursor Pagination", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedProductsForCursorPagination(store);
    });

    it.each([
      ["asc", "full"],
      ["desc", "full"],
      ["asc", "partial"],
      ["desc", "partial"],
    ] as const)(
      "crosses nullable %s sort partitions in both directions with %s selection",
      async (direction, selection) => {
        const store = context.getStore();
        const people = await store.nodes.Person.bulkCreate([
          { props: { name: "A" } },
          { props: { name: "B", age: 20 } },
          { props: { name: "C", age: 10 } },
          { props: { name: "D" } },
          { props: { name: "E", age: 10 } },
          { props: { name: "F", age: 30 } },
        ]);
        const ordered = store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) =>
            person.id.in(people.map((entry) => entry.id)),
          )
          .orderBy("person", "age", direction)
          .orderBy("person", "name", "asc");
        const query =
          selection === "full" ?
            ordered.select((fields) => fields.person)
          : ordered.select((fields) => ({ name: fields.person.name }));
        const expected =
          direction === "asc" ?
            ["C", "E", "B", "F", "A", "D"]
          : ["A", "D", "F", "B", "C", "E"];

        let after: string | undefined;
        for (const [index, name] of expected.entries()) {
          const page = await query.paginate({
            first: 1,
            ...(after === undefined ? {} : { after }),
          });
          expect(page.data.map((person) => person.name)).toEqual([name]);
          expect(page.hasNextPage).toBe(index < expected.length - 1);
          expect(page.hasPrevPage).toBe(index > 0);
          after = page.nextCursor;
        }

        let before: string | undefined;
        for (const [index, name] of expected.toReversed().entries()) {
          const page = await query.paginate({
            last: 1,
            ...(before === undefined ? {} : { before }),
          });
          expect(page.data.map((person) => person.name)).toEqual([name]);
          expect(page.hasPrevPage).toBe(index < expected.length - 1);
          expect(page.hasNextPage).toBe(index > 0);
          before = page.prevCursor;
        }

        const streamed: string[] = [];
        for await (const person of query.stream({ batchSize: 1 })) {
          streamed.push(person.name);
        }
        expect(streamed).toEqual(expected);
      },
    );

    it("paginates forward with first/after", async () => {
      const store = context.getStore();
      // Get first page
      const page1 = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ first: 3 });

      expect(page1.data).toHaveLength(3);
      expect(page1.data[0]?.price).toBe(100);
      expect(page1.data[2]?.price).toBe(300);
      expect(page1.hasNextPage).toBe(true);
      expect(page1.hasPrevPage).toBe(false);
      expect(page1.nextCursor).toBeDefined();

      // Get second page
      const page2 = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ first: 3, after: requireDefined(page1.nextCursor) });

      expect(page2.data).toHaveLength(3);
      expect(page2.data[0]?.price).toBe(400);
      expect(page2.data[2]?.price).toBe(600);
      expect(page2.hasNextPage).toBe(true);
      expect(page2.hasPrevPage).toBe(true);
    });

    it("paginates backward with last/before", async () => {
      const store = context.getStore();
      // First, get to page 2 to have a cursor
      const page1 = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ first: 5 });

      // Get next page
      const page2 = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ first: 5, after: requireDefined(page1.nextCursor) });

      expect(page2.data[0]?.price).toBe(600);
      expect(page2.prevCursor).toBeDefined();

      // Go back to previous page
      const previousPage = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ last: 5, before: requireDefined(page2.prevCursor) });

      expect(previousPage.data).toHaveLength(5);
      expect(previousPage.data[0]?.price).toBe(100);
      expect(previousPage.data[4]?.price).toBe(500);
    });

    it("handles last page correctly", async () => {
      const store = context.getStore();
      // Skip to near the end
      const page1 = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ first: 8 });

      // Get last page (should have 2 items)
      const lastPage = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ first: 5, after: requireDefined(page1.nextCursor) });

      expect(lastPage.data).toHaveLength(2);
      expect(lastPage.hasNextPage).toBe(false);
      expect(lastPage.hasPrevPage).toBe(true);
    });

    it("paginates with descending order", async () => {
      const store = context.getStore();
      const page1 = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "desc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ first: 3 });

      expect(page1.data).toHaveLength(3);
      expect(page1.data[0]?.price).toBe(1000);
      expect(page1.data[1]?.price).toBe(900);
      expect(page1.data[2]?.price).toBe(800);
    });

    it("executes descending multi-column cursor pages", async () => {
      const store = context.getStore();
      const query = store
        .query()
        .from("Product", "product")
        .orderBy("product", "price", "desc")
        .orderBy("product", "name", "desc")
        .select((fields) => ({
          name: fields.product.name,
          price: fields.product.price,
        }));

      const first = await query.paginate({ first: 3 });
      const second = await query.paginate({
        after: requireDefined(first.nextCursor),
        first: 3,
      });

      expect(first.data.map((product) => product.price)).toEqual([
        1000, 900, 800,
      ]);
      expect(second.data.map((product) => product.price)).toEqual([
        700, 600, 500,
      ]);
    });
  });

  // One start node fanning out into several result rows: every row ties on a
  // start-alias order key, so the keyset has to identify the ROW (the start
  // node and the edge each traversal matched), and the cursor has to be
  // positioned against the completed row, whose order keys may read any alias.
  describe("Cursor pagination over traversal fan-out", () => {
    type Page = Readonly<{
      data: readonly string[];
      nextCursor?: string | undefined;
      prevCursor?: string | undefined;
    }>;

    async function walkForward(
      paginate: (
        options: Readonly<{ first: number; after?: string }>,
      ) => Promise<Page>,
    ): Promise<readonly string[]> {
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await paginate({
          first: 2,
          ...(after === undefined ? {} : { after }),
        });
        seen.push(...result.data);
        if (result.nextCursor === undefined) return seen;
        after = result.nextCursor;
      }
      throw new Error("pagination did not terminate");
    }

    async function walkBackward(
      paginate: (
        options: Readonly<{ last: number; before?: string }>,
      ) => Promise<Page>,
    ): Promise<readonly string[]> {
      const seen: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await paginate({
          last: 2,
          ...(before === undefined ? {} : { before }),
        });
        seen.unshift(...result.data);
        if (result.prevCursor === undefined) return seen;
        before = result.prevCursor;
      }
      throw new Error("pagination did not terminate");
    }

    it("returns every row once when the order names only the start alias", async () => {
      const { names, fanOut } = await seedFanOut(context);
      const query = fanOut()
        .orderBy("source", "name", "asc")
        .select((ctx) => ctx.neighbor.name);

      const forward = await walkForward((options) => query.paginate(options));
      const backward = await walkBackward((options) => query.paginate(options));

      expect(forward.toSorted()).toEqual(names);
      expect(backward).toEqual(forward);
    });

    it("orders and pages by a traversal alias's own keys", async () => {
      const { names, fanOut } = await seedFanOut(context);
      const byNeighborName = fanOut()
        .orderBy("neighbor", "name", "desc")
        .select((ctx) => ctx.neighbor.name);
      const byNeighborId = fanOut()
        .orderBy("source", "name", "asc")
        .orderBy("neighbor", "id", "asc")
        .select((ctx) => ctx.neighbor.name);

      expect(
        await walkForward((options) => byNeighborName.paginate(options)),
      ).toEqual(names.toReversed());
      expect(
        await walkBackward((options) => byNeighborName.paginate(options)),
      ).toEqual(names.toReversed());
      const byId = await walkForward((options) =>
        byNeighborId.paginate(options),
      );
      expect(byId.toSorted()).toEqual(names);
    });

    it("keeps two parallel edges between one pair of nodes as two rows", async () => {
      const store = context.getStore();
      const hub = await store.nodes.Person.create({ name: "hub" });
      const neighbor = await store.nodes.Person.create({ name: "twice" });
      const other = await store.nodes.Person.create({ name: "once" });
      await store.edges.knows.create(hub, neighbor);
      await store.edges.knows.create(hub, neighbor);
      await store.edges.knows.create(hub, other);
      const query = store
        .query()
        .from("Person", "source")
        .whereNode("source", (source) => source.id.eq(hub.id))
        .traverse("knows", "edge")
        .to("Person", "neighbor")
        .orderBy("source", "name", "asc")
        .select((ctx) => ctx.neighbor.name);

      const forward = await walkForward((options) => query.paginate(options));

      expect(forward.toSorted()).toEqual(["once", "twice", "twice"]);
    });

    it("pages an optional traversal's unmatched rows alongside its fan-out", async () => {
      const { store, hub, names } = await seedFanOut(context);
      const loner = await store.nodes.Person.create({ name: "loner" });
      const query = store
        .query()
        .from("Person", "source")
        .whereNode("source", (source) => source.id.in([hub.id, loner.id]))
        .optionalTraverse("knows", "edge")
        .to("Person", "neighbor")
        .orderBy("source", "name", "asc")
        .select((ctx) => `${ctx.source.name}>${ctx.neighbor?.name ?? "-"}`);

      const forward = await walkForward((options) => query.paginate(options));
      const backward = await walkBackward((options) => query.paginate(options));

      expect(forward.toSorted()).toEqual(
        [...names.map((name) => `hub>${name}`), "loner>-"].toSorted(),
      );
      expect(backward).toEqual(forward);
    });

    it("pages the same rows through page() inside batchOnce", async () => {
      const { store, names, fanOut } = await seedFanOut(context);
      const query = fanOut()
        .orderBy("source", "name", "asc")
        .select((ctx) => ctx.neighbor.name);

      const viaBatch = await walkForward(async (options) => {
        const [page] = await store.batchOnce(
          () => [query.page(options)] as const,
        );
        return page;
      });

      expect(viaBatch.toSorted()).toEqual(names);
    });

    it("composes the cursor with a completed-match where()", async () => {
      const { names, fanOut } = await seedFanOut(context);
      const query = fanOut()
        .where((fields) => expr.neq(fields.neighbor.name, expr.literal("n3")))
        .orderBy("source", "name", "asc")
        .select((ctx) => ctx.neighbor.name);

      const forward = await walkForward((options) => query.paginate(options));

      expect(forward.toSorted()).toEqual(names.filter((name) => name !== "n3"));
    });
  });
}
