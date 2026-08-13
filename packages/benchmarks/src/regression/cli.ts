import { getPostgresUrl } from "../config";
import { type LaneBackend } from "./lanes";

export type RegressionCliOptions = Readonly<{
  candidateRef: string | undefined;
  candidateWorktree: string | undefined;
  baseRef: string | undefined;
  tagRef: string | undefined;
  featureBaselineRef: string | undefined;
  laneIds: readonly string[] | undefined;
  backends: readonly LaneBackend[];
  worktreeRoot: string | undefined;
  outputDir: string | undefined;
  laneTimeoutMs: number;
  skipInstall: boolean;
  keepWorktrees: boolean;
}>;

const DEFAULT_LANE_TIMEOUT_MS = 900_000;

export class RegressionCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegressionCliUsageError";
  }
}

/**
 * Reads `--name=value` or `--name value` identically. Exported so the EC2
 * regression CLI (`regression/ec2/cli.ts`) reads its own argv through this
 * same reader rather than a second, differently spelled copy.
 */
export function readValue(
  argv: readonly string[],
  name: string,
): string | undefined {
  const inlinePrefix = `--${name}=`;
  const inlineIndex = argv.findIndex((argument) =>
    argument.startsWith(inlinePrefix),
  );
  if (inlineIndex !== -1) {
    return argv[inlineIndex]!.slice(inlinePrefix.length);
  }
  const flag = `--${name}`;
  const flagIndex = argv.indexOf(flag);
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return argv[flagIndex + 1];
  }
  return undefined;
}

/** Reads a bare `--name` boolean flag. Exported for the same reason as `readValue`. */
export function readFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/**
 * Parses `--backend`'s value into the concrete `LaneBackend`s it selects.
 * Exported so the EC2 regression CLI reuses this exact decision instead of
 * re-deriving it.
 */
export function parseBackends(raw: string | undefined): readonly LaneBackend[] {
  if (raw === undefined) return ["sqlite"];
  if (raw === "both") return ["sqlite", "postgres"];
  if (raw === "sqlite" || raw === "postgres") return [raw];
  throw new RegressionCliUsageError(
    `Unsupported --backend value: "${raw}". Expected "sqlite", "postgres", or "both".`,
  );
}

/**
 * An accepted option is applied or refused, never silently downgraded: a
 * postgres leg without a resolvable `POSTGRES_URL` throws instead of
 * quietly falling back to sqlite-only. Reuses `getPostgresUrl()` as the
 * single source of truth for the value that will actually be handed to
 * lane runs once validated.
 */
function assertPostgresUrlResolvable(backends: readonly LaneBackend[]): void {
  if (!backends.includes("postgres")) {
    return;
  }
  if (process.env["POSTGRES_URL"] === undefined) {
    throw new RegressionCliUsageError(
      "--backend requires a resolvable POSTGRES_URL for the postgres leg " +
        '("postgres" or "both"); set POSTGRES_URL or drop the postgres backend.',
    );
  }
  getPostgresUrl();
}

function parseLaneTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LANE_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RegressionCliUsageError(
      `Invalid --lane-timeout-ms value: "${raw}". Must be a positive number.`,
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

/**
 * argv -> RegressionCliOptions. Pure: no filesystem or process spawning,
 * only `process.env["POSTGRES_URL"]` for the applied-or-refused backend
 * check above.
 */
export function parseRegressionCliOptions(
  argv: readonly string[],
): RegressionCliOptions {
  const candidateRef = readValue(argv, "candidate");
  const candidateWorktree = readValue(argv, "candidate-worktree");
  if (candidateRef !== undefined && candidateWorktree !== undefined) {
    throw new RegressionCliUsageError(
      "--candidate and --candidate-worktree are mutually exclusive: a " +
        "candidate is either a ref checked out into a scratch worktree, or " +
        "an existing worktree path, never both.",
    );
  }

  const backends = parseBackends(readValue(argv, "backend"));
  assertPostgresUrlResolvable(backends);

  return {
    candidateRef,
    candidateWorktree,
    baseRef: readValue(argv, "base"),
    tagRef: readValue(argv, "tag"),
    featureBaselineRef: readValue(argv, "feature-baseline"),
    laneIds: parseLaneIds(readValue(argv, "lanes")),
    backends,
    worktreeRoot: readValue(argv, "worktree-root"),
    outputDir: readValue(argv, "output"),
    laneTimeoutMs: parseLaneTimeoutMs(readValue(argv, "lane-timeout-ms")),
    skipInstall: readFlag(argv, "skip-install"),
    keepWorktrees: readFlag(argv, "keep-worktrees"),
  };
}
