/**
 * Two Stores writing through ONE native transaction.
 *
 * Store state kept for a transaction (the managed write session of a
 * `store.transaction` attempt, leased schema fences, held graph write locks)
 * is state about the transaction TOGETHER WITH what it is state about: one
 * Store binding's graph, physical tables, revision and history configuration,
 * and command port. Two Stores sharing one native transaction must keep it
 * apart; a change that keys that state by the native transaction alone pools
 * it across them.
 *
 * The three `scope:` cases reproduce shapes where pooling changes the outcome
 * and assert today's outcome on every driver where the shape exists.
 *
 * The pair suite then drives every Store-configuration pair the
 * {@link PAIR_DIMENSIONS} table generates, through a caller's native
 * transaction and through the first Store's `store.transaction`, each with
 * and without a caller savepoint rolled back between the two Stores' writes.
 * Every pair has runs in which BOTH Stores write; a run that cannot is listed
 * in {@link expectedWrites} with the reason. Its complete observation (write
 * outcomes, receipts, revisions, rows and every statement the connection ran)
 * is compared with a per-driver golden, so a golden that moves is a behaviour
 * change.
 */
import { fileURLToPath } from "node:url";

import { sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import type { AdapterBackend } from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { PER_BEGIN_NATIVE_DRIVERS } from "../../helpers/native-transaction-handles";
import {
  prefixedTableNames,
  type TracedConnection,
  type TracedStatement,
  type TracedTableNames,
} from "../../helpers/traced-connection";
import type {
  IntegrationLaneDriver,
  IntegrationTestContext,
} from "./test-context";

const ScopeItem = defineNode("ScopeItem", {
  schema: z.object({ label: z.string() }),
});
const scopeLink = defineEdge("scopeLink", {
  schema: z.object({ label: z.string() }),
});

/** The two physical table sets a case can place a Store on. */
const TABLE_SETS = [
  prefixedTableNames("tss_one"),
  prefixedTableNames("tss_two"),
] as const satisfies readonly TracedTableNames[];

type GraphOptions = Readonly<{ id: string; constraints: boolean }>;

function scopeGraph(options: GraphOptions) {
  return defineGraph({
    id: options.id,
    nodes: {
      ScopeItem: {
        type: ScopeItem,
        ...(options.constraints ?
          {
            unique: [
              {
                name: "scope_item_label",
                fields: ["label"],
                scope: "kind",
                collation: "binary",
              },
            ],
          }
        : {}),
      },
    },
    edges: {
      scopeLink: {
        type: scopeLink,
        from: [ScopeItem],
        to: [ScopeItem],
        matchIdentity: { name: "scope-link-label", fields: ["label"] },
      },
    },
  });
}

const POSTGRES_DRIVERS: ReadonlySet<IntegrationLaneDriver> = new Set([
  "pglite",
  "node-postgres",
  "postgres-js",
]);

function describeFailure(error: unknown): string {
  if (error instanceof TypeGraphError) {
    const detailCode = error.details["code"];
    return typeof detailCode === "string" && detailCode !== error.code ?
        `${error.name}[${error.code}:${detailCode}]`
      : `${error.name}[${error.code}]`;
  }
  if (!(error instanceof Error)) return `non-error ${String(error)}`;
  const code = engineCodeOf(error);
  return code === undefined ? error.name : `${error.name}[${code}]`;
}

/** The engine code an error, or the first error in its cause chain, carries. */
function engineCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : engineCodeOf(error.cause);
}

async function outcomeOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
    return "ok";
  } catch (error) {
    return describeFailure(error);
  }
}

type DrizzleStatementRunner = Readonly<{
  run?: (query: unknown) => unknown;
  execute?: (query: unknown) => unknown;
}>;

/**
 * Runs one statement on a caller's native transaction handle, as the caller's
 * own SQL would: through the Drizzle handle, not through any TypeGraph
 * binding, so no TypeGraph state sees it.
 */
