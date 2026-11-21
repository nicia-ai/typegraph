/**
 * Shared body of the stale-statistics set-update plan tests, run against a
 * server PostgreSQL (`set-update-stale-statistics-plan.test.ts`) and PGlite
 * (`pglite-set-update-stale-statistics-plan.test.ts`).
 *
 * The nodes table is analyzed while it holds only other graphs' rows, and the
 * candidates are inserted afterwards — the state a bulk load into a large
 * shared table leaves behind, because one import never reaches autovacuum's
 * analyze threshold. PostgreSQL then estimates the fresh kind at one row.
 *
 * Each case captures the UPDATE that `updateWhere()` or `compareAndSet()`
 * sends, refusing it in the driver before it runs, and replays it under
 * `EXPLAIN (ANALYZE, BUFFERS)` in a rolled-back transaction: the plan
 * measured is the plan of the statement the store sent, executed against the
 * rows it would have written.
 */
import { expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../../src";
import type { BundledBackendCapabilityOverrides } from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";

/** Rows of other graphs the planner has statistics for. */
const PREFILL_ROWS = 50_000;

/** Candidate counts each harness measures. */
const CANDIDATE_COUNTS = [1000, 4000] as const;

/**
 * Buffers one candidate may cost: its share of the candidate read, two
 * primary-key-width index lookups and the row write with its index entries.
 * Measured at about 27–31 on a server and on PGlite; a plan that rescans the
 * fresh kind per candidate costs that kind's size per candidate instead.
 */
const MAX_BUFFERS_PER_CANDIDATE = 60;

/**
 * Index tuples and heap rows the plan may visit per candidate: one in the
 * candidate read and one in each of the two keyed lookups.
 */
const MAX_ROWS_VISITED_PER_CANDIDATE = 4;

export type RecordedStatement = Readonly<{
  text: string;
  values: readonly unknown[];
}>;

/** What a harness gives the shared cases. */
export type StaleStatisticsHarness = Readonly<{
  /** A backend over the harness's connection, with optional capabilities. */
  createBackend: (
    capabilities?: BundledBackendCapabilityOverrides,
  ) => GraphBackend;
  /** Every parameterized statement the backends sent, in order. */
  recorded: RecordedStatement[];
  /**
   * Refuses, unexecuted, the next UPDATE of the nodes table a backend sends,
   * and resolves with it once it has been refused.
   */
  interceptNextNodesUpdate: () => Promise<RecordedStatement>;
  /** `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` in a rolled-back transaction. */
  explainAnalyze: (statement: RecordedStatement) => Promise<PlanNode>;
}>;

export type PlanNode = Readonly<{
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Plan Rows": number;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  "Shared Hit Blocks": number;
  "Shared Read Blocks": number;
  Plans?: readonly PlanNode[];
}>;

/** Error a harness rejects an intercepted statement with. */
export class InterceptedStatementError extends Error {
  constructor() {
    super("intercepted before execution");
    this.name = "InterceptedStatementError";
  }
}

/** The nodes table's name in every harness. */
export const NODES_TABLE = "typegraph_nodes";

const NODES_UPDATE = new RegExp(String.raw`\bUPDATE "${NODES_TABLE}"`);

/** Whether `text` is an UPDATE of the nodes table. */
export function isNodesUpdate(text: string): boolean {
  return NODES_UPDATE.test(text);
}

/**
 * Loads {@link PREFILL_ROWS} rows of other graphs and analyzes the table, so
 * every later insert is invisible to the planner's statistics.
 */
export async function prepareStaleNodesTable(
  run: (text: string) => Promise<unknown>,
): Promise<void> {
  await run(`TRUNCATE ${NODES_TABLE}`);
  await run(
    `INSERT INTO ${NODES_TABLE}
       (graph_id, kind, id, props, version, created_at, updated_at)
     SELECT 'other_graph_' || (i % 7), 'Kind' || (i % 5), 'prefill-' || i,
            '{}'::jsonb, 1, now(), now()
     FROM generate_series(1, ${PREFILL_ROWS}) AS i`,
  );
  await run(`ANALYZE ${NODES_TABLE}`);
}

function planNodes(node: PlanNode): readonly PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap((child) => planNodes(child))];
}

/** The plan nodes that read the nodes table (`ModifyTable` only writes it). */
function nodesTableScans(plan: PlanNode): readonly PlanNode[] {
  return planNodes(plan).filter(
    (node) =>
      node["Relation Name"] === NODES_TABLE &&
      node["Node Type"] !== "ModifyTable",
  );
}

