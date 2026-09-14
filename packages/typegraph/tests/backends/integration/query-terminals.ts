import { beforeEach, describe, expect, it } from "vitest";

import {
  count,
  havingGt,
  havingLt,
  param as parameter,
  SchemaChangedError,
} from "../../../src";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

export function registerQueryTerminalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Query terminal contracts", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Alice", age: 20 });
      await store.nodes.Person.create({ name: "Bob", age: 30 });
      await store.nodes.Person.create({ name: "Carol", age: 30 });
    });

    it("counts and checks the bounded relation without running selectors", async () => {
      const store = context.getStore();
      const query = store
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((): string => {
          throw new Error("A scalar terminal must not invoke the selector");
        });
      expect(await query.count()).toBe(3);
      expect(await query.offset(1).limit(1).count()).toBe(1);
      expect(await query.offset(3).exists()).toBe(false);
      expect(await query.limit(0).count()).toBe(0);
      expect(await query.limit(0).exists()).toBe(false);
      expect(await query.exists()).toBe(true);
      expect(await store.query().from("Person", "p").count()).toBe(3);
    });

    it("counts traversal match rows without deduplicating the source", async () => {
      const store = context.getStore();
      const source = await store.nodes.Person.create({ name: "Source" });
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      await store.edges.knows.create(source, first, {});
      await store.edges.knows.create(source, second, {});
      const query = store
        .query()
        .from("Person", "source")
        .whereNode("source", (person) => person.id.eq(source.id))
        .traverse("knows", "edge")
        .to("Person", "target");
      expect(await query.count()).toBe(2);
      expect(await query.offset(1).count()).toBe(1);
      expect(await query.select((ctx) => ctx.source.name).count()).toBe(2);
    });

    it("preserves schema checks for scalar terminals even when the relation is empty", async () => {
      const store = await context.createStore(integrationTestGraph);
      const active = await context.getBackend().getActiveSchema(store.graphId);
      const current = await store.withCheckedReads(
        active?.version,
        async (reads) => {
          const query = reads
            .query()
            .from("Person", "p")
            .orderBy("p", "name")
            .limit(0);
          return [await query.count(), await query.exists()];
        },
      );
      expect(current).toEqual([0, false]);
      for (const operation of ["count", "exists"] as const) {
        await expect(
          store.withCheckedReads((active?.version ?? 0) + 1, async (reads) =>
            reads.query().from("Person", "p").limit(0)[operation](),
          ),
        ).rejects.toBeInstanceOf(SchemaChangedError);
      }
    });

    it("refuses unbound parameters in scalar terminals", async () => {
      const query = context
        .getStore()
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.eq(parameter("name")));
      await expect(query.count()).rejects.toThrow("bound values");
      await expect(query.exists()).rejects.toThrow("bound values");
    });

    it("returns the ordered first result and preserves zero limits", async () => {
      const query = context
        .getStore()
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((ctx) => ctx.p.name);
      expect(await query.first()).toBe("Alice");
      expect(await query.offset(1).first()).toBe("Bob");
      expect(await query.limit(0).first()).toBeUndefined();
      expect(await query.offset(3).first()).toBeUndefined();
      const empty = context
        .getStore()
        .query()
        .from("Person", "p")
        .limit(0)
        .select((): string => {
          throw new Error("Empty first must not map rows");
        });
      expect(await empty.first()).toBeUndefined();
    });

    it("refuses incompatible pagination options instead of dropping them", async () => {
      const query = context
        .getStore()
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((ctx) => ctx.p);
      await expect(query.limit(1).paginate({ first: 2 })).rejects.toThrow(
        "cannot honor query limit/offset",
      );
      await expect(query.offset(1).paginate({ first: 2 })).rejects.toThrow(
        "cannot honor query limit/offset",
      );
      await expect(query.paginate({ first: 1, last: 1 })).rejects.toThrow(
        "both pagination directions",
      );
      await expect(query.paginate({ first: 0 })).rejects.toThrow(
        "positive safe integer",
      );
    });

    it("counts the single aggregate group when HAVING has no explicit grouping", async () => {
      const query = context
        .getStore()
        .query()
        .from("Person", "p")
        .having(havingGt(count("p"), 2));
      expect(await query.count()).toBe(1);
      expect(await query.exists()).toBe(true);
      expect(await query.having(havingLt(count("p"), 3)).count()).toBe(0);
    });

    it("counts groups and combines chained HAVING conditions", async () => {
      const grouped = context
        .getStore()
        .query()
        .from("Person", "p")
        .groupBy("p", "age")
        .having(havingGt(count("p"), 1))
        .having(havingLt(count("p"), 3));
      expect(await grouped.count()).toBe(1);
      expect(await grouped.exists()).toBe(true);
      expect(await grouped.offset(1).count()).toBe(0);
      expect(await grouped.aggregate({ size: count("p") }).execute()).toEqual([
        { size: 2 },
      ]);
    });
  });
}