async function callerStatement(
  driver: IntegrationLaneDriver,
  native: unknown,
  text: string,
): Promise<void> {
  const handle = native as DrizzleStatementRunner;
  const query = drizzleSql.raw(text);
  const method = POSTGRES_DRIVERS.has(driver) ? "execute" : "run";
  if (handle[method] === undefined) {
    throw new Error(`The native handle has no ${method}().`);
  }
  // Called as a method: Drizzle's `run` / `execute` read their receiver.
  await handle[method](query);
}

/** How many statements read or locked `graphId`'s row in a schema table. */
function schemaFenceCount(
  statements: readonly TracedStatement[],
  tables: TracedTableNames,
  graphId: string,
): number {
  return statements.filter(
    (statement) =>
      statement.text.includes(`"${tables.schemaVersions}"`) &&
      statement.params.includes(graphId),
  ).length;
}

async function liveNodeIds(
  backend: AdapterBackend<unknown>,
  tables: TracedTableNames,
  graphId: string,
): Promise<readonly string[]> {
  const rows = await backend.execute<{ id: string }>(
    asCompiledRowsSql(sql`
      SELECT id FROM ${sql.identifier(tables.nodes)}
      WHERE graph_id = ${graphId} AND deleted_at IS NULL
    `),
  );
  return rows.map((row) => row.id).toSorted();
}

