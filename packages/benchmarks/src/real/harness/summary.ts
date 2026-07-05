/**
 * `summary.json` writer for the real-workload benchmark lanes. Every run
 * writes one of these next to its result JSON so a result can never be read
 * without also knowing the exact commands, engine versions, dataset
 * parameters, hardware, and git commit that produced it (harness
 * requirement 4 in docs/design/benchmark-program-plan.md).
 */
import os from "node:os";

import { writeJsonFile } from "./process";

export type EngineVersion = Readonly<{
  engine: string;
  version: string;
  detail?: string;
}>;

export type HardwareInfo = Readonly<{
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryBytes: number;
  nodeVersion: string;
}>;

export function collectHardwareInfo(): HardwareInfo {
  const cpus = os.cpus();
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
  };
}

export type SummaryInput = Readonly<{
  lane: string;
  profile: string;
  commands: readonly string[];
  gitSha: string;
  gitRefName: string | undefined;
  engineVersions: readonly EngineVersion[];
  dataset: Readonly<Record<string, unknown>>;
  warmupIterations: number;
  sampleIterations: number;
  /** e.g. "typegraph-sqlite: file, synchronous=NORMAL", "neo4j: tmpfs, default fsync" */
  durabilityLabels: readonly string[];
  notes?: readonly string[];
}>;

export type Summary = SummaryInput &
  Readonly<{
    generatedAt: string;
    hardware: HardwareInfo;
  }>;

export async function writeSummary(
  outputPath: string,
  input: SummaryInput,
): Promise<Summary> {
  const summary: Summary = {
    ...input,
    generatedAt: new Date().toISOString(),
    hardware: collectHardwareInfo(),
  };
  await writeJsonFile(outputPath, summary);
  return summary;
}
