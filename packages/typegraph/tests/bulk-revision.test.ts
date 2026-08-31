import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  recordedInstantRevision,
} from "../src";
import { createSqlSchema } from "../src/query/compiler/schema";
import { readRecordedClock } from "../src/store/recorded-capture";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows");
const graph = defineGraph({
  id: "bulk_revision_boundary",
  nodes: { Person: { type: Person } },
  edges: {
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

describe("bulk revision boundaries", () => {
  let backend: ReturnType<typeof createTestBackend>;
  let schema: ReturnType<typeof createSqlSchema>;
  let store: Awaited<ReturnType<typeof createStoreWithSchema<typeof graph>>>[0];

  beforeEach(async () => {
    backend = createTestBackend();
    schema = createSqlSchema(backend.tableNames);
    [store] = await createStoreWithSchema(graph, backend, {
      revisionTracking: true,
    });
  });

  async function revision(): Promise<number> {
    const instant = await readRecordedClock(backend, schema, graph.id);
    return instant === undefined ? 0 : recordedInstantRevision(instant);
  }

  async function expectOneRevision(
    write: () => Promise<unknown>,
  ): Promise<void> {
    const before = await revision();
    await write();
    expect(await revision()).toBe(before + 1);
  }

  it("advances once for every node bulk wrapper", async () => {
    await expectOneRevision(() =>
      store.nodes.Person.bulkCreate([
        { props: { name: "create-a" } },
        { props: { name: "create-b" } },
      ]),
    );
    await expectOneRevision(() =>
      store.nodes.Person.bulkInsert([
        { props: { name: "insert-a" } },
        { props: { name: "insert-b" } },
      ]),
    );
    await expectOneRevision(() =>
      store.nodes.Person.bulkUpsertById([
        { id: "upsert-a", props: { name: "upsert-a" } },
        { id: "upsert-b", props: { name: "upsert-b" } },
      ]),
    );
  });

  it("advances once for every edge bulk wrapper", async () => {
    const from = await store.nodes.Person.create(
      { name: "from" },
      { id: "from" },
    );
    const to = await store.nodes.Person.create({ name: "to" }, { id: "to" });
    await expectOneRevision(() =>
      store.edges.knows.bulkCreate([
        { from, to, id: "create-a" },
        { from, to, id: "create-b" },
      ]),
    );
    await expectOneRevision(() =>
      store.edges.knows.bulkInsert([
        { from, to, id: "insert-a" },
        { from, to, id: "insert-b" },
      ]),
    );
    await expectOneRevision(() =>
      store.edges.knows.bulkUpsertById([
        { id: asEdgeId("upsert-a"), from, to },
        { id: asEdgeId("upsert-b"), from, to },
      ]),
    );
  });
});
