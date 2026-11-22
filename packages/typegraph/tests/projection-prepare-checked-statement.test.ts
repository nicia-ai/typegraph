/**
 * A prepared projection checks the generated SQL names of the statement its
 * executions send: inside `withCheckedReads()` that is the projection envelope
 * the checked read wraps and reads back by name, not the bare projection.
 * Every name-checked compile is observed through `compileNameCheckedQuery`,
 * the one function each entry point checks through.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  param as parameter,
} from "../src";
import type * as Compiler from "../src/query/compiler";
import { toSqlWithParams } from "./sql-test-utils";
import { createTestBackend } from "./test-utils";

const checks = vi.hoisted(() => [] as { usage: unknown; sql: unknown }[]);

vi.mock("../src/query/compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof Compiler>();
  return {
    ...actual,
    compileNameCheckedQuery: (
      ...args: Parameters<typeof actual.compileNameCheckedQuery>
    ) => {
      const compiled = actual.compileNameCheckedQuery(...args);
      checks.push({
        usage: args[3],
        sql: compiled,
      });
      return compiled;
    },
  };
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});
const graph = defineGraph({
  id: "projection_prepare_checked_statement",
  nodes: { Person: { type: Person } },
  edges: {},
});

afterEach(() => {
  checks.length = 0;
});

describe("a prepared projection inside withCheckedReads()", () => {
  it("checks at prepare() the statement each execute() sends", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Person.create({ name: "Alice", age: 30 });
    const active = await backend.getActiveSchema(store.graphId);
    const version = active?.version;
    const { prepared, executed } = await store.withCheckedReads(
      version,
      async (reads) => {
        const query = reads
          .query()
          .from("Person", "p")
          .whereNode("p", (person) => person.name.eq(parameter("name")))
          .project((fields) => ({ name: fields.p.name, age: fields.p.age }));
        checks.length = 0;
        const preparedQuery = query.prepare();
        const preparedChecks = checks.map((check) => ({
          usage: check.usage,
          sql: toSqlWithParams(check.sql as never, "sqlite").sql,
        }));
        checks.length = 0;
        const rows = await preparedQuery.execute({ name: "Alice" });
        expect(rows).toEqual([{ name: "Alice", age: 30 }]);
        const executedChecks = checks.map((check) => ({
          usage: check.usage,
          sql: toSqlWithParams(check.sql as never, "sqlite").sql,
        }));
        return { prepared: preparedChecks, executed: executedChecks };
      },
    );
    expect(prepared.map((check) => check.usage)).toEqual(["wrapped"]);
    expect(executed.map((check) => check.usage)).toEqual(["wrapped"]);
    // The same statement up to its bound value.
    expect(prepared[0]?.sql).toEqual(executed[0]?.sql);
  });
});
