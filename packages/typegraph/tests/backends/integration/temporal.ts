import { describe, expect, it } from "vitest";

import { type IntegrationTestContext } from "./test-context";

export function registerTemporalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Temporal Query Execution", () => {
    it("excludes soft-deleted nodes by default", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      await store.nodes.Person.create({ name: "Bob", age: 25 });

      // Delete Alice
      await store.nodes.Person.delete(alice.id);

      const results = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(1);
      expect(results[0]).toBe("Bob");
    });

    it("includes soft-deleted nodes with includeTombstones mode", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      await store.nodes.Person.create({ name: "Bob", age: 25 });

      await store.nodes.Person.delete(alice.id);

      const results = await store
        .query()
        .from("Person", "p")
        .temporal("includeTombstones")
        .select((ctx) => ctx.p.name)
        .execute();

      expect(results).toHaveLength(2);
      expect(results.toSorted()).toEqual(["Alice", "Bob"]);
    });

    it("creates edges with validTo for temporal relationships", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const pastDate = new Date(Date.now() - 86_400_000).toISOString(); // Yesterday

      const edge = await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Former Employee" },
        { validTo: pastDate },
      );

      expect(edge.meta.validTo).toBe(pastDate);
    });

    it("includes ended edges with includeEnded mode", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const pastDate = new Date(Date.now() - 86_400_000).toISOString();

      // Current job
      await store.edges.worksAt.create(alice, techCorp, { role: "Engineer" });

      // Past job (ended)
      await store.edges.worksAt.create(
        alice,
        acme,
        { role: "Intern" },
        { validTo: pastDate },
      );

      // Default query - only current
      const currentJobs = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "e")
        .to("Company", "c")
        .select((ctx) => ctx.c.name)
        .execute();

      expect(currentJobs).toHaveLength(1);
      expect(currentJobs[0]).toBe("TechCorp");

      // With includeEnded - both jobs
      const allJobs = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .temporal("includeEnded")
        .traverse("worksAt", "e2")
        .to("Company", "c2")
        .select((ctx) => ctx.c2.name)
        .execute();

      expect(allJobs).toHaveLength(2);
      expect(allJobs.toSorted()).toEqual(["Acme Corp", "TechCorp"]);
    });

    it("queries with asOf temporal mode to filter by validity window", async () => {
      // asOf mode filters records based on their valid_from/valid_to windows.
      // It shows records that were "valid" at a specific point in time.

      const store = context.getStore();
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();
      const twoHoursAgo = new Date(now.getTime() - 7_200_000).toISOString();
      const oneHourFromNow = new Date(now.getTime() + 3_600_000).toISOString();

      // Create a person who became valid one hour ago (still valid now)
      await store.nodes.Person.create(
        { name: "Alice", age: 30 },
        { validFrom: oneHourAgo },
      );

      // Create a person who will become valid in the future
      await store.nodes.Person.create(
        { name: "Bob", age: 25 },
        { validFrom: oneHourFromNow },
      );

      // Current query - Alice is valid now, Bob is not valid yet
      const currentResults = await store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p.name)
        .execute();

      expect(currentResults).toHaveLength(1);
      expect(currentResults[0]).toBe("Alice");

      // Query asOf two hours ago - neither existed yet (Alice's validFrom is one hour ago)
      const twoHoursAgoResults = await store
        .query()
        .from("Person", "p")
        .temporal("asOf", twoHoursAgo)
        .select((ctx) => ctx.p.name)
        .execute();

      expect(twoHoursAgoResults).toHaveLength(0);

      // Query asOf now - only Alice is valid
      const nowResults = await store
        .query()
        .from("Person", "p")
        .temporal("asOf", now.toISOString())
        .select((ctx) => ctx.p.name)
        .execute();

      expect(nowResults).toHaveLength(1);
      expect(nowResults[0]).toBe("Alice");
    });
  });
}