async function recordedNodeCount(
  backend: AdapterBackend<unknown>,
  tables: TracedTableNames,
  graphId: string,
): Promise<number> {
  const rows = await backend.execute<{ count: number | string }>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count FROM ${sql.identifier(tables.recordedNodes)}
      WHERE graph_id = ${graphId}
    `),
  );
  return Number(requireDefined(rows[0]).count);
}

/**
 * The sequence number of a revision token (`r2:<origin>:<hash>:<seq>:<at>`),
 * or `none` when the Store reports no revision.
 */
function revisionSequence(revision: unknown): string {
  if (revision === undefined) return "none";
  if (typeof revision !== "string") return "unparsed";
  const parts = revision.split(":");
  return parts.length >= 4 ?
      String(Number.parseInt(requireDefined(parts[3]), 10))
    : "unparsed";
}

// --- the generated Store pairs ---------------------------------------------

/** One Store's configuration in a pair. */
type StoreConfig = Readonly<{
  /** Which of the case's two graph ids. */
  graph: 0 | 1;
  /** Which of {@link TABLE_SETS}. */
  tables: 0 | 1;
  history: boolean;
  revisionTracking: boolean;
  constraints: boolean;
}>;

const BASE_CONFIG: StoreConfig = {
  graph: 0,
  tables: 0,
  history: false,
  revisionTracking: false,
  constraints: false,
};

/**
 * Every dimension two Stores on one transaction can differ in, with the
 * configuration that differs from {@link BASE_CONFIG} in it alone.
 */
const PAIR_DIMENSIONS = [
  { name: "graph-id", differ: { ...BASE_CONFIG, graph: 1 } },
  { name: "physical-tables", differ: { ...BASE_CONFIG, tables: 1 } },
  { name: "history", differ: { ...BASE_CONFIG, history: true } },
  {
    name: "revision-tracking",
    differ: { ...BASE_CONFIG, revisionTracking: true },
  },
  // Declaring a uniqueness constraint changes the graph's schema: on the
  // other Store's graph id, creating the second Store would leave the first
  // one stale and every one of its writes would fail STALE_SCHEMA_VERSION. The
  // constrained Store therefore has its own graph id on the same tables.
  {
    name: "constraints",
    differ: { ...BASE_CONFIG, graph: 1, constraints: true },
  },
] as const satisfies readonly Readonly<{
  name: string;
  differ: StoreConfig;
}>[];

type StorePair = Readonly<{ name: string; a: StoreConfig; b: StoreConfig }>;

/**
 * The identical pair, then for every dimension the pair that differs in it,
 * with the differing Store first (A, which opens or adopts the transaction
 * first) and second (B).
 */
const STORE_PAIRS: readonly StorePair[] = [
  { name: "identical", a: BASE_CONFIG, b: BASE_CONFIG },
  ...PAIR_DIMENSIONS.flatMap((dimension) => [
    {
      name: `${dimension.name}-differs-on-a`,
      a: dimension.differ,
      b: BASE_CONFIG,
    },
    {
      name: `${dimension.name}-differs-on-b`,
      a: BASE_CONFIG,
      b: dimension.differ,
    },
  ]),
];

/** How the outer native transaction is opened. */
const ENTRY_KINDS = ["caller-native", "store-transaction"] as const;
type EntryKind = (typeof ENTRY_KINDS)[number];

/** Successful writes per Store in one run of a pair. */
type WriteCounts = Readonly<{ a: number; b: number }>;

/**
 * The writes each Store must complete in one run, and why when it is not
 * both. Every run writes twice per Store (B's first write survives the
 * savepoint rollback as a call that succeeded, then is undone).
 *
 * A Store with history or revision tracking withholds `tx.sql` from its
 * `store.transaction` callback by contract (raw SQL would bypass its capture
 * or its revision), so a run entered through such a Store's
 * `store.transaction` has no native handle to give B: it is a refusal before
 * either Store writes. The same pair's caller-native runs have both write.
 */
function expectedWrites(
  pair: StorePair,
  entry: EntryKind,
): Readonly<{ counts: WriteCounts; refusal?: string }> {
  if (
    entry === "store-transaction" &&
    (pair.a.history || pair.a.revisionTracking)
  ) {
    return {
      counts: { a: 0, b: 0 },
      refusal: "A withholds tx.sql, so B has no handle and nothing is written",
    };
  }
  return { counts: { a: 2, b: 2 } };
}

/** The surface of a Store the pair suite writes through. */
type ItemWriter = Readonly<{
  nodes: Readonly<{
    ScopeItem: Readonly<{
      create: (
        props: Readonly<{ label: string }>,
        options: Readonly<{ id: string }>,
      ) => Promise<unknown>;
    }>;
  }>;
}>;

type ReceiptOutcome = Readonly<{
  receipt: Readonly<{ writes: Readonly<{ total: number }> }>;
}>;

/** A Store of any configuration, as the pair suite drives it. */
type PairStore = Readonly<{
  revisionNow: () => Promise<unknown>;
  withTransaction: (native: unknown) => ItemWriter;
  withRecordedTransaction: <T>(
    native: unknown,
    fn: (tx: ItemWriter) => Promise<T>,
  ) => Promise<ReceiptOutcome & Readonly<{ result: T }>>;
  transactionWithReceipt: <T>(
    fn: (tx: ItemWriter & Readonly<{ sql?: unknown }>) => Promise<T>,
  ) => Promise<ReceiptOutcome & Readonly<{ result: T }>>;
}>;

type PairSide = Readonly<{
  label: "A" | "B";
  config: StoreConfig;
  store: PairStore;
}>;

/**
 * Runs `body` with `side`'s Store bound to `native`: a history Store through
 * `withRecordedTransaction` (the only adoption it allows), any other through
 * `withTransaction`. Returns the receipt total where the entry has one.
 */
async function withAdopted(
  side: PairSide,
  native: unknown,
  body: (tx: ItemWriter) => Promise<void>,
): Promise<string> {
  if (side.config.history) {
    const outcome = await side.store.withRecordedTransaction(native, body);
    return `receipt ${outcome.receipt.writes.total}`;
  }
  await body(side.store.withTransaction(native));
  return "no receipt";
}

type PairRun = Readonly<{
  entry: EntryKind;
  savepoint: boolean;
  /** Prefix of every node id and label this run writes. */
  prefix: string;
}>;

/**
 * One transaction of a pair: A writes, B writes (inside a caller savepoint
 * that is rolled back, when `savepoint`), B writes again, A writes again.
 * Returns the observation lines; the statements the connection ran are read
 * from `connection` by the caller.
 */
async function runPairTransaction(
  driver: IntegrationLaneDriver,
  root: AdapterBackend<unknown>,
  sides: Readonly<{ a: PairSide; b: PairSide }>,
  run: PairRun,
): Promise<Readonly<{ lines: readonly string[]; writes: WriteCounts }>> {
  const steps: string[] = [];
  const settlements: string[] = [];
  const writes = { a: 0, b: 0 };
  async function step(name: string, pending: () => Promise<unknown>) {
    const outcome = await outcomeOf(pending());
    steps.push(`${name}=${outcome}`);
    if (outcome !== "ok") return;
    if (/^a\d$/u.test(name)) writes.a += 1;
    if (/^b\d$/u.test(name)) writes.b += 1;
  }
  const write = (writer: ItemWriter, suffix: string) => () =>
    writer.nodes.ScopeItem.create(
      { label: `${run.prefix}${suffix}` },
      { id: `${run.prefix}${suffix}` },
    );
  async function inside(aTx: ItemWriter, native: unknown): Promise<void> {
    await step("a1", write(aTx, "a1"));
    const settledB = await outcomeOf(
      withAdopted(sides.b, native, async (bTx) => {
        if (run.savepoint) {
          await step("savepoint", () =>
            callerStatement(driver, native, "SAVEPOINT tss_pair"),
          );
        }
        await step("b1", write(bTx, "b1"));
        if (run.savepoint) {
          await step("rollback-to", () =>
            callerStatement(driver, native, "ROLLBACK TO SAVEPOINT tss_pair"),
          );
        }
        await step("b2", write(bTx, "b2"));
      }).then((receipt) => {
        settlements.push(`B ${receipt}`);
      }),
    );
    if (settledB !== "ok") settlements.push(`B ${settledB}`);
    await step("a2", write(aTx, "a2"));
  }
  const settled = await outcomeOf(
    run.entry === "caller-native" ?
      root.transactionWithNative(async (_target, native) => {
        settlements.push(
          `A ${await withAdopted(sides.a, native, (aTx) => inside(aTx, native))}`,
        );
      })
    : sides.a.store
        .transactionWithReceipt(async (aTx) => {
          await inside(aTx, aTx.sql);
        })
        .then((outcome) => {
          settlements.push(`A receipt ${outcome.receipt.writes.total}`);
        }),
  );
  return {
    lines: [
      `steps: ${steps.join(" ")}`,
      `settled: ${settled}`,
      `writes: A ${writes.a} B ${writes.b}`,
      ...settlements.map((settlement) => `settlement: ${settlement}`),
    ],
    // A write inside a transaction that then failed to settle did not land.
    writes: settled === "ok" ? writes : { a: 0, b: 0 },
  };
}

/** Collapses whitespace and replaces every volatile token with a stable one. */
function createTraceCanonicalizer(
  replacements: ReadonlyMap<string, string>,
): (text: string) => string {
  const numbered = new Map<string, string>();
  function renumber(kind: string, token: string): string {
    const known = numbered.get(token);
    if (known !== undefined) return known;
    const label = `<${kind}:${numbered.size + 1}>`;
    numbered.set(token, label);
    return label;
  }
  return (text) => {
    let canonical = text.replaceAll(/\s+/gu, " ").trim();
    for (const [token, replacement] of replacements) {
      canonical = canonical.replaceAll(token, replacement);
    }
    return (
      canonical
        .replaceAll(/r2:[\w-]+:[\da-f]+:\d+:[\dT:.Z-]+/gu, (token) =>
          renumber("revision", token),
        )
        .replaceAll(
          /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/gu,
          "<timestamp>",
        )
        .replaceAll(/(?<=")[\w-]{21}(?=")/gu, (token) =>
          renumber("random", token),
        )
        .replaceAll(/(?<=")[\da-f]{32}(?=")/gu, (token) =>
          renumber("hash", token),
        )
        // A random per-transaction marker set and read back in SQL text.
        .replaceAll(/(?<=')[\da-f]{32}(?=')/gu, (token) =>
          renumber("marker", token),
        )
    );
  };
}

function renderParams(params: readonly unknown[]): string {
  return JSON.stringify(params, (_key, value: unknown) => {
    if (typeof value === "bigint") return `${value}n`;
    if (value === undefined) return "<undefined>";
    if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
    if (value instanceof Date) return "<timestamp>";
    return value;
  });
}

function renderTrace(
  statements: readonly TracedStatement[],
  canonicalize: (text: string) => string,
): readonly string[] {
  return statements.flatMap((statement) => {
    const line = `  sql ${canonicalize(statement.text)}`;
    return statement.params.length === 0 ?
        [line]
      : [line, `    ${canonicalize(renderParams(statement.params))}`];
  });
}

function goldenPath(driver: IntegrationLaneDriver, pair: string): string {
  return fileURLToPath(
    new URL(
      `__snapshots__/shared-native-transaction/${driver}/${pair}.txt`,
      import.meta.url,
    ),
  );
}

type PairObservation = Readonly<{
  text: string;
  /** Per run, the writes each Store completed and the writes it must. */
  runs: readonly Readonly<{
    run: string;
    writes: WriteCounts;
    expected: WriteCounts;
  }>[];
}>;

async function observePair(
  context: IntegrationTestContext,
  pair: StorePair,
): Promise<PairObservation> {
  const connection = await context.openTracedConnection(TABLE_SETS);
  try {
    return await observePairOn(context.driver, connection, pair);
  } finally {
    await connection.close();
  }
}

async function observePairOn(
  driver: IntegrationLaneDriver,
  connection: TracedConnection,
  pair: StorePair,
): Promise<PairObservation> {
  const graphIds = ["tss_pair_graph_0", "tss_pair_graph_1"] as const;
  const backendOf = (config: StoreConfig) =>
    requireDefined(connection.backends[config.tables]);
  const lines: string[] = [
    `pair ${pair.name}`,
    `A ${JSON.stringify(pair.a)}`,
    `B ${JSON.stringify(pair.b)}`,
  ];
  const canonicalize = createTraceCanonicalizer(new Map());
  async function storeFor(config: StoreConfig): Promise<PairStore> {
    const [store] = await createAdapterStoreWithSchema(
      scopeGraph({
        id: graphIds[config.graph],
        constraints: config.constraints,
      }),
      backendOf(config),
      {
        ...(config.history ? { history: true } : {}),
        ...(config.revisionTracking ? { revisionTracking: true } : {}),
      },
    );
    return store as unknown as PairStore;
  }
  let sides: Readonly<{ a: PairSide; b: PairSide }>;
  try {
    sides = {
      a: { label: "A", config: pair.a, store: await storeFor(pair.a) },
      b: { label: "B", config: pair.b, store: await storeFor(pair.b) },
    };
  } catch (error) {
    lines.push(`setup: ${describeFailure(error)}`);
    return { text: `${lines.join("\n")}\n`, runs: [] };
  }
  const runs: PairObservation["runs"][number][] = [];
  const root = backendOf(pair.a);
  let runIndex = 0;
  for (const entry of ENTRY_KINDS) {
    for (const savepoint of [false, true]) {
      runIndex += 1;
      const prefix = `r${runIndex}`;
      const revisionsBefore = await Promise.all([
        sides.a.store.revisionNow(),
        sides.b.store.revisionNow(),
      ]);
      connection.reset();
      const observed = await runPairTransaction(driver, root, sides, {
        entry,
        savepoint,
        prefix,
      });
      const expected = expectedWrites(pair, entry);
      const runName = `${entry}${savepoint ? " with a caller savepoint rolled back" : ""}`;
      runs.push({
        run: runName,
        writes: observed.writes,
        expected: expected.counts,
      });
      const statements = connection.statements();
      const revisionsAfter = await Promise.all([
        sides.a.store.revisionNow(),
        sides.b.store.revisionNow(),
      ]);
      lines.push(
        "",
        `## ${runName}${expected.refusal === undefined ? "" : ` (refusal: ${expected.refusal})`}`,
        ...observed.lines,
        `revision A: ${revisionSequence(revisionsBefore[0])} -> ${revisionSequence(revisionsAfter[0])}`,
        `revision B: ${revisionSequence(revisionsBefore[1])} -> ${revisionSequence(revisionsAfter[1])}`,
      );
      for (const tables of [0, 1] as const) {
        for (const graph of [0, 1] as const) {
          const backend = requireDefined(connection.backends[tables]);
          const live = await liveNodeIds(
            backend,
            requireDefined(TABLE_SETS[tables]),
            graphIds[graph],
          );
          const recorded = await recordedNodeCount(
            backend,
            requireDefined(TABLE_SETS[tables]),
            graphIds[graph],
          );
          if (live.length === 0 && recorded === 0) continue;
          lines.push(
            `rows tables-${tables} graph-${graph}: live [${live.join(", ")}] recorded ${recorded}`,
          );
        }
      }
      lines.push("trace:", ...renderTrace(statements, canonicalize));
    }
  }
  return { text: `${lines.join("\n")}\n`, runs };
}

