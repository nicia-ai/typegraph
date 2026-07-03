/**
 * degree() direction filters must be servable by the default edge indexes.
 *
 * The edge composite indexes lead with `from_kind` / `to_kind` before the
 * id (`edges_from_idx (graph_id, from_kind, from_id, …)`), so a bare
 * `from_id = ?` filter can never seek — degree() scanned the graph's whole
 * edge partition. The direction filters now enumerate the endpoint kinds
 * the graph declaration permits for the counted edge kinds (expanded
 * through the subClassOf closure, since a stored `from_kind` may be any
 * subclass of a declared endpoint), which makes both indexes seekable on
 * both engines with no schema change.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string() }),
});
const Team = defineNode("Team", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows");
const memberOf = defineEdge("memberOf");

function buildGraph() {
  return defineGraph({
    id: "degree-idx",
    nodes: {
      Person: { type: Person },
      Employee: { type: Employee },
      Team: { type: Team },
    },
    edges: {
      knows: { type: knows, from: [Person], to: [Person] },
      memberOf: { type: memberOf, from: [Person], to: [Team] },
    },
    ontology: [subClassOf(Employee, Person)],
  });
}

type CapturedStatement = Readonly<{ sql: string; params: readonly unknown[] }>;

async function withCapturingStore<T>(
  run: (
    store: ReturnType<typeof createStore<ReturnType<typeof buildGraph>>>,
    captured: CapturedStatement[],
    client: Database.Database,
  ) => Promise<T>,
): Promise<T> {
  const { backend: raw, db } = createLocalSqliteBackend();
  try {
    const captured: CapturedStatement[] = [];
    const backend: GraphBackend = {
      ...raw,
      async execute(query) {
        const compiled = raw.compileSql?.(query);
        if (compiled) {
          captured.push({ sql: compiled.sql, params: compiled.params });
        }
        return raw.execute(query);
      },
    };
    const store = createStore(buildGraph(), backend);
    const client = (db as unknown as { $client: Database.Database }).$client;
    return await run(store, captured, client);
  } finally {
    await raw.close();
  }
}

function explainPlan(
  client: Database.Database,
  statement: CapturedStatement,
): string {
  const rows = client
    .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
    .all(...statement.params) as readonly { detail: string }[];
  return rows.map((row) => row.detail).join("\n");
}

describe("degree() direction filter index alignment", () => {
  it("seeks the from/to edge indexes instead of scanning the partition", async () => {
    await withCapturingStore(async (store, captured, client) => {
      // Enough rows (plus fresh statistics) that the planner's index choice
      // is driven by selectivity, not tiny-fixture heuristics.
      const people = await store.nodes.Person.bulkCreate(
        Array.from({ length: 40 }, (_, index) => ({
          props: { name: `p${index}` },
        })),
      );
      for (const [index, person] of people.entries()) {
        for (let step = 1; step <= 3; step++) {
          await store.edges.knows.create(
            person,
            people[(index + step) % people.length]!,
          );
        }
      }
      await store.refreshStatistics();
      const alice = people[0]!;
      const bob = people[1]!;

      captured.length = 0;
      await store.algorithms.degree(alice.id, { direction: "out" });
      const outPlan = explainPlan(client, captured.at(-1)!);
      expect(outPlan).toContain("typegraph_edges_from_idx");
      expect(outPlan).not.toContain("SCAN typegraph_edges");

      captured.length = 0;
      await store.algorithms.degree(bob.id, { direction: "in" });
      const inPlan = explainPlan(client, captured.at(-1)!);
      expect(inPlan).toContain("typegraph_edges_to_idx");
      expect(inPlan).not.toContain("SCAN typegraph_edges");

      captured.length = 0;
      await store.algorithms.degree(alice.id);
      const bothPlan = explainPlan(client, captured.at(-1)!);
      expect(bothPlan).not.toContain("SCAN typegraph_edges");
    });
  });

  it("counts edges whose endpoint kind is a subclass of the declared kind", async () => {
    await withCapturingStore(async (store) => {
      const employee = await store.nodes.Employee.create({ name: "emp" });
      const person = await store.nodes.Person.create({ name: "per" });
      const team = await store.nodes.Team.create({ name: "team" });

      // knows declares from/to [Person]; Employee is a subclass, so the
      // stored from_kind is "Employee" — the enumerated endpoint kinds
      // must include subclasses or these edges silently vanish from the
      // count.
      await store.edges.knows.create(employee as never, person);
      await store.edges.memberOf.create(employee as never, team);

      expect(
        await store.algorithms.degree(employee.id, { direction: "out" }),
      ).toBe(2);
      expect(
        await store.algorithms.degree(person.id, { direction: "in" }),
      ).toBe(1);
      expect(await store.algorithms.degree(team.id, { direction: "in" })).toBe(
        1,
      );
      expect(await store.algorithms.degree(employee.id)).toBe(2);
      expect(
        await store.algorithms.degree(employee.id, { edges: ["memberOf"] }),
      ).toBe(1);
    });
  });

  it("still deduplicates self-loops under direction both", async () => {
    await withCapturingStore(async (store) => {
      const solo = await store.nodes.Person.create({ name: "solo" });
      await store.edges.knows.create(solo, solo);

      expect(await store.algorithms.degree(solo.id)).toBe(1);
      expect(await store.algorithms.degree(solo.id, { direction: "out" })).toBe(
        1,
      );
      expect(await store.algorithms.degree(solo.id, { direction: "in" })).toBe(
        1,
      );
    });
  });
});
