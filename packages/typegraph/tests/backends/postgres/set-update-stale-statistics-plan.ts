/**
 * Shared body of the stale-statistics set-update plan tests, run against a
 * server PostgreSQL (`set-update-stale-statistics-plan.test.ts`) and PGlite
 * (`pglite-set-update-stale-statistics-plan.test.ts`).
 *
 * The nodes table is analyzed before the candidates are inserted — the state a
 * bulk load into a large shared table leaves behind, because one import never
 * reaches autovacuum's analyze threshold. It holds two distributions. Most
 * cases select a graph the statistics have never seen, so PostgreSQL estimates
 * the fresh kind at about one row. The separated cases select a graph and a
 * kind that the statistics hold separately but never together, so PostgreSQL
 * multiplies their frequencies and estimates thousands of candidates whatever
 * the actual count.
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

/**
 * The graph of the separated cases. The analyzed table holds
 * {@link SEPARATED_ROWS} rows of it under other kinds, and as many rows of
 * other graphs under the kinds those cases write.
 */
const SEPARATED_GRAPH = "stale_statistics_separated";

/** Analyzed rows on each side of the separated distribution. */
const SEPARATED_ROWS = 20_000;

/** Candidate counts the separated cases measure, one kind each. */
const SEPARATED_COUNTS = [1, 4000] as const;

type SeparatedCount = (typeof SEPARATED_COUNTS)[number];

function separatedKind<C extends SeparatedCount>(
  candidates: C,
): `Separated${C}` {
  return `Separated${candidates}`;
}

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

/**
 * Rows the plan's nodes may produce per candidate, summed over every node
 * and loop: the candidate read, the key subquery, the joins and the lookups
 * each pass a candidate on once. Measured at 11 on a server and on
 * PGlite. A join that rescans a materialized input once per candidate, which
 * the scans alone do not show, produces that input's size per candidate.
 */
