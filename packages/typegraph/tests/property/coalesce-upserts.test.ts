/**
 * Property: under `coalesceUnchangedUpserts`, upserting the same validated
 * props twice is history-idempotent — the second (byte-identical) delivery
 * performs no write, so the per-graph recorded clock does not advance and no
 * new recorded row is captured. This is the at-least-once replay invariant the
 * option exists to provide (issue #256).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../src";
import { type GraphBackend } from "../../src/backend/types";
import { createSqlSchema } from "../../src/query/compiler/schema";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { toCanonicalRecordedBoundary } from "../../src/store/recorded-capture";
import { createTestBackend } from "../test-utils";

const Item = defineNode("Item", {
  schema: z.object({
    name: z.string(),
    count: z.number().optional(),
    flag: z.boolean().optional(),
  }),
});

const coalesceGraph = defineGraph({
  id: "prop_coalesce_upserts",
  nodes: { Item: { type: Item } },
  edges: {},
});

type ClockRow = Readonly<{ recorded_at: unknown }>;
// Postgres returns COUNT(*) as a string/bigint, SQLite as a number, so the
// value is genuinely not statically a number — Number(...) is a real coercion.
type CountRow = Readonly<{ cnt: unknown }>;

async function readRecordedClock(
  backend: GraphBackend,
): Promise<string | undefined> {
  const rows = await backend.execute<ClockRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_at
      FROM ${createSqlSchema(backend.tableNames).recordedClockTable}
      WHERE graph_id = ${coalesceGraph.id}
    `),
  );
  const value = rows[0]?.recorded_at;
  return value === undefined ? undefined : toCanonicalRecordedBoundary(value);
}

async function countRecordedRows(backend: GraphBackend): Promise<number> {
  const rows = await backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS cnt
      FROM ${createSqlSchema(backend.tableNames).recordedNodesTable}
      WHERE graph_id = ${coalesceGraph.id}
    `),
  );
  return Number(rows[0]?.cnt ?? 0);
}

// Props whose re-validation is a fixed point: scalars with no defaults or
// transforms, and no explicitly-undefined optional keys (requiredKeys pins the
// only always-present field).
const propsArb = fc.record(
  {
    name: fc.string({ maxLength: 16 }),
    count: fc.integer({ min: -1000, max: 1000 }),
    flag: fc.boolean(),
  },
  { requiredKeys: ["name"] },
);

describe("coalesceUnchangedUpserts property", () => {
  it("re-upserting identical props is history-idempotent", async () => {
    await fc.assert(
      fc.asyncProperty(
        propsArb,
        fc.string({ maxLength: 12 }),
        async (props, id) => {
          const backend = createTestBackend();
          const [store] = await createStoreWithSchema(coalesceGraph, backend, {
            history: true,
            coalesceUnchangedUpserts: true,
          });

          await store.nodes.Item.upsertById(id, props);
          const clockAfterFirst = await readRecordedClock(backend);
          const rowsAfterFirst = await countRecordedRows(backend);
          expect(clockAfterFirst).toBeDefined();

          // Any number of byte-identical replays must not touch history.
          await store.nodes.Item.upsertById(id, props);
          await store.nodes.Item.upsertById(id, props);

          expect(await readRecordedClock(backend)).toBe(clockAfterFirst);
          expect(await countRecordedRows(backend)).toBe(rowsAfterFirst);
        },
      ),
      { numRuns: 60 },
    );
  }, 60_000);
});
