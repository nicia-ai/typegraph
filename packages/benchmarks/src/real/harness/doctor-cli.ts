/**
 * Standalone competitor-doctor entry point:
 * `pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:doctor`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor, writeDoctorResult } from "./doctor";

function outputPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/real/harness/ -> ../../../bench-results/current/competitor-doctor.json
  return path.join(
    here,
    "..",
    "..",
    "..",
    "bench-results",
    "current",
    "competitor-doctor.json",
  );
}

async function main(): Promise<void> {
  const result = await runDoctor();
  await writeDoctorResult(outputPath(), result);

  console.log(`Competitor doctor: ${result.status}`);
  for (const check of result.checks) {
    console.log(
      `  [${check.status}] ${check.category}/${check.name}: ${check.detail}`,
    );
  }
  console.log("\nRunnable engines:");
  for (const [engine, runnable] of Object.entries(result.runnable)) {
    console.log(`  ${engine}: ${runnable ? "yes" : "no"}`);
  }

  if (result.status === "failed") {
    process.exitCode = 1;
  }
}

await main();
