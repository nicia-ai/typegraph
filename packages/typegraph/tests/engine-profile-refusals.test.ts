/**
 * `createSqlBackend`'s refusals and derived-capability coherence
 * (`src/backend/drizzle/engine/create-sql-backend.ts`): the checks that make
 * marking a profile-built backend sound for a profile this factory did not
 * write itself, and the proof that copying a bundled profile with one field
 * overridden is a coherent way to build a variant — because `createSqlBackend`
 * is the single place capabilities, the write-fence plan, and the
 * first-party mark are all derived. Nothing downstream holds a second copy
 * that an override could leave stale, and nothing outside the two bundled
 * builders can mint the token that grants first-party standing.
 *
 * Every profile here starts from a real `buildSqliteEngineProfile` or
 * `buildPostgresEngineProfile` result — built against a real database
 * connection exactly like the corresponding bundled factory builds one —
 * with a single field replaced by a plain object literal. Per the
 * construction ratchet (AGENTS.md), nothing here spreads a backend or a call
 * whose name ends in "Backend"; a profile is not a backend, so spreading a
 * profile-builder result is the sanctioned way to build a variant.
 */
import { PGlite } from "@electric-sql/pglite";
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
import { requireCatalog } from "../src/backend/capabilities/catalog";
import { isSchemaFencedInsertEligible } from "../src/backend/capabilities/schema-fenced-insert";
import {
  isFirstPartyFactory,
  pessimisticLockDeclarationLine,
  resolveWriteFencePlan,
} from "../src/backend/capabilities/write-fence";
import { createSqlBackend } from "../src/backend/drizzle/engine";
import { finalizeEngineCapabilities } from "../src/backend/drizzle/engine/capabilities";
import type { SqlEngineProfile } from "../src/backend/drizzle/engine/profile";
import type { AnyPgTransaction } from "../src/backend/drizzle/execution/postgres-execution";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import type { InternalOperationBackend } from "../src/backend/drizzle/operation-backend-core";
import { buildPostgresEngineProfile } from "../src/backend/drizzle/postgres";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import { ConfigurationError } from "../src/errors";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { buildVectorCapabilities } from "../src/query/dialect/vector-strategy";
import { assertRecordedCaptureTransactionIsolation } from "../src/store/recorded-capture/guards";
import { requireDefined } from "../src/utils/presence";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
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

async function createRealPostgresProfile(): Promise<
  SqlEngineProfile<AnyPgTransaction>
