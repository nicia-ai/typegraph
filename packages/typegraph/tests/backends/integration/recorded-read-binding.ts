import { describe, expect, it } from "vitest";

import {
  asRecordedInstant,
  createSqlSchema,
  createStore,
  type NodeId,
  type RecordedInstant,
  recordedRelation,
} from "../../../src";
import {
  resolveReadCoordinate,
  withRecordedCoordinate,
} from "../../../src/core/temporal";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../../src/query/sql-intent";
import { STORE_RUNTIME } from "../../../src/store/runtime-port";
import { type HistoryIntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

async function createHistoryStore(
  context: IntegrationTestContext,
): Promise<HistoryIntegrationStore> {
  return context.createHistoryStore(integrationTestGraph);
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

      const scan = await readStore
        .asOfRecorded(recordedAtCreate)
        .nodes.Person.scan({ limit: 1 });
      expect(scan.data.map((person) => person.name)).toEqual(["Alice"]);
      expect(scan.hasNextPage).toBe(false);

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

      const scan = await readStore
        .asOfRecorded(recordedAtCreate)
        .edges.knows.scan({ limit: 1 });
      expect(scan.data.map((found) => found.since)).toEqual(["2020"]);
      expect(scan.hasNextPage).toBe(false);

      await readStore.edges.knows.update(edge.id, { since: "live-only" });
      expect(await historyStore.recordedNow()).toBe(recordedAtUpdate);

      const live = await readStore.edges.knows.getById(edge.id);
      const recordedAfterUncapturedWrite = await readStore
        .asOfRecorded(recordedAtUpdate)
        .edges.knows.getById(edge.id);
      expect(live?.since).toBe("live-only");
      expect(recordedAfterUncapturedWrite?.since).toBe("2021");
    });

    it("binds externally populated recorded identity assertions", async () => {
      const backend = context.getStore().backend;
      const historyStore = await createHistoryStore(context);
      const person = await historyStore.nodes.Person.create({ name: "Alice" });
      const company = await historyStore.nodes.Company.create({ name: "Acme" });
      const assertion = await historyStore.identity.assertSame(person, company);
      const assertedAt = requireRecordedInstant(
        await historyStore.recordedNow(),
        "expected recorded instant after identity assertion",
      );
      await historyStore.identity.retractAssertion(assertion.assertion.id);

      const readStore = createStore(integrationTestGraph, backend, {
        recordedRead: recordedRelation({
          schema: createSqlSchema(backend.tableNames),
        }),
      });

      expect(
        await readStore
          .asOfRecorded(assertedAt)
          .identity.areSame(person, company),
      ).toBe(true);
      expect(await readStore.identity.areSame(person, company)).toBe(false);
    });

    it("routes recorded identity reads through the binding's DIVERGENT table names", async () => {
      // Regression guard for the recorded-read binding bypass: identity reads
      // at a recorded coordinate must reconstruct from the SAME recorded
      // relation node reads use — the binding's tables — not TypeGraph's
      // default-named recorded identity table. The sibling test above binds a
      // relation whose names are identical to the live schema, so it cannot
      // observe the bypass. Here the recorded identity assertions live under a
      // DIVERGENT table name while the default-named table is emptied, so a
      // store that read the default names would see no assertion and wrongly
      // report the pair as distinct.
      const backend = context.getStore().backend;
      const executeStatement = backend.executeStatement;
      if (executeStatement === undefined) {
        throw new Error(
          "Operational Identity requires a backend with statement execution.",
        );
      }

      const historyStore = await createHistoryStore(context);
      const person = await historyStore.nodes.Person.create({ name: "Alice" });
      const company = await historyStore.nodes.Company.create({ name: "Acme" });
      const assertion = await historyStore.identity.assertSame(person, company);
      const assertedAt = requireRecordedInstant(
        await historyStore.recordedNow(),
        "expected recorded instant after identity assertion",
      );
      await historyStore.identity.retractAssertion(assertion.assertion.id);

      // Move the captured recorded identity assertions to a divergent table
      // name and empty the default-named one, so only the divergent table
      // holds the recorded truth.
      const defaultRecordedIdentity =
        backend.tableNames?.recordedIdentityAssertions ??
        "typegraph_recorded_identity_assertions";
      const divergentRecordedIdentity =
        "divergent_recorded_identity_assertions";
      // Server-Postgres lanes share one database across backend variants, so
      // a previous lane's divergent table may still exist.
      await executeStatement(
        asCompiledStatementSql(
          sql`DROP TABLE IF EXISTS ${sql.raw(divergentRecordedIdentity)}`,
        ),
      );
      await executeStatement(
        asCompiledStatementSql(
          sql`CREATE TABLE ${sql.raw(divergentRecordedIdentity)} AS SELECT * FROM ${sql.raw(defaultRecordedIdentity)}`,
        ),
      );
      await executeStatement(
        asCompiledStatementSql(
          sql`DELETE FROM ${sql.raw(defaultRecordedIdentity)}`,
        ),
      );

      // The read store keeps default names for its own schema; only the bound
      // recorded relation points identity assertions at the divergent table.
      const readStore = createStore(integrationTestGraph, backend, {
        recordedRead: recordedRelation({
          schema: createSqlSchema({
            ...backend.tableNames,
            recordedIdentityAssertions: divergentRecordedIdentity,
          }),
        }),
      });

      // Node reads at the coordinate still see real rows (they already route
      // through the binding), proving identity must read the same relation.
      const recordedPerson = await readStore
        .asOfRecorded(assertedAt)
        .nodes.Person.getById(person.id);
      expect(recordedPerson?.name).toBe("Alice");

      const members = await readStore
        .asOfRecorded(assertedAt)
        .identity.membersOf(person);
      expect(members).toEqual(
        expect.arrayContaining([
          { kind: "Person", id: person.id },
          { kind: "Company", id: company.id },
        ]),
      );
      expect(members).toHaveLength(2);
      expect(
        await readStore
          .asOfRecorded(assertedAt)
          .identity.areSame(person, company),
      ).toBe(true);
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
          .asOfRecorded(
            asRecordedInstant("r1:0000000000000001:2026-01-01T00:00:00.000Z"),
          ),
      ).toThrow("asOfRecorded() requires a recorded read relation");
    });

    it("view.asOfRecorded() refuses on a store without a recorded read binding", () => {
      expect(() =>
        context
          .getStore()
          .asOf("2026-01-01T00:00:00.000Z")
          .asOfRecorded(
            asRecordedInstant("r1:0000000000000001:2026-01-01T00:00:00.000Z"),
          ),
      ).toThrow("asOfRecorded() requires a recorded read relation");
    });

    it("recorded point-read seams refuse on a store without a recorded read binding", async () => {
      type PersonType =
        (typeof integrationTestGraph)["nodes"]["Person"]["type"];
      const coordinate = withRecordedCoordinate(
        resolveReadCoordinate("asOf", "2026-01-01T00:00:00.000Z"),
        asRecordedInstant("r1:0000000000000001:2026-01-01T00:00:00.000Z"),
      );

      await expect(
        context
          .getStore()
          [STORE_RUNTIME].recordedNodeGetById(
            "Person",
            "missing" as NodeId<PersonType>,
            coordinate,
          ),
      ).rejects.toThrow("Recorded-time reads require a recorded read relation");
    });
  });
}
