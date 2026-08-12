import { readFileSync, statSync } from "node:fs";

/**
 * Parses `reports/history.jsonl` deltas into per-label medians. This is
 * the ONLY module allowed to know the row shapes `history.ts`/
 * `real/harness/history.ts` write — every other regression module consumes
 * `ExtractedRun`, never a raw history row.
 */

export type LaneMeasurements = ReadonlyMap<string, number>;

export type ExtractedRun = Readonly<{
  measurements: LaneMeasurements;
  /** Scalar run parameters present in the appended rows, for comparability checks. */
  signature: Readonly<Record<string, string | number>>;
}>;

/** Byte size of `historyPath`, or 0 if the file does not exist yet. */
export function historyFileSize(historyPath: string): number {
  try {
    return statSync(historyPath).size;
  } catch (error) {
    if (isEnoent(error)) {
      return 0;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Lines appended to `historyPath` after `byteOffsetBefore` (I5). A lane
 * run can append more than one line — e.g. the SNB lane appends one line
 * per engine — so "the last line" is not a valid substitute for the
 * byte-range this reads.
 */
export function readHistoryTail(
  historyPath: string,
  byteOffsetBefore: number,
): readonly string[] {
  const buffer = readFileSync(historyPath);
  const tail = buffer.subarray(byteOffsetBefore).toString("utf-8");
  return tail.split("\n").filter((line) => line.trim().length > 0);
}

export class UnrecognizedHistoryRowError extends Error {
  constructor(rawLine: string) {
    super(`Unrecognized history.jsonl row shape: ${rawLine}`);
    this.name = "UnrecognizedHistoryRowError";
  }
}

const SIGNATURE_KEYS = [
  "backend",
  "scale",
  "userCount",
  "sqliteStorage",
  "postgresDriver",
  "warmupIterations",
  "sampleIterations",
  "seedRowsPerKind",
  "profile",
  "requestsPerQuery",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectSignature(
  row: Record<string, unknown>,
  signature: Record<string, string | number>,
): void {
  for (const key of SIGNATURE_KEYS) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") {
      signature[key] = value;
    }
  }
}

function extractSampleMedian(
  rawLine: string,
  sample: unknown,
  medianKey: "median" | "medianMs",
): number {
  if (!isRecord(sample) || typeof sample[medianKey] !== "number") {
    throw new UnrecognizedHistoryRowError(rawLine);
  }
  return sample[medianKey];
}

function collectMeasurements(
  rawLine: string,
  bucket: Record<string, unknown>,
  medianKey: "median" | "medianMs",
  measurements: Map<string, number>,
): void {
  for (const [label, sample] of Object.entries(bucket)) {
    // Labels are free-form human strings (I6) — never split or reshape them.
    measurements.set(label, extractSampleMedian(rawLine, sample, medianKey));
  }
}

/**
 * Normalizes the three measurement shapes present in `history.jsonl`
 * today: `latencies` (perf/write/vector), `measurements` (identity), and
 * `queries` (snb). A row matching none of those shapes throws — no lane
 * may silently contribute zero measurements.
 */
export function extractLaneMeasurements(
  appendedLines: readonly string[],
): ExtractedRun {
  const measurements = new Map<string, number>();
  const signature: Record<string, string | number> = {};

  for (const rawLine of appendedLines) {
    const row = JSON.parse(rawLine) as Record<string, unknown>;
    collectSignature(row, signature);

    if (isRecord(row["latencies"])) {
      collectMeasurements(rawLine, row["latencies"], "median", measurements);
      continue;
    }
    if (isRecord(row["measurements"])) {
      collectMeasurements(rawLine, row["measurements"], "median", measurements);
      continue;
    }
    if (isRecord(row["queries"])) {
      collectMeasurements(rawLine, row["queries"], "medianMs", measurements);
      continue;
    }
    throw new UnrecognizedHistoryRowError(rawLine);
  }

  return { measurements, signature };
}
