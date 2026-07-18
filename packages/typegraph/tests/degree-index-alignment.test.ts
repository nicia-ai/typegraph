/**
 * degree() direction filters must be servable by the default edge indexes —
 * and must count every incident edge while doing it.
 *
 * The edge composite indexes lead with `from_kind` / `to_kind` before the
 * id (`edges_from_idx (graph_id, from_kind, from_id, …)`), so a bare
 * `from_id = ?` filter can never seek — degree() scanned the graph's whole
 * edge partition. The direction filters supply the missing kind equality from
 * the counted node's own kind, read back with an uncorrelated scalar subquery:
 * a stored `from_kind` IS the kind of the node at `from_id`, always, because
 * the write path copies it off the endpoint node and a node's kind never
 * changes.
 *
 * Enumerating the graph's *declared* endpoint kinds instead would seek just as
 * well but is only complete for rows written under the current declaration —
 * see the endpoint-drift case below.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type StoreOptions,
  subClassOf,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { requireDefined } from "../src/utils/presence";
import {
  type CapturedStatement,
  createPlanCaptureBackend,
  explainQueryPlan,
} from "./test-utils";

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

async function withCapturingStore<T>(
  run: (
    store: ReturnType<typeof createStore<ReturnType<typeof buildGraph>>>,
    captured: CapturedStatement[],
    client: Database.Database,
  ) => Promise<T>,
  options?: StoreOptions,
): Promise<T> {
  const { backend, captured, client } = createPlanCaptureBackend();
  const store = createStore(buildGraph(), backend, options);
  return await run(store, captured, client);
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
            requireDefined(people[(index + step) % people.length]),
          );
        }
      }
      await store.refreshStatistics();
      const alice = requireDefined(people[0]);
      const bob = requireDefined(people[1]);

      captured.length = 0;
      await store.algorithms.degree(alice.id, { direction: "out" });
      const outPlan = explainQueryPlan(client, requireDefined(captured.at(-1)));
      expect(outPlan).toContain("typegraph_edges_from_idx");
      expect(outPlan).not.toContain("SCAN typegraph_edges");
      // The node-kind subquery resolves the seed's kind by bare id; without
      // the (graph_id, id) node index it scans the graph's node partition.
      expect(outPlan).toContain("typegraph_nodes_id_idx");
      expect(outPlan).not.toContain("SCAN typegraph_nodes");

      captured.length = 0;
      await store.algorithms.degree(bob.id, { direction: "in" });
      const inPlan = explainQueryPlan(client, requireDefined(captured.at(-1)));
      expect(inPlan).toContain("typegraph_edges_to_idx");
      expect(inPlan).not.toContain("SCAN typegraph_edges");

      captured.length = 0;
      await store.algorithms.degree(alice.id);
      const bothPlan = explainQueryPlan(
        client,
        requireDefined(captured.at(-1)),
      );
      expect(bothPlan).not.toContain("SCAN typegraph_edges");
    });
  });

  it("seeks the recorded bare-id node index at a recorded coordinate", async () => {
    await withCapturingStore(
      async (store, captured, client) => {
        const people = await store.nodes.Person.bulkCreate(
          Array.from({ length: 40 }, (_, index) => ({
            props: { name: `p${index}` },
          })),
        );
        for (const [index, person] of people.entries()) {
          for (let step = 1; step <= 3; step++) {
            await store.edges.knows.create(
              person,
              requireDefined(people[(index + step) % people.length]),
            );
          }
        }
        await store.refreshStatistics();
        const pin = await store.recordedNow();
        if (pin === undefined) {
          throw new Error("recorded clock was not written");
        }
        const alice = requireDefined(people[0]);

        // A recorded pin swaps the node source to the recorded relation,
        // whose entity index leads with `kind` — the kind-by-bare-id probe
        // needs the recorded (graph_id, id) index to seek.
        captured.length = 0;
        const outDegree = await store
          .asOfRecorded(pin)
          .degree(alice.id, { direction: "out" });
        expect(outDegree).toBe(3);
        const plan = explainQueryPlan(client, requireDefined(captured.at(-1)));
        expect(plan).toContain("typegraph_recorded_nodes_id_idx");
        expect(plan).not.toContain("SCAN typegraph_recorded_nodes");
      },
      { history: true },
    );
  });

  it("counts edges whose endpoint kind is a subclass of the declared kind", async () => {
    await withCapturingStore(async (store) => {
      const employee = await store.nodes.Employee.create({ name: "emp" });
      const person = await store.nodes.Person.create({ name: "per" });
      const team = await store.nodes.Team.create({ name: "team" });

      // knows declares from/to [Person]; Employee is a subclass, so the
      // stored from_kind is "Employee" — a filter derived from the declaration
      // alone must expand subclasses or these edges silently vanish from the
      // count. Deriving it from the node's own kind is exact by construction.
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

  it("counts edges written before an endpoint declaration narrowed", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      // Edges are written while `knows` still admits Person on both sides.
      const wide = createStore(buildGraph(), backend);
      const employee = await wide.nodes.Employee.create({ name: "emp" });
      const person = await wide.nodes.Person.create({ name: "per" });
      await wide.edges.knows.create(person, employee as never);
      await wide.edges.knows.create(employee as never, person);

      // The declaration then narrows to Employee-only endpoints. The rows on
      // disk still carry from_kind/to_kind = "Person" for `person`, which no
      // declared endpoint of `knows` now names. A filter enumerating the
      // declared kinds would count 0 for `person`; its actual degree is 2.
      const narrowed = createStore(
        defineGraph({
          id: "degree-idx",
          nodes: {
            Person: { type: Person },
            Employee: { type: Employee },
            Team: { type: Team },
          },
          edges: {
            knows: { type: knows, from: [Employee], to: [Employee] },
            memberOf: { type: memberOf, from: [Employee], to: [Team] },
          },
          ontology: [subClassOf(Employee, Person)],
        }),
        backend,
      );

      expect(await narrowed.algorithms.degree(person.id)).toBe(2);
      expect(
        await narrowed.algorithms.degree(person.id, { direction: "out" }),
      ).toBe(1);
      expect(
        await narrowed.algorithms.degree(person.id, { direction: "in" }),
      ).toBe(1);
      expect(await narrowed.algorithms.degree(employee.id)).toBe(2);
    } finally {
      await backend.close();
    }
  });

  it("reports degree 0 for an id that names no node", async () => {
    await withCapturingStore(async (store) => {
      const person = await store.nodes.Person.create({ name: "per" });
      await store.edges.knows.create(person, person);

      // The kind subquery yields NULL, and `from_kind = NULL` matches nothing.
      expect(await store.algorithms.degree("no-such-node")).toBe(0);
    });
  });
});
