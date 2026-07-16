/**
 * LDBC SNB Interactive short-read benchmark (IS1-IS7) — Lane 1 of the
 * real-workload benchmark program (docs/design/benchmark-program-plan.md).
 *
 * Usage:
 *   tsx src/real/snb-short-reads.ts [--profile=smoke|sf1|sf10] [--engines=a,b,c]
 *     [--data-dir=<extracted-datagen-dir>] [--requests-per-query=N]
 *     [--warmup-requests=N] [--seed=N] [--output=<dir>]
 */
import path from "node:path";

import { parseSnbCliOptions } from "./cli";
import { type SnbIdPools } from "./dataset/ldbc-csv";
import { resolveDatasetRoot } from "./dataset/resolve";
import { createLadybugEngine } from "./engines/ladybug";
import { createNeo4jEngine } from "./engines/neo4j";
import { createPgGraphEngine } from "./engines/pggraph";
import { createTypegraphPostgresEngine } from "./engines/typegraph-postgres";
import { createTypegraphSqliteEngine } from "./engines/typegraph-sqlite";
import {
  type MessageRef,
  type PersonPair,
  type SnbEngineFactory,
  type SnbQueryId,
  type SnbQueryResult,
} from "./engines/types";
import {
  NEO4J_IMAGE,
  packageVersion,
  PGGRAPH_IMAGE,
  runDoctor,
  writeDoctorResult,
  type SnbEngineName,
} from "./harness/doctor";
import { writeLaneHistoryEntry } from "./harness/history";
import { evaluateParity, type EngineQueryOutcomes } from "./harness/parity";
import { writeJsonFile } from "./harness/process";
import { computeLatencyStats, type LatencyStats } from "./harness/stats";
import { writeSummary, type EngineVersion } from "./harness/summary";
import { buildRequestPlan, type SnbRequestPlan } from "./request-plan";
import { resolveGitRefName, resolveGitSha } from "../git";
import { formatMs, nowMs } from "../utils";

const LANE = "snb";

const ENGINE_FACTORIES: Readonly<Record<SnbEngineName, SnbEngineFactory>> = {
  "typegraph-sqlite": createTypegraphSqliteEngine,
  "typegraph-postgres": createTypegraphPostgresEngine,
  neo4j: createNeo4jEngine,
  ladybugdb: createLadybugEngine,
  pggraph: createPgGraphEngine,
};

type EngineQueryMeasurement = Readonly<{
  samplesMs: readonly number[];
  rowCounts: readonly number[];
  digests: readonly string[];
}>;

type EngineRun = Readonly<{
  name: SnbEngineName;
  fairness: string;
  loadMs: number;
  /** Only the queries this engine actually ran (unsupported ones are absent). */
  queries: Partial<Record<SnbQueryId, EngineQueryMeasurement>>;
  /** Declared capability gaps: queryId -> reason, never measured. */
  unsupported: Partial<Record<SnbQueryId, string>>;
}>;

async function measureQuery<Request>(
  requests: readonly Request[],
  warmupRequests: number,
  totalRequests: number,
  run: (request: Request) => Promise<SnbQueryResult>,
): Promise<EngineQueryMeasurement> {
  for (let index = 0; index < warmupRequests; index += 1) {
    await run(requests[index]!);
  }

  const samplesMs: number[] = [];
  const rowCounts: number[] = [];
  const digests: string[] = [];
  for (let index = warmupRequests; index < totalRequests; index += 1) {
    const started = nowMs();
    const result = await run(requests[index]!);
    samplesMs.push(nowMs() - started);
    rowCounts.push(result.rowCount);
    digests.push(result.digest);
  }
  return { samplesMs, rowCounts, digests };
}