> {
  const client = await PGlite.create();
  cleanups.push(() => client.close());
  return buildPostgresEngineProfile(drizzlePg(client), { vector: false });
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

  it("resolves the same unfenced plan and schema-fenced-insert eligibility on the root and on a transaction() handle it opens", async () => {
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

    expect(resolveWriteFencePlan(backend).kind).toBe("unfenced");
    expect(isSchemaFencedInsertEligible(backend)).toBe(false);

    await backend.transaction((tx) => {
      expect(resolveWriteFencePlan(tx).kind).toBe("unfenced");
      expect(isSchemaFencedInsertEligible(tx)).toBe(false);
      return Promise.resolve();
    });
  });

  it("reports isFirstPartyFactory true for both bundled roots, and false for a copy of each with no firstParty token — including on a transaction() handle each backend opens", async () => {
    const sqliteProfile = createRealSqliteProfile();
    const postgresProfile = await createRealPostgresProfile();

    const sqliteBackend = createSqlBackend(sqliteProfile);
    const postgresBackend = createSqlBackend(postgresProfile);
    expect(isFirstPartyFactory(sqliteBackend)).toBe(true);
    expect(isFirstPartyFactory(postgresBackend)).toBe(true);
    // Pinned again here, on top of `engine-profile-parity.test.ts`'s own
    // pin, because this test is what proves the CONTRAST with the
    // no-token copy below.
    await sqliteBackend.transaction((tx) => {
      expect(isFirstPartyFactory(tx)).toBe(true);
      return Promise.resolve();
    });
    await postgresBackend.transaction((tx) => {
      expect(isFirstPartyFactory(tx)).toBe(true);
      return Promise.resolve();
    });

    // The destructured `firstParty` bindings are deliberately unused
    // (`ignoreRestSiblings`): what matters is that each rest object carries
    // every OTHER field forward unchanged, with the token gone.
    const { firstParty: _sqliteToken, ...sqliteWithoutToken } = sqliteProfile;
    const { firstParty: _postgresToken, ...postgresWithoutToken } =
      postgresProfile;

    const sqliteBackendWithoutToken = createSqlBackend(sqliteWithoutToken);
    const postgresBackendWithoutToken = createSqlBackend(postgresWithoutToken);
    expect(isFirstPartyFactory(sqliteBackendWithoutToken)).toBe(false);
    expect(isFirstPartyFactory(postgresBackendWithoutToken)).toBe(false);

    // The root/handle disagreement this token exists to remove: a
    // transaction() handle opened on a profile this factory did not mint a
    // token for must NOT carry the mark either, even though
    // `createTransactionBackend` used to apply it unconditionally
    // regardless of the root's own standing.
    await sqliteBackendWithoutToken.transaction((tx) => {
      expect(isFirstPartyFactory(tx)).toBe(false);
      return Promise.resolve();
    });
    await postgresBackendWithoutToken.transaction((tx) => {
      expect(isFirstPartyFactory(tx)).toBe(false);
      return Promise.resolve();
    });
  });

  it("never marks an adopted transaction first-party, even on a bundled root", async () => {
    // adoptTransaction stays unmarked regardless of the profile's own
    // first-party standing: an adopted transaction's lifetime is the
    // caller's, not one TypeGraph has audited, so it must not qualify for
    // the dialect-derivation fallback or the lazy schema-fence lease
    // first-party standing grants.
    const sqliteBackend = createSqlBackend(createRealSqliteProfile());
    expect(isFirstPartyFactory(sqliteBackend)).toBe(true);
    await sqliteBackend.transactionWithNative((_tx, nativeTx) => {
      const adopted = sqliteBackend.adoptTransaction(nativeTx);
      expect(isFirstPartyFactory(adopted)).toBe(false);
      return Promise.resolve();
    });

    const postgresBackend = createSqlBackend(await createRealPostgresProfile());
    expect(isFirstPartyFactory(postgresBackend)).toBe(true);
    await postgresBackend.transactionWithNative((_tx, nativeTx) => {
      const adopted = postgresBackend.adoptTransaction(nativeTx);
      expect(isFirstPartyFactory(adopted)).toBe(false);
      return Promise.resolve();
    });
  });

  it("derives capabilities.vector from profile.vector rather than a stale declaredCapabilities value, with no vector members when the strategy is absent", () => {
    const base = createRealSqliteProfile();
    const profile = {
      ...base,
      vector: undefined,
      declaredCapabilities: {
        ...base.declaredCapabilities,
        // A leftover a dialect builder wrongly baked in, or a caller
        // otherwise smuggled through `declaredCapabilities` directly, must
        // not survive the tail derivation: it reads `profile.vector` fresh
        // instead of trusting whatever `declaredCapabilities` already says.
        vector: buildVectorCapabilities(sqliteVecStrategy),
      },
    };

    const backend = createSqlBackend(profile);

    expect(backend.capabilities.vector).toBeUndefined();
    expect(backend.upsertEmbedding).toBeUndefined();
    expect(backend.vectorSearch).toBeUndefined();
    expect(backend.deleteEmbedding).toBeUndefined();
  });

  it("keeps a caller's declared vector/fulltext capabilities when the profile's strategy IS present, rather than overwriting them with the strategy-derived default", () => {
    // Distinct from the stale-value test above: there `profile.vector` is
    // `undefined`, so the override is dropped because the strategy is
    // absent. Here the strategy IS present, going through
    // `buildSqliteEngineProfile`'s own `options.capabilities` factory option
    // exactly as `createSqliteBackend` callers set it — a value that must be
    // applied, not silently replaced by the default the strategy would
    // otherwise derive.
    const overriddenVector = {
      ...buildVectorCapabilities(sqliteVecStrategy),
      maxDimensions: 4096,
    };
    const overriddenFulltext = {
      supported: true,
      languages: ["klingon"],
      phraseQueries: false,
      prefixQueries: false,
      highlighting: false,
    };
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
    });
    const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
      vector: sqliteVecStrategy,
      capabilities: {
        vector: overriddenVector,
        fulltext: overriddenFulltext,
      },
    });

    const backend = createSqlBackend(profile);

    expect(backend.capabilities.vector).toEqual(overriddenVector);
    expect(backend.capabilities.fulltext).toEqual(overriddenFulltext);
  });
});

