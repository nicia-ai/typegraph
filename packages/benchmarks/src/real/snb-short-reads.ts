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
import { createTypegraphPostgresEngine } from "./engines/typegraph-postgres";
import { createTypegraphSqliteEngine } from "./engines/typegraph-sqlite";
import {
  IS_QUERY_IDS,
  type IsQueryId,
  type SnbEngineFactory,
  type SnbQueryResult,
} from "./engines/types";
import {
  NEO4J_IMAGE,
  packageVersion,
  runDoctor,
  writeDoctorResult,
  type SnbEngineName,
} from "./harness/doctor";
import { writeLaneHistoryEntry } from "./harness/history";
import { evaluateParity, type EngineRowCounts } from "./harness/parity";
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
};

type EngineQueryMeasurement = Readonly<{
  samplesMs: readonly number[];
  rowCounts: readonly number[];
}>;

type EngineRun = Readonly<{
  name: SnbEngineName;
  fairness: string;
  loadMs: number;
  queries: Readonly<Record<IsQueryId, EngineQueryMeasurement>>;
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
  for (let index = warmupRequests; index < totalRequests; index += 1) {
    const started = nowMs();
    const result = await run(requests[index]!);
    samplesMs.push(nowMs() - started);
    rowCounts.push(result.rowCount);
  }
  return { samplesMs, rowCounts };
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

    const queries: Record<IsQueryId, EngineQueryMeasurement> = {
      IS1: await measureQuery(
        requestPlan.IS1,
        options.warmupRequests,
        requestCount,
        handle.queries.IS1,
      ),
      IS2: await measureQuery(
        requestPlan.IS2,
        options.warmupRequests,
        requestCount,
        handle.queries.IS2,
      ),
      IS3: await measureQuery(
        requestPlan.IS3,
        options.warmupRequests,
        requestCount,
        handle.queries.IS3,
      ),
      IS4: await measureQuery(
        requestPlan.IS4,
        options.warmupRequests,
        requestCount,
        handle.queries.IS4,
      ),
      IS5: await measureQuery(
        requestPlan.IS5,
        options.warmupRequests,
        requestCount,
        handle.queries.IS5,
      ),
      IS6: await measureQuery(
        requestPlan.IS6,
        options.warmupRequests,
        requestCount,
        handle.queries.IS6,
      ),
      IS7: await measureQuery(
        requestPlan.IS7,
        options.warmupRequests,
        requestCount,
        handle.queries.IS7,
      ),
    };

    for (const queryId of IS_QUERY_IDS) {
      const stats = computeLatencyStats(queries[queryId].samplesMs);
      console.log(
        `  ${queryId}: p50=${formatMs(stats.medianMs)} p95=${formatMs(stats.p95Ms)} ` +
          `p99=${formatMs(stats.p99Ms)}${stats.noisy ? " (NOISY, CV>25%)" : ""}`,
      );
    }

    return { name: engineName, fairness: handle.fairness, loadMs, queries };
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
  const resultsByQuery: Record<IsQueryId, QuerySummary[]> = {
    IS1: [],
    IS2: [],
    IS3: [],
    IS4: [],
    IS5: [],
    IS6: [],
    IS7: [],
  };
  // One history line per engine covering all 7 queries — built up across
  // the query loop below, written once per engine afterward.
  const historyQueriesByEngine = new Map<
    SnbEngineName,
    Map<IsQueryId, Readonly<{ stats: LatencyStats; comparable: boolean }>>
  >(runs.map((run) => [run.name, new Map()]));

  for (const queryId of IS_QUERY_IDS) {
    const rowCountsByEngine: EngineRowCounts[] = runs.map((run) => ({
      engine: run.name,
      rowCounts: run.queries[queryId].rowCounts,
    }));
    const parity = evaluateParity(rowCountsByEngine);

    for (const run of runs) {
      const stats = computeLatencyStats(run.queries[queryId].samplesMs);
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

  console.log("\n=== Row-count parity ===");
  const mismatches: string[] = [];
  for (const queryId of IS_QUERY_IDS) {
    const [first] = resultsByQuery[queryId];
    const comparable = first?.comparable ?? false;
    const reason = first?.parityReason;
    console.log(
      `  ${queryId}: comparable=${comparable ? "yes" : "no"}${reason === undefined ? "" : ` (${reason})`}`,
    );
    // Every engine that ran executed all 7 queries, so `runs.length >= 2`
    // guarantees evaluateParity had 2+ engines' row counts to compare —
    // `!comparable` here is a genuine mismatch, never "not enough data".
    if (runs.length >= 2 && !comparable) {
      mismatches.push(`${queryId}: ${reason ?? "row-count mismatch"}`);
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
  // genuine row-count mismatch.
  if (options.runChecks && (mismatches.length > 0 || failures.length > 0)) {
    if (mismatches.length > 0) {
      console.error("\nRow-count mismatches between engines:");
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
