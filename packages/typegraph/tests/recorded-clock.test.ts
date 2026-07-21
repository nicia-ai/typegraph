/**
 * Recorded commit-clock allocator tests.
 *
 * The clock combines a logical per-graph revision with honest physical wall
 * time. Two commits in the same wall-clock millisecond get distinct,
 * both-observable anchors without moving the physical timestamp into the
 * future.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type RecordedInstant,
  renderPostgres,
  sql,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import {
  parseRecordedInstant,
  recordedInstantWallTime,
} from "../src/core/temporal";
import { createSqlSchema } from "../src/query/compiler/schema";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import {
  recordedClockAdvisoryLockSql,
  recordedGraphWriteAdvisoryLockSql,
  toCanonicalRecordedInstant,
} from "../src/store/recorded-capture";
import { createTestBackend } from "./test-utils";

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
): Promise<string> {
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
  return toCanonicalRecordedInstant(row.recorded_from);
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

    expect(firstCommit).toBe("r1:0000000000000001:2026-06-01T12:00:00.000Z");
    expect(secondCommit).toBe("r1:0000000000000002:2026-06-01T12:00:00.000Z");
    expect(parseRecordedInstant(secondCommit).revision).toBe(2);
    expect(recordedInstantWallTime(firstCommit)).toBe(new Date().toISOString());
    expect(recordedInstantWallTime(secondCommit)).toBe(
      new Date().toISOString(),
    );

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
  });

  it("orders commits by revision when physical wall time moves backward", async () => {
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
      recordedAt: "2026-06-01T11:00:00.000Z",
    });

    const validAfterBothWrites = store.asOf("2026-06-01T13:00:00.000Z");
    const atFirst = validAfterBothWrites.asOfRecorded(firstCommit);
    expect(await atFirst.nodes.Item.getById("a" as never)).toBeDefined();
    expect(await atFirst.nodes.Item.getById("b" as never)).toBeUndefined();

    const atSecond = validAfterBothWrites.asOfRecorded(secondCommit);
    expect(await atSecond.nodes.Item.getById("a" as never)).toBeDefined();
    expect(await atSecond.nodes.Item.getById("b" as never)).toBeDefined();
  });

  it("accepts only canonical recorded tokens from text columns", () => {
    const instant = "r1:0000000000000007:2026-06-01T12:00:00.001Z";

    expect(toCanonicalRecordedInstant(instant)).toBe(instant);
    expect(() => toCanonicalRecordedInstant(new Date())).toThrow(
      ConfigurationError,
    );
    expect(() =>
      toCanonicalRecordedInstant("2026-06-01T12:00:00.001Z"),
    ).toThrow(ConfigurationError);
    expect(() => toCanonicalRecordedInstant(42)).toThrow(ConfigurationError);
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
    expect(await readOpenFrom(backend, "x")).toBe(
      await readOpenFrom(backend, "y"),
    );
  });
});
