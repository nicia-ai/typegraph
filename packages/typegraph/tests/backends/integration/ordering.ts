import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { ConfigurationError } from "../../../src/errors";
import { registerOrderingSchemaFormTests } from "./ordering-schema-forms";
import {
  seedMultiHopEdgePropertiesFixture,
  seedPeopleCompaniesForEdgePropertySelection,
  seedPeopleForOrderByNullHandling,
  seedPeopleForOrderingWithNulls,
  seedWorksAtEdgesWithNullSalaryValues,
} from "./seed-helpers";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

/**
 * A kind declaring its own `createdAt` and `version`, so the declared
 * property and the `meta.*` system field of the same leaf name can be told
 * apart in one query.
 */
const Post = defineNode("OrderPost", {
  schema: z.object({
    title: z.string(),
    createdAt: z.string(),
    version: z.number(),
  }),
});
const cites = defineEdge("orderCites", {
  schema: z.object({ createdAt: z.string() }),
});
const declaredMetadataNameGraph = defineGraph({
  id: "order_declared_metadata_names",
  nodes: { OrderPost: { type: Post } },
  edges: { orderCites: { type: cites, from: [Post], to: [Post] } },
});

/** Declared values run opposite to creation order and stored version. */
/**
 * Waits until the wall clock has moved past the current millisecond, so two
 * writes on either side get distinct `created_at` values and their system
 * order is not a tie.
 */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function seedPostsWithReversedDeclaredFields(
  store: InspectableStore<typeof declaredMetadataNameGraph>,
) {
  const first = await store.nodes.OrderPost.create({
    title: "first",
    createdAt: "2030-01-01T00:00:00.000Z",
    version: 1,
  });
  await nextMillisecond();
  const second = await store.nodes.OrderPost.create({
    title: "second",
    createdAt: "2020-01-01T00:00:00.000Z",
    version: 9,
  });
  // `first` reaches stored version 3, `second` stays at 1.
  await store.nodes.OrderPost.update(first.id, { title: "first" });
  await store.nodes.OrderPost.update(first.id, { title: "first" });
  return { first, second };
}

