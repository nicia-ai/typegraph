import { beforeEach, describe, expect, it } from "vitest";

import { requireDefined } from "../../../src/utils/presence";
import { seedProductsForCursorPagination } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

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
}
