/**
 * The repair story for validity windows an older library version stored
 * inverted (`valid_from > valid_to`), design §C.
 *
 * Such a row is readable at NO coordinate: `asOf(t)` needs
 * `valid_from <= t < valid_to`, and backwards bounds admit no `t`. Current
 * write paths cannot mint one — a write that stamps a lower bound the caller
 * did not state stores none rather than an inverting one — but deploying that
 * fix rewrites nothing, so a legacy row stays invisible until an operator runs
 * `repairInvertedValidityWindows`.
 *
 * That is also why every row here is seeded with raw SQL: the store API can no
 * longer produce the shape under test, and a suite that seeded through it would
 * be testing a state the repair does not exist for.
 *
 * Covered here (SQLite; the PostgreSQL parity suite is
 * `tests/backends/postgres/repair-validity-windows.test.ts`):
 *
 * - **T6** `report` finds the row and writes NOTHING — and says so to the
 *   engine, opening its scan in a read-only transaction so a diagnostic pointed
 *   at a live store neither writes nor reserves SQLite's single writer slot.
 * - **T7** `apply` is convergent and idempotent, and changes only inverted
 *   rows — a stated zero-width window is a legal shape and is left alone.
 * - **T7b** the three deployment shapes, each scoped per mode: custom table
 *   names, including partial patches, are APPLIED in both modes; a backend
 *   without `executeStatement` and a recorded-capture backend both REPORT
 *   successfully and REFUSE `apply` with a typed error naming the state. The
 *   capture case carries T6's "writes
 *   nothing" onto the RECORDED axis — clock included — because that backend's
 *   `transaction` is the one read path that opens a capture scope.
 * - **T7c** `report` distinguishes "not scanned" (`undefined`) from "zero".
 * - **T7d** atomicity is reported from the transaction seam rather than object
 *   identity; a backend without transactions still runs both modes and reports
 *   `atomic === false`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { Store } from "../src";
import {
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  repairInvertedValidityWindows,
} from "../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { invertedValidityWindowPredicate } from "../src/backend/repair-validity-windows";
import {
  type GraphBackend,
  type TransactionBackend,
  type TransactionOptions,
} from "../src/backend/types";
import { asNodeId } from "../src/core";
import { renderSql, sql } from "../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import { createRecordedBackend } from "../src/store/recorded-capture";
import { requireDefined } from "../src/utils/presence";
import { createInitializedStore, createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

const graph = defineGraph({
  id: "temporal_repair",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const NODES = "typegraph_nodes";
const EDGES = "typegraph_edges";
const RECORDED_NODES = "typegraph_recorded_nodes";
const RECORDED_EDGES = "typegraph_recorded_edges";
const RECORDED_CLOCK = "typegraph_recorded_clock";

const EARLY = "2020-01-01T00:00:00.000Z";
const MIDDLE = "2022-01-01T00:00:00.000Z";
const LATE = "2024-01-01T00:00:00.000Z";

type RawRow = Readonly<Record<string, unknown>>;

/**
 * Writes a window straight into the relation, bypassing every guard — the only
 * way to reach a shape the library refuses to write.
 */
async function seedWindow(
  backend: GraphBackend,
  table: string,
  id: string,
  window: Readonly<{ validFrom: string | undefined; validTo: string }>,
): Promise<void> {
  const lowerBound =
    window.validFrom === undefined ? sql`NULL` : sql`${window.validFrom}`;
  await requireDefined(backend.executeStatement)(
    asCompiledStatementSql(sql`
      UPDATE ${sql.identifier(table)}
      SET valid_from = ${lowerBound}, valid_to = ${window.validTo}
      WHERE id = ${id}
    `),
  );
}

/**
 * A recorded row carrying the pre-fix shape, seeded the same way a legacy
 * capture would have left it. Raw SQL for the same reason the live seeds are: a
 * history store can no more mint an inverted recorded window than the live
 * store can.
 */
