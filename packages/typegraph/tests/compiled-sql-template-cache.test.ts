/**
 * The compiled-SQL template cache (#246 follow-up). A "current" query compiles
 * ONCE into a template whose read instant is a reserved placeholder, then runs
 * that cached text via `executeRaw` on every call, filling a fresh instant each
 * time. These tests pin the mechanism itself — compile-once, the placeholder
 * structure, and the per-call recompilation fallback for backends that cannot
 * run raw SQL text. Freshness-across-writes is guarded behaviorally in
 * `query-builder-read-freshness.test.ts` and the cross-backend temporal suite.
 */
import { Placeholder } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  count,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  param as parameter,
} from "../src";
import type { GraphBackend } from "../src/backend/types";
import { compileQuery } from "../src/query/compiler/index";
import { CURRENT_READ_INSTANT_PLACEHOLDER } from "../src/query/compiler/temporal";
import { createTestBackend } from "./test-utils";

const GRAPH_ID = "compiled-sql-template-cache";
const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows");

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

/** Wraps a backend to count `compileSql` / `executeRaw` calls. */
function countingBackend(real: GraphBackend): {
  backend: GraphBackend;
  counts: { compileSql: number; executeRaw: number };
} {
  const counts = { compileSql: 0, executeRaw: 0 };
  const backend: GraphBackend = {
    ...real,
    compileSql(query) {
      counts.compileSql++;
      return real.compileSql!(query);
    },
    executeRaw<T>(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<readonly T[]> {
      counts.executeRaw++;
      return real.executeRaw!<T>(sqlText, params);
    },
  };
  return { backend, counts };
}

/** A backend that cannot run raw SQL text (the recompilation-fallback path). */
function backendWithoutRawExecution(real: GraphBackend): GraphBackend {
  const { executeRaw: _omitted, ...rest } = real;
  return rest;
}

async function waitForNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Replaces Placeholder objects with a stable token so params compare by shape. */
function normalizeParams(params: readonly unknown[]): readonly unknown[] {
  return params.map((value) =>
    value instanceof Placeholder ? `<<${value.name}>>` : value,
  );
}

function hasReadInstantPlaceholder(params: readonly unknown[]): boolean {
  return params.some(
    (value) =>
      value instanceof Placeholder &&
      value.name === CURRENT_READ_INSTANT_PLACEHOLDER,
  );
}

describe("compiled SQL template cache", () => {
  let real: GraphBackend;

  beforeEach(() => {
    real = createTestBackend();
  });

  it("compiles a reused prepared current query once, then runs it raw per call", async () => {
    const { backend, counts } = countingBackend(real);
    const store = createStore(graph, backend);
    await store.nodes.Person.create({ name: "Alice" });

    const personByName = store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq(parameter("name")))
      .select((ctx) => ctx.p.name)
      .prepare();

    counts.compileSql = 0;
    counts.executeRaw = 0;

    await personByName.execute({ name: "Alice" });
    await personByName.execute({ name: "Alice" });
    await personByName.execute({ name: "Alice" });

    // One template build (compileSql) shared by three raw executions.
    expect(counts.compileSql).toBe(1);
    expect(counts.executeRaw).toBe(3);
  });

  it("compiles a reused ExecutableQuery instance once across executions", async () => {
    const { backend, counts } = countingBackend(real);
    const store = createStore(graph, backend);
    await store.nodes.Person.create({ name: "Alice" });

    const namesQuery = store
      .query()
      .from("Person", "p")
      .select((ctx) => ctx.p.name);

    counts.compileSql = 0;
    counts.executeRaw = 0;

    await namesQuery.execute();
    await namesQuery.execute();
    await namesQuery.execute();

    expect(counts.compileSql).toBe(1);
    expect(counts.executeRaw).toBe(3);
  });

  it("compiles a reused aggregate query once across executions", async () => {
    const { backend, counts } = countingBackend(real);
    const store = createStore(graph, backend);
    await store.nodes.Person.create({ name: "Alice" });

    const countByName = store
      .query()
      .from("Person", "p")
      .groupBy("p", "name")
      .aggregate({ name: field("p", "name"), total: count("p") });

    counts.compileSql = 0;
    counts.executeRaw = 0;

    await countByName.execute();
    await countByName.execute();

    expect(counts.compileSql).toBe(1);
    expect(counts.executeRaw).toBe(2);
  });

  it("falls back to per-call recompilation and stays correct without executeRaw", async () => {
    const backend = backendWithoutRawExecution(real);
    const store = createStore(graph, backend);
    await store.nodes.Person.create({ name: "Alice" });

    const namesQuery = store
      .query()
      .from("Person", "p")
      .select((ctx) => ctx.p.name);

    expect(await namesQuery.execute()).toEqual(["Alice"]);

    // The fallback recompiles per call, so a reused instance still sees a row
    // created after its first execute().
    await waitForNextMillisecond();
    await store.nodes.Person.create({ name: "Bob" });
    const afterBob = await namesQuery.execute();
    expect(afterBob.toSorted()).toEqual(["Alice", "Bob"]);
  });

  it("reserves the read instant as a placeholder for a current query, with no leaked literal", async () => {
    const store = createStore(graph, real);
    const query = store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ id: ctx.p.id }));
    const ast = query.toAst();

    const compileOnce = () =>
      real.compileSql!(
        compileQuery(ast, GRAPH_ID, {
          dialect: "sqlite",
          readInstant: "placeholder",
        }),
      );

    const first = compileOnce();
    await waitForNextMillisecond();
    const second = compileOnce();

    // The read instant is a reserved placeholder, not a frozen value...
    expect(hasReadInstantPlaceholder(first.params)).toBe(true);
    // ...so the placeholder-mode statement is byte-and-shape stable across the
    // millisecond boundary: nothing time-varying leaked past the seam.
    expect(second.sql).toBe(first.sql);
    expect(normalizeParams(second.params)).toEqual(
      normalizeParams(first.params),
    );
  });

  it("binds no read-instant placeholder for an asOf query", () => {
    const store = createStore(graph, real);
    const asOf = "2024-01-01T00:00:00.000Z";
    const query = store
      .query()
      .from("Person", "p")
      .temporal("asOf", asOf)
      .select((ctx) => ({ id: ctx.p.id }));

    const { params } = real.compileSql!(
      compileQuery(query.toAst(), GRAPH_ID, {
        dialect: "sqlite",
        readInstant: "placeholder",
      }),
    );

    // asOf pins a fixed instant, so there is nothing to refresh per call: the
    // instant is a plain literal and the template is cacheable verbatim.
    expect(hasReadInstantPlaceholder(params)).toBe(false);
    expect(params).toContain(asOf);
  });

  it("rejects param() in an aggregate query with clear guidance", async () => {
    const store = createStore(graph, real);
    // Aggregate queries have no .prepare(), so a param() can never be bound.
    await expect(
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("who")))
        .groupBy("p", "name")
        .aggregate({ name: field("p", "name"), total: count("p") })
        .execute(),
    ).rejects.toThrow(/do not support param\(\)/u);
  });

  it("rejects a user param() named after the reserved read-instant placeholder", () => {
    expect(() => parameter(CURRENT_READ_INSTANT_PLACEHOLDER)).toThrow(
      /reserved/u,
    );
  });
});