const MAX_PLAN_ROWS_PER_CANDIDATE = 16;

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
  /** The number in the first column of the first row `text` returns. */
  queryNumber: (text: string) => Promise<number>;
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
 * Loads {@link PREFILL_ROWS} rows of other graphs and both sides of the
 * separated distribution, and analyzes the table, so every later insert is
 * invisible to the planner's statistics.
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
  await run(
    `INSERT INTO ${NODES_TABLE}
       (graph_id, kind, id, props, version, created_at, updated_at)
     SELECT '${SEPARATED_GRAPH}', 'Other' || (i % 5), 'separated-graph-' || i,
            '{}'::jsonb, 1, now(), now()
     FROM generate_series(1, ${SEPARATED_ROWS}) AS i`,
  );
  const separatedKinds = SEPARATED_COUNTS.map(
    (candidates) => `'${separatedKind(candidates)}'`,
  ).join(", ");
  await run(
    `INSERT INTO ${NODES_TABLE}
       (graph_id, kind, id, props, version, created_at, updated_at)
     SELECT 'other_graph_' || (i % 7),
            (ARRAY[${separatedKinds}])[1 + i % ${SEPARATED_COUNTS.length}],
            'separated-kind-' || i, '{}'::jsonb, 1, now(), now()
     FROM generate_series(1, ${SEPARATED_ROWS}) AS i`,
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

function rowsProduced(plan: PlanNode): number {
  return planNodes(plan).reduce(
    (total, node) => total + node["Actual Rows"] * node["Actual Loops"],
    0,
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
  /** See {@link SeparatedSetUpdateMeasurement.rowsProduced}. */
  rowsProduced: number;
}>;

const separatedSchema = z.object({ status: z.string() });

const separatedGraph = defineGraph({
  id: SEPARATED_GRAPH,
  nodes: {
    [separatedKind(1)]: {
      type: defineNode(separatedKind(1), { schema: separatedSchema }),
    },
    [separatedKind(4000)]: {
      type: defineNode(separatedKind(4000), { schema: separatedSchema }),
    },
  },
  edges: {},
});

/** One separated-distribution `updateWhere({ all: true })`, measured. */
type SeparatedSetUpdateMeasurement = Readonly<{
  written: number;
  buffers: number;
  rowsVisited: number;
  candidateReadEstimate: number;
  /** Every read of the nodes table other than a keyed lookup: its loops and the rows it visited. */
  otherScans: readonly Readonly<{ loops: number; rowsVisited: number }>[];
  /**
   * Rows every node of the plan produced, summed over its loops: the work of
   * joins, sorts and rescanned materializations as well as of the scans.
   */
  rowsProduced: number;
  /** Rows in the nodes table, the candidates included. */
  tableRows: number;
  /** Heap pages of the nodes table. */
  tablePages: number;
}>;

/** Ids a by-id selection names in the separated distribution. */
const SEPARATED_IDS_SELECTED = 100;

async function measureSeparatedSetUpdate(
  harness: StaleStatisticsHarness,
  candidates: SeparatedCount,
  selection: "all" | "idsAndProperty" = "all",
): Promise<SeparatedSetUpdateMeasurement> {
  const [store] = await createStoreWithSchema(
    separatedGraph,
    harness.createBackend(),
    { autoRefreshStatistics: false },
  );
  const collection = store.nodes[separatedKind(candidates)];
  // The harness prepares its table once, so each selection inserts rows of
  // its own and the cases stay independent of their order.
  const idPrefix = selection === "all" ? "separated-fresh" : "separated-by-id";
  await collection.bulkInsert(
    Array.from({ length: candidates }, (_, index) => ({
      id: `${idPrefix}-${index}`,
      props: { status: "pending" },
    })),
  );

  const intercepted = harness.interceptNextNodesUpdate();
  const selectedIds = Array.from(
    { length: Math.min(SEPARATED_IDS_SELECTED, candidates) },
    (_, index) => `${idPrefix}-${index}`,
  );
  await expect(
    selection === "all" ?
      collection.updateWhere({ all: true, patch: { status: "promoted" } })
    : collection.updateWhere({
        where: (node) => node.id.in(selectedIds).and(node.status.eq("pending")),
        patch: { status: "promoted" },
      }),
  ).rejects.toThrow();
  const plan = await harness.explainAnalyze(await intercepted);
  const scans = nodesTableScans(plan);
  const written = selection === "all" ? candidates : selectedIds.length;
  const keyed = new Set(scans.filter((scan) => isKeyedLookup(scan, written)));
  const others = scans.filter((scan) => !keyed.has(scan));
  return {
    written: plan["Actual Rows"],
    buffers: plan["Shared Hit Blocks"] + plan["Shared Read Blocks"],
    rowsVisited: scans.reduce((total, scan) => total + rowsVisited(scan), 0),
    candidateReadEstimate: Math.min(...others.map((scan) => scan["Plan Rows"])),
    rowsProduced: rowsProduced(plan),
    otherScans: others.map((scan) => ({
      loops: scan["Actual Loops"],
      rowsVisited: rowsVisited(scan),
    })),
    tableRows: await harness.queryNumber(`SELECT count(*) FROM ${NODES_TABLE}`),
    tablePages: await harness.queryNumber(
      `SELECT pg_relation_size('${NODES_TABLE}') / current_setting('block_size')::int`,
    ),
  };
}

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
    rowsProduced: rowsProduced(plan),
  };
}

/** Candidates of the reused-id case. */
const REUSED_ID_CANDIDATES = 1000;

/** Other kinds of the reused-id case's graph that hold every candidate's id. */
const REUSED_ID_KINDS = 100;

/**
 * Index entries one keyed lookup visits when a candidate's id is also held by
 * {@link REUSED_ID_KINDS} other kinds of its graph: the `(graph_id, id)` index
 * returns the id under every kind, and the kind is filtered afterwards.
 */
const REUSED_ID_ROWS_PER_LOOKUP = REUSED_ID_KINDS + 1;

/** The reused-id case's write phase, measured. */
type ReusedIdSetUpdateMeasurement = Readonly<{
  written: number;
  /** Per keyed lookup: index used, loops, rows visited. */
  keyedLookups: readonly Readonly<{
    index: string;
    loops: number;
    rowsVisited: number;
  }>[];
  /** Every other read of the nodes table: its loops and the rows it visited. */
  otherScans: readonly Readonly<{ loops: number; rowsVisited: number }>[];
  buffers: number;
  tableRows: number;
}>;

/**
 * `updateWhere()` over {@link REUSED_ID_CANDIDATES} fresh candidates whose ids
 * {@link REUSED_ID_KINDS} other kinds of the same graph also hold, all
 * inserted after the table was analyzed.
 */