async function seedRecordedNode(
  backend: GraphBackend,
  id: string,
  window: Readonly<{ validFrom: string; validTo: string }>,
): Promise<void> {
  await requireDefined(backend.executeStatement)(
    asCompiledStatementSql(sql`
      INSERT INTO ${sql.identifier(RECORDED_NODES)} (
        history_id, graph_id, kind, id, props, version,
        valid_from, valid_to, created_at, updated_at,
        recorded_from, recorded_to, op, meta
      ) VALUES (
        ${`h_${id}`}, ${graph.id}, 'Person', ${id},
        ${JSON.stringify({ name: id })}, 1,
        ${window.validFrom}, ${window.validTo}, ${EARLY}, ${EARLY},
        1, 2, 'create', '{}'
      )
    `),
  );
}

/**
 * A per-graph recorded clock standing where a history-enabled deployment's
 * would. Seeded rather than left empty so that "the repair advanced the clock"
 * is a visible difference and not just a row appearing.
 */
async function seedRecordedClock(
  backend: GraphBackend,
  revision: number,
): Promise<void> {
  await requireDefined(backend.executeStatement)(
    asCompiledStatementSql(sql`
      INSERT INTO ${sql.identifier(RECORDED_CLOCK)}
        (graph_id, revision, recorded_at)
      VALUES (${graph.id}, ${revision}, ${EARLY})
    `),
  );
}

/**
 * Every column of every row, ordered — the byte-identity witness for T6.
 *
 * `orderBy` names the relation's own stable key: the ledgers order by `id`, the
 * recorded clock has one row per `graph_id` and no `id` column at all.
 */
async function readRelation(
  backend: GraphBackend,
  table: string,
  orderBy = "id",
): Promise<readonly RawRow[]> {
  return backend.execute<RawRow>(
    asCompiledRowsSql(sql`
      SELECT * FROM ${sql.identifier(table)} ORDER BY ${sql.identifier(orderBy)}
    `),
  );
}

/**
 * The whole recorded axis: both recorded ledgers and the clock that mints
 * revisions over them. What a `"report"` must leave untouched — not only the
 * rows, but the clock, because minting a revision is how a capture-wrapped
 * backend would write while storing no row of its own.
 */
async function readRecordedAxis(
  backend: GraphBackend,
): Promise<Readonly<Record<string, readonly RawRow[]>>> {
  return {
    recordedNodes: await readRelation(backend, RECORDED_NODES),
    recordedEdges: await readRelation(backend, RECORDED_EDGES),
    recordedClock: await readRelation(backend, RECORDED_CLOCK, "graph_id"),
  };
}

/**
 * The stored window, with SQL NULL mapped to `undefined` — the shape the row
 * mappers hand the rest of the library, and the one this suite asserts.
 */
async function readWindow(
  backend: GraphBackend,
  table: string,
  id: string,
): Promise<
  Readonly<{ validFrom: string | undefined; validTo: string | undefined }>
> {
  const rows = await backend.execute<
    Readonly<{ valid_from: unknown; valid_to: unknown }>
  >(
    asCompiledRowsSql(sql`
      SELECT valid_from, valid_to FROM ${sql.identifier(table)} WHERE id = ${id}
    `),
  );
  const row = requireDefined(rows[0]);
  return {
    validFrom: typeof row.valid_from === "string" ? row.valid_from : undefined,
    validTo: typeof row.valid_to === "string" ? row.valid_to : undefined,
  };
}

/**
 * One graph holding every window shape the repair must tell apart:
 *
 * - `inverted` — the defect: backwards bounds, readable nowhere.
 * - `zeroWidth` — legal: a caller may state `[a, a)` in full, and the repair
 *   does not second-guess a window nobody stamped.
 * - `ordered` — an ordinary bounded row.
 * - `openLeft` — already the shape the repair normalizes to.
 */
