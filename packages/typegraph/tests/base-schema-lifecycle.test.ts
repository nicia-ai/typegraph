import { describe, expect, it, vi } from "vitest";

import { BaseSchemaMigrationError, CompilerInvariantError } from "../src";
import { createBaseSchemaLifecycle } from "../src/backend/drizzle/base-schema";

function migrationReason(error: unknown): string | undefined {
  return error instanceof BaseSchemaMigrationError ?
      error.details.reason
    : undefined;
}

function resolvedVoid(): Promise<void> {
  return Promise.resolve();
}

describe("base schema lifecycle state machine", () => {
  it.each([0, 1.5])("refuses invalid current version %s", (currentVersion) => {
    expect(() =>
      createBaseSchemaLifecycle({
        currentVersion,
        readVersion: () => Promise.resolve(0),
        ensureVersionTable: resolvedVoid,
        writeVersion: (version) => Promise.resolve(version),
        steps: [],
      }),
    ).toThrow(CompilerInvariantError);
  });

  it("requires one contiguous adoption step per version", () => {
    expect(() =>
      createBaseSchemaLifecycle({
        currentVersion: 3,
        readVersion: () => Promise.resolve(0),
        ensureVersionTable: resolvedVoid,
        writeVersion: (version) => Promise.resolve(version),
        steps: [
          { version: 1, adopt: resolvedVoid },
          { version: 3, adopt: resolvedVoid },
        ],
      }),
    ).toThrow(CompilerInvariantError);
  });

  it("requires the adoption registry to reach the current version", () => {
    expect(() =>
      createBaseSchemaLifecycle({
        currentVersion: 2,
        readVersion: () => Promise.resolve(0),
        ensureVersionTable: resolvedVoid,
        writeVersion: (version) => Promise.resolve(version),
        steps: [{ version: 1, adopt: resolvedVoid }],
      }),
    ).toThrow(CompilerInvariantError);
  });

  it.each([
    [undefined, "missing"],
    [1, "stale"],
    [4, "newer"],
  ] as const)("assertCurrent classifies %s as %s", async (version, reason) => {
    const lifecycle = createBaseSchemaLifecycle({
      currentVersion: 3,
      readVersion: () => Promise.resolve(version),
      ensureVersionTable: resolvedVoid,
      writeVersion: (writtenVersion) => Promise.resolve(writtenVersion),
      steps: [1, 2, 3].map((stepVersion) => ({
        version: stepVersion,
        adopt: resolvedVoid,
      })),
    });

    await expect(lifecycle.assertCurrent()).rejects.toSatisfy(
      (error: unknown) => migrationReason(error) === reason,
    );
  });

  it("runs every missing step in order and publishes each completed version", async () => {
    let installedVersion = 0;
    const adopted: number[] = [];
    const published: number[] = [];
    const lifecycle = createBaseSchemaLifecycle({
      currentVersion: 3,
      readVersion: () => Promise.resolve(installedVersion),
      ensureVersionTable: resolvedVoid,
      writeVersion: (version) => {
        published.push(version);
        installedVersion = version;
        return Promise.resolve(installedVersion);
      },
      steps: [1, 2, 3].map((version) => ({
        version,
        adopt: () => {
          adopted.push(version);
          return Promise.resolve();
        },
      })),
    });

    await lifecycle.adopt();

    expect(adopted).toEqual([1, 2, 3]);
    expect(published).toEqual([1, 2, 3]);
  });

  it("accepts a concurrent adopter that reaches this release and skips superseded work", async () => {
    const adopted: number[] = [];
    const lifecycle = createBaseSchemaLifecycle({
      currentVersion: 3,
      readVersion: () => Promise.resolve(0),
      ensureVersionTable: resolvedVoid,
      writeVersion: () => Promise.resolve(3),
      steps: [1, 2, 3].map((version) => ({
        version,
        adopt: () => {
          adopted.push(version);
          return Promise.resolve();
        },
      })),
    });

    await lifecycle.adopt();

    expect(adopted).toEqual([1]);
  });

  it("refuses a concurrent adopter from a newer release without a diagnostic reread", async () => {
    const readVersion = vi.fn(() => Promise.resolve(0));
    const lifecycle = createBaseSchemaLifecycle({
      currentVersion: 3,
      readVersion,
      ensureVersionTable: resolvedVoid,
      writeVersion: () => Promise.resolve(4),
      steps: [1, 2, 3].map((version) => ({
        version,
        adopt: resolvedVoid,
      })),
    });

    await expect(lifecycle.adopt()).rejects.toSatisfy(
      (error: unknown) => migrationReason(error) === "newer",
    );
    expect(readVersion).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, "missing"],
    [0, "stale"],
  ] as const)(
    "refuses a step publication that observes %s as %s",
    async (observedVersion, reason) => {
      const lifecycle = createBaseSchemaLifecycle({
        currentVersion: 1,
        readVersion: () => Promise.resolve(0),
        ensureVersionTable: resolvedVoid,
        writeVersion: () => Promise.resolve(observedVersion),
        steps: [{ version: 1, adopt: resolvedVoid }],
      });

      await expect(lifecycle.adopt()).rejects.toSatisfy(
        (error: unknown) => migrationReason(error) === reason,
      );
    },
  );

  it("uses bootstrap-specific adoption while preserving the final-version gate", async () => {
    const beforeBootstrapAdopt = vi.fn(resolvedVoid);
    const regularAdopt = vi.fn(resolvedVoid);
    const bootstrapAdopt = vi.fn(resolvedVoid);
    const lifecycle = createBaseSchemaLifecycle({
      currentVersion: 2,
      readVersion: () => Promise.resolve(0),
      ensureVersionTable: resolvedVoid,
      writeVersion: (version) => Promise.resolve(version),
      steps: [
        {
          version: 1,
          adopt: regularAdopt,
          adoptBeforeBootstrap: beforeBootstrapAdopt,
          adoptAfterBootstrap: bootstrapAdopt,
        },
        {
          version: 2,
          adopt: regularAdopt,
          adoptBeforeBootstrap: beforeBootstrapAdopt,
          adoptAfterBootstrap: bootstrapAdopt,
        },
      ],
    });

    await lifecycle.adoptBeforeBootstrap(0);
    await lifecycle.adoptAfterBootstrap(0);

    expect(regularAdopt).not.toHaveBeenCalled();
    expect(beforeBootstrapAdopt).toHaveBeenCalledTimes(2);
    expect(bootstrapAdopt).toHaveBeenCalledTimes(2);
  });
});
