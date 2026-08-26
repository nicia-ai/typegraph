import { BaseSchemaMigrationError, CompilerInvariantError } from "../../errors";

const CURRENT_BASE_SCHEMA_VERSION = 1;

export type BaseSchemaLifecycle = Readonly<{
  adopt(): Promise<void>;
  /** Read and refuse a newer marker before bootstrap emits any DDL. */
  prepareBootstrap(): Promise<number | undefined>;
  /** Complete adoption after the adapter's full current-schema DDL ran. */
  adoptAfterBootstrap(startingVersion: number | undefined): Promise<void>;
  assertCurrent(): Promise<void>;
}>;

type BaseSchemaStep = Readonly<{
  version: number;
  adopt(): Promise<void>;
  adoptAfterBootstrap?(): Promise<void>;
}>;

type BaseSchemaLifecycleOptions = Readonly<{
  readVersion(): Promise<number | undefined>;
  ensureVersionTable(): Promise<void>;
  /** Monotonically stamp `version`; false means a newer marker won the race. */
  writeVersion(version: number): Promise<boolean>;
  steps: readonly BaseSchemaStep[];
}>;

function classifyVersion(
  installedVersion: number | undefined,
): "current" | "missing" | "newer" | "stale" {
  if (installedVersion === undefined) return "missing";
  if (installedVersion === CURRENT_BASE_SCHEMA_VERSION) return "current";
  if (installedVersion > CURRENT_BASE_SCHEMA_VERSION) return "newer";
  return "stale";
}

function migrationError(
  installedVersion: number | undefined,
): BaseSchemaMigrationError {
  const state = classifyVersion(installedVersion);
  return new BaseSchemaMigrationError({
    installedVersion,
    requiredVersion: CURRENT_BASE_SCHEMA_VERSION,
    reason: state === "current" ? "stale" : state,
  });
}

/**
 * One owner for deployment-wide physical schema adoption.
 *
 * The ordered registry is deliberately separate from per-graph schema
 * versions: a base relation added by a library release must be adopted once
 * per database, regardless of how many graph documents it stores. Each step
 * is stamped only after it succeeds, so a failed upgrade is retried rather
 * than published as current.
 */
export function createBaseSchemaLifecycle(
  options: BaseSchemaLifecycleOptions,
): BaseSchemaLifecycle {
  const steps = options.steps.toSorted(
    (left, right) => left.version - right.version,
  );
  for (const [index, step] of steps.entries()) {
    if (step.version !== index + 1) {
      throw new CompilerInvariantError(
        "Base schema adoption steps must be contiguous and start at version 1.",
        { expectedVersion: index + 1, actualVersion: step.version },
      );
    }
  }
  if (steps.length !== CURRENT_BASE_SCHEMA_VERSION) {
    throw new CompilerInvariantError(
      "The base schema adoption registry must end at CURRENT_BASE_SCHEMA_VERSION.",
      {
        currentVersion: CURRENT_BASE_SCHEMA_VERSION,
        registeredSteps: steps.length,
      },
    );
  }

  async function assertCurrent(): Promise<void> {
    const installedVersion = await options.readVersion();
    if (classifyVersion(installedVersion) === "current") return;
    throw migrationError(installedVersion);
  }

  async function writeVersion(version: number): Promise<void> {
    if (await options.writeVersion(version)) return;
    throw migrationError(await options.readVersion());
  }

  async function adopt(): Promise<void> {
    const installedVersion = await options.readVersion();
    const state = classifyVersion(installedVersion);
    if (state === "current") return;
    if (state === "newer") throw migrationError(installedVersion);

    if (installedVersion === undefined) await options.ensureVersionTable();
    const startingVersion = installedVersion ?? 0;
    for (const step of steps) {
      if (step.version <= startingVersion) continue;
      await step.adopt();
      await writeVersion(step.version);
    }
  }

  async function prepareBootstrap(): Promise<number | undefined> {
    const installedVersion = await options.readVersion();
    if (classifyVersion(installedVersion) === "newer") {
      throw migrationError(installedVersion);
    }
    return installedVersion;
  }

  async function adoptAfterBootstrap(
    startingVersion: number | undefined,
  ): Promise<void> {
    // Full generated DDL already created every current base relation. A step's
    // bootstrap hook therefore owns only upgrades CREATE TABLE cannot apply to
    // a pre-existing relation, avoiding duplicate cold-start CREATEs.
    const state = classifyVersion(startingVersion);
    if (state === "current") return;
    if (state === "newer") throw migrationError(startingVersion);

    const completedVersion = startingVersion ?? 0;
    for (const step of steps) {
      if (step.version <= completedVersion) continue;
      await (step.adoptAfterBootstrap ?? step.adopt)();
      await writeVersion(step.version);
    }
  }

  return { adopt, prepareBootstrap, adoptAfterBootstrap, assertCurrent };
}
