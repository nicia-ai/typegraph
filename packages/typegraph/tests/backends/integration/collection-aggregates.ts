import { describe, expect, it } from "vitest";

import { createStore, type DatabaseExpression, expr } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type {
  BackendCapabilities,
  GraphBackend,
} from "../../../src/backend/types";
import { integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

export function registerCollectionAggregateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Ordered collection aggregates", () => {
    it("collects ordered scalar values with duplicates and nullable elements", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 30, isActive: true },
        { name: "Bea", age: undefined, isActive: false },
        { name: "Ada", age: 20, isActive: true },
      ])
        await store.nodes.Person.create(person);

      const [row] = await store
        .query()
        .from("Person", "person")
        .aggregate((fields) => ({
          names: expr.collect(fields.person.name, {
            orderBy: [{ expression: fields.person.name, direction: "desc" }],
          }),
          ages: expr.collect(fields.person.age, {
            orderBy: [
              {
                expression: fields.person.age,
                direction: "asc",
                nulls: "first",
              },
            ],
          }),
          active: expr.collect(fields.person.isActive, {
            orderBy: [{ expression: fields.person.name }],
          }),
        }))
        .asRelation()
        .project((columns) => ({
          names: columns.names,
          ages: columns.ages,
          active: columns.active,
        }))
        .execute();

      expect(row).toEqual({
        names: ["Bea", "Ada", "Ada"],
        ages: [undefined, 20, 30],
        active: [true, true, false],
      });
    });

    it("collects optional traversal misses and resolves ordering ties explicitly", async () => {
      const store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Root", age: 10 });
      const friend = await store.nodes.Person.create({
        name: "Friend",
        age: 10,
      });
      const isolated = await store.nodes.Person.create({
        name: "Isolated",
        age: 10,
      });
      await store.edges.knows.create(root, friend, {});

      expect(
        await store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.id.in([root.id, isolated.id]))
          .optionalTraverse("knows", "edge", { expand: "none" })
          .to("Person", "friend")
          .aggregate((fields) => ({
            friends: expr.collect(fields.friend.name, {
              orderBy: [{ expression: fields.friend.name, nulls: "first" }],
            }),
          }))
          .execute(),
      ).toEqual([{ friends: [undefined, "Friend"] }]);

      expect(
        await store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              orderBy: [
                { expression: fields.person.age },
                { expression: fields.person.name, direction: "desc" },
              ],
            }),
          }))
          .execute(),
      ).toEqual([{ names: ["Root", "Isolated", "Friend"] }]);
    });

    it("filters each collection without removing its parent group", async () => {
      const store = context.getStore();
      const matched = await store.nodes.Person.create({ name: "Matched" });
      const unmatched = await store.nodes.Person.create({ name: "Unmatched" });
      const childless = await store.nodes.Person.create({ name: "Childless" });
      const alpha = await store.nodes.Company.create({ name: "Alpha" });
      const beta = await store.nodes.Company.create({ name: "Beta" });
      const ignored = await store.nodes.Company.create({ name: "Ignored" });
      await store.edges.worksAt.create(matched, beta, {
        role: "Engineer",
        salary: 100,
      });
      await store.edges.worksAt.create(matched, alpha, {
        role: "Engineer",
        salary: 100,
      });
      await store.edges.worksAt.create(matched, beta, {
        role: "Engineer",
        salary: 100,
      });
      await store.edges.worksAt.create(matched, ignored, {
        role: "Advisor",
        salary: 200,
      });
      await store.edges.worksAt.create(unmatched, ignored, {
        role: "Advisor",
        salary: 200,
      });

      expect(
        await store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) =>
            person.id.in([matched.id, unmatched.id, childless.id]),
          )
          .optionalTraverse("worksAt", "employment")
          .to("Company", "company")
          .groupBy((fields) => [fields.person.name])
          .aggregate((fields) => ({
            person: fields.person.name,
            allCompanies: expr.collect(fields.company.name, {
              orderBy: [{ expression: fields.company.name }],
            }),
            companies: expr.collect(fields.company.name, {
              filter: expr.eq(fields.employment.role, expr.literal("Engineer")),
              orderBy: [{ expression: fields.company.name }],
            }),
          }))
          .asRelation()
          .orderBy((columns) => columns.person)
          .execute(),
      ).toEqual([
        { person: "Childless", allCompanies: [undefined], companies: [] },
        {
          person: "Matched",
          allCompanies: ["Alpha", "Beta", "Beta", "Ignored"],
          companies: ["Alpha", "Beta", "Beta"],
        },
        { person: "Unmatched", allCompanies: ["Ignored"], companies: [] },
      ]);

      expect(
        await store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.id.eq(matched.id))
          .traverse("worksAt", "employment")
          .to("Company", "company")
          .aggregate((fields) => ({
            companies: expr.collect(fields.company.name, {
              filter: expr.literal(false),
              orderBy: [{ expression: fields.company.name }],
            }),
          }))
          .execute(),
      ).toEqual([{ companies: [] }]);
    });

    it("keeps nullable included operands and binds parameters used only by the filter", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create({ name: "Employee" });
      const first = await store.nodes.Company.create({ name: "First" });
      const second = await store.nodes.Company.create({ name: "Second" });
      await store.edges.worksAt.create(person, first, { role: "Engineer" });
      await store.edges.worksAt.create(person, second, {
        role: "Engineer",
        salary: 120,
      });

      const role = expr.param("role", "string");
      const prepared = store
        .query()
        .from("Person", "person")
        .traverse("worksAt", "employment")
        .to("Company", "company")
        .aggregate((fields) => ({
          salaries: expr.collect(fields.employment.salary, {
            filter: expr.eq(fields.employment.role, role),
            orderBy: [{ expression: fields.employment.salary, nulls: "first" }],
          }),
        }))
        .asRelation()
        .prepare({ role });

      expect(await prepared.execute({ role: "Engineer" })).toEqual([
        { salaries: [undefined, 120] },
      ]);
      expect(
        await store.batchOnce(() => [
          prepared.bind({ role: "Advisor" }),
          prepared.bind({ role: "Engineer" }),
        ]),
      ).toEqual([[{ salaries: [] }], [{ salaries: [undefined, 120] }]]);
    });

    it("decodes dates and distinguishes empty ungrouped and grouped input", async () => {
      const store = context.getStore();
      const earlier = new Date("2024-01-01T00:00:00.000Z");
      const later = new Date("2025-01-01T00:00:00.000Z");
      await store.nodes.Document.create({ title: "Later", publishedAt: later });
      await store.nodes.Document.create({ title: "Missing" });
      await store.nodes.Document.create({
        title: "Earlier",
        publishedAt: earlier,
      });

      const [dates] = await store
        .query()
        .from("Document", "document")
        .aggregate((fields) => ({
          dates: expr.collect(fields.document.publishedAt, {
            orderBy: [
              {
                expression: fields.document.publishedAt,
                direction: "desc",
              },
            ],
          }),
        }))
        .asRelation()
        .project((columns) => ({ dates: columns.dates }))
        .execute();
      expect(dates?.dates).toEqual([undefined, later, earlier]);

      const empty = store
        .query()
        .from("Document", "document")
        .whereNode("document", (document) => document.title.eq("Absent"));
      expect(
        await empty
          .aggregate((fields) => ({
            titles: expr.collect(fields.document.title, {
              orderBy: [{ expression: fields.document.title }],
            }),
          }))
          .execute(),
      ).toEqual([{ titles: [] }]);
      expect(
        await empty
          .groupBy((fields) => [fields.document.title])
          .aggregate((fields) => ({
            title: fields.document.title,
            titles: expr.collect(fields.document.title, {
              orderBy: [{ expression: fields.document.title }],
            }),
          }))
          .execute(),
      ).toEqual([]);
    });

    it("collects scalar literals and declared parameter operands", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Ada", age: 20 });
      await store.nodes.Person.create({ name: "Bea", age: 10 });
      const literalDate = new Date("2026-01-02T00:00:00.000Z");

      expect(
        await store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            strings: expr.collect(expr.literal("Ada"), {
              orderBy: [{ expression: fields.person.name }],
            }),
            numbers: expr.collect(expr.literal(7), {
              orderBy: [{ expression: fields.person.name }],
            }),
            booleans: expr.collect(expr.literal(true), {
              orderBy: [{ expression: fields.person.name }],
            }),
            dates: expr.collect(expr.literal(literalDate), {
              orderBy: [{ expression: fields.person.name }],
            }),
          }))
          .execute(),
      ).toEqual([
        {
          strings: ["Ada", "Ada"],
          numbers: [7, 7],
          booleans: [true, true],
          dates: [literalDate, literalDate],
        },
      ]);

      const label = expr.param("label", "string");
      const score = expr.param("score", "number");
      const active = expr.param("active", "boolean");
      const observedAt = expr.param("observedAt", "date");
      const orderOffset = expr.param("orderOffset", "number");
      const prepared = store
        .query()
        .from("Person", "person")
        .aggregate((fields) => ({
          strings: expr.collect(label, {
            orderBy: [
              {
                expression: expr.add(fields.person.age, orderOffset),
                direction: "desc",
              },
            ],
          }),
          numbers: expr.collect(score, {
            orderBy: [{ expression: fields.person.name }],
          }),
          booleans: expr.collect(active, {
            orderBy: [{ expression: fields.person.name }],
          }),
          dates: expr.collect(observedAt, {
            orderBy: [{ expression: fields.person.name }],
          }),
        }))
        .asRelation()
        .prepare({ active, label, observedAt, orderOffset, score });
      expect(
        await prepared.execute({
          active: false,
          label: "parameter",
          observedAt: literalDate,
          orderOffset: 5,
          score: 9,
        }),
      ).toEqual([
        {
          strings: ["parameter", "parameter"],
          numbers: [9, 9],
          booleans: [false, false],
          dates: [literalDate, literalDate],
        },
      ]);
    });

    it("preserves collection codecs through scalar and conditional composition", async () => {
      const store = context.getStore();
      const earlier = new Date("2024-02-01T00:00:00.000Z");
      const later = new Date("2025-02-01T00:00:00.000Z");
      await store.nodes.Document.create({
        title: "Earlier",
        publishedAt: earlier,
      });
      await store.nodes.Document.create({ title: "Later", publishedAt: later });
      await store.nodes.Person.create({ name: "Reader" });

      const rows = await store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          dates: fields.$scalar((subquery) =>
            subquery.from("Document", "document").aggregate((inner) => ({
              dates: expr.collect(inner.document.publishedAt, {
                orderBy: [{ expression: inner.document.publishedAt }],
              }),
            })),
          ),
        }))
        .execute();
      expect(rows).toEqual([{ dates: [earlier, later] }]);

      const collection = store
        .query()
        .from("Document", "document")
        .aggregate((fields) => ({
          dates: expr.collect(fields.document.publishedAt, {
            orderBy: [{ expression: fields.document.publishedAt }],
          }),
        }))
        .asRelation();
      expect(
        await collection
          .project((columns) => ({
            coalesced: expr.coalesce(columns.dates, columns.dates),
            conditional: expr.when(
              expr.literal(true),
              columns.dates,
              columns.dates,
            ),
          }))
          .execute(),
      ).toEqual([
        {
          coalesced: [earlier, later],
          conditional: [earlier, later],
        },
      ]);
      await expect(
        collection.orderBy((columns) => columns.dates).execute(),
      ).rejects.toThrow(
        "Relation ordering requires scalar keys; collection-valued ordering is unsupported.",
      );

      const names = store
        .query()
        .from("Person", "person")
        .aggregate((fields) => ({
          values: expr.collect(fields.person.name, {
            orderBy: [{ expression: fields.person.name }],
          }),
        }))
        .asRelation();
      expect(() => names.unionAll(collection as never)).toThrow(
        /element|compatible|column/i,
      );
    });

    it("preserves relation input stages, preparation, batching, and set decoding", async () => {
      const store = context.getStore();
      for (const person of [
        { name: "Ada", age: 10 },
        { name: "Ada", age: 10 },
        { name: "Bea", age: 20 },
        { name: "Cara", age: 30 },
      ])
        await store.nodes.Person.create(person);

      const bounded = store
        .query()
        .from("Person", "person")
        .project((fields) => ({
          name: fields.person.name,
          age: fields.person.age,
        }))
        .asRelation()
        .where((columns) => expr.isNotNull(columns.age))
        .distinct()
        .orderBy((columns) => columns.age, "desc")
        .offset(1)
        .limit(2);
      const collected = bounded.aggregate((columns) => ({
        names: expr.collect(columns.name, {
          orderBy: [{ expression: columns.age, direction: "asc" }],
        }),
      }));
      expect(await collected.execute()).toEqual([{ names: ["Ada", "Bea"] }]);
      expect(await collected.unionAll(collected).execute()).toEqual([
        { names: ["Ada", "Bea"] },
        { names: ["Ada", "Bea"] },
      ]);

      const minimum = expr.param("minimum", "number");
      const prepared = store
        .query()
        .from("Person", "person")
        .traverse("worksAt", "employment")
        .to("Company", "company")
        .where((fields) => expr.gt(fields.employment.salary, minimum))
        .aggregate((fields) => ({
          companies: expr.collect(fields.company.name, {
            orderBy: [{ expression: fields.employment.salary }],
          }),
        }))
        .asRelation()
        .prepare({ minimum });
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
      expect(await prepared.execute({ minimum: 70 })).toEqual([
        { companies: ["First", "Second"] },
      ]);
      expect(
        await store.batchOnce(() => [
          prepared.bind({ minimum: 100 }),
          collected,
        ]),
      ).toEqual([[{ companies: ["Second"] }], [{ names: ["Ada", "Bea"] }]]);
    });

    it("preserves transaction and temporal source coordinates", async () => {
      const store = context.getStore();
      await store.transaction(async (transaction) => {
        await transaction.nodes.Person.create({ name: "Inside B" });
        await transaction.nodes.Person.create({ name: "Inside A" });
        expect(
          await transaction
            .query()
            .from("Person", "person")
            .aggregate((fields) => ({
              names: expr.collect(fields.person.name, {
                orderBy: [{ expression: fields.person.name }],
              }),
            }))
            .execute(),
        ).toEqual([{ names: ["Inside A", "Inside B"] }]);
      });

      await store.nodes.Person.create(
        { name: "Historically visible" },
        { validFrom: "2020-01-01T00:00:00.000Z" },
      );
      await store.nodes.Person.create(
        { name: "Not yet visible" },
        { validFrom: "2030-01-01T00:00:00.000Z" },
      );
      expect(
        await store
          .asOf("2025-01-01T00:00:00.000Z")
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              orderBy: [{ expression: fields.person.name }],
            }),
          }))
          .execute(),
      ).toEqual([{ names: ["Historically visible"] }]);
    });

    it("refuses invalid operands, ordering, filters, and nested aggregates", async () => {
      const store = context.getStore();
      expect(() =>
        store
          .query()
          .from("Document", "document")
          .aggregate((fields) => ({
            metadata: expr.collect(fields.document.metadata as never, {
              orderBy: [{ expression: fields.document.title }],
            }),
          })),
      ).toThrow(/COLLECT.*object|object.*COLLECT/i);
      expect(() =>
        store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              orderBy: [] as never,
            }),
          })),
      ).toThrow(/COLLECT.*order|order.*COLLECT/i);
      await expect(
        store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            nested: expr.collect(expr.count(fields.person.id), {
              orderBy: [{ expression: fields.person.name }],
            }),
          }))
          .execute(),
      ).rejects.toThrow(/nested aggregate|aggregate.*aggregate/i);

      expect(() =>
        store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              filter: fields.person.age as never,
              orderBy: [{ expression: fields.person.name }],
            }),
          })),
      ).toThrow(/COLLECT.*filter.*Boolean|Boolean.*COLLECT.*filter/i);
      await expect(
        store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              filter: expr.gt(expr.count(fields.person.id), expr.literal(0)),
              orderBy: [{ expression: fields.person.name }],
            }),
          }))
          .execute(),
      ).rejects.toThrow(/nested aggregate|aggregate.*aggregate/i);

      let foreignOrder: DatabaseExpression<string> | undefined;
      store
        .query()
        .from("Person", "foreignPerson")
        .project((fields) => {
          foreignOrder = fields.foreignPerson.name;
          return { name: fields.foreignPerson.name };
        });
      if (foreignOrder === undefined)
        throw new Error("Expected projection callback to capture its scope");
      const capturedForeignOrder = foreignOrder as never;
      expect(() =>
        store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              orderBy: [{ expression: capturedForeignOrder }],
            }),
          })),
      ).toThrow(/different query scopes/i);
      expect(() =>
        store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              filter: expr.eq(capturedForeignOrder, expr.literal("Ada")),
              orderBy: [{ expression: fields.person.name }],
            }),
          })),
      ).toThrow(/different query scopes/i);
    });

    it("refuses missing ordered-aggregate capability before direct or batched SQL", async () => {
      const base = context.getStore().backend;
      for (const declaration of [false, undefined] as const) {
        const capabilities: BackendCapabilities =
          declaration === false ?
            { ...base.capabilities, orderedAggregates: false }
          : withoutOrderedAggregates(base.capabilities);
        let sqlExecutions = 0;
        const execute: GraphBackend["execute"] = <T>() => {
          sqlExecutions += 1;
          return Promise.reject<readonly T[]>(
            new Error("Collect capability gate reached SQL execution"),
          );
        };
        const store = createStore(
          integrationTestGraph,
          deriveBackend(base, { capabilities, execute }),
        );
        const query = store
          .query()
          .from("Person", "person")
          .aggregate((fields) => ({
            names: expr.collect(fields.person.name, {
              orderBy: [{ expression: fields.person.name }],
            }),
          }));

        await expect(query.execute()).rejects.toThrow(
          /ordered aggregate|COLLECT/i,
        );
        await expect(store.batchOnce(() => [query])).rejects.toThrow(
          /ordered aggregate|COLLECT/i,
        );
        expect(sqlExecutions).toBe(0);
      }
    });
  });
}

function withoutOrderedAggregates(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  const copy = { ...capabilities };
  Reflect.deleteProperty(copy, "orderedAggregates");
  return copy;
}
