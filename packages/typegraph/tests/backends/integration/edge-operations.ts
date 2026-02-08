import { describe, expect, it } from "vitest";

import { type IntegrationTestContext } from "./test-context";

export function registerEdgeOperationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Edge Operations", () => {
    it("retrieves edge by ID", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
        salary: 100_000,
      });

      const retrieved = await store.edges.worksAt.getById(edge.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.role).toBe("Engineer");
      expect(retrieved?.salary).toBe(100_000);
    });

    it("returns undefined for non-existent edge ID", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      // Create an edge to get a valid branded type for casting
      await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });

      // Use type assertion to pass a non-existent ID
      const retrieved = await store.edges.worksAt.getById(
        "non-existent" as Awaited<
          ReturnType<typeof store.edges.worksAt.create>
        >["id"],
      );

      expect(retrieved).toBeUndefined();
    });

    it("deletes edge and excludes from queries", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });
      const techCorp = await store.nodes.Company.create({ name: "TechCorp" });

      const edge1 = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
      });
      await store.edges.worksAt.create(alice, techCorp, {
        role: "Consultant",
      });

      // Delete first edge
      await store.edges.worksAt.delete(edge1.id);

      // Query should only return second edge
      const edges = await store.edges.worksAt.findFrom(alice);

      expect(edges).toHaveLength(1);
      expect(edges[0]?.role).toBe("Consultant");
    });
  });
}