async function collectEngineVersions(
  engines: readonly SnbEngineName[],
): Promise<readonly EngineVersion[]> {
  const versions: EngineVersion[] = [];
  if (
    engines.includes("typegraph-sqlite") ||
    engines.includes("typegraph-postgres")
  ) {
    versions.push({
      engine: "@nicia-ai/typegraph",
      version: (await packageVersion("@nicia-ai/typegraph")) ?? "unknown",
    });
  }
  if (engines.includes("typegraph-sqlite")) {
    versions.push({
      engine: "better-sqlite3",
      version: (await packageVersion("better-sqlite3")) ?? "unknown",
    });
  }
  if (engines.includes("typegraph-postgres")) {
    versions.push({
      engine: "pg",
      version: (await packageVersion("pg")) ?? "unknown",
    });
  }
  if (engines.includes("neo4j")) {
    versions.push({
      engine: "neo4j",
      version: NEO4J_IMAGE,
      detail: `neo4j-driver ${(await packageVersion("neo4j-driver")) ?? "unknown"}`,
    });
  }
  if (engines.includes("ladybugdb")) {
    versions.push({
      engine: "@ladybugdb/core",
      version: (await packageVersion("@ladybugdb/core")) ?? "unknown",
    });
  }
  if (engines.includes("pggraph")) {
    versions.push({
      engine: "pggraph",
      version: PGGRAPH_IMAGE,
      detail: `pg ${(await packageVersion("pg")) ?? "unknown"}`,
    });
  }
  return versions;
}

type RunEngineOptions = Readonly<{
  datasetRoot: string;
  options: ReturnType<typeof parseSnbCliOptions>;
  requestCount: number;
  getOrBuildRequestPlan: (pools: SnbIdPools) => SnbRequestPlan;
}>;

