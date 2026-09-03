import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
  type ValidityEndMutation,
} from "../src";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: "validity_end_types",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

declare const store: Store<typeof graph>;
const personId = asNodeId<typeof Person>("person");
const edgeId = asEdgeId<typeof knows>("edge");

/* eslint-disable unicorn/no-null -- Tests the explicit open-left protocol and unchanged upper-bound types. */
function assertAcceptedStoreCalls(): void {
  void store.nodes.Person.create({ name: "Alice" }, { validFrom: null });
  void store.nodes.Person.createFromRecord(
    { name: "Alice" },
    { validFrom: null },
  );
  void store.nodes.Person.upsertById(
    "person",
    { name: "Alice" },
    { validFrom: null },
  );
  void store.nodes.Person.bulkCreate([
    { props: { name: "Alice" }, validFrom: null },
  ]);
  void store.nodes.Person.bulkInsert([
    { props: { name: "Alice" }, validFrom: null },
  ]);
  void store.edges.knows.create(
    { kind: "Person", id: "a" },
    { kind: "Person", id: "b" },
    {},
    { validFrom: null },
  );
  void store.edges.knows.bulkUpsertById([
    {
      id: edgeId,
      from: { kind: "Person", id: "a" },
      to: { kind: "Person", id: "b" },
      validFrom: null,
    },
  ]);
  void store.nodes.Person.create(
    { name: "Alice" },
    {
      // @ts-expect-error the explicit open-left sentinel does not make arbitrary values valid
      validFrom: false,
    },
  );
  void store.nodes.Person.create(
    { name: "Alice" },
    {
      // @ts-expect-error validTo retains its existing set/clear protocol
      validTo: null,
    },
  );
  void store.nodes.Person.update(personId, {}, { clearValidTo: true });
  void store.nodes.Person.upsertById(
    "person",
    { name: "Alice" },
    { clearValidTo: true },
  );
  void store.nodes.Person.bulkUpsertById([
    {
      id: "person",
      props: { name: "Alice" },
      clearValidTo: true,
    },
  ]);
  void store.edges.knows.update(edgeId, {}, { clearValidTo: true });
  void store.edges.knows.bulkUpsertById([
    {
      id: edgeId,
      from: { kind: "Person", id: "a" },
      to: { kind: "Person", id: "b" },
      clearValidTo: true,
    },
  ]);
  void store.edges.knows.getOrCreateByEndpoints(
    { kind: "Person", id: "a" },
    { kind: "Person", id: "b" },
    {},
    { ifExists: "update", clearValidTo: true },
  );
  void store.edges.knows.bulkGetOrCreateByEndpoints([
    {
      from: { kind: "Person", id: "a" },
      to: { kind: "Person", id: "b" },
      props: {},
      clearValidTo: true,
    },
  ]);

  void store.nodes.Person.update(
    personId,
    {},
    {
      validTo: "2100-01-01T00:00:00.000Z",
      // @ts-expect-error set and clear cannot be requested together
      clearValidTo: true,
    },
  );
  void store.edges.knows.getOrCreateByEndpoints(
    { kind: "Person", id: "a" },
    { kind: "Person", id: "b" },
    {},
    {
      ifExists: "update",
      validTo: "2100-01-01T00:00:00.000Z",
      // @ts-expect-error endpoint updates enforce the same mutual exclusion
      clearValidTo: true,
    },
  );
}

/* eslint-enable unicorn/no-null */

describe("validity-end write types", () => {
  it("models set and clear as mutually exclusive operations", () => {
    expectTypeOf(graph).toHaveProperty("id");
    expectTypeOf<{ validTo: string }>().toExtend<ValidityEndMutation>();
    expectTypeOf<{ clearValidTo: true }>().toExtend<ValidityEndMutation>();
    expectTypeOf(assertAcceptedStoreCalls).toBeFunction();
  });
});
