import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  NodeIndexNotFoundError,
  ValidationError,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

/**
 * Cross-backend coverage for `bulkFindByIndex` candidate retrieval against
 * declared node indexes. Runs identically on every backend the suite targets,
 * so dialect divergence in extraction, null-safe matching, partial `where`,
 * and windowed limiting is caught by construction.
 */
export function registerBulkFindByIndexIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("bulkFindByIndex", () => {
    it("returns grouped candidates per input, preserving order", async () => {
      const store = context.getStore();
      await store.nodes.Product.create({
        name: "Widget",
        price: 1,
        category: "tools",
      });
      await store.nodes.Product.create({
        name: "Gadget",
        price: 2,
        category: "tools",
      });
      await store.nodes.Product.create({
        name: "Novel",
        price: 3,
        category: "books",
      });

      const results = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        [
          { props: { category: "tools" } },
          { props: { category: "books" } },
          { props: { category: "missing" } },
        ],
      );

      expect(results).toHaveLength(3);
      expect(results[0]?.map((node) => node.name).toSorted()).toEqual([
        "Gadget",
        "Widget",
      ]);
      expect(results[1]?.map((node) => node.name)).toEqual(["Novel"]);
      expect(results[2]).toEqual([]);
    });

    it("orders each candidate bucket deterministically across calls", async () => {
      const store = context.getStore();
      const created = [];
      for (const name of ["A", "B", "C", "D"]) {
        created.push(
          await store.nodes.Product.create({
            name,
            price: 1,
            category: "batch",
          }),
        );
      }

      // The bucket is ordered by node id under the database collation (which
      // need not match JS string order); the contract is a stable order, so
      // two lookups must return the same sequence and cover every candidate.
      const args = [{ props: { category: "batch" } }] as const;
      const [first] = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        args,
      );
      const [second] = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        args,
      );

      const firstIds = (first ?? []).map((node) => node.id);
      const secondIds = (second ?? []).map((node) => node.id);
      expect(firstIds).toEqual(secondIds);
      expect([...firstIds].toSorted()).toEqual(
        created.map((node) => node.id).toSorted(),
      );
    });

    it("gives duplicate inputs the same candidate set", async () => {
      const store = context.getStore();
      await store.nodes.Product.create({
        name: "Hammer",
        price: 9,
        category: "tools",
      });

      const results = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        [{ props: { category: "tools" } }, { props: { category: "tools" } }],
      );

      expect(results[0]?.map((node) => node.name)).toEqual(["Hammer"]);
      expect(results[1]?.map((node) => node.name)).toEqual(["Hammer"]);
    });

    it("matches a composite key including a null-valued field", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Ana", isActive: true });
      await store.nodes.Person.create({ name: "Ana" }); // isActive undefined → null
      await store.nodes.Person.create({ name: "Bo", isActive: true });

      const results = await store.nodes.Person.bulkFindByIndex(
        "person_active_name",
        [
          { props: { isActive: true, name: "Ana" } },
          { props: { name: "Ana" } }, // null isActive probe
        ],
      );

      expect(results[0]?.map((node) => node.isActive)).toEqual([true]);
      expect(results[0]).toHaveLength(1);
      expect(results[1]?.map((node) => node.isActive)).toEqual([undefined]);
      expect(results[1]).toHaveLength(1);
    });

    it("applies the partial WHERE to stored rows, not probes", async () => {
      const store = context.getStore();
      await store.nodes.Product.create({
        name: "InStockTool",
        price: 1,
        category: "tools",
        inStock: true,
      });
      await store.nodes.Product.create({
        name: "OutOfStockTool",
        price: 1,
        category: "tools",
        inStock: false,
      });

      const [bucket] = await store.nodes.Product.bulkFindByIndex(
        "product_category_in_stock",
        [{ props: { category: "tools" } }],
      );

      expect(bucket?.map((node) => node.name)).toEqual(["InStockTool"]);
    });

    it("extracts nested JSON-pointer index keys", async () => {
      const store = context.getStore();
      await store.nodes.Document.create({
        title: "First",
        metadata: { author: "alice" },
      });
      await store.nodes.Document.create({
        title: "Second",
        metadata: { author: "bob" },
      });

      const [bucket] = await store.nodes.Document.bulkFindByIndex(
        "document_author",
        [{ props: { metadata: { author: "alice" } } }],
      );

      expect(bucket?.map((node) => node.title)).toEqual(["First"]);
    });

    it("excludes soft-deleted nodes", async () => {
      const store = context.getStore();
      const doomed = await store.nodes.Product.create({
        name: "Doomed",
        price: 1,
        category: "ephemeral",
      });
      await store.nodes.Product.create({
        name: "Survivor",
        price: 1,
        category: "ephemeral",
      });
      await store.nodes.Product.delete(doomed.id);

      const [bucket] = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        [{ props: { category: "ephemeral" } }],
      );

      expect(bucket?.map((node) => node.name)).toEqual(["Survivor"]);
    });

    it("caps each input's candidates with limitPerInput", async () => {
      const store = context.getStore();
      for (const name of ["p1", "p2", "p3", "p4", "p5"]) {
        await store.nodes.Product.create({
          name,
          price: 1,
          category: "capped",
        });
      }

      const [bucket] = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        [{ props: { category: "capped" } }],
        { limitPerInput: 2 },
      );

      expect(bucket).toHaveLength(2);
    });

    it("returns [] for empty input", async () => {
      const store = context.getStore();
      const results = await store.nodes.Product.bulkFindByIndex(
        "product_category",
        [],
      );
      expect(results).toEqual([]);
    });

    it("throws NodeIndexNotFoundError for an unknown index", async () => {
      const store = context.getStore();
      await expect(
        store.nodes.Product.bulkFindByIndex("does_not_exist", [
          { props: { category: "tools" } },
        ]),
      ).rejects.toBeInstanceOf(NodeIndexNotFoundError);
    });

    it("throws ValidationError for a non-positive limitPerInput", async () => {
      const store = context.getStore();
      await expect(
        store.nodes.Product.bulkFindByIndex(
          "product_category",
          [{ props: { category: "tools" } }],
          { limitPerInput: 0 },
        ),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws ValidationError for a non-scalar probe value", async () => {
      const store = context.getStore();
      await expect(
        store.nodes.Product.bulkFindByIndex("product_category", [
          // A non-scalar can't form an index key — must fail with a typed
          // error rather than a cryptic driver bind error.
          { props: { category: { nested: 1 } as unknown as string } },
        ]),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a date-typed index key with ConfigurationError", async () => {
      const store = context.getStore();
      // Date keys can't satisfy cross-backend parity (byte-text vs instant),
      // so the lookup declares the gap instead of returning divergent results.
      await expect(
        store.nodes.Document.bulkFindByIndex("document_published_at", [
          { props: { publishedAt: new Date("2024-01-01T00:00:00.000Z") } },
        ]),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });

    it("rejects a fields-less (keySystemColumns-only) index with ConfigurationError", async () => {
      const store = context.getStore();
      // A keySystemColumns/coveringFields-only index carries no prop `fields`,
      // so bulkFindByIndex has nothing to probe by; it declares the gap rather
      // than running an unconstrained scan.
      const caught = await store.nodes.Company.bulkFindByIndex(
        "company_id_covering",
        [{ props: { name: "Acme" } }],
      ).catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).message).toBe(
        'bulkFindByIndex requires an index with at least one prop-based field on index "company_id_covering" (node kind "Company")',
      );
      expect((caught as ConfigurationError).details).toEqual({
        indexName: "company_id_covering",
        kind: "Company",
      });
    });
  });
}
