/**
 * Date-read benchmark: what decoding date properties costs a whole-row read.
 *
 * A read decodes every position whose schema output is a `Date` from its
 * stored ISO text (`src/store/stored-date-revival.ts`). This measures a
 * 10,000-row `find()` and `query().select()` on in-memory SQLite for three
 * cases with the same stored bytes:
 *
 * - `undated`: a kind with five string properties, in a graph with no date
 *   position anywhere (the reader is the identity).
 * - `undated-in-dated-graph`: the same kind in a graph that also holds a dated
 *   kind (the reader looks the row's kind up and finds no plan).
 * - `dated`: a kind whose five properties are `z.date()` (every row decodes
 *   five dates).
 *
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:date-reads
 *
 * Flags:
 *
 * - `--rows=10000` — rows per kind
 * - `--rounds=15` — measured rounds per case (medians are reported)
 * - `--warmup=3` — unmeasured rounds per case
 * - `--check` — exit non-zero when `undated-in-dated-graph` is more than
 *   `--max-undated-ratio` (default 1.15) times `undated`: a kind with no date
 *   position must pay nothing measurable for another kind's dates
 */
import { performance } from "node:perf_hooks";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import { z } from "zod";

import { median } from "./utils";

const STAMP = "2024-01-02T03:04:05.678Z";

const UndatedRow = defineNode("UndatedRow", {
  schema: z.object({
    title: z.string(),
    first: z.string(),
    second: z.string(),
    third: z.string(),
    fourth: z.string(),
    fifth: z.string(),
  }),
});

const DatedRow = defineNode("DatedRow", {
  schema: z.object({
    title: z.string(),
    first: z.date(),
    second: z.date(),
    third: z.date(),
    fourth: z.date(),
    fifth: z.date(),
  }),
});

const undatedGraph = defineGraph({
  id: "date_read_bench_undated",
  nodes: { UndatedRow: { type: UndatedRow } },
  edges: {},
});

const mixedGraph = defineGraph({
  id: "date_read_bench_mixed",
  nodes: { UndatedRow: { type: UndatedRow }, DatedRow: { type: DatedRow } },
  edges: {},
});

type Options = Readonly<{
  rows: number;
  rounds: number;
  warmup: number;
  check: boolean;
  maxUndatedRatio: number;
}>;

function parsePositiveNumber(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`--${name} must be a positive number, got "${raw}"`);
  return value;
}

function parseOptions(argv: readonly string[]): Options {
  let rows = 10_000;
  let rounds = 15;
  let warmup = 3;
  let check = false;
  let maxUndatedRatio = 1.15;
  for (const argument of argv) {
    if (argument === "--check") {
      check = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.+)$/u.exec(argument);
    if (match === null) throw new Error(`Unknown argument "${argument}"`);
    const [, name = "", raw = ""] = match;
    switch (name) {
      case "rows": {
        rows = Math.round(parsePositiveNumber(name, raw));
        break;
      }
      case "rounds": {
        rounds = Math.round(parsePositiveNumber(name, raw));
        break;
      }
      case "warmup": {
        warmup = Math.round(parsePositiveNumber(name, raw));
        break;
      }
      case "max-undated-ratio": {
        maxUndatedRatio = parsePositiveNumber(name, raw);
        break;
      }
      default: {
        throw new Error(`Unknown flag "--${name}"`);
      }
    }
  }
  return { rows, rounds, warmup, check, maxUndatedRatio };
}

type Measured = Readonly<{ findMs: number; selectMs: number }>;

async function measure(
  read: () => Promise<readonly unknown[]>,
  expectedRows: number,
  options: Options,
): Promise<number> {
  const samples: number[] = [];
  for (let round = 0; round < options.warmup + options.rounds; round += 1) {
    const started = performance.now();
    const rows = await read();
    const elapsed = performance.now() - started;
    if (rows.length !== expectedRows)
      throw new Error(`Expected ${expectedRows} rows, read ${rows.length}`);
    if (round >= options.warmup) samples.push(elapsed);
  }
  return median(samples);
}