/** The `ConfigurationError` an `orderBy` call throws. */
function orderRefusal(build: () => unknown): ConfigurationError {
  try {
    build();
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("expected orderBy to refuse the field");
}

export function registerOrderingIntegrationTests(
  context: IntegrationTestContext,
): void {
  registerOrderingSchemaFormTests(context);

  describe("orderBy field names", () => {
    it("orders a declared createdAt by the property and meta.createdAt by the system column", async () => {
      const store = await context.createStore(declaredMetadataNameGraph);
      await seedPostsWithReversedDeclaredFields(store);
      // Both directions: rows tied on NULL keep one order whichever way
      // they are sorted, so a name read as a missing property cannot pass.
      const titles = async (
        field: "createdAt" | "meta.createdAt",
        direction: "asc" | "desc",
      ) => {
        const rows = await store
          .query()
          .from("OrderPost", "p")
          .orderBy("p", field, direction)
          .select((ctx) => ({ title: ctx.p.title }))
          .execute();
        return rows.map((row) => row.title);
      };

      expect({
        property: await titles("createdAt", "asc"),
        propertyDesc: await titles("createdAt", "desc"),
        system: await titles("meta.createdAt", "asc"),
        systemDesc: await titles("meta.createdAt", "desc"),
      }).toEqual({
        property: ["second", "first"],
        propertyDesc: ["first", "second"],
        system: ["first", "second"],
        systemDesc: ["second", "first"],
      });
    });

    it("orders a declared version by the property and meta.version by the stored version", async () => {
      const store = await context.createStore(declaredMetadataNameGraph);
      await seedPostsWithReversedDeclaredFields(store);
      const titles = async (field: "version" | "meta.version") => {
        const rows = await store
          .query()
          .from("OrderPost", "p")
          .select((ctx) => ({ title: ctx.p.title }))
          .orderBy("p", field, "asc")
          .execute();
        return rows.map((row) => row.title);
      };

      expect({
        property: await titles("version"),
        system: await titles("meta.version"),
      }).toEqual({
        property: ["first", "second"],
        system: ["second", "first"],
      });
    });

    it("refuses an undeclared property on a node alias before and after select", () => {
      const query = context.getStore().query().from("Person", "p");
      const refusals = [
        // @ts-expect-error Person declares no `createdAt`.
        () => query.orderBy("p", "createdAt"),
        () =>
          query
            .select((ctx) => ({ id: ctx.p.id }))
            // @ts-expect-error Person declares no `createdAt`.
            .orderBy("p", "createdAt"),
      ];
      for (const refuse of refusals) {
        expect(orderRefusal(refuse).details).toMatchObject({
          code: "ORDER_FIELD_UNKNOWN",
          alias: "p",
          field: "createdAt",
        });
      }
    });

    it.each([
      ["created_at", "meta.createdAt"],
      ["updated_at", "meta.updatedAt"],
      ["valid_from", "meta.validFrom"],
      ["valid_to", "meta.validTo"],
      ["deleted_at", "meta.deletedAt"],
    ] as const)(
      "names the replacement for the removed node name %s",
      (removed, replacement) => {
        const query = context.getStore().query().from("Person", "p");
        // @ts-expect-error Removed snake_case system names are not order fields.
        const refusal = orderRefusal(() => query.orderBy("p", removed));
        expect(refusal.message).toContain(`use "${replacement}"`);
        expect(refusal.details).toMatchObject({
          code: "ORDER_FIELD_RENAMED",
          field: removed,
          replacement,
        });
      },
    );

    it("refuses an undeclared version on a closed schema and points at meta.version", () => {
      const query = context.getStore().query().from("Person", "p");
      // `version` was never a system order name, so it is unknown, not renamed.
      // @ts-expect-error Person declares no `version`.
      const refusal = orderRefusal(() => query.orderBy("p", "version"));
      expect(refusal.details).toMatchObject({
        code: "ORDER_FIELD_UNKNOWN",
        field: "version",
      });
      expect(refusal.suggestion).toContain('"meta.version"');
    });

    it.each([
      ["from_id", "fromId"],
      ["to_id", "toId"],
      ["created_at", "meta.createdAt"],
    ] as const)(
      "names the replacement for the removed edge name %s",
      (removed, replacement) => {
        const query = context
          .getStore()
          .query()
          .from("Person", "p")
          .traverse("knows", "k")
          .to("Person", "friend");
        // @ts-expect-error Removed snake_case system names are not order fields.
        const refusal = orderRefusal(() => query.orderBy("k", removed));
        expect(refusal.message).toContain(`use "${replacement}"`);
      },
    );

    it("refuses edge endpoint kinds and node-only metadata on an edge alias", () => {
      const query = context
        .getStore()
        .query()
        .from("Person", "p")
        .traverse("knows", "k")
        .to("Person", "friend");
      for (const field of ["fromKind", "toKind", "meta.version"]) {
        // A name the type refuses, passed the way an untyped caller would.
        const refusal = orderRefusal(() => query.orderBy("k", field as never));
        expect(refusal.details).toMatchObject({ code: "ORDER_FIELD_UNKNOWN" });
      }
    });

    it("refuses edge endpoint ids on a node alias", () => {
      const query = context.getStore().query().from("Person", "p");
      // @ts-expect-error `fromId` belongs to edge aliases.
      expect(() => query.orderBy("p", "fromId")).toThrow(ConfigurationError);
    });

    it("orders an edge's declared createdAt apart from meta.createdAt", async () => {
      const store = await context.createStore(declaredMetadataNameGraph);
      const { first, second } =
        await seedPostsWithReversedDeclaredFields(store);
      await store.edges.orderCites.create(first, second, {
        createdAt: "2030-01-01T00:00:00.000Z",
      });
      await nextMillisecond();
      await store.edges.orderCites.create(second, first, {
        createdAt: "2020-01-01T00:00:00.000Z",
      });
      const sources = async (
        field: "createdAt" | "meta.createdAt",
        direction: "asc" | "desc",
      ) => {
        const rows = await store
          .query()
          .from("OrderPost", "source")
          .traverse("orderCites", "c")
          .to("OrderPost", "target")
          .orderBy("c", field, direction)
          .select((ctx) => ({ title: ctx.source.title }))
          .execute();
        return rows.map((row) => row.title);
      };

      expect({
        property: await sources("createdAt", "asc"),
        propertyDesc: await sources("createdAt", "desc"),
        system: await sources("meta.createdAt", "asc"),
        systemDesc: await sources("meta.createdAt", "desc"),
      }).toEqual({
        property: ["second", "first"],
        propertyDesc: ["first", "second"],
        system: ["first", "second"],
        systemDesc: ["second", "first"],
      });
    });
  });

  describe("system temporal columns", () => {
    it("orders by the physical validity lower bound before and after select", async () => {
      const store = context.getStore();
      await store.nodes.Person.create(
        { name: "Later", age: 30, email: "later@example.com" },
        { id: "temporal-later", validFrom: "2026-02-01T00:00:00.000Z" },
      );
      await store.nodes.Person.create(
        { name: "Earlier", age: 30, email: "earlier@example.com" },
        { id: "temporal-earlier", validFrom: "2026-01-01T00:00:00.000Z" },
      );

      const beforeSelect = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "meta.validFrom", "asc")
        .select((ctx) => ({ name: ctx.p.name }))
        .execute();
      const afterSelect = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ({ name: ctx.p.name }))
        .orderBy("p", "meta.validFrom", "asc")
        .execute();

      expect(beforeSelect.map((row) => row.name)).toEqual(["Earlier", "Later"]);
      expect(afterSelect).toEqual(beforeSelect);
    });
  });

  describe("Ordering with Nulls", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForOrderingWithNulls(store);
    });

    it("orders ascending with nulls default behavior", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.age)).toEqual([
        25,
        30,
        35,
        undefined,
        undefined,
      ]);
    });

    it("orders descending", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "desc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results.map((result) => result.age)).toEqual([
        undefined,
        undefined,
        35,
        30,
        25,
      ]);
    });

    it("honors explicit null placement in either direction", async () => {
      const store = context.getStore();
      const people = store
        .query()
        .from("Person", "p")
        .project((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .asRelation();

      const ascendingNullsFirst = await people
        .orderBy((columns) => columns.age, "asc", "first")
        .execute();
      const descendingNullsLast = await people
        .orderBy((columns) => columns.age, "desc", "last")
        .execute();

      expect(ascendingNullsFirst.map((result) => result.age)).toEqual([
        undefined,
        undefined,
        25,
        30,
        35,
      ]);
      expect(descendingNullsLast.map((result) => result.age)).toEqual([
        35,
        30,
        25,
        undefined,
        undefined,
      ]);
    });

    it("orders by multiple fields", async () => {
      const store = context.getStore();
      // Add people with same age
      await store.nodes.Person.create({ name: "Frank", age: 30 });

      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      // People with age 30 should be ordered by name
      const age30 = results.filter((result) => result.age === 30);
      expect(age30.map((result) => result.name)).toEqual(["Alice", "Frank"]);
    });
  });

  describe("OrderBy NULL Handling", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedPeopleForOrderByNullHandling(store);
    });

    it("orders nullable field ascending (nulls behavior)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.age)).toEqual([
        25,
        30,
        35,
        undefined,
        undefined,
      ]);
    });

    it("orders nullable field descending (nulls behavior)", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "desc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.age)).toEqual([
        undefined,
        undefined,
        35,
        30,
        25,
      ]);
    });

    it("orders by nullable string field", async () => {
      const store = context.getStore();
      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "email", "asc")
        .select((ctx) => ({ name: ctx.p.name, email: ctx.p.email }))
        .execute();

      expect(results).toHaveLength(5);
      expect(results.map((result) => result.email)).toEqual([
        "alice@example.com",
        "charlie@example.com",
        "diana@example.com",
        undefined,
        undefined,
      ]);
    });

    it("orders by multiple fields with mixed nullability", async () => {
      const store = context.getStore();
      // Add a second person with age 30 to test secondary sort
      await store.nodes.Person.create({
        name: "Frank",
        age: 30,
        // No email
      });

      const results = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "age", "asc")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({ name: ctx.p.name, age: ctx.p.age }))
        .execute();

      // People with age 30 should be sorted by name
      const age30 = results.filter((result) => result.age === 30);
      expect(age30.map((result) => result.name)).toEqual(["Alice", "Frank"]);
    });

    it("handles order by on field with all nulls", async () => {
      const store = context.getStore();
      // Create products with no rating
      await store.nodes.Product.create({
        name: "Product A",
        price: 100,
        category: "Test",
      });
      await store.nodes.Product.create({
        name: "Product B",
        price: 200,
        category: "Test",
      });

      const results = await store
        .query()
        .from("Product", "p")
        .whereNode("p", (p) => p.category.eq("Test"))
        .orderBy("p", "rating", "asc")
        .orderBy("p", "name", "asc")
        .select((ctx) => ({ name: ctx.p.name, rating: ctx.p.rating }))
        .execute();

      // Should still return results, sorted by secondary key (name)
      expect(results).toHaveLength(2);
      expect(results[0]?.name).toBe("Product A");
      expect(results[1]?.name).toBe("Product B");
    });
  });

  describe("Edge Property Ordering", () => {
    describe("single traversal", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedPeopleCompaniesForEdgePropertySelection(store);
      });

      it("orders by edge property ascending", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "asc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          80_000, 120_000, 150_000,
        ]);
      });

      it("orders by edge property descending", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "desc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          150_000, 120_000, 80_000,
        ]);
      });

      it("orders by edge string property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "role", "asc")
          .select((ctx) => ({
            name: ctx.p.name,
            role: ctx.e.role,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.role)).toEqual([
          "Analyst",
          "Engineer",
          "Manager",
        ]);
      });
    });

    describe("post-select ordering by edge property", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedPeopleCompaniesForEdgePropertySelection(store);
      });

      it("orders by numeric edge property after select (correct type-aware compilation)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .orderBy("e", "salary", "asc")
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          80_000, 120_000, 150_000,
        ]);
      });
    });

    describe("null handling on edge properties", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedWorksAtEdgesWithNullSalaryValues(store);
      });

      it("orders nullable edge property ascending (nulls last)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "asc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          100_000,
          undefined,
          undefined,
        ]);
      });

      it("orders nullable edge property descending (nulls first)", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("worksAt", "e")
          .to("Company", "c")
          .orderBy("e", "salary", "desc")
          .select((ctx) => ({
            name: ctx.p.name,
            salary: ctx.e.salary,
          }))
          .execute();

        expect(results).toHaveLength(3);
        expect(results.map((result) => result.salary)).toEqual([
          undefined,
          undefined,
          100_000,
        ]);
      });
    });

    describe("multi-hop traversal", () => {
      beforeEach(async () => {
        const store = context.getStore();
        await seedMultiHopEdgePropertiesFixture(store);
      });

      it("orders by edge property on second traversal", async () => {
        const store = context.getStore();
        // Query from all people who know someone, then traverse to their companies
        // Alice→Bob (Bob works at Acme 100k), Bob→Charlie (Charlie works at Globex 150k)
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("worksAt", "e2")
          .to("Company", "c")
          .orderBy("e2", "salary", "asc")
          .select((ctx) => ({
            person: ctx.p.name,
            friend: ctx.friend.name,
            company: ctx.c.name,
            salary: ctx.e2.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.salary)).toEqual([
          100_000, 150_000,
        ]);
      });

      it("orders by edge property combined with node property", async () => {
        const store = context.getStore();
        const results = await store
          .query()
          .from("Person", "p")
          .traverse("knows", "e1")
          .to("Person", "friend")
          .traverse("worksAt", "e2")
          .to("Company", "c")
          .orderBy("e2", "salary", "desc")
          .orderBy("friend", "name", "asc")
          .select((ctx) => ({
            friend: ctx.friend.name,
            salary: ctx.e2.salary,
          }))
          .execute();

        expect(results).toHaveLength(2);
        expect(results.map((result) => result.salary)).toEqual([
          150_000, 100_000,
        ]);
      });
    });
  });
}