/** A scan the plan runs once per candidate, each run one id lookup. */
function isKeyedLookup(scan: PlanNode, candidates: number): boolean {
  return (
    (scan["Node Type"] === "Index Scan" ||
      scan["Node Type"] === "Index Only Scan") &&
    (scan["Index Cond"] ?? "").includes("(graph_id = ") &&
    (scan["Index Cond"] ?? "").includes("(id = ") &&
    scan["Actual Loops"] === candidates &&
    scan["Actual Rows"] <= 1
  );
}

function rowsVisited(scan: PlanNode): number {
  return (
    (scan["Actual Rows"] +
      (scan["Rows Removed by Filter"] ?? 0) +
      (scan["Rows Removed by Index Recheck"] ?? 0)) *
    scan["Actual Loops"]
  );
}

const Item = defineNode("Item", {
  schema: z.object({ status: z.string() }),
});

function staleGraph(id: string) {
  return defineGraph({ id, nodes: { Item: { type: Item } }, edges: {} });
}

/**
 * The measured shape of one stale-statistics `updateWhere()`, for the test to
 * assert and for a reader to compare across candidate counts.
 */
type StaleSetUpdateMeasurement = Readonly<{
  candidates: number;
  written: number;
  buffers: number;
  rowsVisited: number;
  candidateReadEstimate: number;
  keyedLookups: number;
  /** `Actual Loops` of every other scan of the nodes table. */
  otherScanLoops: readonly number[];
}>;

async function measureStaleSetUpdate(
  harness: StaleStatisticsHarness,
  candidates: number,
): Promise<StaleSetUpdateMeasurement> {
  const graph = staleGraph(`stale_statistics_plan_${candidates}`);
  const [store] = await createStoreWithSchema(graph, harness.createBackend(), {
    autoRefreshStatistics: false,
  });
  await store.nodes.Item.bulkInsert(
    Array.from({ length: candidates }, (_, index) => ({
      id: `fresh-${index}`,
      props: { status: "pending" },
    })),
  );

  const intercepted = harness.interceptNextNodesUpdate();
  await expect(
    store.nodes.Item.updateWhere({
      where: (item) => item.status.eq("pending"),
      patch: { status: "promoted" },
    }),
  ).rejects.toThrow();
  const plan = await harness.explainAnalyze(await intercepted);
  const scans = nodesTableScans(plan);
  const keyed = scans.filter((scan) => isKeyedLookup(scan, candidates));
  const others = scans.filter((scan) => !keyed.includes(scan));
  return {
    candidates,
    written: plan["Actual Rows"],
    buffers: plan["Shared Hit Blocks"] + plan["Shared Read Blocks"],
    rowsVisited: scans.reduce((total, scan) => total + rowsVisited(scan), 0),
    candidateReadEstimate: Math.max(
      0,
      ...others.map((scan) => scan["Plan Rows"]),
    ),
    keyedLookups: keyed.length,
    otherScanLoops: others.map((scan) => scan["Actual Loops"]),
  };
}

/** Fresh rows of the kind the point-mutation case selects one id from. */
const POINT_MUTATION_FRESH_ROWS = 4000;

/** The candidate read and write-phase lookups of one stale point mutation. */
type StalePointMutationMeasurement = Readonly<{
  written: number;
  keyedLookups: number;
  /** Rows each other scan of the nodes table returned and filtered out. */
  otherScans: readonly Readonly<{ rows: number; removed: number }>[];
}>;

async function measureStalePointMutation(
  harness: StaleStatisticsHarness,
  operation: "compareAndSet" | "updateWhere",
): Promise<StalePointMutationMeasurement> {
  const graph = staleGraph(`stale_statistics_point_${operation}`);
  const [store] = await createStoreWithSchema(graph, harness.createBackend(), {
    autoRefreshStatistics: false,
  });
  const target = await store.nodes.Item.create({ status: "pending" });
  await store.nodes.Item.bulkInsert(
    Array.from({ length: POINT_MUTATION_FRESH_ROWS - 1 }, (_, index) => ({
      id: `point-${index}`,
      props: { status: "pending" },
    })),
  );
  const targetId = target.id;

  const intercepted = harness.interceptNextNodesUpdate();
  await expect(
    operation === "compareAndSet" ?
      store.nodes.Item.compareAndSet(targetId, {
        expected: { status: "pending" },
        patch: { status: "promoted" },
      })
    : store.nodes.Item.updateWhere({
        where: (item) => item.id.eq(targetId),
        patch: { status: "promoted" },
      }),
  ).rejects.toThrow();
  const plan = await harness.explainAnalyze(await intercepted);
  const scans = nodesTableScans(plan);
  const keyed = scans.filter((scan) => isKeyedLookup(scan, 1));
  return {
    written: plan["Actual Rows"],
    keyedLookups: keyed.length,
    otherScans: scans
      .filter((scan) => !keyed.includes(scan))
      .map((scan) => ({
        rows: scan["Actual Rows"],
        removed: scan["Rows Removed by Filter"] ?? 0,
      })),
  };
}

