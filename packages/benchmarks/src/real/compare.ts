/**
 * One entry point for the published SNB comparison: smoke-scale parity first,
 * then each real scale, for a chosen set of engines.
 *
 * Usage (from packages/benchmarks; `pnpm bench:snb:compare -- ...` also
 * builds the library first):
 *
 *   node --import tsx src/real/compare.ts [--engines=a,b,c] [--scales=smoke,sf1]
 *     [--data-dir-sf1=<dir>] [--data-dir-sf10=<dir>] [--output-root=<dir>]
 *     [--history] [--requests-per-query=N] [--warmup-requests=N] [--seed=N]
 *     [--queries=a,b]
 *
 * Each scale is one `snb-short-reads.ts` run with every selected engine, so
 * one parity check covers all of them, writing `report.md`, `results.json`,
 * `summary.json` and `competitor-doctor.json` to `<output-root>/snb-<scale>`.
 * Every run passes `--check --require-all-engines`: a parity mismatch, an
 * engine failure, or a selected engine the doctor cannot run exits non-zero,
 * and a failing scale stops the later ones (an SF1 run is not worth hours
 * when smoke parity already failed).
 *
 * Engines run in containers the harness starts, except a server engine
 * whose `*_URL` variable is set (`TYPEGRAPH_BENCH_POSTGRES_URL`,
 * `TYPEGRAPH_BENCH_NEO4J_URL`, `TYPEGRAPH_BENCH_PGGRAPH_URL`), which runs on
 * that server. Nothing is appended to `reports/history.jsonl` unless
 * `--history` is given.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type SnbProfile } from "./dataset/resolve";
import {
  isSnbEngineName,
  SNB_ENGINE_NAMES,
  type SnbEngineName,
} from "./harness/doctor";
import {
  NEO4J_IMAGE,
  PGGRAPH_IMAGE,
  POSTGRES_IMAGE,
} from "./harness/engine-pins";
import {
  EXTERNAL_NEO4J_URL_ENV,
  EXTERNAL_PGGRAPH_URL_ENV,
  EXTERNAL_POSTGRES_URL_ENV,
  readExternalUrl,
  redactUrl,
} from "./harness/external-servers";

const SCALE_ORDER: readonly SnbProfile[] = ["smoke", "sf1", "sf10"];

/** Runner flags forwarded unchanged to every scale. */
const PASSTHROUGH_FLAGS = [
  "requests-per-query",
  "warmup-requests",
  "seed",
  "queries",
] as const;

export type CompareOptions = Readonly<{
  engines: readonly SnbEngineName[];
  /** Always in smoke, sf1, sf10 order. */
  scales: readonly SnbProfile[];
  dataDirs: Readonly<Partial<Record<SnbProfile, string>>>;
  outputRoot: string;
  recordHistory: boolean;
  passthrough: readonly string[];
}>;

export type CompareStep = Readonly<{
  profile: SnbProfile;
  outputDir: string;
  /** Arguments to `src/real/snb-short-reads.ts`. */
  args: readonly string[];
}>;

function argValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function isSnbProfile(value: string): value is SnbProfile {
  return (SCALE_ORDER as readonly string[]).includes(value);
}

const KNOWN_FLAGS = new Set([
  "engines",
  "scales",
  "data-dir-sf1",
  "data-dir-sf10",
  "output-root",
  "history",
  "help",
  ...PASSTHROUGH_FLAGS,
]);

export function parseCompareOptions(
  argv: readonly string[],
  defaultOutputRoot: string,
): CompareOptions {
  for (const argument of argv) {
    // `pnpm bench:snb:compare -- --engines=...` may forward the separator.
    if (argument === "--") continue;
    const name = /^--([^=]+)/.exec(argument)?.[1];
    if (name === undefined || !KNOWN_FLAGS.has(name)) {
      throw new Error(`Unknown argument "${argument}". Run with --help.`);
    }
  }

  const engineList = argValue(argv, "engines");
  const engines =
    engineList === undefined ? SNB_ENGINE_NAMES : (
      engineList.split(",").map((entry) => entry.trim())
    );
  for (const engine of engines) {
    if (!isSnbEngineName(engine)) {
      throw new Error(
        `Unknown engine "${engine}". Expected one of: ${SNB_ENGINE_NAMES.join(", ")}.`,
      );
    }
  }

  const scaleList = (argValue(argv, "scales") ?? "smoke,sf1")
    .split(",")
    .map((entry) => entry.trim());
  for (const scale of scaleList) {
    if (!isSnbProfile(scale)) {
      throw new Error(
        `Unknown scale "${scale}". Expected some of: ${SCALE_ORDER.join(", ")}.`,
      );
    }
  }

  const dataDirs: Partial<Record<SnbProfile, string>> = {};
  for (const profile of ["sf1", "sf10"] as const) {
    const dir = argValue(argv, `data-dir-${profile}`);
    if (dir !== undefined) dataDirs[profile] = dir;
  }

  return {
    engines: engines as SnbEngineName[],
    scales: SCALE_ORDER.filter((scale) => scaleList.includes(scale)),
    dataDirs,
    outputRoot: argValue(argv, "output-root") ?? defaultOutputRoot,
    recordHistory: argv.includes("--history"),
    passthrough: argv.filter((argument) =>
      PASSTHROUGH_FLAGS.some((flag) => argument.startsWith(`--${flag}=`)),
    ),
  };
}