/** Loads and measures one engine end to end; always closes its handle. */
async function runEngine(
  engineName: SnbEngineName,
  {
    datasetRoot,
    options,
    requestCount,
    getOrBuildRequestPlan,
  }: RunEngineOptions,
): Promise<EngineRun> {
  const factory = ENGINE_FACTORIES[engineName];
  const handle = await factory({
    datasetRoot,
    log: (message) => console.log(`[${engineName}] ${message}`),
  });

  try {
    const loadStarted = nowMs();
    const pools = await handle.load();
    const loadMs = nowMs() - loadStarted;
    console.log(
      `${engineName} loaded in ${formatMs(loadMs)} ` +
        `(${pools.counts.persons} persons, ${pools.counts.posts} posts, ${pools.counts.comments} comments)`,
    );

    const requestPlan = getOrBuildRequestPlan(pools);

    type QueryPlan = Readonly<{
      requests: readonly unknown[];
      run: (request: unknown) => Promise<SnbQueryResult>;
    }>;
    // One dispatch entry per query: its seeded request sequence plus a
    // type-erased runner. Each cast is sound — `requestPlan[id]` is built with
    // exactly this query's input type (see request-plan.ts) — and looping over
    // this map (instead of a hand-written measureQuery call per query) is what
    // lets the capability gate below skip an engine's unsupported queries
    // uniformly, no matter how many queries the lane grows to.
    const q = handle.queries;
    const queryPlans: Record<SnbQueryId, QueryPlan> = {
      IS1: { requests: requestPlan.IS1, run: (r) => q.IS1(r as string) },
      IS2: { requests: requestPlan.IS2, run: (r) => q.IS2(r as string) },
      IS3: { requests: requestPlan.IS3, run: (r) => q.IS3(r as string) },
      IS4: { requests: requestPlan.IS4, run: (r) => q.IS4(r as MessageRef) },
      IS5: { requests: requestPlan.IS5, run: (r) => q.IS5(r as MessageRef) },
      IS6: { requests: requestPlan.IS6, run: (r) => q.IS6(r as MessageRef) },
      IS7: { requests: requestPlan.IS7, run: (r) => q.IS7(r as MessageRef) },
      IC13: { requests: requestPlan.IC13, run: (r) => q.IC13(r as PersonPair) },
      BFS3: { requests: requestPlan.BFS3, run: (r) => q.BFS3(r as string) },
      IC2: { requests: requestPlan.IC2, run: (r) => q.IC2(r as string) },
      IC8: { requests: requestPlan.IC8, run: (r) => q.IC8(r as string) },
      IC9: { requests: requestPlan.IC9, run: (r) => q.IC9(r as string) },
      GA_DEGREE: {
        requests: requestPlan.GA_DEGREE,
        run: (r) => q.GA_DEGREE(r as string),
      },
      GA_WCC: {
        requests: requestPlan.GA_WCC,
        run: (r) => q.GA_WCC(r as string),
      },
      GA_BFS: {
        requests: requestPlan.GA_BFS,
        run: (r) => q.GA_BFS(r as string),
      },
      GA_SSSP: {
        requests: requestPlan.GA_SSSP,
        run: (r) => q.GA_SSSP(r as string),
      },
    };

    const queries: Partial<Record<SnbQueryId, EngineQueryMeasurement>> = {};
    const unsupported: Partial<Record<SnbQueryId, string>> = {};
    for (const queryId of options.queries) {
      const reason = handle.unsupported?.[queryId];
      if (reason !== undefined) {
        unsupported[queryId] = reason;
        console.log(`  ${queryId}: unsupported (${reason})`);
        continue;
      }
      const plan = queryPlans[queryId];
      const measurement = await measureQuery(
        plan.requests,
        options.warmupRequests,
        requestCount,
        plan.run,
      );
      queries[queryId] = measurement;
      const stats = computeLatencyStats(measurement.samplesMs);
      console.log(
        `  ${queryId}: p50=${formatMs(stats.medianMs)} p95=${formatMs(stats.p95Ms)} ` +
          `p99=${formatMs(stats.p99Ms)}${stats.noisy ? " (NOISY, CV>25%)" : ""}`,
      );
    }

    return {
      name: engineName,
      fairness: handle.fairness,
      loadMs,
      queries,
      unsupported,
    };
  } finally {
    await handle.close();
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseSnbCliOptions(argv);
  const datasetRoot = await resolveDatasetRoot(
    options.profile,
    options.dataDir,
  );
  console.log(
    `LDBC SNB short reads (profile=${options.profile}, dataset=${datasetRoot})`,
  );

  const doctorResult = await runDoctor({ engines: options.engines });
  await writeDoctorResult(
    path.join(options.outputDir, "competitor-doctor.json"),
    doctorResult,
  );
  console.log(`Competitor doctor: ${doctorResult.status}`);
  for (const check of doctorResult.checks) {
    if (check.status !== "ok") {
      console.log(
        `  [${check.status}] ${check.category}/${check.name}: ${check.detail}`,
      );
    }
  }

  const engineNames = options.engines.filter(
    (name) => doctorResult.runnable[name],
  );
  if (engineNames.length === 0) {
    console.log(
      "No requested engines are runnable on this machine (see competitor-doctor.json). " +
        "Nothing to run — this is expected in CI without Docker/optional packages.",
    );
    return;
  }
  const skipped = options.engines.filter(
    (name) => !doctorResult.runnable[name],
  );
  if (skipped.length > 0) {
    console.log(`Skipping unavailable engines: ${skipped.join(", ")}`);
  }

  const requestCount = options.warmupRequests + options.requestsPerQuery;
  let requestPlan: SnbRequestPlan | undefined;
  const runs: EngineRun[] = [];
  // A doctor-runnable engine can still fail mid-run (resource exhaustion, a
  // transient container issue — this is exactly how a Postgres container's
  // undersized storage was discovered). One engine's crash must not lose
  // every other engine's already-collected results or kill the whole
  // process — recorded here as an explicit failed row, never a silent loss.
  const failures: { engine: SnbEngineName; error: string }[] = [];

  for (const engineName of engineNames) {
    console.log(`\n=== ${engineName} ===`);
    try {
      const run = await runEngine(engineName, {
        datasetRoot,
        options,
        requestCount,
        getOrBuildRequestPlan: (pools) => {
          requestPlan ??= buildRequestPlan({
            pools,
            requestCount,
            seed: options.seed,
          });
          return requestPlan;
        },
      });
      runs.push(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  [FAILED] ${engineName}: ${message}`);
      failures.push({ engine: engineName, error: message });
    }
  }

  type QuerySummary = Readonly<{
    engine: SnbEngineName;
    stats: LatencyStats;
    comparable: boolean;
    parityReason?: string;
  }>;
  const resultsByQuery = Object.fromEntries(
    options.queries.map((queryId) => [queryId, [] as QuerySummary[]]),
  ) as Record<SnbQueryId, QuerySummary[]>;
  // One history line per engine covering all queries — built up across the
  // query loop below, written once per engine afterward.
  const historyQueriesByEngine = new Map<
    SnbEngineName,
    Map<SnbQueryId, Readonly<{ stats: LatencyStats; comparable: boolean }>>
  >(runs.map((run) => [run.name, new Map()]));

  for (const queryId of options.queries) {
    // Only engines that actually ran this query participate — an engine that
    // declared it unsupported (capability gap) is absent, not a zero.
    const ranThisQuery = runs.filter(
      (run) => run.queries[queryId] !== undefined,
    );
    const outcomesByEngine: EngineQueryOutcomes[] = ranThisQuery.map((run) => {
      const measurement = run.queries[queryId]!;
      return {
        engine: run.name,
        rowCounts: measurement.rowCounts,
        digests: measurement.digests,
      };
    });
    const parity = evaluateParity(outcomesByEngine);

    for (const run of ranThisQuery) {
      const stats = computeLatencyStats(run.queries[queryId]!.samplesMs);
      resultsByQuery[queryId].push({
        engine: run.name,
        stats,
        comparable: parity.comparable,
        ...(parity.reason === undefined ? {} : { parityReason: parity.reason }),
      });
      historyQueriesByEngine
        .get(run.name)!
        .set(queryId, { stats, comparable: parity.comparable });
    }
  }

  for (const run of runs) {
    writeLaneHistoryEntry({
      lane: LANE,
      engine: run.name,
      profile: options.profile,
      requestsPerQuery: options.requestsPerQuery,
      loadMs: run.loadMs,
      queries: historyQueriesByEngine.get(run.name)!,
    });
  }

  console.log("\n=== Parity (row count + value digest) ===");
  const mismatches: string[] = [];
  for (const queryId of options.queries) {
    const summaries = resultsByQuery[queryId];
    const ranCount = summaries.length;
    const [first] = summaries;
    const comparable = first?.comparable ?? false;
    const reason = first?.parityReason;
    // Distinguish a genuine mismatch from "too few engines ran it" — the
    // latter is expected for capability-gated queries (e.g. only pgGraph runs
    // GA_WCC) and must never count as a parity failure.
    const status =
      ranCount === 0 ? "no engines ran it"
      : ranCount === 1 ? `only ${first!.engine} ran it`
      : comparable ? "yes"
      : `no (${reason ?? "parity mismatch"})`;
    console.log(`  ${queryId}: comparable=${status}`);
    if (ranCount >= 2 && !comparable) {
      mismatches.push(`${queryId}: ${reason ?? "parity mismatch"}`);
    }
  }

  const gapLines: string[] = [];
  for (const run of runs) {
    for (const queryId of options.queries) {
      const reason = run.unsupported[queryId];
      if (reason !== undefined) {
        gapLines.push(`  ${run.name} / ${queryId}: ${reason}`);
      }
    }
  }
  if (gapLines.length > 0) {
    console.log("\n=== Capability gaps (declared unsupported) ===");
    for (const line of gapLines) {
      console.log(line);
    }
  }

  if (failures.length > 0) {
    console.log("\n=== Engine failures ===");
    for (const failure of failures) {
      console.log(`  [FAILED] ${failure.engine}: ${failure.error}`);
    }
  }

  const resultsPath = path.join(options.outputDir, "results.json");
  await writeJsonFile(resultsPath, {
    profile: options.profile,
    requestsPerQuery: options.requestsPerQuery,
    warmupRequests: options.warmupRequests,
    engines: runs.map((run) => ({
      name: run.name,
      fairness: run.fairness,
      loadMs: run.loadMs,
      unsupported: run.unsupported,
    })),
    failures,
    queries: resultsByQuery,
  });

  await writeSummary(path.join(options.outputDir, "summary.json"), {
    lane: LANE,
    profile: options.profile,
    commands: [`tsx src/real/snb-short-reads.ts ${argv.join(" ")}`],
    gitSha: resolveGitSha(),
    gitRefName: resolveGitRefName(),
    engineVersions: await collectEngineVersions(engineNames),
    dataset: { profile: options.profile, datasetRoot },
    warmupIterations: options.warmupRequests,
    sampleIterations: options.requestsPerQuery,
    durabilityLabels: runs.map((run) => `${run.name}: ${run.fairness}`),
  });

  console.log(`\nWrote results to ${options.outputDir}`);

  // A doctor-runnable engine that then failed mid-run is a real regression
  // signal (unlike "not runnable", which is expected in a no-Docker CI
  // environment and must stay green) — --check treats it the same as a
  // genuine parity mismatch.
  if (options.runChecks && (mismatches.length > 0 || failures.length > 0)) {
    if (mismatches.length > 0) {
      console.error("\nParity mismatches between engines:");
      for (const mismatch of mismatches) {
        console.error(`  ${mismatch}`);
      }
    }
    if (failures.length > 0) {
      console.error("\nEngine failures:");
      for (const failure of failures) {
        console.error(`  ${failure.engine}: ${failure.error}`);
      }
    }
    process.exitCode = 1;
  }
}

await main(process.argv.slice(2));