describe("finalizeEngineCapabilities", () => {
  it("omits capabilities.fulltext and reduces contributions.rebuild to the fence condition when the profile supplies no fulltext strategy", () => {
    // A profile built with `fulltext: false` reaches this arm: with no
    // fulltext contribution to tear down, the rebuild answer is the
    // transactional-fence condition alone.
    const base = createRealSqliteProfile();

    const capabilities = finalizeEngineCapabilities(base.declaredCapabilities, {
      execution: base.execution,
      vectorStrategy: undefined,
      fulltextStrategy: undefined,
      fulltextTableName: base.tableNames.fulltext,
    });

    expect(capabilities.fulltext).toBeUndefined();
    expect(capabilities.vector).toBeUndefined();
    expect(capabilities.contributions?.rebuild).toBe(
      base.declaredCapabilities.execution.interactiveTransactions,
    );
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

describe("requireCatalog refusals", () => {
  it("refuses a backend with no catalog member, naming both catalog and the caller's operation", () => {
    const backendWithNoCatalog = { catalog: undefined };

    let thrown: unknown;
    try {
      requireCatalog(backendWithNoCatalog, "index materialization");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe("CATALOG_UNAVAILABLE");
    expect(configurationError.message).toContain("catalog");
    expect(configurationError.message).toContain("index materialization");
  });

  it("returns the backend's own catalog probes, on the root and on a transaction() handle it opens, when present", async () => {
    const sqliteBackend = createSqlBackend(createRealSqliteProfile());
    expect(requireCatalog(sqliteBackend, "test")).toBe(sqliteBackend.catalog);
    await sqliteBackend.transaction((tx) => {
      expect(requireCatalog(tx, "test")).toBe(tx.catalog);
      return Promise.resolve();
    });

    const postgresBackend = createSqlBackend(await createRealPostgresProfile());
    expect(requireCatalog(postgresBackend, "test")).toBe(
      postgresBackend.catalog,
    );
    await postgresBackend.transaction((tx) => {
      expect(requireCatalog(tx, "test")).toBe(tx.catalog);
      return Promise.resolve();
    });
  });

  it("root backend.catalog is the SAME object EngineProvisioning.catalog built — buildOperations does not build a second one", async () => {
    // Asserting on the ASSEMBLED backend's `catalog` alone would not catch a
    // regression here: `createSqlBackend` always sets the root's exposed
    // `catalog` from `profile.provisioning.catalog` regardless of what
    // `buildOperations` returns, so a `buildOperations` that built its OWN,
    // different bag would still leave `backend.catalog` looking correct.
    // Spying on `buildOperations` itself catches exactly that — the bag it
    // actually returned, before `createSqlBackend` overwrites `catalog` on
    // the final object.
    const sqliteProfile = createRealSqliteProfile();
    const sqliteBuildOperations = vi.spyOn(sqliteProfile, "buildOperations");
    createSqlBackend(sqliteProfile);
    const sqliteOperations = requireDefined(
      sqliteBuildOperations.mock.results[0],
    ).value as InternalOperationBackend;
    expect(sqliteOperations.catalog).toBe(sqliteProfile.provisioning.catalog);

    const postgresProfile = await createRealPostgresProfile();
    const postgresBuildOperations = vi.spyOn(
      postgresProfile,
      "buildOperations",
    );
    createSqlBackend(postgresProfile);
    const postgresOperations = requireDefined(
      postgresBuildOperations.mock.results[0],
    ).value as InternalOperationBackend;
    expect(postgresOperations.catalog).toBe(
      postgresProfile.provisioning.catalog,
    );
  });

  it("refuses dropInvalidIndex on a transaction-scoped PostgreSQL catalog: PostgreSQL cannot run DROP INDEX CONCURRENTLY inside a transaction block", async () => {
    const postgresBackend = createSqlBackend(await createRealPostgresProfile());

    let thrown: unknown;
    await postgresBackend.transaction(async (tx) => {
      try {
        await requireDefined(tx.catalog).dropInvalidIndex(
          "zz_catalog_probe_tx_drop_invalid_index",
        );
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "CATALOG_DROP_INVALID_INDEX_REQUIRES_ROOT_BACKEND",
    );

    // The root backend's own catalog carries no such refusal — the same
    // call succeeds there (a no-op: the index does not exist).
    await expect(
      requireDefined(postgresBackend.catalog).dropInvalidIndex(
        "zz_catalog_probe_tx_drop_invalid_index",
      ),
    ).resolves.toBeUndefined();
  });
});
