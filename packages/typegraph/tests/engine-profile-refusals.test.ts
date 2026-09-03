/**
 * `createSqlBackend`'s three refusals (`src/backend/drizzle/engine/create-sql-backend.ts`):
 * the checks that make marking a profile-built backend sound for a profile
 * this factory did not write itself, not only for the two bundled ones.
 *
 * Every profile here starts from a real `buildSqliteEngineProfile` result —
 * built against an in-memory better-sqlite3 database exactly like
 * `createSqliteBackend` builds one — with a single field replaced by a
 * plain object literal. Per the construction ratchet (AGENTS.md), nothing
 * here spreads a backend or a call whose name ends in "Backend"; a profile
 * is not a backend, so spreading `buildSqliteEngineProfile(...)`'s result is
 * the sanctioned way to build a variant.
 */
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { isBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import { isSchemaFencedInsertEligible } from "../src/backend/capabilities/schema-fenced-insert";
import {
  isFirstPartyFactory,
  pessimisticLockDeclarationLine,
  resolveWriteFencePlan,
} from "../src/backend/capabilities/write-fence";
import { createSqlBackend } from "../src/backend/drizzle/engine";
import type { SqlEngineProfile } from "../src/backend/drizzle/engine/profile";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import { ConfigurationError } from "../src/errors";
import { assertRecordedCaptureTransactionIsolation } from "../src/store/recorded-capture/guards";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createRealSqliteProfile(): SqlEngineProfile<AnySqliteDatabase> {
  const sqlite = new RealDatabase(":memory:");
  cleanups.push(() => {
    sqlite.close();
  });
  return buildSqliteEngineProfile(drizzleSqlite(sqlite), {
    executionProfile: { isSync: true },
  });
}

describe("createSqlBackend refusals", () => {
  it("refuses a profile whose resolved capabilities omit pessimisticLocks", () => {
    const base = createRealSqliteProfile();
    const profile = {
      ...base,
      declaredCapabilities: {
        ...base.declaredCapabilities,
        pessimisticLocks: undefined,
      },
    };

    let thrown: unknown;
    try {
      createSqlBackend(profile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "ENGINE_PROFILE_REQUIRES_WRITE_FENCE_DECLARATION",
    );
    expect(configurationError.message).toContain(
      pessimisticLockDeclarationLine("sqlite"),
    );
  });

  it("marks isBundledRootAutocommitEligible only when the profile declares singleStatementDurable", () => {
    const base = createRealSqliteProfile();
    const profile = {
      ...base,
      autocommit: { singleStatementDurable: false },
    };

    const backend = createSqlBackend(profile);

    expect(isBundledRootAutocommitEligible(backend)).toBe(false);
    // Everything else this factory marks is unaffected by this gate.
    expect(isFirstPartyFactory(backend)).toBe(true);
    expect(isSchemaFencedInsertEligible(backend)).toBe(true);
  });

  it("refuses a profile that declares advisoryLocks: true but supplies no fenceSql", () => {
    const base = createRealSqliteProfile();
    const profile = {
      ...base,
      declaredCapabilities: {
        ...base.declaredCapabilities,
        pessimisticLocks: {
          advisoryLocks: true,
          tableLocks: true,
          serializedWriters: false,
        },
      },
    };
    // `base.fenceTarget` (the real SQLite profile's) carries no `fenceSql` —
    // exactly the shape a lock declaration without a spelling refuses.

    let thrown: unknown;
    try {
      createSqlBackend(profile);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "WRITE_FENCE_SQL_UNAVAILABLE",
    );
  });

  it("marks isSchemaFencedInsertEligible only when the resolved fence plan is not unfenced", () => {
    const base = createRealSqliteProfile();
    const profile = {
      ...base,
      declaredCapabilities: {
        ...base.declaredCapabilities,
        pessimisticLocks: {
          advisoryLocks: false,
          tableLocks: false,
          serializedWriters: false,
        },
      },
    };

    const backend = createSqlBackend(profile);

    expect(isSchemaFencedInsertEligible(backend)).toBe(false);
    // The refusal above already required a declared value, so this profile
    // still constructs, and the other two marks are unaffected by this gate.
    expect(isFirstPartyFactory(backend)).toBe(true);
    expect(isBundledRootAutocommitEligible(backend)).toBe(true);
  });
});

describe("resolveWriteFencePlan refusals", () => {
  it("refuses a postgres-dialect target that declares advisoryLocks: true but supplies no fenceSql, naming postgresFenceSql", () => {
    const base = createRealSqliteProfile();

    let thrown: unknown;
    try {
      resolveWriteFencePlan({
        dialect: "postgres",
        capabilities: {
          ...base.declaredCapabilities,
          pessimisticLocks: {
            advisoryLocks: true,
            tableLocks: true,
            serializedWriters: false,
          },
        },
        // No `fenceSql` — the exact shape a lock declaration without a
        // spelling refuses, reached this time through `resolveWriteFencePlan`
        // directly rather than through `createSqlBackend`'s construction-time
        // gate above.
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "WRITE_FENCE_SQL_UNAVAILABLE",
    );
    expect(configurationError.suggestion).toContain("postgresFenceSql");
  });
});

describe("assertRecordedCaptureTransactionIsolation refusals", () => {
  it("refuses a postgres-dialect target with no fenceSql via the session-fact refusal, not the lock refusal", async () => {
    // This target declares NO `pessimisticLocks` at all — the exact
    // extensibility case (a custom backend with `serializedWriters: true`
    // and no advisory locks) the lock-plan refusal's message would
    // misdescribe by claiming `advisoryLocks: true`.
    const target = {
      dialect: "postgres" as const,
      fenceSql: undefined,
      execute: () => Promise.reject(new Error("must not be called")),
    };

    let thrown: unknown;
    try {
      await assertRecordedCaptureTransactionIsolation(target);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "WRITE_FENCE_SQL_UNAVAILABLE",
    );
    expect(configurationError.message).not.toContain("advisoryLocks: true");
    expect(configurationError.message).toContain("fenceSql");
    expect(configurationError.suggestion).toContain("postgresFenceSql");
  });
});
