import {
  type PerfBackend,
  type PerfCliOptions,
  type PostgresDriver,
} from "./config";

function parseBackend(rawBackend: string): PerfBackend {
  if (rawBackend === "sqlite" || rawBackend === "postgres") {
    return rawBackend;
  }

  throw new Error(
    `Unsupported backend: "${rawBackend}". Expected "sqlite" or "postgres".`,
  );
}

function parsePostgresDriver(raw: string): PostgresDriver {
  if (raw === "pg" || raw === "postgres-js") {
    return raw;
  }

  throw new Error(
    `Unsupported --postgres-driver value: "${raw}". Expected "pg" or "postgres-js".`,
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

  const driverArgument = argv.find((argument) =>
    argument.startsWith("--postgres-driver="),
  );
  const postgresDriver: PostgresDriver =
    driverArgument === undefined ? "pg" : (
      parsePostgresDriver(driverArgument.slice("--postgres-driver=".length))
    );

  return {
    runChecks,
    backend,
    postgresDriver,
    scale,
  };
}
