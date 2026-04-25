import { createBackendResources } from "./backend";
import { parseCliOptions } from "./cli";
import { applyScale, BENCHMARK_CONFIG, getGuardrails } from "./config";
import {
  evaluateGuardrails,
  printGuardrailFailures,
  printSummary,
} from "./guardrails";
import { writeHistoryEntry } from "./history";
import { measureQueries } from "./measurements";
import { seedStore } from "./seed";

async function main(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  applyScale(options.scale);
  const scaleSuffix = options.scale === 1 ? "" : `, scale=${options.scale}`;
  console.log(
    `TypeGraph perf sanity (${options.runChecks ? "guardrail mode" : "report mode"}, backend=${options.backend}${scaleSuffix}, users=${BENCHMARK_CONFIG.userCount})`,
  );

  const resources = await createBackendResources(options.backend);
  if (!resources.hasVectorPredicate) {
    console.log(
      "(vector predicate unavailable on this backend — vector and hybrid measurements will be skipped)",
    );
  } else if (!resources.hasHybridFacade) {
    console.log(
      "(hybrid-search facade not implemented on this backend — hybrid measurement will be skipped)",
    );
  }
  try {
    const seedResult = await seedStore(resources.store);

    const { metrics, latencies } = await measureQueries(resources.store, {
      hasVectorPredicate: resources.hasVectorPredicate,
      hasHybridFacade: resources.hasHybridFacade,
      docs: seedResult.docs,
    });
    printSummary(metrics);

    const historyPath = writeHistoryEntry({
      backend: options.backend,
      scale: options.scale,
      userCount: BENCHMARK_CONFIG.userCount,
      latencies,
    });
    console.log(`\nappended run to ${historyPath}`);

    if (!options.runChecks) {
      return;
    }

    const guardrails = getGuardrails(options.backend);
    const violations = evaluateGuardrails(metrics, guardrails);
    if (violations.length > 0) {
      printGuardrailFailures(violations);
      process.exitCode = 1;
      return;
    }

    console.log("\nAll performance guardrails passed.");
  } finally {
    await resources.close();
  }
}

await main(process.argv.slice(2));