async function seedGraph(backend: GraphBackend): Promise<Store<typeof graph>> {
  const store = await createInitializedStore(graph, backend);
  for (const id of ["inverted", "zeroWidth", "ordered", "openLeft"]) {
    await store.nodes.Person.create({ name: id }, { id });
  }
  await store.edges.knows.create(
    { kind: "Person", id: "inverted" },
    { kind: "Person", id: "ordered" },
    { since: EARLY },
    { id: "invertedEdge" },
  );
  await seedWindow(backend, NODES, "inverted", {
    validFrom: LATE,
    validTo: EARLY,
  });
  await seedWindow(backend, NODES, "zeroWidth", {
    validFrom: MIDDLE,
    validTo: MIDDLE,
  });
  await seedWindow(backend, NODES, "ordered", {
    validFrom: EARLY,
    validTo: LATE,
  });
  await seedWindow(backend, NODES, "openLeft", {
    validFrom: undefined,
    validTo: LATE,
  });
  await seedWindow(backend, EDGES, "invertedEdge", {
    validFrom: LATE,
    validTo: EARLY,
  });
  return store;
}

describe("repairInvertedValidityWindows", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  describe("T6 — report mode", () => {
    it("finds a seeded legacy inverted row and writes nothing", async () => {
      await seedGraph(backend);
      const before = {
        nodes: await readRelation(backend, NODES),
        edges: await readRelation(backend, EDGES),
      };

      const report = await repairInvertedValidityWindows({
        backend,
        relations: "live-and-recorded",
        mode: "report",
      });

      expect(report.counts).toEqual({
        nodes: 1,
        edges: 1,
        recordedNodes: 0,
        recordedEdges: 0,
      });
      // Byte identity over EVERY column, not just the window: a report that
      // ran the apply statement would change `valid_from` here, and one that
      // touched `version`/`updated_at` would change those.
      expect({
        nodes: await readRelation(backend, NODES),
        edges: await readRelation(backend, EDGES),
      }).toEqual(before);
    });

    it("opens a read-only transaction to scan, and a writing one to apply", async () => {
      await seedGraph(backend);
      const accessModes: (TransactionOptions["accessMode"] | undefined)[] = [];
      // White-box on purpose: the engine effect this pins — `BEGIN` instead of
      // the writer-slot-reserving `BEGIN IMMEDIATE` — is invisible from the one
      // connection a test holds. What IS observable is the decision itself, and
      // that is what the docs promise operators when they say a `report` may be
      // pointed at a live store without quiescing it. The PostgreSQL suite
      // asserts the engine's own verdict (`SHOW transaction_read_only`).
      const observed: GraphBackend = deriveBackend(backend, {
        transaction: async <T>(
          fn: (tx: TransactionBackend) => Promise<T>,
          options?: TransactionOptions,
        ): Promise<T> => {
          accessModes.push(options?.accessMode);
          return backend.transaction((tx) => fn(tx), options);
        },
      });

      await repairInvertedValidityWindows({
        backend: observed,
        relations: "live-and-recorded",
        mode: "report",
      });
      await repairInvertedValidityWindows({
        backend: observed,
        relations: "live",
        mode: "apply",
      });

      expect(accessModes).toEqual(["read_only", undefined]);
    });

    it("reports the same counts twice, because it changes nothing", async () => {
      await seedGraph(backend);
      const first = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "report",
      });
      const second = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "report",
      });
      expect(second.counts).toEqual(first.counts);
      expect(first.counts.nodes).toBe(1);
    });
  });

  describe("T7 — apply mode", () => {
    it("repairs only inverted rows and converges", async () => {
      const store = await seedGraph(backend);

      const applied = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "apply",
      });
      expect(applied.counts.nodes).toBe(1);
      expect(applied.counts.edges).toBe(1);
      expect(applied.atomic).toBe(true);

      expect(await readWindow(backend, NODES, "inverted")).toEqual({
        validFrom: undefined,
        validTo: EARLY,
      });
      expect(await readWindow(backend, EDGES, "invertedEdge")).toEqual({
        validFrom: undefined,
        validTo: EARLY,
      });
      // A stated zero-width window is legal and is NOT the defect: it is
      // readable at no instant because its author said so.
      expect(await readWindow(backend, NODES, "zeroWidth")).toEqual({
        validFrom: MIDDLE,
        validTo: MIDDLE,
      });
      expect(await readWindow(backend, NODES, "ordered")).toEqual({
        validFrom: EARLY,
        validTo: LATE,
      });

      // The point of the repair: the row is now readable before its end.
      await expect(
        store.nodes.Person.getById(asNodeId<typeof Person>("inverted"), {
          temporalMode: "asOf",
          asOf: "2019-01-01T00:00:00.000Z",
        }),
      ).resolves.toBeDefined();
    });

    it("is idempotent: a second run reports zero and changes nothing", async () => {
      await seedGraph(backend);
      await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "apply",
      });
      const after = {
        nodes: await readRelation(backend, NODES),
        edges: await readRelation(backend, EDGES),
      };

      const second = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "apply",
      });
      expect(second.counts.nodes).toBe(0);
      expect(second.counts.edges).toBe(0);
      expect({
        nodes: await readRelation(backend, NODES),
        edges: await readRelation(backend, EDGES),
      }).toEqual(after);

      const report = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "report",
      });
      expect(report.counts.nodes).toBe(0);
      expect(report.counts.edges).toBe(0);
    });

    it("leaves a row whose bounds it cannot classify alone, and refuses", async () => {
      await seedGraph(backend);
      // SQLite compares TEXT lexicographically, so a non-canonical bound cannot
      // be classified without a semantics this repair does not own.
      await seedWindow(backend, NODES, "ordered", {
        validFrom: "2024",
        validTo: EARLY,
      });

      const report = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "report",
      });
      expect(report.nonCanonical.nodes).toBe(1);
      expect(report.nonCanonical.edges).toBe(0);
      // Not classified, so not counted as inverted either.
      expect(report.counts.nodes).toBe(1);

      await expect(
        repairInvertedValidityWindows({
          backend,
          relations: "live",
          mode: "apply",
        }),
      ).rejects.toThrow(/non-canonical bounds/);
      // The refusal is total for the call: nothing was repaired.
      expect(await readWindow(backend, NODES, "inverted")).toEqual({
        validFrom: LATE,
        validTo: EARLY,
      });
    });

    it("narrows to one graph when graphId is given", async () => {
      await seedGraph(backend);
      const report = await repairInvertedValidityWindows({
        backend,
        graphId: "some_other_graph",
        relations: "live",
        mode: "apply",
      });
      expect(report.counts.nodes).toBe(0);
      expect(await readWindow(backend, NODES, "inverted")).toEqual({
        validFrom: LATE,
        validTo: EARLY,
      });
    });

    it("establishes canonicality before comparing, on SQLite only", () => {
      // The predicate TEXT is one owner; its SEMANTICS are not dialect-neutral.
      // SQLite compares the bounds as TEXT, so `>` is chronological only for
      // canonical values — which is exactly what a relation holding legacy rows
      // cannot be assumed to hold. PostgreSQL stores `timestamptz`, where the
      // comparison is chronological unconditionally.
      const sqlite = renderSql(
        invertedValidityWindowPredicate({ dialect: "sqlite" }),
        "sqlite",
      ).sql;
      const postgres = renderSql(
        invertedValidityWindowPredicate({ dialect: "postgres" }),
        "postgres",
      ).sql;
      expect(sqlite).toContain("GLOB");
      expect(postgres).not.toContain("GLOB");
      for (const rendered of [sqlite, postgres]) {
        expect(rendered).toContain("valid_from > valid_to");
        expect(rendered).not.toContain("graph_id");
      }
      expect(
        renderSql(
          invertedValidityWindowPredicate({
            dialect: "postgres",
            graphId: "g",
          }),
          "postgres",
        ).sql,
      ).toContain("graph_id");
    });
  });

  describe("T7b — the three deployment shapes, per mode", () => {
    const CUSTOM_NAMES = {
      nodes: "app_nodes",
      edges: "app_edges",
      recordedNodes: "app_recorded_nodes",
      recordedEdges: "app_recorded_edges",
      recordedClock: "app_recorded_clock",
      revisionOrigins: "app_revision_origins",
      fulltext: "app_fulltext",
      uniques: "app_uniques",
      identityAssertions: "app_identity_assertions",
      recordedIdentityAssertions: "app_recorded_identity_assertions",
      identityClosure: "app_identity_closure",
      identitySeparation: "app_identity_separation",
    } as const;

    async function seedCustomTables(): Promise<GraphBackend> {
      const custom = createTestBackend(createSqliteTables(CUSTOM_NAMES));
      const store = await createInitializedStore(graph, custom);
      await store.nodes.Person.create({ name: "inverted" }, { id: "inverted" });
      await seedWindow(custom, CUSTOM_NAMES.nodes, "inverted", {
        validFrom: LATE,
        validTo: EARLY,
      });
      return custom;
    }

    it("threads the backend's table names into both modes", async () => {
      const custom = await seedCustomTables();

      const report = await repairInvertedValidityWindows({
        backend: custom,
        relations: "live",
        mode: "report",
      });
      expect(report.counts.nodes).toBe(1);

      await repairInvertedValidityWindows({
        backend: custom,
        relations: "live",
        mode: "apply",
      });
      expect(await readWindow(custom, CUSTOM_NAMES.nodes, "inverted")).toEqual({
        validFrom: undefined,
        validTo: EARLY,
      });
    });

    it("applies an explicit tableNames override over the backend's own", async () => {
      const custom = await seedCustomTables();
      // A backend that names no tables resolves the built-in defaults, which do
      // not exist here — the shape a repair that ignored `tableNames` would hit.
      const defaulted = projectBackendWithout(custom, ["tableNames"]);

      await expect(
        repairInvertedValidityWindows({
          backend: defaulted,
          relations: "live",
          mode: "report",
        }),
      ).rejects.toThrow(/typegraph_nodes/);

      const report = await repairInvertedValidityWindows({
        backend: defaulted,
        relations: "live",
        mode: "report",
        tableNames: CUSTOM_NAMES,
      });
      expect(report.counts.nodes).toBe(1);
    });

    it("merges a partial tableNames override over the backend's own", async () => {
      const custom = await seedCustomTables();

      const report = await repairInvertedValidityWindows({
        backend: custom,
        relations: "live-and-recorded",
        mode: "report",
        tableNames: {
          nodes: CUSTOM_NAMES.nodes,
          recordedNodes: undefined,
        },
      });

      expect(report.counts.nodes).toBe(1);
      expect(report.counts.edges).toBe(0);
      expect(report.counts.recordedNodes).toBe(0);
      expect(report.counts.recordedEdges).toBe(0);
    });

    it("reports on a backend without executeStatement and refuses to apply", async () => {
      await seedGraph(backend);
      const readOnly = projectBackendWithout(backend, ["executeStatement"]);

      const report = await repairInvertedValidityWindows({
        backend: readOnly,
        relations: "live",
        mode: "report",
      });
      expect(report.counts.nodes).toBe(1);

      const refusal = await repairInvertedValidityWindows({
        backend: readOnly,
        relations: "live",
        mode: "apply",
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).message).toMatch(
        /requires executeStatement support/,
      );
    });

    it("reports through a recorded-capture backend and refuses to apply", async () => {
      await seedGraph(backend);
      await seedRecordedNode(backend, "kept", {
        validFrom: LATE,
        validTo: EARLY,
      });
      await seedRecordedClock(backend, 3);
      const captured = createRecordedBackend(backend);
      const before = await readRecordedAxis(backend);

      const report = await repairInvertedValidityWindows({
        backend: captured,
        relations: "live-and-recorded",
        mode: "report",
      });
      expect(report.counts.nodes).toBe(1);
      expect(report.counts.recordedNodes).toBe(1);
      // The one path where "report writes nothing" is genuinely at risk: this
      // backend's `transaction` opens a CAPTURED scope and flushes it, so the
      // report runs inside recorded-time capture. Byte identity over both
      // recorded ledgers AND the clock is the witness — a scope that minted a
      // revision would leave no recorded row behind but would still bump
      // `typegraph_recorded_clock`, which is a write by any reading of the
      // contract. `accessMode: "read_only"` is what tells the wrapper the scope
      // owns no write lock, and on PostgreSQL what makes the engine enforce it.
      expect(await readRecordedAxis(backend)).toEqual(before);

      const refusal = await repairInvertedValidityWindows({
        backend: captured,
        relations: "live",
        mode: "apply",
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).message).toMatch(
        /history-capturing backend/,
      );
      expect((refusal as ConfigurationError).details["code"]).toBe(
        "RECORDED_CAPTURE_RAW_SQL_DISABLED",
      );
      // Refused, not half-done.
      expect(await readWindow(backend, NODES, "inverted")).toEqual({
        validFrom: LATE,
        validTo: EARLY,
      });
    });
  });

  describe("T7c — not scanned is not zero", () => {
    it("leaves unscanned relations undefined rather than 0", async () => {
      await seedGraph(backend);
      const live = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "report",
      });
      expect(live.relations).toBe("live");
      expect(live.counts.recordedNodes).toBeUndefined();
      expect(live.counts.recordedEdges).toBeUndefined();
      expect(live.nonCanonical.recordedNodes).toBeUndefined();
      expect(live.counts.nodes).toBe(1);

      const both = await repairInvertedValidityWindows({
        backend,
        relations: "live-and-recorded",
        mode: "report",
      });
      expect(both.relations).toBe("live-and-recorded");
      expect(both.counts.recordedNodes).toBe(0);
      expect(both.counts.recordedEdges).toBe(0);
      expect(both.nonCanonical.recordedNodes).toBe(0);
    });

    it("repairs the recorded axis when it is in scope", async () => {
      const store = await createInitializedStore(graph, backend);
      await store.nodes.Person.create({ name: "kept" }, { id: "kept" });
      await seedRecordedNode(backend, "kept", {
        validFrom: LATE,
        validTo: EARLY,
      });

      const live = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "apply",
      });
      expect(live.counts.recordedNodes).toBeUndefined();
      expect(await readWindow(backend, RECORDED_NODES, "kept")).toEqual({
        validFrom: LATE,
        validTo: EARLY,
      });

      const both = await repairInvertedValidityWindows({
        backend,
        relations: "live-and-recorded",
        mode: "apply",
      });
      expect(both.counts.recordedNodes).toBe(1);
      expect(await readWindow(backend, RECORDED_NODES, "kept")).toEqual({
        validFrom: undefined,
        validTo: EARLY,
      });
    });
  });

  describe("T7d — a backend without transactions", () => {
    it("runs both modes and says the call was not atomic", async () => {
      await seedGraph(backend);
      const nonTransactional: GraphBackend = deriveBackend(backend, {
        capabilities: {
          ...backend.capabilities,
          execution: {
            ...backend.capabilities.execution,
            interactiveTransactions: false,
          },
        },
      });

      const report = await repairInvertedValidityWindows({
        backend: nonTransactional,
        relations: "live",
        mode: "report",
      });
      expect(report.atomic).toBe(false);
      expect(report.counts.nodes).toBe(1);

      const applied = await repairInvertedValidityWindows({
        backend: nonTransactional,
        relations: "live",
        mode: "apply",
      });
      expect(applied.atomic).toBe(false);
      expect(applied.counts.nodes).toBe(1);
      expect(await readWindow(backend, NODES, "inverted")).toEqual({
        validFrom: undefined,
        validTo: EARLY,
      });
    });

    it("reports atomic on a backend that has transactions", async () => {
      await seedGraph(backend);
      const report = await repairInvertedValidityWindows({
        backend,
        relations: "live",
        mode: "report",
      });
      expect(report.atomic).toBe(true);
    });

    it("reports the transaction seam rather than inferring from object identity", async () => {
      await seedGraph(backend);
      function sameIdentityTransaction<T>(
        fn: (tx: TransactionBackend) => Promise<T>,
      ): Promise<T> {
        return fn(sameIdentityBackend);
      }
      const sameIdentityBackend: GraphBackend = deriveBackend(backend, {
        // A custom backend may expose the same object as its transaction
        // context. The helper must report that it invoked the transaction seam
        // without trying to infer that fact from callback-target identity.
        transaction: sameIdentityTransaction,
      });

      const report = await repairInvertedValidityWindows({
        backend: sameIdentityBackend,
        relations: "live",
        mode: "report",
      });

      expect(report.atomic).toBe(true);
    });
  });
});
