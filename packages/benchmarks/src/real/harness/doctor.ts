/**
 * Competitor preflight for the real-workload benchmark lanes. Every engine's
 * docker/package availability is checked and recorded as an explicit
 * "failed" row when missing — never a silent skip (harness requirement 3 in
 * docs/design/benchmark-program-plan.md). The four engines this program
 * drives:
 *
 * - `typegraph-sqlite` — embedded (better-sqlite3), no external dependency.
 * - `typegraph-postgres` — needs a reachable PostgreSQL server; this program
 *   launches one imperatively (docker run + tmpfs), so it needs Docker.
 * - `neo4j` — imperative Docker container (docker run + tmpfs/named volume).
 * - `ladybugdb` — embedded (`@ladybugdb/core`), no external dependency.
 * - `pggraph` — imperative Docker container running the Evokoa pgGraph
 *   PostgreSQL extension image; driven over `pg` like typegraph-postgres.
 */
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { spawnStatus, stringifyError, writeJsonFile } from "./process";

const require = createRequire(import.meta.url);

export const SNB_ENGINE_NAMES = [
  "typegraph-sqlite",
  "typegraph-postgres",
  "neo4j",
  "ladybugdb",
  "pggraph",
] as const;
export type SnbEngineName = (typeof SNB_ENGINE_NAMES)[number];

export function isSnbEngineName(value: string): value is SnbEngineName {
  return (SNB_ENGINE_NAMES as readonly string[]).includes(value);
}

/**
 * Docker image tags pinned for reproducibility (also recorded in
 * summary.json). TypeGraph's Postgres migration unconditionally enables the
 * `vector` extension regardless of whether the graph declares any embedding
 * fields, so the image must be pgvector-enabled — matching the image this
 * repo's own CI already uses for Postgres tests (.github/workflows/ci.yml).
 */
export const POSTGRES_IMAGE =
  process.env["TYPEGRAPH_BENCH_POSTGRES_IMAGE"] ?? "pgvector/pgvector:pg18";
export const NEO4J_IMAGE =
  process.env["TYPEGRAPH_BENCH_NEO4J_IMAGE"] ?? "neo4j:2026.05.0";
/**
 * Evokoa pgGraph extension image (bundles PostgreSQL 17 + the `graph`
 * extension + pg_cron). Pinned to a released version tag for reproducibility;
 * override via env for a newer build.
 */
export const PGGRAPH_IMAGE =
  process.env["TYPEGRAPH_BENCH_PGGRAPH_IMAGE"] ??
  "ghcr.io/evokoa/pggraph:0.1.8";

type CheckStatus = "ok" | "failed" | "skipped";

type DoctorCheck = Readonly<{
  category: string;
  name: string;
  status: CheckStatus;
  required: boolean;
  detail: string;
  command?: string;
}>;

export type DoctorResult = Readonly<{
  generatedAt: string;
  status: "ok" | "failed";
  engines: readonly SnbEngineName[];
  checks: readonly DoctorCheck[];
  /** Whether each selected engine has everything it needs to run. */
  runnable: Readonly<Record<SnbEngineName, boolean>>;
  caveats: readonly string[];
}>;

async function checkLoopback(): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error) => {
      resolve({
        category: "runtime",
        name: "loopback bind",
        status: "failed",
        required: true,
        detail: stringifyError(error),
      });
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => {
        resolve({
          category: "runtime",
          name: "loopback bind",
          status: "ok",
          required: true,
          detail: "Can bind a harness-owned 127.0.0.1 port.",
        });
      });
    });
  });
}

async function checkCommand(
  category: string,
  name: string,
  command: string,
  commandArgs: readonly string[],
  required: boolean,
): Promise<DoctorCheck> {
  const result = await spawnStatus(command, commandArgs, 20_000);
  const commandText = `${command} ${commandArgs.join(" ")}`;
  if (result.code === 0) {
    return {
      category,
      name,
      status: "ok",
      required,
      detail: oneLine(result.stdout || result.stderr) || `${name} available.`,
      command: commandText,
    };
  }
  return {
    category,
    name,
    status: required ? "failed" : "skipped",
    required,
    detail: commandFailure(command, commandArgs, result),
    command: commandText,
  };
}

async function checkPackage(
  packageName: string,
  required: boolean,
): Promise<DoctorCheck> {
  try {
    await import(packageName);
    const version = await packageVersion(packageName);
    return {
      category: "node-package",
      name: packageName,
      status: "ok",
      required,
      detail: `Package can be imported${version ? ` (version ${version})` : ""}.`,
    };
  } catch (error) {
    return {
      category: "node-package",
      name: packageName,
      status: required ? "failed" : "skipped",
      required,
      detail: stringifyError(error),
    };
  }
}

