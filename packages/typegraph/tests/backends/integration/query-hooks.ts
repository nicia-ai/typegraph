import { describe, expect, it } from "vitest";

import { type QueryHookContext } from "../../../src";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

export function registerQueryHookIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("query hooks", () => {
    it("reports SQL, parameters, row count, and duration per submitted statement", async () => {
      const starts: QueryHookContext[] = [];
      const ends: Readonly<{
        ctx: QueryHookContext;
        result: Readonly<{ rowCount: number; durationMs: number }>;
      }>[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            starts.push(ctx);
          },
          onQueryEnd: (ctx, result) => {
            ends.push({ ctx, result });
          },
        },
      });
      await store.nodes.Person.create({
        name: "Hook Alice",
        age: 30,
        email: "hook-alice@example.com",
      });

      const rows = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.eq("Hook Alice"))
        .select((ctx) => ctx.p)
        .execute();

      expect(rows).toHaveLength(1);
      expect(starts).toHaveLength(1);
      expect(ends).toHaveLength(1);
      expect(starts[0]?.sql).toContain("SELECT");
      expect(starts[0]?.params.length).toBeGreaterThan(0);
      expect(ends[0]?.ctx).toBe(starts[0]);
      expect(ends[0]?.result.rowCount).toBe(1);
      expect(ends[0]?.result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("fires once for each statement in a selective-projection fallback", async () => {
      const starts: QueryHookContext[] = [];
      const store = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (ctx) => {
            starts.push(ctx);
          },
        },
      });
      await store.nodes.Person.create({
        name: "Hook Adult",
        email: "adult@example.com",
      });
      await store.nodes.Person.create({ name: "Hook Child", age: 10 });

      const rows = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "name", "asc")
        .select((ctx) =>
          ctx.p.name === "Hook Adult" ? ctx.p.email : ctx.p.name,
        )
        .execute();

      expect(rows).toEqual(["adult@example.com", "Hook Child"]);
      expect(starts).toHaveLength(2);
      expect(starts[0]?.operationId).not.toBe(starts[1]?.operationId);
      expect(starts[0]?.sql).not.toBe(starts[1]?.sql);
    });
  });
}
