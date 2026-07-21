/**
 * Recorded commit-clock allocator tests.
 *
 * The clock combines a logical per-graph revision with a non-decreasing
 * physical wall-time high-water mark. Two commits in the same wall-clock
 * millisecond get distinct, both-observable anchors without manufacturing
 * timestamp increments.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  compareRecordedInstants,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type RecordedInstant,
  recordedInstantRevision,
  recordedInstantWallTime,
  renderPostgres,
  sql,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { parseRecordedInstant } from "../src/core/temporal";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import {
  recordedClockAdvisoryLockSql,
  recordedGraphWriteAdvisoryLockSql,
} from "../src/store/recorded-capture";
import { createTestBackend, recordedRevisionFromDriver } from "./test-utils";

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const clockGraph = defineGraph({
  id: "recorded_clock_allocator",
  nodes: { Item: { type: Item } },
  edges: {},
});

type FromRow = Readonly<{ recorded_from: unknown }>;

function requireRecordedInstant(
  instant: RecordedInstant | undefined,
  message: string,
): RecordedInstant {
  expect(instant).toBeDefined();
  if (instant === undefined) throw new Error(message);
  return instant;
}

async function readOpenFrom(
  backend: GraphBackend,
  id: string,
): Promise<number> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<FromRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_from
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${clockGraph.id} AND id = ${id}
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`No recorded row for ${id}`);
  return recordedRevisionFromDriver(row.recorded_from);
}

describe("recorded commit clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a namespaced Postgres advisory lock separate from schema writes", () => {
    const compiled = renderPostgres(recordedClockAdvisoryLockSql("graph-1"));
    const compactSql = compiled.sql.replaceAll(/\s+/gu, " ");

    expect(compactSql).toMatch(
      /pg_advisory_xact_lock\(\s*hashtext\(\$1\), hashtext\(\$2\)\s*\)/u,
    );
    expect(compiled.params).toEqual(["typegraph:recorded-clock", "graph-1"]);
  });

  it("uses a namespace distinct from the graph-write lock", () => {
    // Graph writes take their advisory lock before graph row reads/writes;
    // recorded-clock allocation takes its lock at flush after live writes. A
    // shared namespace would recreate the original acquire-order inversion.
    const recordedClockParams = renderPostgres(
      recordedClockAdvisoryLockSql("graph-1"),
    ).params;
    const graphWriteParams = renderPostgres(
      recordedGraphWriteAdvisoryLockSql("graph-1"),
    ).params;

    expect(recordedClockParams).toEqual([
      "typegraph:recorded-clock",
      "graph-1",
    ]);
    expect(graphWriteParams).toEqual([
      "typegraph:recorded-graph-write",
      "graph-1",
    ]);
    expect(graphWriteParams[0]).not.toBe(recordedClockParams[0]);
  });

  it("treats the internal revision-zero lock seed as no recorded commit", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(clockGraph, backend, {
      history: true,
    });
    if (backend.executeStatement === undefined) {
      throw new Error("test backend must execute statements");
    }
    const schema = createSqlSchema(backend.tableNames);
    await backend.executeStatement(
      asCompiledStatementSql(sql`
        INSERT INTO ${schema.recordedClockTable} (graph_id, revision, recorded_at)
        VALUES (${clockGraph.id}, ${0}, ${"1970-01-01T00:00:00.000Z"})
      `),
    );

    await expect(store.recordedNow()).resolves.toBeUndefined();
  });

  it("allocates distinct, both-observable instants for same-millisecond commits", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(clockGraph, backend, {
      history: true,
    });

    // Fake only Date (so async scheduling is unaffected) and pin the wall clock
    // so both commits land in the same wall millisecond.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

    // Two separate transactions, both committed at the SAME pinned wall instant.
    await store.transaction(async (tx) => {
      await tx.nodes.Item.create({ label: "first" }, { id: "a" });
    });
    const firstCommit = requireRecordedInstant(
      await store.recordedNow(),
      "expected first recorded clock commit",
    );

    await store.transaction(async (tx) => {
      await tx.nodes.Item.create({ label: "second" }, { id: "b" });
    });
    const secondCommit = requireRecordedInstant(
      await store.recordedNow(),
      "expected second recorded clock commit",
    );

    await store.transaction(async (tx) => {
      await tx.nodes.Item.create({ label: "third" }, { id: "c" });
    });
    const thirdCommit = requireRecordedInstant(
      await store.recordedNow(),
      "expected third recorded clock commit",
    );

    expect(firstCommit).toBe("r1:0000000000000001:2026-06-01T12:00:00.000Z");
    expect(secondCommit).toBe("r1:0000000000000002:2026-06-01T12:00:00.000Z");
    expect(thirdCommit).toBe("r1:0000000000000003:2026-06-01T12:00:00.000Z");
    expect(parseRecordedInstant(secondCommit).revision).toBe(2);
    expect(recordedInstantRevision(thirdCommit)).toBe(3);
    expect(compareRecordedInstants(firstCommit, secondCommit)).toBe(-1);
    expect(compareRecordedInstants(secondCommit, secondCommit)).toBe(0);
    expect(compareRecordedInstants(thirdCommit, secondCommit)).toBe(1);
    expect(recordedInstantWallTime(firstCommit)).toBe(new Date().toISOString());
    expect(recordedInstantWallTime(secondCommit)).toBe(
      new Date().toISOString(),
    );
    expect(recordedInstantWallTime(thirdCommit)).toBe(new Date().toISOString());

    // Both instants are observable and isolate their own commit.
    const atFirst = store.asOfRecorded(firstCommit);
    const aAtFirst = await atFirst.nodes.Item.getById("a" as never);
    expect(aAtFirst?.label).toBe("first");
    // `b` was recorded at the later instant, so it is not yet on record at the
    // first commit.
    expect(await atFirst.nodes.Item.getById("b" as never)).toBeUndefined();

    const atSecond = store.asOfRecorded(secondCommit);
    const aAtSecond = await atSecond.nodes.Item.getById("a" as never);
    const bAtSecond = await atSecond.nodes.Item.getById("b" as never);
    expect(aAtSecond?.label).toBe("first");
    expect(bAtSecond?.label).toBe("second");
    expect(await atSecond.nodes.Item.getById("c" as never)).toBeUndefined();

    const atThird = store.asOfRecorded(thirdCommit);
    const aAtThird = await atThird.nodes.Item.getById("a" as never);
    const bAtThird = await atThird.nodes.Item.getById("b" as never);
    const cAtThird = await atThird.nodes.Item.getById("c" as never);
    expect(aAtThird?.label).toBe("first");
    expect(bAtThird?.label).toBe("second");
    expect(cAtThird?.label).toBe("third");
  });

  it("clamps physical time when the wall clock moves backward", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(clockGraph, backend, {
      history: true,
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
    await store.nodes.Item.create({ label: "first" }, { id: "a" });
    const firstCommit = requireRecordedInstant(
      await store.recordedNow(),
      "expected first recorded clock commit",
    );

    vi.setSystemTime(new Date("2026-06-01T11:00:00.000Z"));
    await store.nodes.Item.create({ label: "second" }, { id: "b" });
    const secondCommit = requireRecordedInstant(
      await store.recordedNow(),
      "expected second recorded clock commit",
    );

    expect(secondCommit > firstCommit).toBe(true);
    expect(parseRecordedInstant(secondCommit)).toEqual({
      revision: 2,
      recordedAt: "2026-06-01T12:00:00.000Z",
    });

    const atFirst = store.asOfRecorded(firstCommit);
    expect(await atFirst.nodes.Item.getById("a" as never)).toBeDefined();
    expect(await atFirst.nodes.Item.getById("b" as never)).toBeUndefined();

    // The later diagonal checkpoint remains cumulative even though its write
    // happened after the application clock stepped backward.
    const atSecond = store.asOfRecorded(secondCommit);
    expect(await atSecond.nodes.Item.getById("a" as never)).toBeDefined();
    expect(await atSecond.nodes.Item.getById("b" as never)).toBeDefined();
  });

  it("shares one recorded instant across every entity touched in a transaction", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(clockGraph, backend, {
      history: true,
    });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-02T00:00:00.000Z"));

    await store.transaction(async (tx) => {
      await tx.nodes.Item.create({ label: "x" }, { id: "x" });
      await tx.nodes.Item.create({ label: "y" }, { id: "y" });
    });

    // One transaction → one recorded commit instant shared by both nodes, even
    // though their inserts are distinct statements.
    const sharedRevision = recordedInstantRevision(
      requireRecordedInstant(
        await store.recordedNow(),
        "expected shared recorded commit",
      ),
    );
    expect(await readOpenFrom(backend, "x")).toBe(sharedRevision);
    expect(await readOpenFrom(backend, "y")).toBe(sharedRevision);
  });
});
