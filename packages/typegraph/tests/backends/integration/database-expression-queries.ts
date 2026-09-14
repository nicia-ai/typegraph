import { describe, expect, it } from "vitest";

import { countDistinct, expr, SchemaChangedError } from "../../../src";
import type { IntegrationTestContext } from "./test-context";

export function registerDatabaseExpressionQueryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Database expression queries", () => {
    it("executes projections on the transaction supplied by sequential batch", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Batch person", age: 25 });
      const names = store
        .query()
        .from("Person", "person")
        .project((expressions) => ({ name: expressions.person.name }));
      const ages = store
        .query()
        .from("Person", "person")
        .project((expressions) => ({ age: expressions.person.age }));
      expect(await store.batch(names, ages)).toEqual([
        [{ name: "Batch person" }],
        [{ age: 25 }],
      ]);
    });
    it("preserves computed ordering and stale-schema checks in checked projections", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Young", age: 19 });
      await store.nodes.Person.create({ name: "Old", age: 35 });
      const activeSchema = await context
        .getBackend()
        .getActiveSchema(store.graphId);
      const version = activeSchema?.version;
      await store.withCheckedReads(version, async (reads) => {
        const query = reads
          .query()
          .from("Person", "person")
          .project((expression) => ({ name: expression.person.name }))
          .orderBy(
            (expression) => expr.add(expression.person.age, expr.literal(1)),
            "desc",
          );
        expect(await query.execute()).toEqual([
          { name: "Old" },
          { name: "Young" },
        ]);
        expect(await query.offset(1).first()).toEqual({ name: "Young" });
        expect(await query.count()).toBe(2);
        expect(await query.limit(0).exists()).toBe(false);
      });
      await expect(
        store.withCheckedReads((version ?? 0) + 1, async (reads) =>
          reads
            .query()
            .from("Person", "person")
            .project((expression) => ({ name: expression.person.name }))
            .execute(),
        ),
      ).rejects.toBeInstanceOf(SchemaChangedError);
    });
    it("filters, orders, and projects typed scalar expressions", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({
        age: 17,
        isActive: true,
        name: "Minor",
      });
      await store.nodes.Person.create({
        age: 42,
        isActive: false,
        name: "Older",
      });
      await store.nodes.Person.create({
        age: 21,
        isActive: true,
        name: "Adult",
      });

      const rows = await store
        .query()
        .from("Person", "person")
        .whereNode("person", (_person, expressions) =>
          expr.and(
            expr.gte(expressions.person.age, expr.literal(18)),
            expr.eq(expressions.person.isActive, expr.literal(true)),
          ),
        )
        .project((expressions) => ({
          ageNextYear: expr.add(expressions.person.age, expr.literal(1)),
          name: expressions.person.name,
        }))
        .orderBy((expressions) => expressions.person.age, "desc")
        .execute();

      expect(rows).toEqual([{ ageNextYear: 22, name: "Adult" }]);
    });

    it("preserves null, date, Boolean, and JSON projection semantics", async () => {
      const store = context.getStore();
      const publishedAt = new Date("2025-04-03T02:01:00.000Z");
      await store.nodes.Document.create({
        metadata: {
          author: "Ada",
          flags: { published: true },
          node: "declared node property",
        },
        publishedAt,
        title: "Typed document",
      });

      const [row] = await store
        .query()
        .from("Document", "document")
        .project((expressions) => ({
          author: expressions.document.metadata.author,
          metadata: expressions.document.metadata,
          metadataNode: expressions.document.metadata.$get("node"),
          missingReviewer: expr.isNull(expressions.document.metadata.reviewer),
          published: expressions.document.metadata.flags.published,
          publishedAt: expressions.document.publishedAt,
        }))
        .execute();

      expect(row).toEqual({
        author: "Ada",
        metadata: {
          author: "Ada",
          flags: { published: true },
          node: "declared node property",
        },
        metadataNode: "declared node property",
        missingReviewer: true,
        published: true,
        publishedAt,
      });
    });

    it("uses portable division-by-zero and numeric-conversion semantics", async () => {
      const store = context.getStore();
      await store.nodes.Product.create({
        category: "valid",
        name: "12.5",
        price: 25,
      });
      await store.nodes.Product.create({
        category: "invalid",
        name: "not a decimal",
        price: 10,
      });

      const rows = await store
        .query()
        .from("Product", "product")
        .project((expressions) => ({
          category: expressions.product.category,
          converted: expr.toNumber(expressions.product.name),
          dividedByZero: expr.divide(
            expressions.product.price,
            expr.literal(0),
          ),
        }))
        .orderBy((expressions) => expressions.product.category)
        .execute();

      expect(rows).toEqual([
        { category: "invalid", converted: undefined, dividedByZero: undefined },
        { category: "valid", converted: 12.5, dividedByZero: undefined },
      ]);
    });

    it("applies the portable numeric conversion grammar", async () => {
      const store = context.getStore();
      const samples = [
        ["plus", "+1", undefined],
        ["leading-dot", ".5", undefined],
        ["leading-zero", "01", undefined],
        ["trailing-dot", "1.", undefined],
        ["comma", "1,2", undefined],
        ["long-exponent", "1e999999", undefined],
        ["overflow", "1e309", undefined],
        ["underflow", "1e-999", 0],
        ["minimum-subnormal", "3e-324", Number.MIN_VALUE],
        ["maximum-finite", "1.7976931348623158e308", Number.MAX_VALUE],
        ["maximum-finite-precise", "1.79769313486231580e308", Number.MAX_VALUE],
        ["overflow-midpoint", "1.79769313486231581e308", undefined],
        ["overflow-near-boundary", "1.79769313486231584e308", undefined],
        ["overflow-above-boundary", "1.79769313486231585e308", undefined],
        ["above-rounding-boundary", "1.7976931348623159e308", undefined],
        [
          "negative-maximum-finite",
          "-1.7976931348623158e308",
          -Number.MAX_VALUE,
        ],
        [
          "negative-maximum-finite-precise",
          "-1.79769313486231580e308",
          -Number.MAX_VALUE,
        ],
        ["negative-overflow-midpoint", "-1.79769313486231581e308", undefined],
        [
          "negative-overflow-near-boundary",
          "-1.79769313486231584e308",
          undefined,
        ],
        [
          "negative-overflow-above-boundary",
          "-1.79769313486231585e308",
          undefined,
        ],
        ["negative-rounding-boundary", "-1.7976931348623159e308", undefined],
        [
          "exact-maximum-integer",
          String(2n ** 1024n - 2n ** 971n),
          Number.MAX_VALUE,
        ],
        [
          "exact-overflow-boundary",
          String(2n ** 1024n - 2n ** 970n),
          undefined,
        ],
        ["large-finite", "1e308", 1e308],
        ["scaled-subnormal", "123456e-324", Number("123456e-324")],
        ["negative-zero", "-0", -0],
        ["zero-large-exponent", "0e999", 0],
        ["negative-zero-large-exponent", "-0.0e999", -0],
        ["whitespace", " \t1.25\r\n", 1.25],
        ["exponent", "-2.5E+2", -250],
      ] as const;
      for (const [category, name] of samples) {
        await store.nodes.Product.create({ category, name, price: 1 });
      }

      const rows = await store
        .query()
        .from("Product", "product")
        .project((expressions) => ({
          category: expressions.product.category,
          converted: expr.toNumber(expressions.product.name),
        }))
        .execute();

      for (const [category, _input, expected] of samples) {
        expect(rows.find((row) => row.category === category)?.converted).toBe(
          expected,
        );
      }
    });

    it("builds expression callbacks once and maps once per decoded row", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "First" });
      await store.nodes.Person.create({ name: "Second" });
      let expressionBuilds = 0;
      let mappedRows = 0;

      const query = store
        .query()
        .from("Person", "person")
        .project((expressions) => {
          expressionBuilds += 1;
          return { name: expressions.person.name };
        })
        .map((row) => {
          mappedRows += 1;
          return row.name.toUpperCase();
        });

      expect(expressionBuilds).toBe(1);
      expect(mappedRows).toBe(0);
      const results = await query.execute();
      expect(results.toSorted()).toEqual(["FIRST", "SECOND"]);
      expect(expressionBuilds).toBe(1);
      expect(mappedRows).toBe(2);
    });

    it("groups by computed expressions and filters typed aggregates", async () => {
      const store = context.getStore();
      await store.nodes.Product.create({
        category: "tools",
        name: "A",
        price: 10,
      });
      await store.nodes.Product.create({
        category: "tools",
        name: "B",
        price: 10,
      });
      await store.nodes.Product.create({
        category: "tools",
        name: "C",
        price: 20,
      });

      const rows = await store
        .query()
        .from("Product", "product")
        .groupBy((expressions) => [
          expr.multiply(expressions.product.price, expr.literal(2)),
        ])
        .having((expressions) =>
          expr.gt(expr.count(expressions.product.id), expr.literal(1)),
        )
        .aggregate((expressions) => ({
          doubledPrice: expr.multiply(
            expressions.product.price,
            expr.literal(2),
          ),
          products: expr.count(expressions.product.id),
          total: expr.sum(expressions.product.price),
        }))
        .execute();

      expect(rows).toEqual([{ doubledPrice: 20, products: 2, total: 20 }]);
    });

    it("keeps COUNT DISTINCT on portable scalar equality", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ isActive: true, name: "Same" });
      await store.nodes.Person.create({ isActive: true, name: "Same" });
      await store.nodes.Person.create({ isActive: false, name: "Other" });

      const [result] = await store
        .query()
        .from("Person", "person")
        .aggregate((expressions) => ({
          activeValues: expr.countDistinct(expressions.person.isActive),
          names: expr.countDistinct(expressions.person.name),
        }))
        .execute();

      expect(result).toEqual({ activeValues: 2, names: 2 });
    });

    it("refuses structured COUNT DISTINCT operands before SQL execution", () => {
      const store = context.getStore();
      const expected =
        "COUNT DISTINCT supports only string, number, boolean, and date values; received object.";

      expect(() =>
        store
          .query()
          .from("Document", "document")
          .aggregate((expressions) => ({
            distinctMetadata: expr.countDistinct(
              expressions.document.metadata as never,
            ),
          })),
      ).toThrow(expected);

      expect(() =>
        store
          .query()
          .from("Document", "document")
          .aggregate({
            distinctMetadata: countDistinct("document", "metadata"),
          }),
      ).toThrow(expected);

      expect(() =>
        store
          .query()
          .from("Document", "document")
          .aggregate({ distinctTags: countDistinct("document", "tags") }),
      ).toThrow(
        "COUNT DISTINCT supports only string, number, boolean, and date values; received array.",
      );
    });

    it("refuses aggregates in predicates, grouping, and aggregate operands", async () => {
      const store = context.getStore();

      await expect(
        store
          .query()
          .from("Person", "person")
          .whereNode("person", (_person, expressions) =>
            expr.gt(expr.count(expressions.person.id), expr.literal(0)),
          )
          .project((expressions) => ({ name: expressions.person.name }))
          .execute(),
      ).rejects.toThrow(
        "Aggregate expressions are not allowed in predicate clauses",
      );

      await expect(
        store
          .query()
          .from("Person", "person")
          .groupBy((expressions) => expr.count(expressions.person.id))
          .aggregate((expressions) => ({
            people: expr.count(expressions.person.id),
          }))
          .execute(),
      ).rejects.toThrow(
        "Aggregate expressions are not allowed in GROUP BY clauses",
      );

      await expect(
        store
          .query()
          .from("Person", "person")
          .aggregate((expressions) => ({
            nested: expr.sum(expr.count(expressions.person.id)),
          }))
          .execute(),
      ).rejects.toThrow(/nested aggregate|aggregate.*aggregate/i);
    });

    it("projects and orders traversed edge fields", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create({ name: "Employee" });
      const first = await store.nodes.Company.create({ name: "First" });
      const second = await store.nodes.Company.create({ name: "Second" });
      await store.edges.worksAt.create(person, first, {
        role: "Engineer",
        salary: 80,
      });
      await store.edges.worksAt.create(person, second, {
        role: "Advisor",
        salary: 120,
      });

      const rows = await store
        .query()
        .from("Person", "person")
        .traverse("worksAt", "employment")
        .to("Company", "company")
        .project((expressions) => ({
          company: expressions.company.name,
          compensation: expr.add(
            expressions.employment.salary,
            expr.literal(5),
          ),
          role: expressions.employment.role,
        }))
        .orderBy((expressions) => expressions.employment.salary, "desc")
        .execute();

      expect(rows).toEqual([
        { company: "Second", compensation: 125, role: "Advisor" },
        { company: "First", compensation: 85, role: "Engineer" },
      ]);
    });

    it("binds prepared expressions and batches ordered projections", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ age: 19, name: "Young" });
      await store.nodes.Person.create({ age: 35, name: "Old" });
      await store.nodes.Product.create({
        category: "identity",
        name: "Identity",
        price: 1,
      });

      const prepared = store
        .query()
        .from("Person", "person")
        .whereNode("person", (_person, expressions) =>
          expr.gte(expressions.person.age, expr.param("minimumAge", "number")),
        )
        .project((expressions) => ({ name: expressions.person.name }))
        .prepare();
      await expect(prepared.execute({ minimumAge: 21 })).resolves.toEqual([
        { name: "Old" },
      ]);
      await expect(
        prepared.execute({ minimumAge: "twenty-one" }),
      ).rejects.toThrow(/minimumAge|number/i);

      const preparedObject = store
        .query()
        .from("Person", "person")
        .project(() => ({ payload: expr.param("payload", "object") }))
        .prepare();
      await expect(
        preparedObject.execute({ payload: { score: Number.NaN } }),
      ).rejects.toThrow(/payload|finite/i);
      await expect(
        preparedObject.execute({ payload: new Map() }),
      ).rejects.toThrow(/payload|plain JSON object/i);

      const [identity] = await store
        .query()
        .from("Product", "product")
        .project((expressions) => ({
          converted: expr.toNumber(expressions.product.price),
        }))
        .execute();
      expect(identity?.converted).toBe(1);

      const [rows] = await store.batchOnce(() => [
        store
          .query()
          .from("Person", "person")
          .project((expressions) => ({
            age: expressions.person.age,
            name: expressions.person.name,
          }))
          .orderBy((expressions) => expressions.person.age, "desc"),
      ]);
      expect(rows).toEqual([
        { age: 35, name: "Old" },
        { age: 19, name: "Young" },
      ]);
    });
  });
}
