import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  asCompiledStatementSql,
  createStoreWithSchema,
  defineGraphExtension,
  rebuildIdentityClosure,
} from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { type IntegrationTestContext } from "./test-context";

export function registerIdentityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Operational Identity", () => {
    it("asserts, reads, retracts, and folds classes", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "shared-id" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "shared-id" },
      );
      const product = await store.nodes.Product.create(
        { name: "Alice Product", price: 1, category: "test" },
        { id: "product-id" },
      );

      expect(await store.identity.membersOf(person)).toEqual([
        { kind: "Company", id: "shared-id" },
        { kind: "Person", id: "shared-id" },
      ]);
      const assertion = await store.identity.assertSame(company, product);
      expect(await store.identity.areSame(person, product)).toBe(true);
      expect(await store.identity.representativeOf(person)).toEqual({
        kind: "Company",
        id: "shared-id",
      });

      await store.identity.retractAssertion(assertion.id);
      expect(await store.identity.areSame(person, product)).toBe(false);
    });

    it("grows a materialized folded class without closure conflicts", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "folded-shared" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "folded-company" },
      );
      await store.identity.assertSame(person, company);

      await store.nodes.Product.create(
        { name: "Alice Product", price: 1, category: "test" },
        { id: "folded-shared" },
      );

      expect(await store.identity.membersOf(person)).toEqual([
        { kind: "Company", id: "folded-company" },
        { kind: "Person", id: "folded-shared" },
        { kind: "Product", id: "folded-shared" },
      ]);
    });

    it("recreates tombstones through single and bulk create paths", async () => {
      const store = context.getStore();
      const originalValidFrom = "2020-01-01T00:00:00.000Z";
      const recreatedValidFrom = "2021-01-01T00:00:00.000Z";
      const recreatedValidTo = "2030-01-01T00:00:00.000Z";
      const singleOriginal = await store.nodes.Person.create(
        { name: "Single original" },
        { id: "single-recreate", validFrom: originalValidFrom },
      );
      await store.nodes.Person.delete(singleOriginal.id);

      const single = await store.nodes.Person.create(
        { name: "Single recreated" },
        {
          id: "single-recreate",
          validFrom: recreatedValidFrom,
          validTo: recreatedValidTo,
        },
      );
      expect(single.meta.validFrom).toBe(recreatedValidFrom);
      expect(single.meta.validTo).toBe(recreatedValidTo);

      const bulkOriginal = await store.nodes.Person.create(
        { name: "Bulk original" },
        { id: "bulk-recreate", validFrom: originalValidFrom },
      );
      const bulkAlias = await store.nodes.Company.create({
        name: "Bulk alias",
      });
      await store.identity.assertSame(bulkOriginal, bulkAlias);
      await store.nodes.Person.delete(bulkOriginal.id);
      const bulk = await store.nodes.Person.bulkCreate([
        {
          id: "bulk-recreate",
          props: { name: "Bulk recreated" },
          validFrom: recreatedValidFrom,
          validTo: recreatedValidTo,
        },
        { id: "bulk-new", props: { name: "Bulk new" } },
      ]);
      expect(bulk.map((node) => node.id)).toEqual([
        "bulk-recreate",
        "bulk-new",
      ]);
      expect(bulk[0]?.meta.validFrom).toBe(recreatedValidFrom);
      expect(bulk[0]?.meta.validTo).toBe(recreatedValidTo);
      expect(bulk[0]?.name).toBe("Bulk recreated");
      expect(await store.identity.assertionsOf(bulk[0]!)).toEqual([]);

      await store.nodes.Person.delete(bulk[1]!.id);
      await store.nodes.Person.bulkInsert([
        { id: "bulk-new", props: { name: "Bulk inserted again" } },
      ]);
      expect(
        await store.backend.getNode(store.graphId, "Person", "bulk-new"),
      ).toMatchObject({ deleted_at: undefined });
    });

    it("lifts different assertions to whole classes", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const alias = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "alice-company" },
      );
      const other = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await store.identity.assertSame(person, alias);
      await store.identity.assertDifferent(alias, other);

      expect(await store.identity.areDifferent(person, other)).toBe(true);
    });

    it("serializes opposing concurrent writers through one graph lock", async () => {
      const store = context.getStore();
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });

      const results = await Promise.allSettled([
        store.identity.assertSame(first, second),
        store.identity.assertDifferent(first, second),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        (await store.identity.areSame(first, second)) !==
          (await store.identity.areDifferent(first, second)),
      ).toBe(true);
    });

    it("runs eager bulk mutations once and reports identity write intents", async () => {
      const store = context.getStore();
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      const third = await store.nodes.Person.create({ name: "Third" });

      const outcome = await store.transactionWithReceipt(async (tx) => {
        const assertions = await tx.identity.bulkAssertSame([
          { a: first, b: second },
          { a: second, b: third },
        ]);
        await tx.identity.bulkRetractAssertions([assertions[0]!.id]);
      });

      expect(outcome.receipt.writes.identity).toEqual({
        sameAssertions: 2,
        differentAssertions: 0,
        retractions: 1,
        total: 3,
      });
      expect(outcome.receipt.writes.total).toBe(3);
    });

    it("supports symmetric bulk assertions and pair-based retractions", async () => {
      const store = context.getStore();
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      const third = await store.nodes.Person.create({ name: "Third" });
      const separate = await store.nodes.Person.create({ name: "Separate" });

      const same = await store.identity.bulkAssertSame([
        { a: first, b: second },
        { a: second, b: third },
      ]);
      expect(same.map((assertion) => assertion.relation)).toEqual([
        "same",
        "same",
      ]);
      expect(await store.identity.areSame(first, third)).toBe(true);

      const different = await store.identity.bulkAssertDifferent([
        { a: first, b: separate },
        { a: second, b: separate },
      ]);
      expect(different.map((assertion) => assertion.relation)).toEqual([
        "different",
        "different",
      ]);
      expect(await store.identity.areDifferent(third, separate)).toBe(true);

      await store.identity.retractDifferentAssertion(second, separate);
      expect(await store.identity.areDifferent(third, separate)).toBe(true);
      await store.identity.retractDifferentAssertion(first, separate);
      expect(await store.identity.areDifferent(third, separate)).toBe(false);

      await store.identity.retractSameAssertion(second, third);
      expect(await store.identity.areSame(first, third)).toBe(false);
      await store.identity.bulkRetractAssertions([same[0]!.id, same[0]!.id]);
      expect(await store.identity.areSame(first, second)).toBe(false);
    });

    it("makes current reads equal a valid-time view at now", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create({ name: "Alice" });
      const company = await store.nodes.Company.create({ name: "Alice LLC" });
      await store.identity.assertSame(person, company);
      const now = new Date().toISOString();

      expect(await store.asOf(now).identity.membersOf(person)).toEqual(
        await store.identity.membersOf(person),
      );

      const currentPeople = await store
        .query()
        .from("Person", "person")
        .select((queryContext) => queryContext.person.id)
        .execute();
      const asOfPeople = await store
        .asOf(now)
        .query()
        .from("Person", "person")
        .select((queryContext) => queryContext.person.id)
        .execute();
      expect(asOfPeople).toEqual(currentPeople);
    });

    it("conducts through a future-valid folded bridge and filters it at read time", async () => {
      const store = context.getStore();
      const seed = await store.nodes.Person.create(
        { name: "Seed" },
        { id: "seed" },
      );
      const bridgePerson = await store.nodes.Person.create(
        { name: "Future bridge" },
        { id: "bridge" },
      );
      await store.nodes.Company.create(
        { name: "Future bridge company" },
        {
          id: "bridge",
          validFrom: new Date(Date.now() + 60_000).toISOString(),
        },
      );
      const far = await store.nodes.Product.create(
        { name: "Far", price: 1, category: "test" },
        { id: "far" },
      );
      await store.identity.assertSame(seed, bridgePerson);
      await store.identity.assertSame({ kind: "Company", id: "bridge" }, far);

      expect(await store.identity.membersOf(seed)).toEqual([
        { kind: "Person", id: "bridge" },
        { kind: "Person", id: "seed" },
        { kind: "Product", id: "far" },
      ]);
    });

    it("uses code-point ordering for mixed-case and astral ids", async () => {
      const store = context.getStore();
      const upper = await store.nodes.Person.create(
        { name: "Upper" },
        { id: "A" },
      );
      const lower = await store.nodes.Person.create(
        { name: "Lower" },
        { id: "a" },
      );
      const astral = await store.nodes.Person.create(
        { name: "Astral" },
        { id: "😀" },
      );
      await store.identity.bulkAssertSame([
        { a: lower, b: astral },
        { a: upper, b: lower },
      ]);

      expect(await store.identity.membersOf(astral)).toEqual([
        { kind: "Person", id: "A" },
        { kind: "Person", id: "a" },
        { kind: "Person", id: "😀" },
      ]);
      expect(await store.identity.representativeOf(astral)).toEqual({
        kind: "Person",
        id: "A",
      });
    });

    it("reconstructs mixed explicit-folded-explicit chains on recorded time", async () => {
      const [store] = await createStoreWithSchema(
        context.getStore().graph,
        context.getStore().backend,
        { history: true },
      );
      const seed = await store.nodes.Person.create(
        { name: "Seed" },
        { id: "seed" },
      );
      const bridgePerson = await store.nodes.Person.create(
        { name: "Bridge" },
        { id: "bridge" },
      );
      const bridgeCompany = await store.nodes.Company.create(
        { name: "Bridge company" },
        { id: "bridge" },
      );
      const far = await store.nodes.Product.create(
        { name: "Far", price: 1, category: "test" },
        { id: "far" },
      );
      await store.identity.assertSame(seed, bridgePerson);
      await store.identity.assertSame(bridgeCompany, far);
      const beforeDelete = await store.recordedNow();
      expect(beforeDelete).toBeDefined();
      await store.nodes.Company.hardDelete(bridgeCompany.id);

      expect(await store.identity.areSame(seed, far)).toBe(false);
      expect(
        await store.asOfRecorded(beforeDelete!).identity.membersOf(seed),
      ).toEqual([
        { kind: "Company", id: "bridge" },
        { kind: "Person", id: "bridge" },
        { kind: "Person", id: "seed" },
        { kind: "Product", id: "far" },
      ]);
    });

    it("clears current and recorded identity state and remains reusable", async () => {
      const [store] = await createStoreWithSchema(
        context.getStore().graph,
        context.getStore().backend,
        { history: true },
      );
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "clear-fold" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "clear-fold" },
      );
      const product = await store.nodes.Product.create(
        { name: "Alice Product", price: 1, category: "test" },
        { id: "clear-product" },
      );
      await store.identity.assertSame(company, product);
      const beforeClear = await store.recordedNow();
      expect(beforeClear).toBeDefined();

      await store.clear();

      expect(await store.nodes.Person.getById(person.id)).toBeUndefined();
      expect(await store.identity.assertionsOf(person)).toEqual([]);
      expect(await store.identity.membersOf(person)).toEqual([]);
      expect(
        await store.asOfRecorded(beforeClear!).identity.membersOf(person),
      ).toEqual([]);

      const recreatedPerson = await store.nodes.Person.create(
        { name: "Recreated Alice" },
        { id: "clear-fold" },
      );
      await store.nodes.Company.create(
        { name: "Recreated Alice LLC" },
        { id: "clear-fold" },
      );
      expect(await store.identity.membersOf(recreatedPerson)).toEqual([
        { kind: "Company", id: "clear-fold" },
        { kind: "Person", id: "clear-fold" },
      ]);
    });

    it("records identity assertion removal when an extension kind is removed", async () => {
      const [store] = await createStoreWithSchema(
        context.getStore().graph,
        context.getStore().backend,
        { history: true },
      );
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: { Tag: { properties: { label: { type: "string" } } } },
        }),
      );
      const person = await evolved.nodes.Person.create({ name: "Alice" });
      const tag = await evolved.getNodeCollectionOrThrow("Tag").create({
        label: "author",
      });
      await evolved.identity.assertSame(person, tag as never);
      const beforeRemoval = await evolved.recordedNow();
      expect(beforeRemoval).toBeDefined();

      const removed = await evolved.removeKinds(["Tag"]);
      const afterRemoval = await removed.recordedNow();
      expect(afterRemoval).toBeDefined();

      expect(await removed.identity.assertionsOf(person)).toEqual([]);
      expect(
        await removed
          .asOfRecorded(beforeRemoval!)
          .identity.assertionsOf(person),
      ).toHaveLength(1);
      expect(
        await removed.asOfRecorded(afterRemoval!).identity.assertionsOf(person),
      ).toEqual([]);
    });

    it("detaches on delete, does not revive assertions, and folds on recreate", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "company" },
      );
      await store.identity.assertSame(person, company);
      await store.nodes.Person.delete(person.id);
      const recreated = await store.nodes.Person.create(
        { name: "Alice Again" },
        { id: "alice" },
      );

      expect(await store.identity.assertionsOf(recreated)).toEqual([]);
      expect(await store.identity.membersOf(recreated)).toEqual([
        { kind: "Person", id: "alice" },
      ]);
    });

    it("repairs corrupted derived closure without changing truth", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create({ name: "Alice" });
      const company = await store.nodes.Company.create({ name: "Alice LLC" });
      const assertion = await store.identity.assertSame(person, company);
      const schema = createSqlSchema(store.backend.tableNames);
      if (store.backend.executeStatement === undefined) {
        throw new Error("Integration backend cannot corrupt derived closure");
      }
      await store.backend.executeStatement(
        asCompiledStatementSql(sql`
          DELETE FROM ${schema.identityClosureTable}
          WHERE graph_id = ${store.graphId}
        `),
      );
      expect(await store.identity.areSame(person, company)).toBe(false);

      await rebuildIdentityClosure(store);

      expect(await store.identity.areSame(person, company)).toBe(true);
      expect(await store.identity.assertionsOf(person)).toEqual([assertion]);
    });
  });
}
