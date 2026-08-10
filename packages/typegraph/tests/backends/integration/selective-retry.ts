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
