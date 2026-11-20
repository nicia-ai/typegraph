/**
 * Competitor preflight for the real-workload benchmark lanes. Every engine's
 * docker/package availability is checked and recorded as an explicit
 * "failed" row when missing — never a silent skip (harness requirement 3 in
 * docs/design/benchmark-program-plan.md). The five engines this program
 * drives:
 *
 * - `typegraph-sqlite` — embedded (better-sqlite3), no external dependency.
 * - `typegraph-postgres` — needs a reachable PostgreSQL server; this program
 *   launches one imperatively (docker run), or uses the server named by
 *   `TYPEGRAPH_BENCH_POSTGRES_URL`.
 * - `neo4j` — imperative Docker container (docker run + named volume), or the
 *   server named by `TYPEGRAPH_BENCH_NEO4J_URL`.
 * - `ladybugdb` — embedded (`@ladybugdb/core`), no external dependency.
 * - `pggraph` — imperative Docker container running the pgGraph
 *   PostgreSQL extension image, or the server named by
 *   `TYPEGRAPH_BENCH_PGGRAPH_URL`; driven over `pg` like typegraph-postgres.
 *
 * A server engine on an existing server is probed there (reachable, the
 * extension or plugin it needs, the role privileges its isolation needs)
 * instead of requiring Docker.
 */
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { NEO4J_IMAGE, PGGRAPH_IMAGE, POSTGRES_IMAGE } from "./engine-pins";
import {
  probeNeo4jServer,
  probePgGraphServer,
  probePostgresServer,
  type ProbeVerdict,
} from "./external-server-probes";
import {
  EXTERNAL_NEO4J_URL_ENV,
  EXTERNAL_PGGRAPH_URL_ENV,
  EXTERNAL_POSTGRES_URL_ENV,
  readExternalUrl,
} from "./external-servers";
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
  /** Where the `*_URL` variables are read from (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
}>;

type ServerEngine = "typegraph-postgres" | "neo4j" | "pggraph";

type ServerEngineSpec = Readonly<{
  urlEnv: string;
  image: string;
  /** Node package the engine drives the server with. */
  driverPackage: string;
  probe: (
    url: string,
    env: Readonly<Record<string, string | undefined>>,
  ) => Promise<ProbeVerdict>;
}>;

/**
 * The three server engines: each runs in a container the harness launches
 * unless its `*_URL` variable names an existing server, in which case the
 * doctor probes that server instead of requiring Docker.
 */
const SERVER_ENGINES: Readonly<Record<ServerEngine, ServerEngineSpec>> = {
  "typegraph-postgres": {
    urlEnv: EXTERNAL_POSTGRES_URL_ENV,
    image: POSTGRES_IMAGE,
    driverPackage: "pg",
    probe: (url) => probePostgresServer(url),
  },
  neo4j: {
    urlEnv: EXTERNAL_NEO4J_URL_ENV,
    image: NEO4J_IMAGE,
    driverPackage: "neo4j-driver",
    probe: (url, env) => probeNeo4jServer(url, env),
  },
  pggraph: {
    urlEnv: EXTERNAL_PGGRAPH_URL_ENV,
    image: PGGRAPH_IMAGE,
    driverPackage: "pg",
    probe: (url) => probePgGraphServer(url),
  },
};

const SERVER_ENGINE_NAMES = Object.keys(SERVER_ENGINES) as ServerEngine[];

export async function runDoctor(
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const engines = options.engines ?? SNB_ENGINE_NAMES;
  const env = options.env ?? process.env;
  const wants = (engine: SnbEngineName): boolean => engines.includes(engine);

  const checks: DoctorCheck[] = [];
  checks.push(await checkLoopback());

  const externalUrls = new Map<ServerEngine, string>();
  for (const engine of SERVER_ENGINE_NAMES) {
    const url = readExternalUrl(env, SERVER_ENGINES[engine].urlEnv);
    if (url !== undefined) externalUrls.set(engine, url);
  }
  const needsDocker = (engine: ServerEngine): boolean =>
    wants(engine) && !externalUrls.has(engine);

  const docker = await checkCommand(
    "runtime",
    "Docker daemon",
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    SERVER_ENGINE_NAMES.some((engine) => needsDocker(engine)),
  );
  checks.push(docker);

  const packages = new Set<string>();
  if (wants("typegraph-sqlite")) packages.add("better-sqlite3");
  if (wants("ladybugdb")) packages.add("@ladybugdb/core");
  for (const engine of SERVER_ENGINE_NAMES) {
    if (wants(engine)) packages.add(SERVER_ENGINES[engine].driverPackage);
  }
  for (const packageName of packages) {
    checks.push(await checkPackage(packageName, true));
  }

  const serverReady = new Map<ServerEngine, boolean>();
  for (const engine of SERVER_ENGINE_NAMES) {
    if (!wants(engine)) continue;
    const spec = SERVER_ENGINES[engine];
    const url = externalUrls.get(engine);
    if (url === undefined) {
      checks.push(await checkDockerImage(spec.image, docker.status === "ok"));
      serverReady.set(engine, docker.status === "ok");
      continue;
    }
    const verdict = await spec.probe(url, env);
    checks.push({
      category: "external-server",
      name: `${engine} (${spec.urlEnv})`,
      status: verdict.ok ? "ok" : "failed",
      required: true,
      detail: verdict.detail,
    });
    serverReady.set(engine, verdict.ok);
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
      case "typegraph-sqlite": {
        return !requiredFailed("node-package", "better-sqlite3");
      }
      case "ladybugdb": {
        return !requiredFailed("node-package", "@ladybugdb/core");
      }
      case "typegraph-postgres":
      case "neo4j":
      case "pggraph": {
        return (
          serverReady.get(engine) === true &&
          !requiredFailed("node-package", SERVER_ENGINES[engine].driverPackage)
        );
      }
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
      "Loopback TCP is expected only for services started and owned by the harness (docker-backed PostgreSQL, Neo4j or pgGraph).",
      "This doctor does not require docker images to be cached; an uncached image is still pulled by the benchmark run.",
      "typegraph-sqlite and ladybugdb are embedded and never require Docker.",
      `A server engine whose URL variable is set (${SERVER_ENGINE_NAMES.map((engine) => SERVER_ENGINES[engine].urlEnv).join(", ")}) is probed on that server and does not require Docker.`,
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
