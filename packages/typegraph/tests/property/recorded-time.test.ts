/**
 * Property-based tests for recorded/system-time reconstruction.
 *
 * Two laws, asserted together for any sequence of committed writes:
 *
 * 1. **Reconstruction** — reading `store.asOfRecorded(commitInstant)` reproduces
 *    exactly the state that was current when that commit landed; earlier commits
 *    are unaffected by later ones, and the per-graph recorded clock advances
 *    strictly monotonically.
 * 2. **Interval invariants** — the recorded relation a capture run produces is a
 *    clean SQL:2011 system-versioned chain per `(kind, id)`: no overlapping
 *    `[recorded_from, recorded_to)` intervals, at most one open row, no
 *    zero-width committed rows, and an open-row count that matches whether the
 *    entity is live/tombstoned (1) or hard-deleted/never (0). These are what let
 *    the read drop the `history_id` tiebreak, so they are asserted structurally
 *    against the rows, not only inferred from reconstruction.
 *
 * Both laws are exercised with **multi-write transactions** (intra-transaction
 * collapse: several writes to one entity in one commit must persist exactly one
 * net transition), so the recorded-nodes and recorded-edges relations get the
 * same structural coverage.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asRecordedInstant,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type RecordedInstant,
  recordedRelation,
} from "../../src";
import { type GraphBackend } from "../../src/backend/types";
import { RECORDED_MAX } from "../../src/core/temporal";
import {
  createSqlSchema,
  type SqlSchema,
} from "../../src/query/compiler/schema";
import { sql, type SqlFragment } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { toCanonicalRecordedBoundary } from "../../src/store/recorded-capture";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const Link = defineEdge("Link", {
  schema: z.object({ since: z.string() }),
});

const propertyGraph = defineGraph({
  id: "prop_recorded_time",
  nodes: { Item: { type: Item } },
  edges: { Link: { type: Link, from: [Item], to: [Item] } },
});

const NODE_IDS = ["p0", "p1", "p2"] as const;
const EDGE_IDS = ["e0", "e1", "e2"] as const;
// Permanent endpoints for the edge law — seeded live, never mutated, so an
// edge's lifecycle is the only thing under test.
const EDGE_FROM = "edge-from";
const EDGE_TO = "edge-to";

type ClockRow = Readonly<{ recorded_at: unknown }>;
type IntervalRow = Readonly<{
  id: string;
  recorded_from: unknown;
  recorded_to: unknown;
}>;

function schemaFor(backend: GraphBackend): SqlSchema {
  return createSqlSchema(backend.tableNames);
}

function requireRecordedInstant(
  instant: RecordedInstant | undefined,
  message: string,
): RecordedInstant {
  expect(instant).toBeDefined();
  if (instant === undefined) throw new Error(message);
  return instant;
}

async function readRecordedClock(
  backend: GraphBackend,
): Promise<RecordedInstant> {
  const rows = await backend.execute<ClockRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_at
      FROM ${schemaFor(backend).recordedClockTable}
      WHERE graph_id = ${propertyGraph.id}
    `),
  );
  const value = rows[0]?.recorded_at;
  if (value === undefined) throw new Error("Recorded clock not written");
  // A value read from the recorded clock is a genuine recorded instant.
  return asRecordedInstant(toCanonicalRecordedBoundary(value));
}

async function readIntervals(
  backend: GraphBackend,
  table: SqlFragment,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly { from: string; to: string }[]>> {
  const rows = await backend.execute<IntervalRow>(
    asCompiledRowsSql(sql`
      SELECT id, recorded_from, recorded_to
      FROM ${table}
      WHERE graph_id = ${propertyGraph.id}
      ORDER BY id, recorded_from
    `),
  );
  const byId = new Map<string, { from: string; to: string }[]>();
  for (const id of ids) byId.set(id, []);
  for (const row of rows) {
    const list = byId.get(row.id);
    if (list === undefined) continue;
    list.push({
      from: toCanonicalRecordedBoundary(row.recorded_from),
      to: toCanonicalRecordedBoundary(row.recorded_to),
    });
  }
  return byId;
}

// The reference model: an entity is "live" (carrying a value), "soft"
// (soft-deleted — its live row still exists, so it cannot be re-created), or
// "absent" (hard-deleted or never created — re-creatable). Reads see a value
// only when live; the expected count of OPEN recorded rows is 1 for live/soft
// and 0 for absent.
type EntityState =
  | Readonly<{ kind: "live"; value: string }>
  | Readonly<{ kind: "soft" }>
  | Readonly<{ kind: "absent" }>;

function readValue(state: EntityState): string | undefined {
  return state.kind === "live" ? state.value : undefined;
}

function expectedOpenRows(state: EntityState): number {
  return state.kind === "absent" ? 0 : 1;
}

type Op = "update" | "softDelete" | "hardDelete" | "recreate";

function isLegal(op: Op, state: EntityState): boolean {
  switch (op) {
    case "update":
    case "softDelete": {
      return state.kind === "live";
    }
    case "hardDelete": {
      return state.kind !== "absent";
    }
    case "recreate": {
      return state.kind === "absent";
    }
  }
}

function nextState(op: Op, value: string): EntityState {
  switch (op) {
    case "update":
    case "recreate": {
      return { kind: "live", value };
    }
    case "softDelete": {
      return { kind: "soft" };
    }
    case "hardDelete": {
      return { kind: "absent" };
    }
  }
}

const opArb = fc.constantFrom<Op>(
  "update",
  "softDelete",
  "hardDelete",
  "recreate",
);

type Snapshot = ReadonlyMap<string, string | undefined>;
type Checkpoint = Readonly<{ commit: RecordedInstant; snapshot: Snapshot }>;

function snapshotOf(model: ReadonlyMap<string, EntityState>): Snapshot {
  return new Map([...model].map(([id, state]) => [id, readValue(state)]));
}

/**
 * Asserts the persisted intervals for every id form a clean SQL:2011 chain:
 * no zero-width committed rows, no overlap, and an open-row count matching the
 * final model state. This is where intra-transaction collapse is caught — a
 * second interval written for one entity in one commit would either be
 * zero-width or overlap.
 */
