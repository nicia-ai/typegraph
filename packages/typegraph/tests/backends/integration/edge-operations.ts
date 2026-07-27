import { describe, expect, it } from "vitest";

import { type IntegrationTestContext } from "./test-context";

export function registerEdgeOperationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Edge Operations", () => {
    const FIRST_VALID_FROM = "2019-03-01T00:00:00.000Z";
    const FIRST_VALID_TO = "2021-08-31T23:59:59.999Z";
    const SECOND_VALID_FROM = "2022-01-01T00:00:00.000Z";
    const SECOND_VALID_TO = "2024-12-31T23:59:59.999Z";

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

    it("sets valid time when creating by endpoints and preserves it when found", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const created = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM, validTo: FIRST_VALID_TO },
      );
      const found = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Manager" },
        { validFrom: SECOND_VALID_FROM, validTo: SECOND_VALID_TO },
      );

      expect(created.action).toBe("created");
      expect(created.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(created.edge.meta.validTo).toBe(FIRST_VALID_TO);
      expect(found.action).toBe("found");
      expect(found.edge.id).toBe(created.edge.id);
      expect(found.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(found.edge.meta.validTo).toBe(FIRST_VALID_TO);
    });

    it("updates validTo but preserves validFrom when updating by endpoints", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const created = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Engineer" },
        { validFrom: FIRST_VALID_FROM },
      );
      const updated = await store.edges.worksAt.getOrCreateByEndpoints(
        alice,
        acme,
        { role: "Manager" },
        {
          ifExists: "update",
          validFrom: SECOND_VALID_FROM,
          validTo: SECOND_VALID_TO,
        },
      );

      expect(updated.action).toBe("updated");
      expect(updated.edge.id).toBe(created.edge.id);
      expect(updated.edge.role).toBe("Manager");
      expect(updated.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(updated.edge.meta.validTo).toBe(SECOND_VALID_TO);
    });

    it("sets distinct valid-time windows for bulk endpoint writes", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const acme = await store.nodes.Company.create({ name: "Acme Corp" });

      const results = await store.edges.worksAt.bulkGetOrCreateByEndpoints([
        {
          from: alice,
          to: acme,
          props: { role: "Engineer" },
          validFrom: FIRST_VALID_FROM,
          validTo: FIRST_VALID_TO,
        },
        {
          from: bob,
          to: acme,
          props: { role: "Manager" },
          validFrom: SECOND_VALID_FROM,
          validTo: SECOND_VALID_TO,
        },
      ]);

      expect(results[0]?.action).toBe("created");
      expect(results[0]?.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(results[0]?.edge.meta.validTo).toBe(FIRST_VALID_TO);
      expect(results[1]?.action).toBe("created");
      expect(results[1]?.edge.meta.validFrom).toBe(SECOND_VALID_FROM);
      expect(results[1]?.edge.meta.validTo).toBe(SECOND_VALID_TO);

      const [updated] = await store.edges.worksAt.bulkGetOrCreateByEndpoints(
        [
          {
            from: alice,
            to: acme,
            props: { role: "Principal Engineer" },
            validFrom: SECOND_VALID_FROM,
            validTo: SECOND_VALID_TO,
          },
        ],
        { ifExists: "update" },
      );

      expect(updated?.action).toBe("updated");
      expect(updated?.edge.meta.validFrom).toBe(FIRST_VALID_FROM);
      expect(updated?.edge.meta.validTo).toBe(SECOND_VALID_TO);
    });
  });
}
