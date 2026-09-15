import { describe, expect, it } from "vitest";

import { count } from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

export function registerMultiKindQueryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Multi-kind queries", () => {
    it("refuses empty and unknown sources, expansion options, and unshared fields", () => {
      const store = context.getStore();
      expect(() =>
        store.query().from([] as unknown as readonly ["Person"], "node"),
      ).toThrow("nonempty source kind list");
      expect(() =>
        store
          .query()
          .from(["Unknown"] as unknown as readonly ["Person"], "node"),
      ).toThrow("Unknown");
      expect(() =>
        store
          .query()
          // @ts-expect-error List sources deliberately have no ontology expansion option.
          .from(["Person", "Company"] as const, "node", {
            includeSubClasses: true,
          }),
      ).toThrow("does not accept from() options");
      expect(() =>
        store
          .query()
          .from(["Person", "Company"] as const, "node")
          .orderBy("node", "age"),
      ).toThrow("age");
    });

    it("filters and projects shared fields while excluding unrequested kinds", async () => {
      const store = context.getStore();
      await store.nodes.Person.bulkCreate([
        { id: "multi-person", props: { name: "Shared", age: 37 } },
      ]);
      await store.nodes.Company.bulkCreate([
        {
          id: "multi-company",
          props: { name: "Shared", industry: "Research" },
        },
      ]);
      await store.nodes.Product.bulkCreate([
        {
          id: "multi-product",
          props: { name: "Shared", price: 10, category: "excluded" },
        },
      ]);

      const rows = await store
        .query()
        .from(["Person", "Company"] as const, "node")
        .whereNode("node", (node) => node.name.eq("Shared"))
        .orderBy("node", "kind")
        .select((fields) => ({
          id: fields.node.id,
          kind: fields.node.kind,
          name: fields.node.name,
        }))
        .execute();

      expect(rows).toEqual([
        { id: "multi-company", kind: "Company", name: "Shared" },
        { id: "multi-person", kind: "Person", name: "Shared" },
      ]);

      const fullRows = await store
        .query()
        .from(["Person", "Company"] as const, "node")
        .orderBy("node", "kind")
        .select((fields) => fields.node)
        .execute();
      expect(fullRows.map((node) => node.kind)).toEqual(["Company", "Person"]);
      expect(fullRows[0]).toMatchObject({
        id: "multi-company",
        kind: "Company",
        name: "Shared",
        industry: "Research",
      });
      expect(fullRows[1]).toMatchObject({
        id: "multi-person",
        kind: "Person",
        name: "Shared",
        age: 37,
      });

      const kindSpecific = await store
        .query()
        .from(["Person", "Company"] as const, "node")
        .orderBy("node", "kind")
        .select((fields) =>
          fields.node.kind === "Person" ?
            fields.node.age
          : fields.node.industry,
        )
        .execute();
      expect(kindSpecific).toEqual(["Research", 37]);
    });

    it("normalizes duplicate source kinds and composes with aggregate and batchOnce", async () => {
      const store = context.getStore();
      await store.nodes.Person.bulkCreate([
        { id: "multi-batch-person", props: { name: "Person" } },
      ]);
      await store.nodes.Company.bulkCreate([
        { id: "multi-batch-company", props: { name: "Company" } },
      ]);

      const selected = store
        .query()
        .from(["Person", "Company", "Person"] as const, "node")
        .orderBy("node", "name")
        .select((fields) => fields.node.name);
      const aggregate = store
        .query()
        .from(["Person", "Company", "Person"] as const, "node")
        .aggregate({ total: count("node") });

      expect(
        await store.batchOnce(() => [selected, aggregate] as const),
      ).toEqual([["Company", "Person"], [{ total: 2 }]]);
    });

    it("retains the temporal coordinate across selected kinds", async () => {
      const store = context.getStore();
      await store.nodes.Person.bulkCreate([
        {
          id: "multi-valid-person",
          props: { name: "Past" },
          validFrom: "2020-01-01T00:00:00.000Z",
        },
      ]);
      await store.nodes.Company.bulkCreate([
        {
          id: "multi-valid-company",
          props: { name: "Future" },
          validFrom: "2040-01-01T00:00:00.000Z",
        },
      ]);

      const rows = await store
        .query()
        .temporal("asOf", "2030-01-01T00:00:00.000Z")
        .from(["Person", "Company"] as const, "node")
        .orderBy("node", "kind")
        .select((fields) => fields.node.name)
        .execute();
      expect(rows).toEqual(["Past"]);
    });

    it("paginates and streams equal ids across kinds without skips or duplicates", async () => {
      const store = context.getStore();
      await store.nodes.Person.bulkCreate([
        { id: "multi-shared-id", props: { name: "Same" } },
      ]);
      await store.nodes.Company.bulkCreate([
        { id: "multi-shared-id", props: { name: "Same" } },
      ]);

      const query = store
        .query()
        .from(["Person", "Company"] as const, "node")
        .whereNode("node", (node) => node.id.eq("multi-shared-id"))
        .orderBy("node", "name")
        .select((fields) => fields.node.kind);

      const first = await query.paginate({ first: 1 });
      const second = await query.paginate({
        first: 1,
        after: requireDefined(first.nextCursor),
      });
      expect([...first.data, ...second.data]).toEqual(["Company", "Person"]);
      expect(second.hasNextPage).toBe(false);

      const last = await query.paginate({ last: 1 });
      const previous = await query.paginate({
        last: 1,
        before: requireDefined(last.prevCursor),
      });
      expect([...previous.data, ...last.data]).toEqual(["Company", "Person"]);
      expect(previous.hasPrevPage).toBe(false);

      const streamed: string[] = [];
      for await (const kind of query.stream({ batchSize: 1 })) {
        streamed.push(kind);
      }
      expect(streamed).toEqual(["Company", "Person"]);
    });
  });
}