function assertIntervalInvariants(
  intervals: ReadonlyMap<string, readonly { from: string; to: string }[]>,
  finalState: ReadonlyMap<string, EntityState>,
): void {
  for (const [id, rows] of intervals) {
    for (const { from, to } of rows) {
      expect(from < to).toBe(true);
    }
    const openRows = rows.filter((row) => row.to === RECORDED_MAX);
    expect(openRows.length).toBe(
      expectedOpenRows(requireDefined(finalState.get(id))),
    );
    const sorted = rows.toSorted((a, b) => (a.from < b.from ? -1 : 1));
    for (let index = 1; index < sorted.length; index += 1) {
      expect(
        requireDefined(sorted[index - 1]).to <=
          requireDefined(sorted[index]).from,
      ).toBe(true);
    }
  }
}

async function assertReconstruction(
  checkpoints: readonly Checkpoint[],
  ids: readonly string[],
  reconstructAt: (
    commit: RecordedInstant,
  ) => Promise<ReadonlyMap<string, string | undefined>>,
): Promise<void> {
  for (const [index, checkpoint] of checkpoints.entries()) {
    if (index > 0) {
      expect(
        requireDefined(checkpoints[index - 1]).commit < checkpoint.commit,
      ).toBe(true);
    }
    const reconstructed = await reconstructAt(checkpoint.commit);
    for (const id of ids) {
      expect(reconstructed.get(id)).toBe(checkpoint.snapshot.get(id));
    }
  }
}