/** One runner invocation per scale, in order. */
export function planCompareSteps(
  options: CompareOptions,
): readonly CompareStep[] {
  return options.scales.map((profile) => {
    const outputDir = path.join(options.outputRoot, `snb-${profile}`);
    const dataDir = options.dataDirs[profile];
    return {
      profile,
      outputDir,
      args: [
        `--profile=${profile}`,
        `--engines=${options.engines.join(",")}`,
        `--output=${outputDir}`,
        "--check",
        "--require-all-engines",
        ...(options.recordHistory ? [] : ["--no-history"]),
        ...(dataDir === undefined ? [] : [`--data-dir=${dataDir}`]),
        ...options.passthrough,
      ],
    };
  });
}

/** Where each selected engine will run, for the plan printed before anything starts. */
export function describeEngineTargets(
  engines: readonly SnbEngineName[],
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  function server(urlEnv: string, image: string): string {
    const url = readExternalUrl(env, urlEnv);
    return url === undefined ?
        `container ${image}`
      : `existing server ${redactUrl(url)} (${urlEnv})`;
  }
  return engines.map((engine) => {
    switch (engine) {
      case "typegraph-sqlite": {
        return `${engine}: in-process`;
      }
      case "ladybugdb": {
        return `${engine}: in-process`;
      }
      case "typegraph-postgres": {
        return `${engine}: ${server(EXTERNAL_POSTGRES_URL_ENV, POSTGRES_IMAGE)}`;
      }
      case "neo4j": {
        return `${engine}: ${server(EXTERNAL_NEO4J_URL_ENV, NEO4J_IMAGE)}`;
      }
      case "pggraph": {
        return `${engine}: ${server(EXTERNAL_PGGRAPH_URL_ENV, PGGRAPH_IMAGE)}`;
      }
    }
  });
}

const USAGE = `Usage: node --import tsx src/real/compare.ts [options]

  --engines=a,b,c         engines to compare (default: all five)
  --scales=smoke,sf1      scales to run, always smoke first (default: smoke,sf1; sf10 allowed)
  --data-dir-sf1=<dir>    extracted LDBC SF1 datagen directory (default: ~/.cache/typegraph/fixtures/ldbc-snb/sf1)
  --data-dir-sf10=<dir>   same for SF10
  --output-root=<dir>     one snb-<scale>/ directory per scale is written here
  --history               also append the runs to reports/history.jsonl (off by default)
  --requests-per-query=N, --warmup-requests=N, --seed=N, --queries=a,b
                          forwarded to every scale

Server engines use containers unless TYPEGRAPH_BENCH_POSTGRES_URL,
TYPEGRAPH_BENCH_NEO4J_URL (+ TYPEGRAPH_BENCH_NEO4J_DATABASE) or
TYPEGRAPH_BENCH_PGGRAPH_URL name an existing server. Exits non-zero on a
parity mismatch, an engine failure, or a selected engine that cannot run.`;

function runStep(runnerPath: string, step: CompareStep): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", runnerPath, ...step.args],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help")) {
    console.log(USAGE);
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const options = parseCompareOptions(
    argv,
    path.join(
      here,
      "..",
      "..",
      "bench-results",
      "current",
      `snb-compare-${stamp}`,
    ),
  );
  const steps = planCompareSteps(options);

  console.log(
    `SNB comparison: ${options.engines.length} engines, scales ${options.scales.join(" then ")}`,
  );
  for (const line of describeEngineTargets(options.engines, process.env)) {
    console.log(`  ${line}`);
  }
  console.log(
    options.recordHistory ?
      "  history: appending to reports/history.jsonl (--history)"
    : "  history: not recorded (pass --history to append)",
  );

  const runnerPath = path.join(here, "snb-short-reads.ts");
  const completed: CompareStep[] = [];
  for (const step of steps) {
    console.log(`\n##### ${step.profile}: ${step.args.join(" ")}\n`);
    const exitCode = await runStep(runnerPath, step);
    if (exitCode !== 0) {
      console.error(
        `\n${step.profile} failed (exit ${exitCode}); see ${step.outputDir} (report.md, or competitor-doctor.json when the doctor refused an engine).` +
          (steps.length > completed.length + 1 ?
            ` Not running ${steps
              .slice(completed.length + 1)
              .map((later) => later.profile)
              .join(", ")}.`
          : ""),
      );
      process.exitCode = exitCode;
      return;
    }
    completed.push(step);
  }

  console.log("\nAll scales passed parity. Reports:");
  for (const step of completed) {
    console.log(`  ${path.join(step.outputDir, "report.md")}`);
  }
}

// Run only as an entry point, so the tests can import the planning functions.
if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  await main(process.argv.slice(2));
}
