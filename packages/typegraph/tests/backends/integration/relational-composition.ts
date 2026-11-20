import { describe, expect, it, vi } from "vitest";

import { ConfigurationError, count, expr, field } from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

export function registerRelationalCompositionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Relational composition", () => {
    it.each(["aggregate", "project"] as const)(
      "preserves distinct input rows before grouped %s",
      async (operation) => {
        const store = context.getStore();
        for (const name of ["Ada", "Ada", "Bea"])
          await store.nodes.Person.create({ name });
        const names = store
          .query()
          .from("Person", "person")
          .project((fields) => ({ name: fields.person.name }))
          .asRelation();

        expect(
          await names
            .distinct()
            .groupBy((columns) => [columns.name])
            [operation]((columns) => ({
              name: columns.name,
              count: expr.count(),
            }))
            .orderBy((columns) => columns.name)
            .execute(),
        ).toEqual([
          { name: "Ada", count: 1 },
          { name: "Bea", count: 1 },
        ]);
      },
    );

    it.each(["aggregate", "project"] as const)(
      "preserves filtered, ordered and ranged input before grouped %s",
      async (operation) => {
        const store = context.getStore();
        for (const person of [
          { name: "Ada", age: 10 },
          { name: "Ada", age: 20 },
          { name: "Bea", age: 30 },
          { name: "Cara", age: 40 },
          { name: "Excluded", age: 50 },
        ])
          await store.nodes.Person.create(person);
        const people = store
          .query()
          .from("Person", "person")
          .project((fields) => ({
            name: fields.person.name,
            age: fields.person.age,
          }))
          .asRelation();
        const grouped = people
          .where((columns) => expr.neq(columns.name, expr.literal("Excluded")))
          .orderBy((columns) => columns.age, "desc")
          .offset(1)
          .limit(1)
          .groupBy((columns) => [columns.name]);

        expect(
          await grouped[operation]((columns) => ({
            name: columns.name,
            count: expr.count(),
          }))
            .orderBy((columns) => columns.name)
            .execute(),
        ).toEqual([{ name: "Bea", count: 1 }]);
        expect(
          await grouped
            .limit(0)
            [operation]((columns) => ({
              name: columns.name,
              count: expr.count(),
            }))
            .execute(),
        ).toEqual([]);
      },
    );

    it("accumulates repeated relation grouping without changing earlier builders", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 20 },
        { name: "Ada", age: 30 },
        { name: "Bea", age: 20 },
      ])
        await store.nodes.Person.create(person);
      const byName = store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          name: fields.person.name,
          age: fields.person.age,
        }))
        .asRelation()
        .groupBy((columns) => [columns.name]);

      expect(
        await byName
          .groupBy((columns) => [columns.age])
          .aggregate((columns) => ({
            name: columns.name,
            age: columns.age,
            count: expr.count(),
          }))
          .orderBy((columns) => columns.name)
          .orderBy((columns) => columns.age)
          .execute(),
      ).toEqual([
        { name: "Ada", age: 20, count: 1 },
        { name: "Ada", age: 30, count: 1 },
        { name: "Bea", age: 20, count: 1 },
      ]);
      expect(
        await byName
          .aggregate((columns) => ({ name: columns.name, count: expr.count() }))
          .orderBy((columns) => columns.name)
          .execute(),
      ).toEqual([
        { name: "Ada", count: 2 },
        { name: "Bea", count: 1 },
      ]);
    });

    it("carries source ordering and refuses hidden-order distinctness or mapped SQL input", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Ada", age: 20 });
      await store.nodes.Person.create({ name: "Ada", age: 30 });
      const projection = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }));
      const byAge = projection
        .orderBy((fields) => fields.person.age)
        .asRelation();
      expect(() => byAge.distinct()).toThrow(ConfigurationError);
      expect(
        await projection
          .orderBy((fields) => fields.person.name)
          .asRelation()
          .distinct()
          .count(),
      ).toBe(1);
      expect(() =>
        projection
          .map((row) => row)
          .asRelation()
          .project((columns) => ({ name: columns.name })),
      ).toThrow(ConfigurationError);
      expect(await projection.limit(0).asRelation().first()).toBeUndefined();
    });

    it("refuses nongrouped projected values before database execution", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Ada", age: 20 });
      const rows = store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          name: fields.person.name,
          age: fields.person.age,
        }))
        .asRelation();
      await expect(
        rows
          .aggregate((columns) => ({ name: columns.name, count: expr.count() }))
          .execute(),
      ).rejects.toThrow(ConfigurationError);
      await expect(
        rows
          .groupBy((columns) => [columns.name])
          .aggregate((columns) => ({
            name: columns.name,
            age: columns.age,
            count: expr.count(),
          }))
          .execute(),
      ).rejects.toThrow(ConfigurationError);
    });

    it("preserves distinct and limited input stages before a new projection", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 20 },
        { name: "Ada", age: 30 },
        { name: "Bea", age: 40 },
      ])
        await store.nodes.Person.create(person);
      const rows = store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          name: fields.person.name,
          age: fields.person.age,
        }))
        .asRelation();
      expect(
        await rows
          .distinct()
          .project((columns) => ({ name: columns.name }))
          .count(),
      ).toBe(3);
      expect(
        await rows
          .orderBy((columns) => columns.age, "desc")
          .limit(1)
          .project((columns) => ({ name: columns.name }))
          .execute(),
      ).toEqual([{ name: "Bea" }]);
      expect(() =>
        rows.map((row) => row).project((columns) => ({ name: columns.name })),
      ).toThrow(ConfigurationError);
    });

    it("uses common terminals, preparation and ordered batching for legacy aggregates", async () => {
      const store = context.getStore();
      for (const name of ["Ada", "Ada", "Bea"])
        await store.nodes.Person.create({ name });
      const parameters = { excluded: expr.param("excluded", "string") };
      const groups = store
        .query()
        .from("Person", "person")
        .whereNode("person", (_person, fields) =>
          expr.neq(fields.person.name, parameters.excluded),
        )
        .groupBy("person", "name")
        .aggregate({ name: field("person", "name"), total: count("person") })
        .orderBy("name", "desc");
      const prepared = groups.prepare(parameters);
      expect(await prepared.execute({ excluded: "Nobody" })).toEqual([
        { name: "Bea", total: 1 },
        { name: "Ada", total: 2 },
      ]);
      const bound = prepared.bind({ excluded: "Nobody" });
      expect(await bound.count()).toBe(2);
      expect(await bound.first()).toEqual({ name: "Bea", total: 1 });
      expect(await store.batchOnce(() => [bound] as const)).toEqual([
        [
          { name: "Bea", total: 1 },
          { name: "Ada", total: 2 },
        ],
      ]);
    });

    it("deduplicates proven node identities and refuses representative payloads", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Ada" });
      const bob = await store.nodes.Person.create({ name: "Bea" });
      const cara = await store.nodes.Person.create({ name: "Cara" });
      await store.edges.knows.create(alice, bob, {});
      await store.edges.knows.create(alice, cara, {});
      const matches = store
        .query()
        .from("Person", "person")
        .traverse("knows", "edge")
        .to("Person", "friend");
      const identities = matches
        .project((fields) => ({
          kind: fields.person.kind,
          id: fields.person.id,
        }))
        .asRelation();
      expect(await identities.count()).toBe(2);
      expect(
        await identities.distinctNodes({ kind: "kind", id: "id" }).execute(),
      ).toEqual([{ kind: "Person", id: alice.id }]);
      const withPayload = matches
        .project((fields) => ({
          kind: fields.person.kind,
          id: fields.person.id,
          friend: fields.friend.name,
        }))
        .asRelation();
      expect(() =>
        withPayload.distinctNodes({ kind: "kind", id: "id" }),
      ).toThrow(ConfigurationError);
      const invented = matches
        .project((fields) => ({
          kind: fields.person.name,
          id: fields.friend.name,
        }))
        .asRelation()
        .project((columns) => ({ kind: columns.kind, id: columns.id }));
      expect(() => invented.distinctNodes({ kind: "kind", id: "id" })).toThrow(
        ConfigurationError,
      );
      const unproven = matches
        .project(() => ({
          kind: expr.literal("Person" as const),
          id: expr.literal(alice.id),
        }))
        .asRelation();
      expect(() =>
        identities.union(unproven).distinctNodes({ kind: "kind", id: "id" }),
      ).toThrow(ConfigurationError);
    });

    it("pages and streams only relations with a proven unique output order", async () => {
      const store = context.getStore();
      for (const name of ["Ada", "Ada", "Bea", "Cara"])
        await store.nodes.Person.create({ name });
      const rows = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }))
        .asRelation();
      const ordered = rows.distinct().orderBy((columns) => columns.name);
      expect(await ordered.page({ limit: 1, offset: 1 })).toEqual([
        { name: "Bea" },
      ]);
      const streamed: unknown[] = [];
      for await (const row of ordered.stream({ pageSize: 1 }))
        streamed.push(row);
      expect(streamed).toEqual([
        { name: "Ada" },
        { name: "Bea" },
        { name: "Cara" },
      ]);
      await expect(
        rows.orderBy((columns) => columns.name).page({ limit: 1 }),
      ).rejects.toThrow(ConfigurationError);
      await expect(rows.distinct().page({ limit: 1 })).rejects.toThrow(
        ConfigurationError,
      );
      await expect(ordered.page({ limit: 0 })).rejects.toThrow();
    });

    it("refuses incompatible temporal pins, mapped operands, and unbound execution", async () => {
      const store = context.getStore();
      const current = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }))
        .asRelation();
      const historical = store
        .asOf("2025-01-01T00:00:00.000Z")
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }))
        .asRelation();
      expect(() => current.union(historical)).toThrow(ConfigurationError);
      expect(() => current.map((row) => row).union(current)).toThrow(
        ConfigurationError,
      );
      const unbound = current.where((columns) =>
        expr.eq(columns.name, expr.param("name", "string")),
      );
      await expect(unbound.execute()).rejects.toThrow();
      await expect(unbound.count()).rejects.toThrow();
    });

    it("groups derived columns, accumulates filters, and quotes output names", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 20 },
        { name: "Ada", age: 40 },
        { name: "Bea", age: 60 },
      ])
        await store.nodes.Person.create(person);
      const rows = store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          displayName: fields.person.name,
          age: fields.person.age,
        }))
        .asRelation();
      expect(
        await rows
          .where((columns) => expr.lt(columns.age, expr.literal(50)))
          .where((columns) => expr.gt(columns.age, expr.literal(30)))
          .project((columns) => ({ outputName: columns.displayName }))
          .orderBy((columns) => columns.outputName)
          .execute(),
      ).toEqual([{ outputName: "Ada" }]);
      expect(
        await rows
          .groupBy((columns) => [columns.displayName])
          .aggregate((columns) => ({
            name: columns.displayName,
            total: expr.sum(columns.age),
          }))
          .orderBy((columns) => columns.name)
          .execute(),
      ).toEqual([
        { name: "Ada", total: 60 },
        { name: "Bea", total: 60 },
      ]);
    });

    it("preserves prepared and mapped output ordering in batched envelopes", async () => {
      const store = context.getStore();
      for (const name of ["Ada", "Bea"])
        await store.nodes.Person.create({ name });
      const rows = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }))
        .asRelation()
        .orderBy((columns) => columns.name, "desc");
      expect(
        await store.batchOnce(
          () => [rows.prepare().bind({}), rows.map((row) => row.name)] as const,
        ),
      ).toEqual([
        [{ name: "Bea" }, { name: "Ada" }],
        ["Bea", "Ada"],
      ]);
    });

    it("combines visible projections, orders duplicate keys, and limits the union", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Ada", age: 20 });
      await store.nodes.Person.create({ name: "Ada", age: 40 });
      await store.nodes.Person.create({ name: "Bea", age: 20 });
      const names = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }))
        .asRelation();
      expect(
        await names
          .union(names)
          .orderBy((columns) => columns.name)
          .execute(),
      ).toEqual([{ name: "Ada" }, { name: "Bea" }]);
      expect(await names.unionAll(names).count()).toBe(6);
      expect(
        await names
          .union(names)
          .orderBy((columns) => columns.name)
          .offset(1)
          .limit(1)
          .execute(),
      ).toEqual([{ name: "Bea" }]);
      expect(await names.intersect(names).count()).toBe(2);
      expect(await names.except(names).exists()).toBe(false);
    });

    it("filters aggregate results and aggregates them again", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 10 },
        { name: "Ada", age: 20 },
        { name: "Bea", age: 40 },
      ])
        await store.nodes.Person.create(person);
      const totals = store
        .query()
        .from("Person", "person")
        .groupBy((fields) => [fields.person.name])
        .aggregate((fields) => ({
          name: fields.person.name,
          total: expr.sum(fields.person.age),
        }))
        .asRelation();
      expect(
        await totals
          .where((columns) => expr.gt(columns.total, expr.literal(30)))
          .execute(),
      ).toEqual([{ name: "Bea", total: 40 }]);
      expect(
        await totals
          .aggregate((columns) => ({ total: expr.sum(columns.total) }))
          .execute(),
      ).toEqual([{ total: 70 }]);
      expect(
        await totals
          .where((columns) => expr.gt(columns.total, expr.literal(100)))
          .count(),
      ).toBe(0);
    });

    it("deduplicates whole rows before limits and counts without running mappers", async () => {
      const store = context.getStore();
      for (const name of ["Ada", "Ada", "Bea"])
        await store.nodes.Person.create({ name });
      const mapper = vi.fn((row: { name: string }) => row.name);
      const names = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ name: fields.person.name }))
        .asRelation();
      expect(await names.limit(2).distinct().count()).toBe(2);
      expect(
        await names
          .distinct()
          .orderBy((columns) => columns.name)
          .offset(1)
          .first(),
      ).toEqual({ name: "Bea" });
      expect(await names.distinct().map(mapper).count()).toBe(2);
      expect(mapper).not.toHaveBeenCalled();
      expect(await names.limit(0).first()).toBeUndefined();
    });

    it("preserves NULL ordering and projection decoding through derived stages", async () => {
      const store = context.getStore();
      const publishedAt = new Date("2025-01-02T00:00:00Z");
      await store.nodes.Document.create({
        title: "Present",
        publishedAt,
        metadata: { flags: { published: true } },
      });
      await store.nodes.Document.create({ title: "Absent" });
      const documents = store
        .query()
        .from("Document", "document")
        .project((fields) => ({
          title: fields.document.title,
          date: fields.document.publishedAt,
          metadata: fields.document.metadata,
        }))
        .asRelation();
      expect(
        await documents
          .orderBy((columns) => columns.date, "asc", "first")
          .execute(),
      ).toEqual([
        { title: "Absent", date: undefined, metadata: undefined },
        {
          title: "Present",
          date: publishedAt,
          metadata: { flags: { published: true } },
        },
      ]);
    });

    it("prepares parameters across both set operands and a derived predicate", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 20 },
        { name: "Bea", age: 40 },
      ])
        await store.nodes.Person.create(person);
      const parameters = {
        minimum: expr.param("minimum", "number"),
        maximum: expr.param("maximum", "number"),
        excluded: expr.param("excluded", "string"),
      };
      const young = store
        .query()
        .from("Person", "person")
        .whereNode("person", (_person, fields) =>
          expr.lt(fields.person.age, parameters.maximum),
        )
        .project((fields) => ({ name: fields.person.name }))
        .asRelation();
      const old = store
        .query()
        .from("Person", "person")
        .whereNode("person", (_person, fields) =>
          expr.gt(fields.person.age, parameters.minimum),
        )
        .project((fields) => ({ name: fields.person.name }))
        .asRelation();
      const prepared = young
        .union(old)
        .where((columns) => expr.neq(columns.name, parameters.excluded))
        .orderBy((columns) => columns.name)
        .prepare(parameters);
      expect(
        await prepared.execute({ minimum: 30, maximum: 30, excluded: "Bea" }),
      ).toEqual([{ name: "Ada" }]);
      const bound = prepared.bind({
        minimum: 30,
        maximum: 30,
        excluded: "Ada",
      });
      expect(await store.batchOnce(() => [bound] as const)).toEqual([
        [{ name: "Bea" }],
      ]);
    });

    it("batches derived queries in one statement with independent result order", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 20 },
        { name: "Bea", age: 40 },
      ])
        await store.nodes.Person.create(person);
      const rows = store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          name: fields.person.name,
          age: fields.person.age,
        }))
        .asRelation();
      const execute = vi.spyOn(context.getBackend(), "execute");
      execute.mockClear();
      expect(
        await store.batchOnce(
          () =>
            [
              rows.orderBy((columns) => columns.name, "desc"),
              rows.where((columns) => expr.gt(columns.age, expr.literal(30))),
            ] as const,
        ),
      ).toEqual([
        [
          { name: "Bea", age: 40 },
          { name: "Ada", age: 20 },
        ],
        [{ name: "Bea", age: 40 }],
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("rejects incompatible set columns and captured relation scopes", () => {
      const store = context.getStore();
      const names = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ value: fields.person.name }))
        .asRelation();
      const ages = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ value: fields.person.age }))
        .asRelation();
      // @ts-expect-error Set operands have incompatible output types.
      expect(() => names.union(ages)).toThrow(ConfigurationError);
      let captured:
        Parameters<Parameters<typeof names.where>[0]>[0]["value"] | undefined;
      names.where((columns) => {
        captured = columns.value;
        return expr.eq(columns.value, expr.literal("Ada"));
      });
      const other = store
        .query()
        .from("Person", "person")
        .project((fields) => ({ value: fields.person.name }))
        .asRelation();
      expect(() =>
        other.where(() =>
          expr.eq(requireDefined(captured), expr.literal("Ada")),
        ),
      ).toThrow();
    });

    it("selects exactly two rows per interleaved partition with deterministic ties", async () => {
      const store = context.getStore();
      for (const product of [
        { name: "a-low", category: "A", price: 10 },
        { name: "b-high", category: "B", price: 90 },
        { name: "a-tie-1", category: "A", price: 80 },
        { name: "b-low", category: "B", price: 20 },
        { name: "a-tie-2", category: "A", price: 80 },
        { name: "a-tie-3", category: "A", price: 80 },
        { name: "b-mid", category: "B", price: 50 },
        { name: "a-mid", category: "A", price: 40 },
      ])
        await store.nodes.Product.create(product);
      const products = store
        .query()
        .from("Product", "product")
        .project((fields) => ({
          category: fields.product.category,
          name: fields.product.name,
          price: fields.product.price,
        }))
        .asRelation();
      expect(
        await products
          .topPerPartition({
            partitionBy: (columns) => [columns.category],
            orderBy: (columns) => [
              { expression: columns.price, direction: "desc" },
              { expression: columns.name },
            ],
            limit: 2,
          })
          .orderBy((columns) => columns.category)
          .orderBy((columns) => columns.name)
          .execute(),
      ).toEqual([
        { category: "A", name: "a-tie-1", price: 80 },
        { category: "A", name: "a-tie-2", price: 80 },
        { category: "B", name: "b-high", price: 90 },
        { category: "B", name: "b-mid", price: 50 },
      ]);
      expect(
        await products
          .topPerPartition({
            partitionBy: (columns) => [columns.category],
            orderBy: (columns) => [
              { expression: columns.price, direction: "desc" },
              { expression: columns.name },
            ],
            limit: 2,
          })
          .orderBy((columns) => columns.category)
          .orderBy((columns) => columns.name)
          .offset(1)
          .limit(1)
          .execute(),
      ).toEqual([{ category: "A", name: "a-tie-2", price: 80 }]);
    });

    it("deduplicates before ranking and treats absent partition keys as one partition", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: undefined },
        { name: "Ada", age: undefined },
        { name: "Bea", age: undefined },
        { name: "Cara", age: 20 },
        { name: "Dana", age: 20 },
      ])
        await store.nodes.Person.create(person);
      const people = store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          name: fields.person.name,
          age: fields.person.age,
        }))
        .asRelation();
      expect(
        await people
          .distinct()
          .topPerPartition({
            partitionBy: (columns) => [columns.age],
            orderBy: (columns) => [{ expression: columns.name }],
            limit: 2,
          })
          .orderBy((columns) => columns.name)
          .execute(),
      ).toEqual([
        { name: "Ada", age: undefined },
        { name: "Bea", age: undefined },
        { name: "Cara", age: 20 },
        { name: "Dana", age: 20 },
      ]);
    });

    it("ranks the filtered and ranged source, then filters winners without replacement", async () => {
      const store = context.getStore();
      for (const product of [
        { name: "a-100", category: "A", price: 100 },
        { name: "a-90", category: "A", price: 90 },
        { name: "a-80", category: "A", price: 80 },
        { name: "b-100", category: "B", price: 100 },
        { name: "b-90", category: "B", price: 90 },
        { name: "b-80", category: "B", price: 80 },
      ])
        await store.nodes.Product.create(product);
      const products = store
        .query()
        .from("Product", "product")
        .project((fields) => ({
          category: fields.product.category,
          name: fields.product.name,
          price: fields.product.price,
        }))
        .asRelation();
      const top = products
        .where((columns) => expr.lt(columns.price, expr.literal(100)))
        .topPerPartition({
          partitionBy: (columns) => [columns.category],
          orderBy: (columns) => [
            { expression: columns.price, direction: "desc" },
          ],
          limit: 1,
        });
      expect(
        await top.orderBy((columns) => columns.category).execute(),
      ).toEqual([
        { category: "A", name: "a-90", price: 90 },
        { category: "B", name: "b-90", price: 90 },
      ]);
      expect(
        await top
          .where((columns) => expr.lt(columns.price, expr.literal(90)))
          .execute(),
      ).toEqual([]);
      expect(
        await products
          .orderBy((columns) => columns.name)
          .offset(2)
          .limit(2)
          .topPerPartition({
            partitionBy: (columns) => [columns.category],
            orderBy: (columns) => [{ expression: columns.price }],
            limit: 2,
          })
          .orderBy((columns) => columns.name)
          .execute(),
      ).toEqual([
        { category: "A", name: "a-90", price: 90 },
        { category: "B", name: "b-100", price: 100 },
      ]);
    });

    it("preserves decoded values after ranking nullable dates", async () => {
      const store = context.getStore();
      const publishedAt = new Date("2025-02-01T00:00:00.000Z");
      await store.nodes.Document.create({ title: "Guide" });
      await store.nodes.Document.create({
        title: "Guide",
        publishedAt,
        metadata: { flags: { published: true } },
      });
      const documents = store
        .query()
        .from("Document", "document")
        .project((fields) => ({
          title: fields.document.title,
          date: fields.document.publishedAt,
          metadata: fields.document.metadata,
          label: fields.document.title,
        }))
        .asRelation();
      expect(
        await documents
          .topPerPartition({
            partitionBy: (columns) => [columns.title],
            orderBy: (columns) => [
              { expression: columns.date, direction: "desc", nulls: "last" },
            ],
            limit: 1,
          })
          .execute(),
      ).toEqual([
        {
          title: "Guide",
          date: publishedAt,
          metadata: { flags: { published: true } },
          label: "Guide",
        },
      ]);
    });

    it("keeps visible rank-like relation columns while choosing a hidden rank name", async () => {
      const store = context.getStore();
      for (const product of [
        { name: "a-low", category: "A", price: 10 },
        { name: "a-high", category: "A", price: 20 },
        { name: "b-high", category: "B", price: 30 },
      ])
        await store.nodes.Product.create(product);
      const ranked = store
        .query()
        .from("Product", "product")
        .project((fields) => ({
          category: fields.product.category,
          name: fields.product.name,
          price: fields.product.price,
        }))
        .asRelation()
        .project((columns) => ({
          category: columns.category,
          __tg_partition_rank: columns.price,
          __tg_partition_rank_: columns.name,
          __TG_PARTITION_RANK__: columns.price,
        }))
        .topPerPartition({
          partitionBy: (columns) => [columns.category],
          orderBy: (columns) => [
            { expression: columns.__tg_partition_rank, direction: "desc" },
          ],
          limit: 1,
        })
        .orderBy((columns) => columns.category);
      expect(await ranked.execute()).toEqual([
        {
          category: "A",
          __tg_partition_rank: 20,
          __tg_partition_rank_: "a-high",
          __TG_PARTITION_RANK__: 20,
        },
        {
          category: "B",
          __tg_partition_rank: 30,
          __tg_partition_rank_: "b-high",
          __TG_PARTITION_RANK__: 30,
        },
      ]);
    });

    it("composes ranking with preparation, batching, set operands and later stages", async () => {
      const store = context.getStore();
      for (const product of [
        { name: "a-10", category: "A", price: 10 },
        { name: "a-20", category: "A", price: 20 },
        { name: "b-10", category: "B", price: 10 },
        { name: "b-20", category: "B", price: 20 },
      ])
        await store.nodes.Product.create(product);
      const minimum = expr.param("minimum", "number");
      const rows = store
        .query()
        .from("Product", "product")
        .project((fields) => ({
          category: fields.product.category,
          name: fields.product.name,
          price: fields.product.price,
        }))
        .asRelation()
        .where((columns) => expr.gt(columns.price, minimum))
        .topPerPartition({
          partitionBy: (columns) => [columns.category],
          orderBy: (columns) => [
            { expression: columns.price, direction: "desc" },
          ],
          limit: 1,
        })
        .orderBy((columns) => columns.category);
      const prepared = rows.prepare({ minimum });
      expect(await prepared.execute({ minimum: 0 })).toEqual([
        { category: "A", name: "a-20", price: 20 },
        { category: "B", name: "b-20", price: 20 },
      ]);
      const bound = prepared.bind({ minimum: 0 });
      expect(await store.batchOnce(() => [bound, bound] as const)).toEqual([
        [
          { category: "A", name: "a-20", price: 20 },
          { category: "B", name: "b-20", price: 20 },
        ],
        [
          { category: "A", name: "a-20", price: 20 },
          { category: "B", name: "b-20", price: 20 },
        ],
      ]);
      expect(
        await rows
          .unionAll(rows)
          .orderBy((columns) => columns.category)
          .prepare({ minimum })
          .execute({ minimum: 0 }),
      ).toEqual([
        { category: "A", name: "a-20", price: 20 },
        { category: "A", name: "a-20", price: 20 },
        { category: "B", name: "b-20", price: 20 },
        { category: "B", name: "b-20", price: 20 },
      ]);
    });

    it("binds parameters used inside partition and ranking expressions", async () => {
      const store = context.getStore();
      for (const product of [
        { name: "a-10", category: "A", price: 10 },
        { name: "a-20", category: "A", price: 20 },
        { name: "b-30", category: "B", price: 30 },
      ])
        await store.nodes.Product.create(product);
      const fallback = expr.param("fallback", "string");
      const offset = expr.param("offset", "number");
      const rows = store
        .query()
        .from("Product", "product")
        .project((fields) => ({
          category: fields.product.category,
          name: fields.product.name,
          price: fields.product.price,
        }))
        .asRelation()
        .topPerPartition({
          partitionBy: (columns) => [expr.coalesce(columns.category, fallback)],
          orderBy: (columns) => [
            { expression: expr.add(columns.price, offset), direction: "desc" },
          ],
          limit: 1,
        })
        .orderBy((columns) => columns.category)
        .prepare({ fallback, offset });
      expect(await rows.execute({ fallback: "unused", offset: 5 })).toEqual([
        { category: "A", name: "a-20", price: 20 },
        { category: "B", name: "b-30", price: 30 },
      ]);
    });

    it("rejects invalid ranking inputs and captured scopes", () => {
      const store = context.getStore();
      const rows = store
        .query()
        .from("Product", "product")
        .project((fields) => ({
          category: fields.product.category,
          price: fields.product.price,
        }))
        .asRelation();
      const valid = {
        partitionBy: (
          columns: Parameters<Parameters<typeof rows.where>[0]>[0],
        ) => [columns.category] as const,
        orderBy: (columns: Parameters<Parameters<typeof rows.where>[0]>[0]) =>
          [{ expression: columns.price }] as const,
        limit: 1,
      };
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
        expect(() => rows.topPerPartition({ ...valid, limit })).toThrow(
          ConfigurationError,
        );
      expect(() => {
        // @ts-expect-error Empty partition keys are rejected statically and at runtime.
        rows.topPerPartition({ ...valid, partitionBy: () => [] });
      }).toThrow(ConfigurationError);
      expect(() => {
        // @ts-expect-error Empty order keys are rejected statically and at runtime.
        rows.topPerPartition({ ...valid, orderBy: () => [] });
      }).toThrow(ConfigurationError);
      let captured: ReturnType<typeof valid.partitionBy>[0] | undefined;
      rows.topPerPartition({
        ...valid,
        partitionBy: (columns) => {
          captured = columns.category;
          return [columns.category] as const;
        },
      });
      const other = store
        .query()
        .from("Product", "product")
        .project((fields) => ({
          category: fields.product.category,
          price: fields.product.price,
        }))
        .asRelation();
      expect(() =>
        other.topPerPartition({
          ...valid,
          partitionBy: () => [requireDefined(captured)],
        }),
      ).toThrow(ConfigurationError);
      expect(() => {
        // @ts-expect-error Unknown options are rejected at the public type boundary.
        rows.topPerPartition({ ...valid, unsupported: true });
      }).toThrow(ConfigurationError);
      expect(() => rows.map((row) => row).topPerPartition(valid)).toThrow(
        ConfigurationError,
      );
      expect(() =>
        rows.groupBy((columns) => [columns.category]).topPerPartition(valid),
      ).toThrow(ConfigurationError);
    });
  });
}