describe("recorded-time property tests", () => {
  it("collapses multi-write transactions and maintains the node interval invariants", async () => {
    // Each transaction is a batch of 1–3 ops, so an entity can be written more
    // than once before a single commit — the intra-transaction collapse case.
    const txArb = fc.array(opArb, { minLength: 1, maxLength: 3 });
    const scenarioArb = fc.record({
      transactions: fc.array(
        fc.record({
          node: fc.integer({ min: 0, max: NODE_IDS.length - 1 }),
          ops: txArb,
        }),
        { maxLength: 12 },
      ),
      labels: fc.array(fc.string({ maxLength: 8 }), {
        minLength: 1,
        maxLength: 64,
      }),
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ transactions, labels }) => {
        const backend = createTestBackend();
        const [store] = await createStoreWithSchema(propertyGraph, backend, {
          history: true,
        });

        await store.transaction(async (tx) => {
          for (const id of NODE_IDS) {
            await tx.nodes.Item.create({ label: `init-${id}` }, { id });
          }
        });
        const model = new Map<string, EntityState>(
          NODE_IDS.map((id) => [id, { kind: "live", value: `init-${id}` }]),
        );
        const checkpoints: Checkpoint[] = [
          {
            commit: await readRecordedClock(backend),
            snapshot: snapshotOf(model),
          },
        ];

        let labelCursor = 0;
        for (const transaction of transactions) {
          const id = requireDefined(NODE_IDS[transaction.node]);
          const applied = await store.transaction(async (tx) => {
            let anyWrite = false;
            for (const op of transaction.ops) {
              const state = requireDefined(model.get(id));
              if (!isLegal(op, state)) continue;
              const value = requireDefined(labels[labelCursor % labels.length]);
              labelCursor += 1;
              switch (op) {
                case "update": {
                  await tx.nodes.Item.update(id as never, { label: value });
                  break;
                }
                case "softDelete": {
                  await tx.nodes.Item.delete(id as never);
                  break;
                }
                case "hardDelete": {
                  await tx.nodes.Item.hardDelete(id as never);
                  break;
                }
                case "recreate": {
                  await tx.nodes.Item.create({ label: value }, { id });
                  break;
                }
              }
              model.set(id, nextState(op, value));
              anyWrite = true;
            }
            return anyWrite;
          });
          // A transaction that applied no write allocates no recorded instant,
          // so it is not a checkpoint.
          if (applied) {
            checkpoints.push({
              commit: await readRecordedClock(backend),
              snapshot: snapshotOf(model),
            });
          }
        }

        await assertReconstruction(checkpoints, NODE_IDS, async (commit) => {
          const reconstructed = await store
            .asOfRecorded(commit)
            .nodes.Item.getByIds(NODE_IDS as unknown as readonly never[]);
          return new Map(
            NODE_IDS.map((id, index) => [id, reconstructed[index]?.label]),
          );
        });

        assertIntervalInvariants(
          await readIntervals(
            backend,
            schemaFor(backend).recordedNodesTable,
            NODE_IDS,
          ),
          model,
        );
      }),
      { numRuns: 80 },
    );
  }, 60_000);

  it("external recorded-read bindings reconstruct captured node checkpoints without enabling capture", async () => {
    const txArb = fc.array(opArb, { minLength: 1, maxLength: 3 });
    const scenarioArb = fc.record({
      transactions: fc.array(
        fc.record({
          node: fc.integer({ min: 0, max: NODE_IDS.length - 1 }),
          ops: txArb,
        }),
        { maxLength: 10 },
      ),
      labels: fc.array(fc.string({ maxLength: 8 }), {
        minLength: 1,
        maxLength: 64,
      }),
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ transactions, labels }) => {
        const backend = createTestBackend();
        const [historyStore] = await createStoreWithSchema(
          propertyGraph,
          backend,
          { history: true },
        );

        await historyStore.transaction(async (tx) => {
          for (const id of NODE_IDS) {
            await tx.nodes.Item.create({ label: `init-${id}` }, { id });
          }
        });
        const model = new Map<string, EntityState>(
          NODE_IDS.map((id) => [id, { kind: "live", value: `init-${id}` }]),
        );
        const checkpoints: Checkpoint[] = [
          {
            commit: await readRecordedClock(backend),
            snapshot: snapshotOf(model),
          },
        ];

        let labelCursor = 0;
        for (const transaction of transactions) {
          const id = requireDefined(NODE_IDS[transaction.node]);
          const applied = await historyStore.transaction(async (tx) => {
            let anyWrite = false;
            for (const op of transaction.ops) {
              const state = requireDefined(model.get(id));
              if (!isLegal(op, state)) continue;
              const value = requireDefined(labels[labelCursor % labels.length]);
              labelCursor += 1;
              switch (op) {
                case "update": {
                  await tx.nodes.Item.update(id as never, { label: value });
                  break;
                }
                case "softDelete": {
                  await tx.nodes.Item.delete(id as never);
                  break;
                }
                case "hardDelete": {
                  await tx.nodes.Item.hardDelete(id as never);
                  break;
                }
                case "recreate": {
                  await tx.nodes.Item.create({ label: value }, { id });
                  break;
                }
              }
              model.set(id, nextState(op, value));
              anyWrite = true;
            }
            return anyWrite;
          });
          if (applied) {
            checkpoints.push({
              commit: await readRecordedClock(backend),
              snapshot: snapshotOf(model),
            });
          }
        }

        const readStore = createStore(propertyGraph, backend, {
          recordedRead: recordedRelation({ schema: schemaFor(backend) }),
        });
        expect(readStore.historyEnabled).toBe(false);
        expect(readStore.recordedReadBound).toBe(true);
        await expect(readStore.recordedNow()).rejects.toThrow(
          "recordedNow() requires a store created with { history: true }",
        );

        await assertReconstruction(checkpoints, NODE_IDS, async (commit) => {
          const reconstructed = await readStore
            .asOfRecorded(commit)
            .nodes.Item.getByIds(NODE_IDS as unknown as readonly never[]);
          return new Map(
            NODE_IDS.map((id, index) => [id, reconstructed[index]?.label]),
          );
        });

        const liveEntry = [...model].find(([, state]) => state.kind === "live");
        if (liveEntry === undefined) return;

        const [liveId, liveState] = liveEntry;
        const recordedNow = requireRecordedInstant(
          await historyStore.recordedNow(),
          "expected property test history store to have a recorded instant",
        );
        await readStore.nodes.Item.update(liveId as never, {
          label: "external-live-only",
        });
        expect(await historyStore.recordedNow()).toBe(recordedNow);

        const recordedAfterLiveOnlyWrite = await readStore
          .asOfRecorded(recordedNow)
          .nodes.Item.getById(liveId as never);
        expect(recordedAfterLiveOnlyWrite?.label).toBe(readValue(liveState));
      }),
      { numRuns: 40 },
    );
  }, 60_000);

  it("collapses multi-write transactions and maintains the edge interval invariants", async () => {
    // Mirrors the node property: one committed transaction can touch the same
    // edge several times, so capture must persist only the net edge transition.
    const txArb = fc.array(opArb, { minLength: 1, maxLength: 3 });
    const scenarioArb = fc.record({
      transactions: fc.array(
        fc.record({
          edge: fc.integer({ min: 0, max: EDGE_IDS.length - 1 }),
          ops: txArb,
        }),
        { maxLength: 12 },
      ),
      labels: fc.array(fc.string({ maxLength: 8 }), {
        minLength: 1,
        maxLength: 64,
      }),
    });

    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ transactions, labels }) => {
        const backend = createTestBackend();
        const [store] = await createStoreWithSchema(propertyGraph, backend, {
          history: true,
        });

        await store.transaction(async (tx) => {
          await tx.nodes.Item.create({ label: "from" }, { id: EDGE_FROM });
          await tx.nodes.Item.create({ label: "to" }, { id: EDGE_TO });
          for (const id of EDGE_IDS) {
            await tx.edges.Link.create(
              { kind: "Item", id: EDGE_FROM },
              { kind: "Item", id: EDGE_TO },
              { since: `init-${id}` },
              { id },
            );
          }
        });
        const model = new Map<string, EntityState>(
          EDGE_IDS.map((id) => [id, { kind: "live", value: `init-${id}` }]),
        );
        const checkpoints: Checkpoint[] = [
          {
            commit: await readRecordedClock(backend),
            snapshot: snapshotOf(model),
          },
        ];

        let labelCursor = 0;
        for (const transaction of transactions) {
          const id = requireDefined(EDGE_IDS[transaction.edge]);
          const applied = await store.transaction(async (tx) => {
            let anyWrite = false;
            for (const op of transaction.ops) {
              const state = requireDefined(model.get(id));
              if (!isLegal(op, state)) continue;
              const value = requireDefined(labels[labelCursor % labels.length]);
              labelCursor += 1;
              switch (op) {
                case "update": {
                  await tx.edges.Link.update(id as never, { since: value });
                  break;
                }
                case "softDelete": {
                  await tx.edges.Link.delete(id as never);
                  break;
                }
                case "hardDelete": {
                  await tx.edges.Link.hardDelete(id as never);
                  break;
                }
                case "recreate": {
                  await tx.edges.Link.create(
                    { kind: "Item", id: EDGE_FROM },
                    { kind: "Item", id: EDGE_TO },
                    { since: value },
                    { id },
                  );
                  break;
                }
              }
              model.set(id, nextState(op, value));
              anyWrite = true;
            }
            return anyWrite;
          });
          // A transaction that applied no write allocates no recorded instant,
          // so it is not a checkpoint.
          if (applied) {
            checkpoints.push({
              commit: await readRecordedClock(backend),
              snapshot: snapshotOf(model),
            });
          }
        }

        await assertReconstruction(checkpoints, EDGE_IDS, async (commit) => {
          const reconstructed = await store
            .asOfRecorded(commit)
            .edges.Link.getByIds(EDGE_IDS as unknown as readonly never[]);
          return new Map(
            EDGE_IDS.map((id, index) => [id, reconstructed[index]?.since]),
          );
        });

        assertIntervalInvariants(
          await readIntervals(
            backend,
            schemaFor(backend).recordedEdgesTable,
            EDGE_IDS,
          ),
          model,
        );
      }),
      { numRuns: 80 },
    );
  }, 60_000);
});
