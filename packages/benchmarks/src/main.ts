import { createBackendResources } from "./backend";
import { parseCliOptions } from "./cli";
import { getGuardrails } from "./config";
import {
  evaluateGuardrails,
  printGuardrailFailures,
  printSummary,
} from "./guardrails";
import { measureQueries } from "./measurements";
import { seedStore } from "./seed";

async function main(argv: readonly string[]): Promise<void> {
  const options = parseCliOptions(argv);
  console.log(
    `TypeGraph perf sanity (${options.runChecks ? "guardrail mode" : "report mode"}, backend=${options.backend})`,
  );

  const resources = await createBackendResources(options.backend);
  try {
    await seedStore(resources.store);

    const metrics = await measureQueries(resources.store);
    printSummary(metrics);

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
