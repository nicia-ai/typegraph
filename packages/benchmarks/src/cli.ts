import { type PerfBackend, type PerfCliOptions } from "./config";

function parseBackend(rawBackend: string): PerfBackend {
  if (rawBackend === "sqlite" || rawBackend === "postgres") {
    return rawBackend;
  }

  throw new Error(
    `Unsupported backend: "${rawBackend}". Expected "sqlite" or "postgres".`,
  );
}

function parseScale(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid --scale value: "${raw}". Must be a positive number.`,
    );
  }
  return parsed;
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

  const scaleArgument = argv.find((argument) =>
    argument.startsWith("--scale="),
  );
  const scale =
    scaleArgument === undefined ? 1 : (
      parseScale(scaleArgument.slice("--scale=".length))
    );

  return {
    runChecks,
    backend,
    scale,
  };
}
