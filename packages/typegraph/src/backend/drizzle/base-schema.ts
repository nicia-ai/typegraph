import { BaseSchemaMigrationError, CompilerInvariantError } from "../../errors";

/**
 * Immutable release ledger for TypeGraph-owned physical storage.
 *
 * A new base-table shape replaces neither an older entry nor its digests: add
 * the next version here and add the corresponding adoption step to every
 * bundled backend. The ordered-shape ratchet tests compare the latest entry
 * with generated base DDL, while the lifecycle refuses a backend whose step
 * registry does not reach the same version.
 */
export const BASE_SCHEMA_RELEASES = [
  {
    version: 1,
    id: "versioned-base-storage",
    orderedShapeDigests: {
      postgres:
        "b8f25c291cc75a36102ba7160c25923926f263f61ed1d3d05619708936d0246f",
      sqlite:
        "68363b5bf1c91c5f3e7528ebd255b542a1cd26677a01c7b2271e100e08a1e354",
    },
  },
  {
    version: 2,
    id: "fence-rows",
    orderedShapeDigests: {
      postgres:
        "6ceed53669691b9eb8974d0ef371dd86cab3cb33d187a328b3dd3d905776b024",
      sqlite:
        "1b7ef8370ac366e48d1517a5eb98a3d4d6a1c71c2d8e74e77bd78367af0cc042",
    },
  },
  {
    version: 3,
    id: "lineage-since-index",
    orderedShapeDigests: {
      postgres:
        "3566f85b41ee4139e580fb6964ef6258ba9fa1d3756dcc42b47a5235690d6375",
      sqlite:
        "4bd7e6a5caeb3b5e54933b26f6697e53fc7a9aa916c0606c77006fdc93080981",
    },
  },
  {
    version: 4,
    id: "identity-transition-log",
    orderedShapeDigests: {
      postgres:
        "6c794e185d6720b9144eab10d0186216126378f72cb679e5fdad4da5aadedc42",
      sqlite:
        "b41b614e5d8fc9d16d007422f0ed4db69066fe7faff3874b3083ca443b1b58cd",
    },
  },
  {
    version: 5,
    id: "identity-transitions-restored-at",
    orderedShapeDigests: {
      postgres:
        "eaf5ac6f9a8e07073395774c72bf618c557b62f77a523a575ecff60ae9cf2fd7",
      sqlite:
        "04ceef5d851f2a2ef4176490625cd7b1f6bda458fbf9312a1979e81cd196475a",
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

type BaseSchemaBootstrapStrategy =
  | Readonly<{ phase: "covered-by-generated-ddl" }>
  | Readonly<{ phase: "before"; adopt(): Promise<void> }>
  | Readonly<{ phase: "after"; adopt(): Promise<void> }>;

type BaseSchemaStep = Readonly<{
  version: number;
  /** Steps may be retried or raced by concurrent adopters and must be idempotent. */
  adopt(): Promise<void>;
  bootstrap: BaseSchemaBootstrapStrategy;
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
 * per database, regardless of how many graph documents it stores. Every
 * not-yet-adopted step runs, in order, publishing the marker after each step
 * (see `runSteps`) — a step that throws aborts before that step's write, so a
 * failed upgrade is retried from the last durably stamped version rather
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

  /**
   * Runs every not-yet-adopted step's `adoptStep` in order, publishing the
   * marker after each one. A step whose `adoptStep` throws aborts before its
   * marker write, so a retry re-adopts from the last durably published
   * version, including the step that threw. Publishing after every step
   * (rather than once at the end) lets a concurrent adopter's observed
   * version short-circuit the remaining steps: once `writeVersion` reports a
   * version another process already published, every later step in this
   * call is superseded and skipped — a process on an older release must
   * never keep applying steps against a database a newer release already
   * brought current.
   */
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
    // Generated DDL owns explicitly covered steps. Before/after strategies own
    // only upgrades that CREATE TABLE cannot apply to a pre-existing relation.
    const state = classifyVersion(startingVersion, currentVersion);
    if (state === "current") return;
    if (state === "newer") {
      throw migrationError(startingVersion, currentVersion, state);
    }
    await runSteps(startingVersion ?? 0, async (step) => {
      if (step.bootstrap.phase === "after") await step.bootstrap.adopt();
    });
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
      if (step.bootstrap.phase === "before") await step.bootstrap.adopt();
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
