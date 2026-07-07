import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isSnbEngineName,
  SNB_ENGINE_NAMES,
  type SnbEngineName,
} from "./harness/doctor";
import { type SnbProfile } from "./dataset/resolve";

export type SnbCliOptions = Readonly<{
  profile: SnbProfile;
  engines: readonly SnbEngineName[];
  dataDir: string | undefined;
  requestsPerQuery: number;
  warmupRequests: number;
  seed: number;
  outputDir: string;
  /** Exit non-zero on a genuine row-count mismatch between 2+ engines that ran. */
  runChecks: boolean;
}>;

const PROFILE_DEFAULTS: Readonly<
  Record<SnbProfile, { warmup: number; samples: number }>
> = {
  // ≥3 warmups, ≥15 samples per the harness discipline
  // (docs/design/benchmark-program-plan.md); smoke stays near the floor for CI speed.
  smoke: { warmup: 3, samples: 15 },
  sf1: { warmup: 5, samples: 20 },
  sf10: { warmup: 5, samples: 20 },
};

function parseArgValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((argument) => argument.startsWith(prefix));
  return found?.slice(prefix.length);
}

function parseProfile(raw: string | undefined): SnbProfile {
  if (raw === undefined || raw === "smoke") return "smoke";
  if (raw === "sf1") return "sf1";
  if (raw === "sf10") return "sf10";
  throw new Error(
    `Unsupported --profile value: "${raw}". Expected "smoke", "sf1", or "sf10".`,
  );
}

function parseEngines(raw: string | undefined): readonly SnbEngineName[] {
  if (raw === undefined) return SNB_ENGINE_NAMES;
  const names = raw.split(",").map((entry) => entry.trim());
  for (const name of names) {
    if (!isSnbEngineName(name)) {
      throw new Error(
        `Unsupported engine "${name}" in --engines. Expected one of: ${SNB_ENGINE_NAMES.join(", ")}.`,
      );
    }
  }
  return names as SnbEngineName[];
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid --${name} value: "${raw}". Must be a positive integer.`,
    );
  }
  return parsed;
}

function defaultOutputDir(profile: SnbProfile): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/real/ -> ../../bench-results/current/snb-<profile>
  return path.join(
    here,
    "..",
    "..",
    "bench-results",
    "current",
    `snb-${profile}`,
  );
}

export function parseSnbCliOptions(argv: readonly string[]): SnbCliOptions {
  const profile = parseProfile(parseArgValue(argv, "profile"));
  const defaults = PROFILE_DEFAULTS[profile];

  return {
    profile,
    engines: parseEngines(parseArgValue(argv, "engines")),
    dataDir: parseArgValue(argv, "data-dir"),
    requestsPerQuery: parsePositiveInt(
      parseArgValue(argv, "requests-per-query"),
      "requests-per-query",
      defaults.samples,
    ),
    warmupRequests: parsePositiveInt(
      parseArgValue(argv, "warmup-requests"),
      "warmup-requests",
      defaults.warmup,
    ),
    seed: parsePositiveInt(parseArgValue(argv, "seed"), "seed", 42),
    outputDir: parseArgValue(argv, "output") ?? defaultOutputDir(profile),
    runChecks: argv.includes("--check"),
  };
}
