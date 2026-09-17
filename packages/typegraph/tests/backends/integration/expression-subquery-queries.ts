import { describe, expect, it } from "vitest";

import { expr } from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../../src/query/sql-intent";
import type { IntegrationTestContext } from "./test-context";

export function registerExpressionSubqueryQueryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Expression subqueries", () => {
    it("matches optional arrays against literal and correlated row expressions", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Aster" });
      await store.nodes.Person.create({ name: "Birch" });
      await store.nodes.Document.create({ tags: ["Aster"], title: "Tagged" });
      await store.nodes.Document.create({ title: "Untyped" });

      const literalMatches = await store
        .query()
        .from("Document", "document")
        .where((expressions) =>
          expr.arrayContains(expressions.document.tags, expr.literal("Aster")),
        )
        .project((expressions) => ({ title: expressions.document.title }))
        .execute();
      expect(literalMatches).toEqual([{ title: "Tagged" }]);

      const rows = await store
        .query()
        .from("Person", "person")
        .project((expressions) => ({
          hasTaggedDocument: expressions.$exists((subquery, outer) =>
            subquery
              .from("Document", "document")
              .where((inner) =>
                expr.arrayContains(inner.document.tags, outer.person.name),
              )
              .project((inner) => ({ id: inner.document.id }))
              .limit(1),
          ),
          name: expressions.person.name,
        }))
        .orderBy((expressions) => expressions.person.name)
        .execute();

      expect(rows).toEqual([
        { hasTaggedDocument: true, name: "Aster" },
        { hasTaggedDocument: false, name: "Birch" },
      ]);
    });

    it("treats stored JSON null and scalar array values as non-matches", async () => {
      const store = context.getStore();
      const matching = await store.nodes.Document.create({
        tags: ["Aster"],
        title: "Array",
      });
      const jsonNull = await store.nodes.Document.create({ title: "Null" });
      const scalar = await store.nodes.Document.create({ title: "Scalar" });
      const executeStatement = store.backend.executeStatement;
      if (executeStatement === undefined)
        throw new Error("Integration backend does not support raw statements");
      const schema = createSqlSchema(store.backend.tableNames);

      await executeStatement(
        asCompiledStatementSql(sql`
          UPDATE ${schema.nodesTable}
          SET props = ${JSON.stringify({
            // eslint-disable-next-line unicorn/no-null -- stored JSON null is the case under test.
            tags: null,
            title: "Null",
          })}
          WHERE graph_id = ${store.graphId} AND id = ${jsonNull.id}
        `),
      );
      await executeStatement(
        asCompiledStatementSql(sql`
          UPDATE ${schema.nodesTable}
          SET props = ${JSON.stringify({ tags: "Aster", title: "Scalar" })}
          WHERE graph_id = ${store.graphId} AND id = ${scalar.id}
        `),
      );

      const rows = await store
        .query()
        .from("Document", "document")
        .where((expressions) =>
          expr.arrayContains(expressions.document.tags, expr.literal("Aster")),
        )
        .project((expressions) => ({ title: expressions.document.title }))
        .execute();

      expect(matching.id).toBeDefined();
      expect(rows).toEqual([{ title: "Array" }]);
    });

    it("correlates exists and scalar projections when inner aliases reuse outer names", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ age: 31, name: "Alice" });
      await store.nodes.Person.create({ age: 27, name: "Bob" });

      const rows = await store
        .query()
        .from("Person", "p")
        .project((expression) => ({
          age: expression.$scalar((subquery, outer) =>
            subquery
              .from("Person", "p")
              .whereNode("p", (_person, inner) =>
                expr.eq(inner.p.name, outer.p.name),
              )
              .project((inner) => ({ age: inner.p.age }))
              .limit(1),
          ),
          found: expression.$exists((subquery, outer) =>
            subquery
              .from("Person", "p")
              .whereNode("p", (_person, inner) =>
                expr.eq(inner.p.name, outer.p.name),
              )
              .project((inner) => ({ id: inner.p.id })),
          ),
          name: expression.p.name,
        }))
        .orderBy((expression) => expression.p.name)
        .execute();

      expect(rows).toEqual([
        { age: 31, found: true, name: "Alice" },
        { age: 27, found: true, name: "Bob" },
      ]);
    });

    it("binds parameters nested inside expression subqueries", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Bob" });

      const prepared = store
        .query()
        .from("Person", "outerPerson")
        .project((expression) => ({
          found: expression.$exists((subquery) =>
            subquery
              .from("Person", "innerPerson")
              .whereNode("innerPerson", (_person, inner) =>
                expr.eq(inner.innerPerson.name, expr.param("needle", "string")),
              )
              .project((inner) => ({ id: inner.innerPerson.id })),
          ),
          name: expression.outerPerson.name,
        }))
        .prepare();

      expect(await prepared.execute({ needle: "Alice" })).toEqual([
        { found: true, name: "Alice" },
        { found: true, name: "Bob" },
      ]);
      expect(await prepared.execute({ needle: "Missing" })).toEqual([
        { found: false, name: "Alice" },
        { found: false, name: "Bob" },
      ]);
    });

    it("embeds expression subqueries in batchOnce", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ age: 31, name: "Alice" });

      const [rows] = await store.batchOnce(() => [
        store
          .query()
          .from("Person", "person")
          .project((expression) => ({
            age: expression.$scalar((subquery, outer) =>
              subquery
                .from("Person", "candidate")
                .whereNode("candidate", (_person, inner) =>
                  expr.eq(inner.candidate.name, outer.person.name),
                )
                .project((inner) => ({ age: inner.candidate.age }))
                .limit(1),
            ),
            name: expression.person.name,
          })),
      ]);

      expect(rows).toEqual([{ age: 31, name: "Alice" }]);
    });

    it("correlates an outer edge field through its physical traversal CTE", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.create({ name: "Engineer" });
      const company = await store.nodes.Company.create({ name: "Acme" });
      await store.edges.worksAt.create(alice, company, { role: "Engineer" });

      const rows = await store
        .query()
        .from("Person", "person")
        .traverse("worksAt", "employment")
        .to("Company", "company")
        .project((expression) => ({
          matchedRole: expression.$exists((subquery, outer) =>
            subquery
              .from("Person", "candidate")
              .whereNode("candidate", (_person, inner) =>
                expr.eq(inner.candidate.name, outer.employment.role),
              )
              .project((inner) => ({ id: inner.candidate.id })),
          ),
        }))
        .execute();

      expect(rows).toEqual([{ matchedRole: true }]);
    });

    it("preserves application object keys while namespacing inner aliases", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Alice" });
      const applicationValue = { alias: "candidate", nodeAlias: "candidate" };

      const rows = await store
        .query()
        .from("Person", "person")
        .project((expression) => ({
          value: expression.$scalar((subquery) =>
            subquery
              .from("Person", "candidate")
              .project(() => ({ value: expr.literal(applicationValue) }))
              .limit(1),
          ),
        }))
        .limit(1)
        .execute();

      expect(rows).toEqual([{ value: applicationValue }]);
    });
  });
}
