/* eslint-disable unicorn/no-thenable -- A schema field named `then` IS the
   subject under test: it is legal to declare, it round-trips as data, and the
   bug was a read path answering its name instead of its value. */
/**
 * Fields named after a protocol hook (`then`, `toJSON`) or an
 * `Object.prototype` member are ordinary data.
 *
 * A schema may declare them, they survive validation and the JSON round-trip
 * untouched, and every read path must return the stored value. The hazard is a
 * trap that answers such a name by NAME IDENTITY before consulting the data it
 * fronts: smart selection's result proxy returned `undefined` for a projected
 * field named `toJSON` while the full mapper returned the stored string, so the
 * same query answered differently depending on which path it took.
 *
 * These tests read the ACTUAL RESULT on both paths, not just the tracking that
 * feeds it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { defineNodeIndex } from "../src/indexes/define-index";
import { type SqlFragment } from "../src/query/sql-fragment";
import { type CompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";
import { toSqlWithParams } from "./sql-test-utils";
import { createTestBackend } from "./test-utils";

// ============================================================
// Graph: protocol-named fields on both a node and an edge
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    toJSON: z.string().optional(),
    then: z.string().optional(),
  }),
});

/** No protocol-named field: the control for serialization / await safety. */
const Plain = defineNode("Plain", {
  schema: z.object({ label: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    toJSON: z.string().optional(),
    then: z.string().optional(),
  }),
});

const testGraph = defineGraph({
  id: "interop_probe_field_names",
  nodes: { Person: { type: Person }, Plain: { type: Plain } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },
  },
});

// ============================================================
// Recording backend (captures the statement smart select ran)
// ============================================================

function createRecordingBackend(): Readonly<{
  backend: GraphBackend;
  getLastQuery: () => SqlFragment | string | undefined;
}> {
  const backend = createTestBackend();
  let lastQuery: SqlFragment | string | undefined;

  const recordingBackend: GraphBackend = {
    ...backend,
    execute: async <T>(query: CompiledRowsSql) => {
      lastQuery = query;
      return backend.execute<T>(query);
    },
    executeRaw: async <T>(sqlText: string, params: readonly unknown[]) => {
      lastQuery = sqlText;
      return requireDefined(backend.executeRaw)<T>(sqlText, params);
    },
  };

  return { backend: recordingBackend, getLastQuery: () => lastQuery };
}

function lastSql(getLastQuery: () => SqlFragment | string | undefined): string {
  const last = requireDefined(getLastQuery());
  return typeof last === "string" ? last : toSqlWithParams(last).sql;
}