export function registerSharedNativeTransactionTests(
  context: IntegrationTestContext,
): void {
  describe("two Stores on one native transaction", () => {
    describe("scope: a plain binding inside another Store's recorded transaction", () => {
      it("fences every write of the plain binding, across a caller savepoint rolled back before its first write", async () => {
        const connection = await context.openTracedConnection([TABLE_SETS[0]]);
        try {
          const root = requireDefined(connection.backends[0]);
          const graphA = scopeGraph({ id: "tss_fence_a", constraints: false });
          const graphB = scopeGraph({ id: "tss_fence_b", constraints: false });
          const [history] = await createAdapterStoreWithSchema(graphA, root, {
            history: true,
          });
          const [plain] = await createAdapterStoreWithSchema(graphB, root);
          connection.reset();
          await root.transactionWithNative((_target, native) =>
            history.withRecordedTransaction(native, async (tx) => {
              await tx.nodes.ScopeItem.create({ label: "a1" }, { id: "a1" });
              const plainTx = plain.withTransaction(native);
              await callerStatement(context.driver, native, "SAVEPOINT tss");
              await plainTx.nodes.ScopeItem.create(
                { label: "b1" },
                { id: "b1" },
              );
              await callerStatement(
                context.driver,
                native,
                "ROLLBACK TO SAVEPOINT tss",
              );
              await plainTx.nodes.ScopeItem.create(
                { label: "b2" },
                { id: "b2" },
              );
              await plainTx.nodes.ScopeItem.create(
                { label: "b3" },
                { id: "b3" },
              );
            }),
          );
          const statements = connection.statements();
          expect({
            fencesA: schemaFenceCount(statements, TABLE_SETS[0], graphA.id),
            fencesB: schemaFenceCount(statements, TABLE_SETS[0], graphB.id),
            liveB: await liveNodeIds(root, TABLE_SETS[0], graphB.id),
          }).toEqual({ fencesA: 1, fencesB: 3, liveB: ["b2", "b3"] });
        } finally {
          await connection.close();
        }
      });

      it("fences the plain binding over other physical tables with the same graph id and version", async () => {
        const connection = await context.openTracedConnection(TABLE_SETS);
        try {
          const [rootOne, rootTwo] = [
            requireDefined(connection.backends[0]),
            requireDefined(connection.backends[1]),
          ];
          const graph = scopeGraph({
            id: "tss_fence_same",
            constraints: false,
          });
          const [history] = await createAdapterStoreWithSchema(graph, rootOne, {
            history: true,
          });
          const [plain] = await createAdapterStoreWithSchema(graph, rootTwo);
          connection.reset();
          await rootOne.transactionWithNative((_target, native) =>
            history.withRecordedTransaction(native, async (tx) => {
              await tx.nodes.ScopeItem.create({ label: "a1" }, { id: "a1" });
              const plainTx = plain.withTransaction(native);
              await plainTx.nodes.ScopeItem.create(
                { label: "b1" },
                { id: "b1" },
              );
              await plainTx.nodes.ScopeItem.create(
                { label: "b2" },
                { id: "b2" },
              );
            }),
          );
          const statements = connection.statements();
          expect({
            fencesOne: schemaFenceCount(statements, TABLE_SETS[0], graph.id),
            fencesTwo: schemaFenceCount(statements, TABLE_SETS[1], graph.id),
          }).toEqual({ fencesOne: 1, fencesTwo: 2 });
        } finally {
          await connection.close();
        }
      });
    });

    describe("scope: a revision-tracked Store adopting another Store's transaction", () => {
      it("advances the adopting Store's revision for its write", async () => {
        const graphA = scopeGraph({ id: "tss_revision_a", constraints: false });
        const graphB = scopeGraph({ id: "tss_revision_b", constraints: false });
        const backend = context.getBackend();
        const [plain] = await createAdapterStoreWithSchema(graphA, backend);
        const [tracked] = await createAdapterStoreWithSchema(graphB, backend, {
          revisionTracking: true,
        });
        const before = await tracked.revisionNow();
        await plain.transaction(async (tx) => {
          await tx.nodes.ScopeItem.create({ label: "a1" }, { id: "a1" });
          const trackedTx = tracked.withTransaction(
            requireDefined((tx as Readonly<{ sql?: unknown }>).sql),
          );
          await trackedTx.nodes.ScopeItem.create({ label: "b1" }, { id: "b1" });
        });
        const written = await tracked.nodes.ScopeItem.find();
        expect({
          before: revisionSequence(before),
          after: revisionSequence(await tracked.revisionNow()),
          written: written.map((item) => item.id),
        }).toEqual({ before: "none", after: "1", written: ["b1"] });
      });
    });

    describe("scope: two adoptions of one handle writing one graph", () => {
      it("runs a durable-match edge create on one adoption while the other's revision-tracked frame holds the graph lock", async () => {
        const graph = scopeGraph({ id: "tss_lock", constraints: false });
        const backend = context.getBackend();
        const [store] = await createAdapterStoreWithSchema(graph, backend, {
          revisionTracking: true,
        });
        await store.nodes.ScopeItem.create({ label: "from" }, { id: "from" });
        await store.nodes.ScopeItem.create({ label: "to" }, { id: "to" });
        // Both frames start in one turn, so the edge frame reaches its lock
        // while the node frame's acquisition is registered and unsettled.
        const outcome = await backend.transactionWithNative(
          async (_target, native) => {
            const first = store.withTransaction(native);
            const second = store.withTransaction(native);
            const [node, edge] = await Promise.all([
              outcomeOf(
                first.nodes.ScopeItem.create({ label: "n1" }, { id: "n1" }),
              ),
              outcomeOf(
                second.edges.scopeLink.create(
                  { kind: "ScopeItem", id: "from" },
                  { kind: "ScopeItem", id: "to" },
                  { label: "l1" },
                  { id: "e1" },
                ),
              ),
            ]);
            return { node, edge };
          },
        );
        const edges = await store.edges.scopeLink.find();
        expect({
          perBeginNative: PER_BEGIN_NATIVE_DRIVERS.has(context.driver),
          ...outcome,
          edges: edges.map((edge) => edge.id),
        }).toEqual({
          perBeginNative: PER_BEGIN_NATIVE_DRIVERS.has(context.driver),
          node: "ok",
          edge: "ok",
          edges: ["e1"],
        });
      });
    });

    describe("generated Store pairs", () => {
      for (const pair of STORE_PAIRS) {
        it(`${pair.name}: rows, revisions, receipts, statements and errors match the golden`, async () => {
          const observed = await observePair(context, pair);
          // Checked before the golden: a snapshot of refusals would match a
          // golden recorded from refusals, and certify nothing.
          expect(
            observed.runs.map((run) => ({ run: run.run, writes: run.writes })),
          ).toEqual(
            observed.runs.map((run) => ({
              run: run.run,
              writes: run.expected,
            })),
          );
          expect(observed.runs).toHaveLength(4);
          expect(
            observed.runs.some(
              (run) => run.expected.a > 0 && run.expected.b > 0,
            ),
          ).toBe(true);
          await expect(observed.text).toMatchFileSnapshot(
            goldenPath(context.driver, pair.name),
          );
        });
      }
    });
  });
}