/** Registers the shared cases against `harness()`, resolved per test. */
export function registerStaleStatisticsPlanCases(
  harness: () => StaleStatisticsHarness | undefined,
): void {
  it.for(CANDIDATE_COUNTS)(
    "writes %i fresh candidates by one keyed lookup each, in buffers linear in the count",
    async (candidates, ctx) => {
      const active = harness();
      if (active === undefined) {
        ctx.skip();
        return;
      }
      const measured = await measureStaleSetUpdate(active, candidates);

      // The statistics really are stale: the planner believes the fresh kind
      // is a sliver of what it reads.
      expect(measured.candidateReadEstimate).toBeLessThan(candidates / 10);
      expect({
        written: measured.written,
        // The target row and the snapshot's version are each found by an
        // index condition on the candidate's id, once per candidate; the only
        // other read of the nodes table is the one candidate read.
        keyedLookups: measured.keyedLookups,
        otherScanLoops: measured.otherScanLoops,
        withinRowsVisited:
          measured.rowsVisited <= MAX_ROWS_VISITED_PER_CANDIDATE * candidates,
        withinBuffers:
          measured.buffers <= MAX_BUFFERS_PER_CANDIDATE * candidates,
      }).toEqual({
        written: candidates,
        keyedLookups: 2,
        otherScanLoops: [1],
        withinRowsVisited: true,
        withinBuffers: true,
      });
    },
  );

  it("writes every candidate in one statement whatever the bind budget", async (ctx) => {
    const active = harness();
    if (active === undefined) {
      ctx.skip();
      return;
    }
    const bindBudget = 64;
    const graph = staleGraph("stale_statistics_bind_budget");
    const [store] = await createStoreWithSchema(
      graph,
      active.createBackend({ maxBindParameters: bindBudget }),
      { autoRefreshStatistics: false },
    );
    const ids = Array.from({ length: 100 }, (_, index) => `budget-${index}`);
    await store.nodes.Item.bulkInsert(
      ids.map((id) => ({ id, props: { status: "pending" } })),
    );

    active.recorded.length = 0;
    const { affectedCount } = await store.nodes.Item.updateWhere({
      where: (item) => item.status.eq("pending"),
      patch: { status: "updated" },
    });
    const updates = active.recorded.filter((statement) =>
      isNodesUpdate(statement.text),
    );

    expect(affectedCount).toBe(ids.length);
    expect(updates).toHaveLength(1);
    expect(requireDefined(updates[0]).values.length).toBeLessThanOrEqual(
      bindBudget,
    );
  });

  // KNOWN LIMITATION, pinned so a change to it is seen. Only the write phase
  // is keyed. A point mutation's candidate query is the compiler's
  // `graph_id = ? AND kind = ? AND id = ?` read, and with the fresh kind
  // estimated at one row PostgreSQL reads it through the `graph_id` index
  // (measured on a server and on PGlite) and filters the id: one row
  // selected, every other un-analyzed row of the kind filtered out. One call
  // is linear in the kind; a loop of them is quadratic, like the import
  // update, bulkReparent and merge-apply loops measured by
  // `bench:stale-statistics`. Keying the candidate read means changing how
  // the shared compiler emits an id predicate for every query, which is left
  // to that sibling work.
  it.for(["compareAndSet", "updateWhere"] as const)(
    "%s of one id still scans the fresh kind to select it (known limitation)",
    async (operation, ctx) => {
      const active = harness();
      if (active === undefined) {
        ctx.skip();
        return;
      }
      const measured = await measureStalePointMutation(active, operation);

      expect(measured).toEqual({
        written: 1,
        // The write finds the target, and for updateWhere the version its
        // snapshot read, by the id.
        keyedLookups: operation === "updateWhere" ? 2 : 1,
        otherScans: [{ rows: 1, removed: POINT_MUTATION_FRESH_ROWS - 1 }],
      });
    },
  );
}