/**
 * The select callback is typed from the schema, but reading `ctx.p.toJSON`
 * through the typed accessor collides with the declared-field type in a way
 * that adds noise to every assertion; index through a record view instead.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

describe("protocol-named fields are data on every read path", () => {
  let store: Store<typeof testGraph>;
  let getLastQuery: () => SqlFragment | string | undefined;

  beforeEach(async () => {
    const recording = createRecordingBackend();
    getLastQuery = recording.getLastQuery;
    store = createStore(testGraph, recording.backend);

    const alice = await store.nodes.Person.create({
      name: "Alice",
      toJSON: "STORED",
      then: "THEN-STORED",
    });
    const bob = await store.nodes.Person.create({
      name: "Bob",
      toJSON: "OTHER",
      then: "THEN-OTHER",
    });
    await store.edges.knows.create(
      { kind: "Person", id: alice.id },
      { kind: "Person", id: bob.id },
      { toJSON: "EDGE-STORED", then: "EDGE-THEN-STORED" },
    );
  });

  // ============================================================
  // The finding: node result through smart selection
  // ============================================================

  it("returns a node's declared toJSON and then fields through smart selection", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({
        name: ctx.p.name,
        toJSON: asRecord(ctx.p)["toJSON"],
        then: asRecord(ctx.p)["then"],
      }))
      .execute();

    expect(results).toEqual([
      { name: "Alice", toJSON: "STORED", then: "THEN-STORED" },
    ]);

    // The values came through the SELECTIVE path, not a silent fallback to the
    // full props blob — otherwise this test would pass without the projection
    // ever carrying the field.
    const sql = lastSql(getLastQuery);
    expect(sql).toContain('AS "p_toJSON"');
    expect(sql).toContain('AS "p_then"');
    expect(sql).not.toContain('AS "p_props"');
  });

  it("agrees with the full mapper on a node's declared toJSON and then fields", async () => {
    const selective = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({
        toJSON: asRecord(ctx.p)["toJSON"],
        then: asRecord(ctx.p)["then"],
      }))
      .execute();

    // Returning the whole alias object is unsupported by selective projection,
    // so this query maps through the FULL path.
    const full = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({ node: ctx.p }))
      .execute();

    const fullNode = asRecord(asRecord(requireDefined(full[0]))["node"]);
    expect(requireDefined(selective[0])).toEqual({
      toJSON: fullNode["toJSON"],
      then: fullNode["then"],
    });
    expect(fullNode["toJSON"]).toBe("STORED");
  });

  // ============================================================
  // The same class on an edge alias
  // ============================================================

  it("returns an edge's declared toJSON and then fields through smart selection", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .traverse("knows", "e", { direction: "out" })
      .to("Person", "other")
      .select((ctx) => ({
        toJSON: asRecord(ctx.e)["toJSON"],
        then: asRecord(ctx.e)["then"],
      }))
      .execute();

    expect(results).toEqual([
      { toJSON: "EDGE-STORED", then: "EDGE-THEN-STORED" },
    ]);

    const sql = lastSql(getLastQuery);
    expect(sql).toContain('AS "e_toJSON"');
    expect(sql).not.toContain('AS "e_props"');
  });

  // ============================================================
  // Controls: the exemption still covers ABSENT keys
  // ============================================================

  it("serializes a selective result whose schema declares no toJSON", async () => {
    await store.nodes.Plain.create({ label: "control" });

    // `ctx.q.meta` maps to a guarded proxy, so the result object CONTAINS the
    // proxy and JSON.stringify probes `toJSON` on it. The Plain schema has no
    // such field, so the probe must resolve to undefined rather than raise the
    // missing-field error that drives the fallback.
    const results = await store
      .query()
      .from("Plain", "q")
      .select((ctx) => ({ label: ctx.q.label, meta: ctx.q.meta }))
      .execute();

    const row = requireDefined(results[0]);
    expect(() => JSON.stringify(row)).not.toThrow();
    expect(asRecord(row)["label"]).toBe("control");
    expect(asRecord(asRecord(row)["meta"])["toJSON"]).toBeUndefined();
  });

  it("resolves a selective result containing the proxy when awaited", async () => {
    await store.nodes.Plain.create({ label: "control" });

    const results = await store
      .query()
      .from("Plain", "q")
      .select((ctx) => ctx.q.meta)
      .execute();

    const proxy = requireDefined(results[0]);
    // An absent `then` must read as undefined, not raise: the promise
    // resolution procedure probes `then` on every value it adopts.
    await expect(Promise.resolve(proxy)).resolves.toBe(proxy);
  });

  it("does not invoke a declared then field as a thenable on either path", async () => {
    const selective = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({ then: asRecord(ctx.p)["then"] }))
      .execute();

    const full = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({ node: ctx.p }))
      .execute();

    const selectiveRow = requireDefined(selective[0]);
    const fullNode = asRecord(asRecord(requireDefined(full[0]))["node"]);

    // A stored `then` is JSON data, so it is never callable: adoption sees a
    // non-callable `then` and resolves the object itself. Both paths agree.
    await expect(Promise.resolve(selectiveRow)).resolves.toBe(selectiveRow);
    await expect(Promise.resolve(fullNode)).resolves.toBe(fullNode);
    expect(asRecord(selectiveRow)["then"]).toBe("THEN-STORED");
  });

  // ============================================================
  // Predicate builders: the same class on the write-the-query side
  // ============================================================

  it("filters on a node field named toJSON through the query builder", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.toJSON.eq("STORED"))
      .select((ctx) => ({ name: ctx.p.name }))
      .execute();

    expect(results).toEqual([{ name: "Alice" }]);
  });

  it("filters on an edge field named toJSON after the traversal is closed", async () => {
    // `whereEdge` AFTER `.to(...)` resolves through the query builder's edge
    // accessor.
    const results = await store
      .query()
      .from("Person", "p")
      .traverse("knows", "e", { direction: "out" })
      .to("Person", "other")
      .whereEdge("e", (edge) => edge.toJSON.eq("EDGE-STORED"))
      .select((ctx) => ({ name: ctx.p.name }))
      .execute();

    expect(results).toEqual([{ name: "Alice" }]);
  });

  it("filters on an edge field named toJSON mid-traversal", async () => {
    // `whereEdge` BEFORE `.to(...)` resolves through the traversal builder's
    // own edge accessor — a second proxy with the same trap.
    const results = await store
      .query()
      .from("Person", "p")
      .traverse("knows", "e", { direction: "out" })
      .whereEdge("e", (edge) => edge.toJSON.eq("EDGE-STORED"))
      .to("Person", "other")
      .select((ctx) => ({ name: ctx.p.name }))
      .execute();

    expect(results).toEqual([{ name: "Alice" }]);
  });

  it("filters on a field named toJSON through a collection read predicate", async () => {
    const found = await store.nodes.Person.find({
      where: (person) => person.toJSON.eq("STORED"),
    });

    expect(found).toHaveLength(1);
    expect(requireDefined(found[0]).name).toBe("Alice");
  });

  it("filters on a field named toJSON through a collection write predicate", async () => {
    // updateWhere builds its predicate on the collection's own accessor proxy,
    // which is a distinct trap from the query builder's.
    const result = await store.nodes.Person.updateWhere({
      patch: { name: "Renamed" },
      where: (person) => person.toJSON.eq("STORED"),
    });

    expect(result).toEqual({ affectedCount: 1 });
    const renamed = await store.nodes.Person.find({
      where: (person) => person.name.eq("Renamed"),
    });
    expect(renamed).toHaveLength(1);
  });
});

describe("index WHERE clauses treat protocol names as data", () => {
  it("builds a partial index on a declared field named toJSON", () => {
    const index = defineNodeIndex(Person, {
      name: "person_name_where_tojson",
      fields: ["name"],
      where: (row) => row.toJSON.isNotNull(),
    });

    expect(index.where).toBeDefined();
    expect(JSON.stringify(index.where)).toContain("toJSON");
  });
});
