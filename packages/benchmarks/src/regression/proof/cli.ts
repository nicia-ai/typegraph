import {
  parseBackends,
  readFlag,
  readValue,
  RegressionCliUsageError,
} from "../cli";
import { type LaneBackend } from "../lanes";

/**
 * CLI parsing for the seeded-regression proof driver
 * (`src/regression-proof.ts`). Pure: no filesystem or process spawning.
 *
 * The shared regression CLI owns generic argv and backend parsing. This
 * module only translates its usage error into the proof CLI's boundary type.
 */

type ProofHalf = "both" | "timing" | "explain";

export type ProofCliOptions = Readonly<{
  seedId: string;
  baseRef: string | undefined;
  laneIds: readonly string[] | undefined;
  backends: readonly LaneBackend[];
  half: ProofHalf;
  laneTimeoutMs: number;
  explainTimeoutMs: number;
  worktreeRoot: string | undefined;
  proofReportPath: string | undefined;
  keepWorktrees: boolean;
}>;

/**
 * The seeded lane's shape (bounded #396 fixture, `HOP_OPS` repetitions) is
 * deliberately slow — `regression/cli.ts`'s own 900s harness default would
 * report a timeout (an inconclusive, not a severity) rather than let the
 * seeded run finish.
 */
const DEFAULT_LANE_TIMEOUT_MS = 3_600_000;
const DEFAULT_EXPLAIN_TIMEOUT_MS = 900_000;

export class ProofCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofCliUsageError";
  }
}

function parseProofBackends(raw: string | undefined): readonly LaneBackend[] {
  try {
    return parseBackends(raw);
  } catch (error) {
    if (error instanceof RegressionCliUsageError) {
      throw new ProofCliUsageError(error.message);
    }
    throw error;
  }
}

function parseHalf(raw: string | undefined): ProofHalf {
  if (raw === undefined) return "both";
  if (raw === "both" || raw === "timing" || raw === "explain") return raw;
  throw new ProofCliUsageError(
    `Unsupported --half value: "${raw}". Expected "both", "timing", or "explain".`,
  );
}

function parseTimeoutMs(
  raw: string | undefined,
  flagName: string,
  defaultValue: number,
): number {
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ProofCliUsageError(
      `Invalid --${flagName} value: "${raw}". Must be a positive number.`,
    );
  }
  return parsed;
}

function parseLaneIds(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** argv -> ProofCliOptions. `--seed=<id>` is required. */
export function parseProofCliOptions(argv: readonly string[]): ProofCliOptions {
  const seedId = readValue(argv, "seed");
  if (seedId === undefined) {
    throw new ProofCliUsageError(
      "--seed=<id> is required (e.g. --seed=identity-frontier-396).",
    );
  }

  return {
    seedId,
    baseRef: readValue(argv, "base"),
    laneIds: parseLaneIds(readValue(argv, "lanes")),
    backends: parseProofBackends(readValue(argv, "backend")),
    half: parseHalf(readValue(argv, "half")),
    laneTimeoutMs: parseTimeoutMs(
      readValue(argv, "lane-timeout-ms"),
      "lane-timeout-ms",
      DEFAULT_LANE_TIMEOUT_MS,
    ),
    explainTimeoutMs: parseTimeoutMs(
      readValue(argv, "explain-timeout-ms"),
      "explain-timeout-ms",
      DEFAULT_EXPLAIN_TIMEOUT_MS,
    ),
    worktreeRoot: readValue(argv, "worktree-root"),
    proofReportPath: readValue(argv, "proof-report"),
    keepWorktrees: readFlag(argv, "keep-worktrees"),
  };
}

/**
 * Repo-relative paths from `git status --porcelain` that fall under any of
 * `watchedPrefixes`. Handles the porcelain v1 rename/copy shape
 * (`"XY old -> new"`, reporting `new`) and quoted paths.
 */
export function findUncommittedProofPaths(
  porcelain: string,
  watchedPrefixes: readonly string[],
): readonly string[] {
  const matches: string[] = [];
  for (const rawLine of porcelain.split("\n")) {
    if (rawLine.trim().length === 0) {
      continue;
    }
    // Porcelain v1: two status characters, one space, then the path (or
    // "path1 -> path2" for a rename/copy).
    const statusPath = rawLine.slice(3);
    const renameSeparator = " -> ";
    const targetPath =
      statusPath.includes(renameSeparator) ?
        statusPath.slice(
          statusPath.indexOf(renameSeparator) + renameSeparator.length,
        )
      : statusPath;
    const unquotedPath =
      targetPath.startsWith('"') && targetPath.endsWith('"') ?
        targetPath.slice(1, -1)
      : targetPath;
    if (watchedPrefixes.some((prefix) => unquotedPath.startsWith(prefix))) {
      matches.push(unquotedPath);
    }
  }
  return matches;
}
