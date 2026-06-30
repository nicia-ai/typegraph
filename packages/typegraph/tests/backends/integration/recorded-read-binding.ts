import { describe, expect, it } from "vitest";

import {
  asRecordedInstant,
  createSqlSchema,
  createStore,
  createStoreWithSchema,
  type NodeId,
  type RecordedInstant,
  recordedRelation,
} from "../../../src";
import {
  resolveReadCoordinate,
  withRecordedCoordinate,
} from "../../../src/core/temporal";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

async function createHistoryStore(
  context: IntegrationTestContext,
): Promise<IntegrationStore> {
  const [store] = await createStoreWithSchema(
    integrationTestGraph,
    context.getStore().backend,
    { history: true },
  );
  return store;
}

function requireRecordedInstant(
  instant: RecordedInstant | undefined,
  message: string,
): RecordedInstant {
  expect(instant).toBeDefined();
  if (instant === undefined) throw new Error(message);
  return instant;
}

export function registerRecordedReadBindingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Recorded read binding", () => {
    it("binds an externally populated recorded relation for reads only", async () => {
      const backend = context.getStore().backend;
      const historyStore = await createHistoryStore(context);
      const alice = await historyStore.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      const recordedAtCreate = requireRecordedInstant(
        await historyStore.recordedNow(),
        "expected recorded instant after person create",
      );

      await historyStore.nodes.Person.update(alice.id, { name: "Alicia" });
      const recordedAtUpdate = requireRecordedInstant(
        await historyStore.recordedNow(),
        "expected recorded instant after person update",
      );
      expect(recordedAtCreate < recordedAtUpdate).toBe(true);

      const readStore = createStore(integrationTestGraph, backend, {
        recordedRead: recordedRelation({
          schema: createSqlSchema(backend.tableNames),
        }),
      });

      expect(readStore.historyEnabled).toBe(false);
      expect(readStore.recordedReadBound).toBe(true);
      await expect(readStore.recordedNow()).rejects.toThrow(
        "recordedNow() requires a store created with { history: true }",
      );

      const atCreate = await readStore
        .asOfRecorded(recordedAtCreate)
        .nodes.Person.getById(alice.id);
      const atUpdate = await readStore
        .asOfRecorded(recordedAtUpdate)
        .nodes.Person.getById(alice.id);
      expect(atCreate?.name).toBe("Alice");
      expect(atUpdate?.name).toBe("Alicia");

      const rows = await readStore
        .asOfRecorded(recordedAtCreate)
        .query()
        .from("Person", "person")
        .whereNode("person", (person) => person.name.eq("Alice"))
        .select((select) => select.person.name)
        .execute();
      expect(rows).toEqual(["Alice"]);

      await readStore.nodes.Person.update(alice.id, {
        name: "Live-only update",
      });
      expect(await historyStore.recordedNow()).toBe(recordedAtUpdate);

      const live = await readStore.nodes.Person.getById(alice.id);
      const recordedAfterUncapturedWrite = await readStore
        .asOfRecorded(recordedAtUpdate)
        .nodes.Person.getById(alice.id);
      expect(live?.name).toBe("Live-only update");
      expect(recordedAfterUncapturedWrite?.name).toBe("Alicia");
    });

    it("binds an externally populated recorded relation for edge point reads", async () => {
      const backend = context.getStore().backend;
      const historyStore = await createHistoryStore(context);
      const alice = await historyStore.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      const bob = await historyStore.nodes.Person.create({
        name: "Bob",
        age: 31,
      });
      const edge = await historyStore.edges.knows.create(alice, bob, {
        since: "2020",
      });
      const recordedAtCreate = requireRecordedInstant(
        await historyStore.recordedNow(),
        "expected recorded instant after edge create",
      );

      await historyStore.edges.knows.update(edge.id, { since: "2021" });
      const recordedAtUpdate = requireRecordedInstant(
        await historyStore.recordedNow(),
        "expected recorded instant after edge update",
      );
      expect(recordedAtCreate < recordedAtUpdate).toBe(true);

      const readStore = createStore(integrationTestGraph, backend, {
        recordedRead: recordedRelation({
          schema: createSqlSchema(backend.tableNames),
        }),
      });

      const edgeAtCreate = await readStore
        .asOfRecorded(recordedAtCreate)
        .edges.knows.getById(edge.id);
      const edgeAtUpdate = await readStore
        .asOfRecorded(recordedAtUpdate)
        .edges.knows.getById(edge.id);
      expect(edgeAtCreate?.since).toBe("2020");
      expect(edgeAtUpdate?.since).toBe("2021");

      const ordered = await readStore
        .asOfRecorded(recordedAtUpdate)
        .edges.knows.getByIds([edge.id, "missing-edge" as never, edge.id]);
      expect(ordered.map((found) => found?.since)).toEqual([
        "2021",
        undefined,
        "2021",
      ]);

      await readStore.edges.knows.update(edge.id, { since: "live-only" });
      expect(await historyStore.recordedNow()).toBe(recordedAtUpdate);

      const live = await readStore.edges.knows.getById(edge.id);
      const recordedAfterUncapturedWrite = await readStore
        .asOfRecorded(recordedAtUpdate)
        .edges.knows.getById(edge.id);
      expect(live?.since).toBe("live-only");
      expect(recordedAfterUncapturedWrite?.since).toBe("2021");
    });

    it("recordedNow() refuses on a store without history capture", async () => {
      await expect(context.getStore().recordedNow()).rejects.toThrow(
        "recordedNow() requires a store created with { history: true }",
      );
    });

    it("asOfRecorded() refuses on a store without a recorded read binding", () => {
      expect(() =>
        context
          .getStore()
          .asOfRecorded(asRecordedInstant("2026-01-01T00:00:00.000Z")),
      ).toThrow("asOfRecorded() requires a recorded read relation");
    });

    it("view.asOfRecorded() refuses on a store without a recorded read binding", () => {
      expect(() =>
        context
          .getStore()
          .asOf("2026-01-01T00:00:00.000Z")
          .asOfRecorded(asRecordedInstant("2026-01-01T00:00:00.000Z")),
      ).toThrow("asOfRecorded() requires a recorded read relation");
    });

    it("recorded point-read seams refuse on a store without a recorded read binding", async () => {
      type PersonType =
        (typeof integrationTestGraph)["nodes"]["Person"]["type"];
      const coordinate = withRecordedCoordinate(
        resolveReadCoordinate("asOf", "2026-01-01T00:00:00.000Z"),
        asRecordedInstant("2026-01-01T00:00:00.000Z"),
      );

      await expect(
        context
          .getStore()
          .recordedNodeGetById(
            "Person",
            "missing" as NodeId<PersonType>,
            coordinate,
          ),
      ).rejects.toThrow("Recorded-time reads require a recorded read relation");
    });
  });
}