async function seedUndated(
  store: Awaited<
    ReturnType<typeof createStoreWithSchema<typeof undatedGraph>>
  >[0],
  rows: number,
): Promise<void> {
  const props = {
    first: STAMP,
    second: STAMP,
    third: STAMP,
    fourth: STAMP,
    fifth: STAMP,
  };
  const batch = Array.from({ length: rows }, (_, index) => ({
    props: { title: `row-${index}`, ...props },
  }));
  await store.nodes.UndatedRow.bulkInsert(batch);
}

async function runUndated(options: Options): Promise<Measured> {
  const { backend } = createLocalSqliteBackend();
  const [store] = await createStoreWithSchema(undatedGraph, backend);
  await seedUndated(store, options.rows);
  const findMs = await measure(
    () => store.nodes.UndatedRow.find(),
    options.rows,
    options,
  );
  const selectMs = await measure(
    () =>
      store
        .query()
        .from("UndatedRow", "row")
        .select((ctx) => ctx.row)
        .execute(),
    options.rows,
    options,
  );
  await store.close();
  return { findMs, selectMs };
}

async function runMixed(
  options: Options,
): Promise<Readonly<{ undated: Measured; dated: Measured }>> {
  const { backend } = createLocalSqliteBackend();
  const [store] = await createStoreWithSchema(mixedGraph, backend);
  const stamp = new Date(STAMP);
  await store.nodes.UndatedRow.bulkInsert(
    Array.from({ length: options.rows }, (_, index) => ({
      props: {
        title: `row-${index}`,
        first: STAMP,
        second: STAMP,
        third: STAMP,
        fourth: STAMP,
        fifth: STAMP,
      },
    })),
  );
  await store.nodes.DatedRow.bulkInsert(
    Array.from({ length: options.rows }, (_, index) => ({
      props: {
        title: `row-${index}`,
        first: stamp,
        second: stamp,
        third: stamp,
        fourth: stamp,
        fifth: stamp,
      },
    })),
  );
  const undated: Measured = {
    findMs: await measure(
      () => store.nodes.UndatedRow.find(),
      options.rows,
      options,
    ),
    selectMs: await measure(
      () =>
        store
          .query()
          .from("UndatedRow", "row")
          .select((ctx) => ctx.row)
          .execute(),
      options.rows,
      options,
    ),
  };
  const dated: Measured = {
    findMs: await measure(
      () => store.nodes.DatedRow.find(),
      options.rows,
      options,
    ),
    selectMs: await measure(
      () =>
        store
          .query()
          .from("DatedRow", "row")
          .select((ctx) => ctx.row)
          .execute(),
      options.rows,
      options,
    ),
  };
  await store.close();
  return { undated, dated };
}

function perRowMicroseconds(milliseconds: number, rows: number): string {
  return `${((milliseconds * 1000) / rows).toFixed(2)} µs/row`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const undated = await runUndated(options);
  const mixed = await runMixed(options);
  const cases = [
    ["undated", undated],
    ["undated-in-dated-graph", mixed.undated],
    ["dated (5 date positions)", mixed.dated],
  ] as const;
  console.log(
    `date-read benchmark: ${options.rows} rows, median of ${options.rounds} rounds (SQLite in memory)`,
  );
  for (const [label, measured] of cases) {
    console.log(
      `  ${label.padEnd(26)} find ${measured.findMs.toFixed(1)} ms (${perRowMicroseconds(measured.findMs, options.rows)})` +
        `  select ${measured.selectMs.toFixed(1)} ms (${perRowMicroseconds(measured.selectMs, options.rows)})`,
    );
  }
  const findRatio = mixed.undated.findMs / undated.findMs;
  const selectRatio = mixed.undated.selectMs / undated.selectMs;
  console.log(
    `  undated-in-dated-graph / undated: find ${findRatio.toFixed(3)}, select ${selectRatio.toFixed(3)}`,
  );
  console.log(
    `  dated / undated: find ${(mixed.dated.findMs / undated.findMs).toFixed(3)}, select ${(mixed.dated.selectMs / undated.selectMs).toFixed(3)}`,
  );
  if (
    options.check &&
    (findRatio > options.maxUndatedRatio ||
      selectRatio > options.maxUndatedRatio)
  ) {
    console.error(
      `A kind with no date position slowed down in a graph with a dated kind: ratio above ${options.maxUndatedRatio}.`,
    );
    process.exitCode = 1;
  }
}

await main();