/** Resolves an installed package's own `version` field (for summary.json). */
export async function packageVersion(
  packageName: string,
): Promise<string | null> {
  try {
    let dir = dirname(require.resolve(packageName));
    let previous: string | undefined;
    while (dir !== previous) {
      try {
        const manifest = JSON.parse(
          await readFile(`${dir}/package.json`, "utf8"),
        ) as { name?: string; version?: string };
        if (
          manifest.name === packageName &&
          typeof manifest.version === "string"
        ) {
          return manifest.version;
        }
      } catch {
        // Keep walking until the package root manifest is found.
      }
      previous = dir;
      dir = dirname(dir);
    }
    return null;
  } catch {
    return null;
  }
}

async function checkDockerImage(
  image: string,
  dockerOk: boolean,
): Promise<DoctorCheck> {
  if (!dockerOk) {
    return {
      category: "docker-image",
      name: image,
      status: "skipped",
      required: false,
      detail: "Docker is unavailable; image cache was not checked.",
    };
  }
  const inspect = await spawnStatus(
    "docker",
    ["image", "inspect", image],
    20_000,
  );
  if (inspect.code === 0) {
    return {
      category: "docker-image",
      name: image,
      status: "ok",
      required: false,
      detail: "Image is already cached.",
      command: `docker image inspect ${image}`,
    };
  }
  return {
    category: "docker-image",
    name: image,
    status: "skipped",
    required: false,
    detail: "Image is not cached; Docker will pull it at benchmark runtime.",
    command: `docker image inspect ${image}`,
  };
}

export type DoctorOptions = Readonly<{
  engines?: readonly SnbEngineName[];
}>;

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const engines = options.engines ?? SNB_ENGINE_NAMES;
  const wants = (engine: SnbEngineName): boolean => engines.includes(engine);

  const checks: DoctorCheck[] = [];
  checks.push(await checkLoopback());

  const dockerRequired =
    wants("typegraph-postgres") || wants("neo4j") || wants("pggraph");
  const docker = await checkCommand(
    "runtime",
    "Docker daemon",
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    dockerRequired,
  );
  checks.push(docker);

  if (wants("typegraph-sqlite")) {
    checks.push(await checkPackage("better-sqlite3", true));
  }
  if (wants("typegraph-postgres") || wants("pggraph")) {
    checks.push(await checkPackage("pg", true));
  }
  if (wants("neo4j")) {
    checks.push(await checkPackage("neo4j-driver", true));
  }
  if (wants("ladybugdb")) {
    checks.push(await checkPackage("@ladybugdb/core", true));
  }

  if (wants("typegraph-postgres")) {
    checks.push(await checkDockerImage(POSTGRES_IMAGE, docker.status === "ok"));
  }
  if (wants("neo4j")) {
    checks.push(await checkDockerImage(NEO4J_IMAGE, docker.status === "ok"));
  }
  if (wants("pggraph")) {
    checks.push(await checkDockerImage(PGGRAPH_IMAGE, docker.status === "ok"));
  }

  const requiredFailed = (category: string, name: string): boolean =>
    checks.some(
      (check) =>
        check.category === category &&
        check.name === name &&
        check.required &&
        check.status === "failed",
    );

  // Engines not included in `engines` were never checked, so they are
  // conservatively reported as not runnable rather than vacuously true.
  function engineRunnable(engine: SnbEngineName): boolean {
    if (!wants(engine)) return false;
    switch (engine) {
      case "typegraph-sqlite":
        return !requiredFailed("node-package", "better-sqlite3");
      case "typegraph-postgres":
        return docker.status === "ok" && !requiredFailed("node-package", "pg");
      case "neo4j":
        return (
          docker.status === "ok" &&
          !requiredFailed("node-package", "neo4j-driver")
        );
      case "ladybugdb":
        return !requiredFailed("node-package", "@ladybugdb/core");
      case "pggraph":
        return docker.status === "ok" && !requiredFailed("node-package", "pg");
    }
  }

  const runnable = Object.fromEntries(
    SNB_ENGINE_NAMES.map((engine) => [engine, engineRunnable(engine)]),
  ) as Record<SnbEngineName, boolean>;

  const failedRequired = checks.some(
    (check) => check.required && check.status === "failed",
  );

  return {
    generatedAt: new Date().toISOString(),
    status: failedRequired ? "failed" : "ok",
    engines,
    checks,
    runnable,
    caveats: [
      "Loopback TCP is expected only for services started and owned by the harness (docker-backed Postgres or Neo4j).",
      "This doctor does not require docker images to be cached; an uncached image is still pulled by the benchmark run.",
      "typegraph-sqlite and ladybugdb are embedded and never require Docker.",
    ],
  };
}

export async function writeDoctorResult(
  outputPath: string,
  result: DoctorResult,
): Promise<void> {
  await writeJsonFile(outputPath, result);
}

function commandFailure(
  command: string,
  commandArgs: readonly string[],
  result: {
    code: number | null;
    stdout: string;
    stderr: string;
    error?: string;
    timedOut: boolean;
  },
): string {
  const reason =
    result.timedOut ? "timed out" : (result.error ?? `exit ${result.code}`);
  const output = oneLine(result.stderr || result.stdout);
  return `${command} ${commandArgs.join(" ")} failed: ${reason}${output ? `: ${output}` : ""}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
