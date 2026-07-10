/**
 * Compile + repeated-execute micro-benchmark for the compiled-SQL template
 * cache (the #246 follow-up).
 *
 * It isolates two costs the end-to-end read suite blends together:
 *
 *   1. compile-only — the JS cost of turning a query AST into SQL text + params
 *      (`toSQL()`, no database round trip), for a point lookup and a 3-hop
 *      traversal. This is the work a reused/prepared query must NOT repeat.
 *   2. repeated point-query execution — the same point query executed many
 *      times three ways: recompile-per-call (a fresh builder each iteration),
 *      a reused instance, and a prepared query. Plus an `executeRaw` floor
 *      (pre-compiled SQL handed straight to the driver).
 *
 * The queries run against an empty store on purpose: a point lookup's compile
 * and per-call execution cost — the thing under test — does not depend on
 * whether the row exists, so there is nothing to seed.
 *
 * Guardrail: reusing or preparing a point query must save roughly the per-call
 * compile cost versus recompiling every call. The check is on the ABSOLUTE
 * per-call saving (≈ the measured compile cost), not a latency threshold or a
 * ratio, so it holds on the fast in-memory lane and the slower file/Postgres
 * lanes alike — where a real round trip dwarfs the compile cost, the saving is
 * still there, just a smaller fraction of the whole.
 *
 * Run:
 *   pnpm --filter @nicia-ai/typegraph-benchmarks bench:compile
 *   POSTGRES_URL=... pnpm --filter @nicia-ai/typegraph-benchmarks bench:compile --backend=postgres
 */
import { param } from "@nicia-ai/typegraph";

import { createBackendResources } from "./backend";
import { parseCliOptions } from "./cli";
import { type PerfStore } from "./graph";
import { median, nowMs } from "./utils";

const COMPILE_OPS_PER_SAMPLE = 1000;
const COMPILE_SAMPLES = 25;
const EXECUTE_OPS_PER_SAMPLE = 100;
const EXECUTE_SAMPLES = 15;

/**
 * At least this fraction of the measured per-call compile cost must be saved
 * by reusing/preparing a point query instead of recompiling every call. A
 * regressed cache (recompile-per-call) saves ~0 and trips this.
 */
const MIN_SAVED_COMPILE_FRACTION = 0.5;

function microseconds(ms: number): string {
  return `${(ms * 1000).toFixed(1)}µs`;
}

/** Median per-operation latency (ms) of a synchronous op, timed in batches. */
function measureSync(label: string, op: () => void): number {
  for (let index = 0; index < COMPILE_OPS_PER_SAMPLE; index += 1) op();

  const perOp: number[] = [];
  for (let sample = 0; sample < COMPILE_SAMPLES; sample += 1) {
    const startedAt = nowMs();
    for (let index = 0; index < COMPILE_OPS_PER_SAMPLE; index += 1) op();
    perOp.push((nowMs() - startedAt) / COMPILE_OPS_PER_SAMPLE);
  }

  const result = median(perOp);
  console.log(`${label}: ${microseconds(result)}/op`);
  return result;
}

/** Median per-operation latency (ms) of an async op, timed in batches. */
async function measureAsync(
  label: string,
  op: () => Promise<void>,
): Promise<number> {
  for (let index = 0; index < EXECUTE_OPS_PER_SAMPLE; index += 1) await op();

  const perOp: number[] = [];
  for (let sample = 0; sample < EXECUTE_SAMPLES; sample += 1) {
    const startedAt = nowMs();
    for (let index = 0; index < EXECUTE_OPS_PER_SAMPLE; index += 1) await op();
    perOp.push((nowMs() - startedAt) / EXECUTE_OPS_PER_SAMPLE);
  }

  const result = median(perOp);
  console.log(`${label}: ${microseconds(result)}/op`);
  return result;
}

function pointQuery(store: PerfStore) {
  return store
    .query()
    .from("User", "u")
    .whereNode("u", (user) => user.id.eq("user_0"))
    .select((ctx) => ({ name: ctx.u.name }));
}

function preparedPointQuery(store: PerfStore) {
  return store
    .query()
    .from("User", "u")
    .whereNode("u", (user) => user.id.eq(param("userId")))
    .select((ctx) => ({ name: ctx.u.name }))
    .prepare();
}

function threeHopQuery(store: PerfStore) {
  return store
    .query()
    .from("User", "u")
    .whereNode("u", (user) => user.id.eq("user_0"))
    .traverse("follows", "e1", { expand: "none" })
    .to("User", "f1")
    .traverse("follows", "e2", { expand: "none" })
    .to("User", "f2")
    .traverse("authored", "e3", { expand: "none" })
    .to("Post", "post")
    .select((ctx) => ({
      f1Name: ctx.f1.name,
      f2Name: ctx.f2.name,
      title: ctx.post.title,
    }));
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const resources = await createBackendResources(
    options.backend,
    options.postgresDriver,
    options.sqliteStorage,
  );
  const { store, backend } = resources;

  try {
    console.log(`\ncompile-only (${options.backend}):`);
    const reusedPoint = pointQuery(store);
    const reusedThreeHop = threeHopQuery(store);
    const pointCompileMs = measureSync("  point compile", () => {
      reusedPoint.toSQL();
    });
    measureSync("  3-hop compile", () => {
      reusedThreeHop.toSQL();
    });

    console.log(`\nrepeated point-query execution (${options.backend}):`);
    // A pre-compiled statement handed straight to the driver — the floor a
    // perfectly-cached path approaches (no compile, no builder allocation).
    const compiledPoint = reusedPoint.toSQL();
    const rawFloorMs = await measureAsync("  executeRaw floor", async () => {
      await backend.executeRaw!(compiledPoint.sql, compiledPoint.params);
    });

    const coldMs = await measureAsync(
      "  recompile-per-call (fresh builder)",
      async () => {
        await pointQuery(store).execute();
      },
    );

    const cachedInstance = pointQuery(store);
    const cachedMs = await measureAsync(
      "  reused instance (cached template)",
      async () => {
        await cachedInstance.execute();
      },
    );

    const prepared = preparedPointQuery(store);
    const preparedMs = await measureAsync(
      "  prepared (cached template)",
      async () => {
        await prepared.execute({ userId: "user_0" });
      },
    );

    const cachedSaved = coldMs - cachedMs;
    const preparedSaved = coldMs - preparedMs;
    const required = pointCompileMs * MIN_SAVED_COMPILE_FRACTION;

    console.log("\nsummary:");
    console.log(`  compile cost/call:   ${microseconds(pointCompileMs)}`);
    console.log(`  executeRaw floor:    ${microseconds(rawFloorMs)}`);
    console.log(`  reused saves/call:   ${microseconds(cachedSaved)}`);
    console.log(`  prepared saves/call: ${microseconds(preparedSaved)}`);
    console.log(`  required saving:     ${microseconds(required)}`);

    if (cachedSaved < required || preparedSaved < required) {
      console.error(
        `\nGuardrail FAILED: reusing/preparing a point query must save at least ` +
          `${microseconds(required)}/call (≈ the compile cost). ` +
          `reused saved ${microseconds(cachedSaved)}, prepared saved ${microseconds(preparedSaved)}. ` +
          `The compiled-SQL template cache looks inactive (recompiling per call?).`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nGuardrail OK: reused saves ${microseconds(cachedSaved)}/call, ` +
        `prepared saves ${microseconds(preparedSaved)}/call ` +
        `(≥ ${microseconds(required)} required).`,
    );
  } finally {
    await resources.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
