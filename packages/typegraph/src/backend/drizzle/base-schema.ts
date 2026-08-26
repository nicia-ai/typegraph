import { BaseSchemaMigrationError, CompilerInvariantError } from "../../errors";

/**
 * Immutable release ledger for TypeGraph-owned physical storage.
 *
 * A new base-table shape replaces neither an older entry nor its digests: add
 * the next version here and add the corresponding adoption step to every
 * bundled backend. The shape ratchet tests compare the latest entry with the
 * generated base DDL, while the lifecycle refuses a backend whose step
 * registry does not reach the same version.
 */
export const BASE_SCHEMA_RELEASES = [
  {
    version: 1,
    id: "versioned-base-storage",
    shapeDigests: {
      postgres:
        "c9c81dcb1e7b8a1a8ccf43fe48aebb9677d211b734be0d24a94ecb3b148ebd60",
      sqlite:
        "0f5a64c5efd432fad2b93bb13353d20e37d57a845bacfb28c8cc604e1ae99b6f",
    },
  },
] as const;

function currentBaseSchemaVersion(): number {
  const release = BASE_SCHEMA_RELEASES.at(-1);
  if (release === undefined) {
    throw new CompilerInvariantError(
      "The base schema release ledger must not be empty.",
    );
  }
  return release.version;
}

export const CURRENT_BASE_SCHEMA_VERSION = currentBaseSchemaVersion();

export type BaseSchemaLifecycle = Readonly<{
  adopt(): Promise<void>;
  /** Read and refuse a newer marker before bootstrap emits any DDL. */
  prepareBootstrap(): Promise<number | undefined>;
  /** Repair existing relations before bootstrap creates dependent indexes. */
  adoptBeforeBootstrap(startingVersion: number | undefined): Promise<void>;
  /** Complete adoption after the adapter's full current-schema DDL ran. */
  adoptAfterBootstrap(startingVersion: number | undefined): Promise<void>;
  assertCurrent(): Promise<void>;
}>;

type BaseSchemaStep = Readonly<{
  version: number;
  adopt(): Promise<void>;
  adoptBeforeBootstrap?(): Promise<void>;
  adoptAfterBootstrap?(): Promise<void>;
}>;

type BaseSchemaLifecycleOptions = Readonly<{
  /** Override only for isolated state-machine tests. Bundled backends omit it. */
  currentVersion?: number;
  readVersion(): Promise<number | undefined>;
  ensureVersionTable(): Promise<void>;
  /** Monotonically stamp `version` and return the version observed afterward. */
  writeVersion(version: number): Promise<number | undefined>;
  steps: readonly BaseSchemaStep[];
}>;

function classifyVersion(
  installedVersion: number | undefined,
  currentVersion: number,
): "current" | "missing" | "newer" | "stale" {
  if (installedVersion === undefined) return "missing";
  if (installedVersion === currentVersion) return "current";
  if (installedVersion > currentVersion) return "newer";
  return "stale";
}

function migrationError(
  installedVersion: number | undefined,
  requiredVersion: number,
  reason: "missing" | "newer" | "stale",
): BaseSchemaMigrationError {
  return new BaseSchemaMigrationError({
    installedVersion,
    requiredVersion,
    reason,
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
  const currentVersion = options.currentVersion ?? CURRENT_BASE_SCHEMA_VERSION;
  if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
    throw new CompilerInvariantError(
      "The current base schema version must be a positive safe integer.",
      { currentVersion },
    );
  }
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
  if (steps.length !== currentVersion) {
    throw new CompilerInvariantError(
      "The base schema adoption registry must end at the current version.",
      {
        currentVersion,
        registeredSteps: steps.length,
      },
    );
  }

  function requireCurrent(installedVersion: number | undefined): void {
    const state = classifyVersion(installedVersion, currentVersion);
    if (state === "current") return;
    throw migrationError(installedVersion, currentVersion, state);
  }

  async function assertCurrent(): Promise<void> {
    requireCurrent(await options.readVersion());
  }

  async function writeVersion(version: number): Promise<number> {
    const observedVersion = await options.writeVersion(version);
    if (observedVersion === undefined) {
      throw migrationError(observedVersion, currentVersion, "missing");
    }
    if (observedVersion < version) {
      throw migrationError(observedVersion, currentVersion, "stale");
    }
    return observedVersion;
  }

  async function runSteps(
    startingVersion: number,
    adoptStep: (step: BaseSchemaStep) => Promise<void>,
  ): Promise<void> {
    let observedVersion = startingVersion;
    for (const step of steps) {
      if (step.version <= observedVersion) continue;
      await adoptStep(step);
      observedVersion = await writeVersion(step.version);
    }
    requireCurrent(observedVersion);
  }

  async function adopt(): Promise<void> {
    const installedVersion = await options.readVersion();
    const state = classifyVersion(installedVersion, currentVersion);
    if (state === "current") return;
    if (state === "newer") {
      throw migrationError(installedVersion, currentVersion, state);
    }

    if (installedVersion === undefined) await options.ensureVersionTable();
    await runSteps(installedVersion ?? 0, async (step) => step.adopt());
  }

  async function prepareBootstrap(): Promise<number | undefined> {
    const installedVersion = await options.readVersion();
    const state = classifyVersion(installedVersion, currentVersion);
    if (state === "newer") {
      throw migrationError(installedVersion, currentVersion, state);
    }
    return installedVersion;
  }

  async function adoptAfterBootstrap(
    startingVersion: number | undefined,
  ): Promise<void> {
    // Full generated DDL already created every current base relation. A step's
    // bootstrap hook therefore owns only upgrades CREATE TABLE cannot apply to
    // a pre-existing relation, avoiding duplicate cold-start CREATEs.
    const state = classifyVersion(startingVersion, currentVersion);
    if (state === "current") return;
    if (state === "newer") {
      throw migrationError(startingVersion, currentVersion, state);
    }
    await runSteps(startingVersion ?? 0, (step) =>
      step.adoptAfterBootstrap?.() ?? Promise.resolve(),
    );
  }

  async function adoptBeforeBootstrap(
    startingVersion: number | undefined = 0,
  ): Promise<void> {
    const state = classifyVersion(startingVersion, currentVersion);
    if (state === "newer") {
      throw migrationError(startingVersion, currentVersion, state);
    }
    for (const step of steps) {
      if (step.version <= startingVersion) continue;
      await step.adoptBeforeBootstrap?.();
    }
  }

  return {
    adopt,
    prepareBootstrap,
    adoptBeforeBootstrap,
    adoptAfterBootstrap,
    assertCurrent,
  };
}
