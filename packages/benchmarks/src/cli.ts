import { type PerfBackend, type PerfCliOptions } from "./config";

function parseBackend(rawBackend: string): PerfBackend {
  if (rawBackend === "sqlite" || rawBackend === "postgres") {
    return rawBackend;
  }

  throw new Error(
    `Unsupported backend: "${rawBackend}". Expected "sqlite" or "postgres".`,
  );
}

export function parseCliOptions(argv: readonly string[]): PerfCliOptions {
  const runChecks = argv.includes("--check");
  const backendArgument = argv.find((argument) =>
    argument.startsWith("--backend="),
  );
  const backend =
    backendArgument === undefined ? "sqlite" : (
      parseBackend(backendArgument.slice(10))
    );

  return {
    runChecks,
    backend,
  };
}
