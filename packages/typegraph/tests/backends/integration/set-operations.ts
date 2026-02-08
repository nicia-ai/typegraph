import { beforeEach, describe, expect, it } from "vitest";

import { seedCompaniesForSetOperations } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerSetOperationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Set Operations Execution", () => {
    beforeEach(async () => {
      const store = context.getStore();
      await seedCompaniesForSetOperations(store);
    });

    it("executes UNION of two queries", async () => {
      const store = context.getStore();
      const techCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      const healthCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Healthcare"))
        .select((ctx) => ctx.c.name);

      const results = await techCompanies.union(healthCompanies).execute();

      expect(results).toHaveLength(4);
      expect(results.toSorted()).toEqual([
        "BioMed",
        "DataInc",
        "HealthFirst",
        "TechCorp",
      ]);
    });

    it("executes INTERSECT of two queries", async () => {
      const store = context.getStore();
      // All companies
      const allCompanies = store
        .query()
        .from("Company", "c")
        .select((ctx) => ctx.c.name);

      // Tech companies
      const techCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      const results = await allCompanies.intersect(techCompanies).execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["DataInc", "TechCorp"]);
    });

    it("executes EXCEPT (difference) of two queries", async () => {
      const store = context.getStore();
      // All companies
      const allCompanies = store
        .query()
        .from("Company", "c")
        .select((ctx) => ctx.c.name);

      // Tech companies
      const techCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      const results = await allCompanies.except(techCompanies).execute();

      expect(results).toHaveLength(3);
      expect(results.toSorted()).toEqual([
        "BioMed",
        "FinanceHub",
        "HealthFirst",
      ]);
    });

    it("executes UNION ALL (preserves duplicates)", async () => {
      const store = context.getStore();
      // Query that would return TechCorp
      const query1 = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.name.eq("TechCorp"))
        .select((ctx) => ctx.c.name);

      // Query that also returns TechCorp (plus others)
      const query2 = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      const results = await query1.unionAll(query2).execute();

      // TechCorp appears twice (once from each query)
      const techCorpCount = results.filter(
        (result) => result === "TechCorp",
      ).length;
      expect(techCorpCount).toBe(2);
    });

    it("chains multiple set operations", async () => {
      const store = context.getStore();
      // (Tech UNION Healthcare) EXCEPT Finance
      const techCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      const healthCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Healthcare"))
        .select((ctx) => ctx.c.name);

      const financeCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Finance"))
        .select((ctx) => ctx.c.name);

      const results = await techCompanies
        .union(healthCompanies)
        .except(financeCompanies)
        .execute();

      expect(results).toHaveLength(4);
      expect(results.toSorted()).toEqual([
        "BioMed",
        "DataInc",
        "HealthFirst",
        "TechCorp",
      ]);
    });

    it("applies LIMIT to set operation result", async () => {
      const store = context.getStore();
      const techCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      const healthCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Healthcare"))
        .select((ctx) => ctx.c.name);

      const results = await techCompanies
        .union(healthCompanies)
        .limit(2)
        .execute();

      expect(results).toHaveLength(2);
    });

    it("applies LIMIT and OFFSET to set operation result", async () => {
      const store = context.getStore();
      const techCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      const healthCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Healthcare"))
        .select((ctx) => ctx.c.name);

      // UNION returns 4 rows, offset 2 with limit 10 should return 2
      // Note: OFFSET requires LIMIT in SQLite
      const results = await techCompanies
        .union(healthCompanies)
        .limit(10)
        .offset(2)
        .execute();

      expect(results).toHaveLength(2);
    });

    it("executes INTERSECT with empty result", async () => {
      const store = context.getStore();
      // Tech companies
      const techCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Tech"))
        .select((ctx) => ctx.c.name);

      // Finance companies (no overlap)
      const financeCompanies = store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Finance"))
        .select((ctx) => ctx.c.name);

      const results = await techCompanies.intersect(financeCompanies).execute();

      expect(results).toHaveLength(0);
    });
  });
}