async function measureReusedIdSetUpdate(
  harness: StaleStatisticsHarness,
): Promise<ReusedIdSetUpdateMeasurement> {
  const graphId = "stale_statistics_reused_ids";
  const [store] = await createStoreWithSchema(
    staleGraph(graphId),
    harness.createBackend(),
    { autoRefreshStatistics: false },
  );
  const reused = await harness.queryNumber(
    `WITH inserted AS (
       INSERT INTO ${NODES_TABLE}
         (graph_id, kind, id, props, version, created_at, updated_at)
       SELECT '${graphId}', 'Reused' || kind_index, 'reused-' || id_index,
              '{}'::jsonb, 1, now(), now()
       FROM generate_series(1, ${REUSED_ID_KINDS}) AS kind_index,
            generate_series(0, ${REUSED_ID_CANDIDATES - 1}) AS id_index
       RETURNING 1
     )
     SELECT count(*) FROM inserted`,
  );
  expect(reused).toBe(REUSED_ID_KINDS * REUSED_ID_CANDIDATES);
  // Inserted after the other kinds' rows, each candidate's entry is the last
  // of its id's entries in the `(graph_id, id)` index. A lookup that stops at
  // its first match (the join covers the primary key, so PostgreSQL knows at
  // most one row matches) still reads every other kind's entry before it.
  await store.nodes.Item.bulkInsert(
    Array.from({ length: REUSED_ID_CANDIDATES }, (_, index) => ({
      id: `reused-${index}`,
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
  const keyed = scans.filter(
    (scan) =>
      (scan["Node Type"] === "Index Scan" ||
        scan["Node Type"] === "Index Only Scan") &&
      scan["Actual Loops"] === REUSED_ID_CANDIDATES,
  );
  return {
    written: plan["Actual Rows"],
    keyedLookups: keyed.map((scan) => ({
      index: scan["Index Name"] ?? "",
      loops: scan["Actual Loops"],
      rowsVisited: rowsVisited(scan),
    })),
    otherScans: scans
      .filter((scan) => !keyed.includes(scan))
      .map((scan) => ({
        loops: scan["Actual Loops"],
        rowsVisited: rowsVisited(scan),
      })),
    buffers: plan["Shared Hit Blocks"] + plan["Shared Read Blocks"],
    tableRows: await harness.queryNumber(`SELECT count(*) FROM ${NODES_TABLE}`),
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
        withinRowsProduced:
          measured.rowsProduced <= MAX_PLAN_ROWS_PER_CANDIDATE * candidates,
        withinBuffers:
          measured.buffers <= MAX_BUFFERS_PER_CANDIDATE * candidates,
      }).toEqual({
        written: candidates,
        keyedLookups: 2,
        otherScanLoops: [1],
        withinRowsVisited: true,
        withinRowsProduced: true,
        withinBuffers: true,
      });
    },
  );

  // The bound the write phase keeps whatever the statistics say: every read
  // of the nodes table other than the keyed lookups runs once, so the plan
  // visits at most one scan of the table plus a constant number of rows per
  // candidate. Which side of that bound PostgreSQL takes follows its estimate
  // of the candidate count, not the actual count. Here the graph and the kind
  // are each in the statistics but never together, so it multiplies their
  // frequencies and estimates thousands of candidates; measured on a server
  // and on PGlite, it hashes them against one sequential scan of the whole
  // table even for a single candidate. The case asserts the bound and the
  // writes, not that plan: two keyed lookups and no scan would satisfy it
  // too, and are cheaper.
  it.for(SEPARATED_COUNTS)(
    "writes %i candidates of a graph and kind analyzed only apart within one table scan plus keyed lookups",
    async (candidates, ctx) => {
      const active = harness();
      if (active === undefined) {
        ctx.skip();
        return;
      }
      const measured = await measureSeparatedSetUpdate(active, candidates);

      // The planner multiplies the graph's and the kind's frequencies.
      expect(measured.candidateReadEstimate).toBeGreaterThan(1000);
      expect({
        written: measured.written,
        everyOtherReadRunsOnce: measured.otherScans.every(
          (scan) => scan.loops === 1,
        ),
        atMostOneWholeTableScan:
          measured.otherScans.filter(
            (scan) => scan.rowsVisited >= measured.tableRows,
          ).length <= 1,
        withinRowsVisited:
          measured.rowsVisited <=
          measured.tableRows + MAX_ROWS_VISITED_PER_CANDIDATE * candidates,
        withinRowsProduced:
          measured.rowsProduced <=
          measured.tableRows + MAX_PLAN_ROWS_PER_CANDIDATE * candidates,
        withinBuffers:
          measured.buffers <=
          measured.tablePages + MAX_BUFFERS_PER_CANDIDATE * candidates,
      }).toEqual({
        written: candidates,
        everyOtherReadRunsOnce: true,
        atMostOneWholeTableScan: true,
        withinRowsVisited: true,
        withinRowsProduced: true,
        withinBuffers: true,
      });
    },
  );

  // A selection that names ids is estimated from the id list, whatever the
  // graph's and the kind's frequencies, so it stays keyed in the distribution
  // where a selection over the whole kind scans the table, and it does so
  // with a further property predicate beside the ids.
  it("keeps a selection by ids and a property keyed when the graph and kind are analyzed only apart", async (ctx) => {
    const active = harness();
    if (active === undefined) {
      ctx.skip();
      return;
    }
    const measured = await measureSeparatedSetUpdate(
      active,
      4000,
      "idsAndProperty",
    );

    expect({
      written: measured.written,
      wholeTableScans: measured.otherScans.filter(
        (scan) => scan.rowsVisited >= measured.tableRows,
      ).length,
      everyOtherReadRunsOnce: measured.otherScans.every(
        (scan) => scan.loops === 1,
      ),
      withinRowsVisited:
        measured.rowsVisited <=
        MAX_ROWS_VISITED_PER_CANDIDATE * SEPARATED_IDS_SELECTED,
      withinBuffers:
        measured.buffers <= MAX_BUFFERS_PER_CANDIDATE * SEPARATED_IDS_SELECTED,
    }).toEqual({
      written: SEPARATED_IDS_SELECTED,
      wholeTableScans: 0,
      everyOtherReadRunsOnce: true,
      withinRowsVisited: true,
      withinBuffers: true,
    });
  });

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
    "%s of one id selects it by key or by one scan of the fresh kind (known limitation)",
    async (operation, ctx) => {
      const active = harness();
      if (active === undefined) {
        ctx.skip();
        return;
      }
      const measured = await measureStalePointMutation(active, operation);

      // The write finds the target, and for updateWhere the version its
      // snapshot read, by the id.
      const writeLookups = operation === "updateWhere" ? 2 : 1;
      // PostgreSQL chooses how the candidate read finds the id from its
      // estimate of the fresh kind, which varies with what ANALYZE sampled:
      // usually it scans the kind's un-analyzed rows and filters the id (the
      // limitation), sometimes it looks the id up by key as well. Both are
      // correct, and neither rescans.
      const candidateReadByKey = measured.otherScans.length === 0;
      expect(measured).toEqual(
        candidateReadByKey ?
          { written: 1, keyedLookups: writeLookups + 1, otherScans: [] }
        : {
            written: 1,
            keyedLookups: writeLookups,
            otherScans: [{ rows: 1, removed: POINT_MUTATION_FRESH_ROWS - 1 }],
          },
      );
    },
  );

  // STATED LIMIT, pinned so a change to it is seen. Registered last: its
  // 100,000 rows would change the plans of the cases above. The write phase's
  // constant work per candidate assumes ids are unique within a graph across
  // kinds, which generated ids are. Both keyed lookups use the `(graph_id,
  // id)` index and filter the kind afterwards, and they stop at the first
  // row of the candidate's kind (the join covers the primary key), so an id
  // that K other kinds of the graph hold ahead of the candidate costs up to K
  // more index entries in each lookup. Measured on a server and on PGlite.
  it("visits every kind's entry of an id reused across kinds of the graph (stated limit)", async (ctx) => {
    const active = harness();
    if (active === undefined) {
      ctx.skip();
      return;
    }
    const measured = await measureReusedIdSetUpdate(active);

    const lookup = {
      index: `${NODES_TABLE}_id_idx`,
      loops: REUSED_ID_CANDIDATES,
      rowsVisited: REUSED_ID_ROWS_PER_LOOKUP * REUSED_ID_CANDIDATES,
    };
    expect({
      written: measured.written,
      keyedLookups: measured.keyedLookups,
      otherScanLoops: measured.otherScans.map((scan) => scan.loops),
    }).toEqual({
      written: REUSED_ID_CANDIDATES,
      keyedLookups: [lookup, lookup],
      otherScanLoops: [1],
    });
  });
}
