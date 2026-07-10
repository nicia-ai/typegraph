/**
 * A "current" (live) temporal-validity filter binds its read instant at SQL
 * compile time (`currentReadInstant()`). `ExecutableQuery`, `UnionableQuery`,
 * `ExecutableAggregateQuery`, and `PreparedQuery` all used to cache their
 * compiled SQL across calls — `.prepare()` compiled once and every
 * `execute()` reused that SQL text forever; a reused `ExecutableQuery`
 * instance cached its first `.execute()`'s compilation the same way. Both
 * froze "now" at the moment of first compilation, silently hiding every row
 * created afterward from that query for its entire remaining lifetime — a
 * severe regression, since `.prepare()`-once-`.execute()`-many is this
 * library's own documented, recommended pattern. Compiled SQL text is no
 * longer cached across calls in any of the four classes; these tests pin
 * that a row created after prepare()/first-execute() is visible on the very
 * next execute() call.
 */
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
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows");

const graph = defineGraph({
  id: "query-builder-read-freshness",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

/**
 * Forces a real wall-clock millisecond boundary. `valid_from`/the "current
 * instant" bound in a compiled temporal filter are both ISO-8601 strings at
 * millisecond precision — without this, a fast test runner could compile
 * and insert within the same millisecond, in which case even the buggy
 * (frozen-instant) behavior would pass `valid_from <= now` by coincidence,
 * silently weakening these as regression guards.
 */
async function waitForNextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

/** The bound "current" instants among a compiled statement's parameters. */
function isoInstants(params: readonly unknown[]): readonly string[] {
  return params.filter(
    (value): value is string =>
      typeof value === "string" && ISO_INSTANT.test(value),
  );
}

describe("query builder read freshness", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("PreparedQuery sees a row created after prepare(), not just after the first execute()", async () => {
    const store = createStore(graph, backend);

    const personById = store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.id.eq(parameter("id")))
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
      .prepare();

    // prepare() ran before this row existed — force it onto a strictly
    // later millisecond so the assertion can't pass by timing coincidence.
    await waitForNextMillisecond();
    const alice = await store.nodes.Person.create({ name: "Alice" });

    const result = await personById.execute({ id: alice.id });
    expect(result).toEqual([{ id: alice.id, name: "Alice" }]);

    // A second row, created after the FIRST execute() too — pins that
    // execute() itself doesn't freeze anything either.
    await waitForNextMillisecond();
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const bobResult = await personById.execute({ id: bob.id });
    expect(bobResult).toEqual([{ id: bob.id, name: "Bob" }]);
  });

  it("a reused ExecutableQuery instance sees rows created between execute() calls", async () => {
    const store = createStore(graph, backend);

    const allPeople = store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }));

    const before = await allPeople.execute();
    expect(before).toHaveLength(0);

    await waitForNextMillisecond();
    await store.nodes.Person.create({ name: "Alice" });

    const after = await allPeople.execute();
    expect(after).toHaveLength(1);
  });

  it("a reused UnionableQuery instance sees rows created between execute() calls", async () => {
    const store = createStore(graph, backend);

    const named = store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({ id: ctx.p.id }));
    const otherNamed = store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Bob"))
      .select((ctx) => ({ id: ctx.p.id }));
    const unioned = named.union(otherNamed);

    const before = await unioned.execute();
    expect(before).toHaveLength(0);

    await waitForNextMillisecond();
    await store.nodes.Person.create({ name: "Alice" });

    const after = await unioned.execute();
    expect(after).toHaveLength(1);
  });

  it("a reused ExecutableAggregateQuery instance sees rows created between execute() calls", async () => {
    const store = createStore(graph, backend);

    const countByName = store
      .query()
      .from("Person", "p")
      .groupBy("p", "name")
      .aggregate({
        name: field("p", "name"),
        total: count("p"),
      });

    const before = await countByName.execute();
    expect(before).toHaveLength(0);

    await waitForNextMillisecond();
    await store.nodes.Person.create({ name: "Alice" });

    const after = await countByName.execute();
    expect(after).toEqual([{ name: "Alice", total: 1 }]);
  });

  it("recompiles to byte-identical SQL, differing only in the bound instant", async () => {
    const store = createStore(graph, backend);
    const query = store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ id: ctx.p.id }));

    const first = query.toSQL();
    await waitForNextMillisecond();
    const second = query.toSQL();

    // Recompiling per call is what keeps a reused query fresh. It must cost
    // nothing else: same statement text, same parameter arity, same parameter
    // values apart from the instant the clock advanced past.
    expect(second.sql).toBe(first.sql);
    expect(second.params).toHaveLength(first.params.length);

    const changed = first.params.filter(
      (value, index) => value !== second.params[index],
    );
    expect(changed).toEqual(isoInstants(first.params));
    expect(changed.length).toBeGreaterThan(0);
  });

  it("binds one read instant across both operands of a set operation", () => {
    const store = createStore(graph, backend);
    const alice = store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({ id: ctx.p.id }));
    const bob = store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Bob"))
      .select((ctx) => ({ id: ctx.p.id }));

    // Each operand compiles its own temporal filter. A compound SELECT is
    // evaluated against ONE snapshot, so both halves must agree on "now" —
    // otherwise an INTERSECT/EXCEPT can disagree about a row created between
    // the two clock samples.
    const instants = new Set(isoInstants(alice.union(bob).toSQL().params));

    expect(instants.size).toBe(1);
  });

  it("binds one read instant across a nested set operation's three operands", () => {
    const store = createStore(graph, backend);
    const operand = (name: string) =>
      store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(name))
        .select((ctx) => ({ id: ctx.p.id }));

    const compiled = operand("Alice")
      .union(operand("Bob"))
      .except(operand("Carol"))
      .toSQL();

    expect(new Set(isoInstants(compiled.params)).size).toBe(1);
  });
});
