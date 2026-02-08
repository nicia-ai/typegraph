import { beforeEach, describe, expect, it } from "vitest";

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
        .paginate({ first: 3, after: page1.nextCursor! });

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
        .paginate({ first: 5, after: page1.nextCursor! });

      expect(page2.data[0]?.price).toBe(600);
      expect(page2.prevCursor).toBeDefined();

      // Go back to previous page
      const previousPage = await store
        .query()
        .from("Product", "p")
        .orderBy("p", "price", "asc")
        .select((ctx) => ({ name: ctx.p.name, price: ctx.p.price }))
        .paginate({ last: 5, before: page2.prevCursor! });

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
        .paginate({ first: 5, after: page1.nextCursor! });

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
  });
}
