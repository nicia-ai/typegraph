import { describe, expect, it } from "vitest";

import { createStoreWithSchema, param as parameter } from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
import { type CompiledRowsSql } from "../../../src/query/sql-intent";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

function createStatementCounter(backend: GraphBackend): Readonly<{
  backend: GraphBackend;
  count: () => number;
  reset: () => void;
}> {
  const projected = projectGraphBackend(backend);
  const executeRaw = projected.executeRaw;
  let statementCount = 0;

  const countingBackend = deriveBackend(projected, {
    execute: <T>(query: CompiledRowsSql): Promise<readonly T[]> => {
      statementCount += 1;
      return projected.execute<T>(query);
    },
    ...(executeRaw === undefined ?
      {}
    : {
        executeRaw: <T>(
          sqlText: string,
          params: readonly unknown[],
        ): Promise<readonly T[]> => {
          statementCount += 1;
          return executeRaw<T>(sqlText, params);
        },
      }),
  });

  return {
    backend: countingBackend,
    count: () => statementCount,
    reset: () => {
      statementCount = 0;
    },
  };
}

export function registerSelectiveRetryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("selective projection retries", () => {
    it("selects complete nodes before executing fresh, prepared, and paginated queries", async () => {
      const counter = createStatementCounter(context.getBackend());
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        counter.backend,
      );
      const person = await store.nodes.Person.create({
        name: "Whole",
        age: 42,
      });
      function query() {
        return store
          .query()
          .from("Person", "p")
          .whereNode("p", (node) => node.id.eq(person.id))
          .orderBy("p", "name")
          .select((ctx) => ({ id: ctx.p.id, nested: [ctx.p] }));
      }
      for (const execute of [
        () => query().execute(),
        () => query().execute(),
        () => query().prepare().execute({}),
        async () => {
          const page = await query().paginate({ first: 1 });
          return page.data;
        },
        () => query().executeOn(counter.backend),
      ]) {
        counter.reset();
        const rows = await execute();
        expect(rows[0]?.nested[0]).toMatchObject({
          id: person.id,
          name: "Whole",
          age: 42,
        });
        expect(counter.count()).toBe(1);
      }
    });

    it("plans whole edges and spread aliases as full rows before executing", async () => {
      const counter = createStatementCounter(context.getBackend());
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        counter.backend,
      );
      const person = await store.nodes.Person.create({
        name: "Whole",
        age: 42,
      });
      const target = await store.nodes.Person.create({ name: "Target" });
      const edge = await store.edges.knows.create(person, target, {
        since: "2024",
      });
      function query() {
        return store
          .query()
          .from("Person", "p")
          .whereNode("p", (node) => node.id.eq(person.id))
          .traverse("knows", "edge")
          .to("Person", "target");
      }
      counter.reset();
      const whole = await query()
        .select((ctx) => ({ id: ctx.p.id, edge: ctx.edge }))
        .execute();
      expect(whole[0]?.edge).toMatchObject({ id: edge.id, since: "2024" });
      expect(counter.count()).toBe(1);

      counter.reset();
      const spread = await query()
        .select((ctx) => ({
          id: ctx.p.id,
          person: { ...ctx.p },
          edge: { ...ctx.edge },
        }))
        .execute();
      expect(spread[0]?.person).toMatchObject({
        id: person.id,
        name: "Whole",
        age: 42,
      });
      expect(spread[0]?.edge).toMatchObject({ id: edge.id, since: "2024" });
      expect(counter.count()).toBe(1);
    });

    it("fetches the newest traversed target in one ordered limit statement", async () => {
      const counter = createStatementCounter(context.getBackend());
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        counter.backend,
      );
      const source = await store.nodes.Person.create({ name: "Source" });
      const older = await store.nodes.Person.create({ name: "Older", age: 1 });
      const newer = await store.nodes.Person.create({ name: "Newer", age: 2 });
      await store.edges.knows.create(source, older, {});
      await store.edges.knows.create(source, newer, {});
      counter.reset();
      const rows = await store
        .query()
        .from("Person", "source")
        .whereNode("source", (node) => node.id.eq(source.id))
        .traverse("knows", "edge")
        .to("Person", "target")
        .orderBy("target", "age", "desc")
        .orderBy("target", "id", "desc")
        .select((ctx) => ctx.target)
        .limit(1)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(newer.id);
      expect(counter.count()).toBe(1);
    });

    it("tracks threshold branches without issuing a fallback statement", async () => {
      const counter = createStatementCounter(context.getBackend());
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        counter.backend,
      );
      await store.nodes.Person.create({
        name: "Threshold Adult",
        age: 30,
        email: "adult@example.com",
      });
      await store.nodes.Person.create({ name: "Threshold Child", age: 10 });
      counter.reset();

      const rows = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.startsWith("Threshold "))
        .orderBy("p", "name", "asc")
        .select((ctx) => ((ctx.p.age ?? 0) > 18 ? ctx.p.email : ctx.p.name))
        .execute();

      expect(rows).toEqual(["adult@example.com", "Threshold Child"]);
      expect(counter.count()).toBe(1);
    });

    it("permanently disables a prepared projection after a missing-field fallback", async () => {
      const counter = createStatementCounter(context.getBackend());
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        counter.backend,
      );
      await store.nodes.Person.create({
        name: "VIP",
        email: "vip@example.com",
      });
      const prepared = store
        .query()
        .from("Person", "p")
        .whereNode("p", (person) => person.name.eq(parameter("name")))
        .select((ctx) => (ctx.p.name === "VIP" ? ctx.p.email : ctx.p.name))
        .prepare();
      counter.reset();

      expect(await prepared.execute({ name: "VIP" })).toEqual([
        "vip@example.com",
      ]);
      const firstExecutionStatements = counter.count();
      counter.reset();
      expect(await prepared.execute({ name: "VIP" })).toEqual([
        "vip@example.com",
      ]);

      expect(firstExecutionStatements).toBe(2);
      expect(counter.count()).toBe(1);
    });
  });
}
