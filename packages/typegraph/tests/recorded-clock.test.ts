/**
 * Recorded commit-clock allocator tests.
 *
 * The clock is a logical, per-graph monotonic instant — deliberately NOT raw
 * wall time — so two commits in the same wall-clock millisecond still get
 * distinct, both-observable recorded instants (otherwise the second would open
 * its row at the same timestamp the first closed, a zero-width version the
 * half-open read excludes forever). These tests pin the wall clock to force the
 * collision the guard exists for; with real timers the commits separate
 * naturally and would pass even if the guard were removed.
 */
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asCompiledRowsSql,
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type RecordedInstant,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  recordedClockAdvisoryLockSql,
  toCanonicalIso,
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
  return toCanonicalIso(row.recorded_from);
}

describe("recorded commit clock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a namespaced Postgres advisory lock separate from schema writes", () => {
    const compiled = new PgDialect().sqlToQuery(
      recordedClockAdvisoryLockSql("graph-1"),
    );
    const compactSql = compiled.sql.replaceAll(/\s+/gu, " ");

    expect(compactSql).toMatch(
      /pg_advisory_xact_lock\(\s*hashtext\(\$1\), hashtext\(\$2\)\s*\)/u,
    );
    expect(compiled.params).toEqual(["typegraph:recorded-clock", "graph-1"]);
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

    expect(firstCommit).toBe("2026-06-01T12:00:00.000Z");
    // The collision guard advances the second commit by one logical millisecond
    // rather than colliding with the first.
    expect(secondCommit).toBe("2026-06-01T12:00:00.001Z");
    // The clock now runs ahead of the (still-pinned) wall clock — expected for a
    // logical commit clock under bursty same-ms writes.
    expect(secondCommit > new Date().toISOString()).toBe(true);

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

  it("canonicalizes a recorded-clock value, failing typed on an invalid instant", () => {
    const iso = "2026-06-01T12:00:00.001Z";
    // Valid Date and valid string canonicalize identically.
    expect(toCanonicalIso(new Date(iso))).toBe(iso);
    expect(toCanonicalIso(iso)).toBe(iso);
    // An invalid Date must raise the typed ConfigurationError, not the bare
    // RangeError that `new Date("bad").toISOString()` throws.
    expect(() => toCanonicalIso(new Date("not a real date"))).toThrow(
      ConfigurationError,
    );
    expect(() => toCanonicalIso("not a real date")).toThrow(ConfigurationError);
    expect(() => toCanonicalIso(42)).toThrow(ConfigurationError);
  });

  it("interprets a zoneless timestamp string as UTC, not host-local time", () => {
    // A driver that yields a naive timestamp (no Z / offset) for the recorded
    // columns must be read as UTC — otherwise recordedNow() drifts by the
    // server's offset (and across DST). Both the space- and T-separated shapes
    // canonicalize to the same UTC instant regardless of the host timezone.
    expect(toCanonicalIso("2026-06-25 12:00:00")).toBe(
      "2026-06-25T12:00:00.000Z",
    );
    expect(toCanonicalIso("2026-06-25T12:30")).toBe("2026-06-25T12:30:00.000Z");
    expect(toCanonicalIso("2026-06-25T12:00:00.123")).toBe(
      "2026-06-25T12:00:00.123Z",
    );
    // An explicit zone is still honored as written.
    expect(toCanonicalIso("2026-06-25T12:00:00+02:00")).toBe(
      "2026-06-25T10:00:00.000Z",
    );
    // PostgreSQL text renderings can be space-separated and use a colon-less
    // offset. Normalize them instead of relying on implementation-defined
    // Date.parse behavior for non-ISO shapes.
    expect(toCanonicalIso("2026-06-25 12:00:00+00")).toBe(
      "2026-06-25T12:00:00.000Z",
    );
    expect(toCanonicalIso("2026-06-25 12:00:00+0000")).toBe(
      "2026-06-25T12:00:00.000Z",
    );
    expect(toCanonicalIso("2026-06-25 12:00:00-0230")).toBe(
      "2026-06-25T14:30:00.000Z",
    );
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
