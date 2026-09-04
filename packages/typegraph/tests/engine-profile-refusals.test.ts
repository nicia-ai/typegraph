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
import { afterEach, describe, expect, it } from "vitest";

import { isBundledRootAutocommitEligible } from "../src/backend/capabilities/autocommit-single-statement";
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
import { buildPostgresEngineProfile } from "../src/backend/drizzle/postgres";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import { ConfigurationError } from "../src/errors";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { buildVectorCapabilities } from "../src/query/dialect/vector-strategy";

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
  it("omits capabilities.fulltext and reports contributions.rebuild: false when the profile supplies no fulltext strategy", () => {
    // Every bundled profile supplies a fulltext strategy today, so this arm
    // is unreachable through either dialect builder — it exists so a future
    // profile that turns fulltext off has somewhere correct to land, and
    // this test is the only thing exercising it.
    const base = createRealSqliteProfile();

    const capabilities = finalizeEngineCapabilities(base.declaredCapabilities, {
      execution: base.execution,
      vectorStrategy: undefined,
      fulltextStrategy: undefined,
      fulltextTableName: base.tableNames.fulltext,
    });

    expect(capabilities.fulltext).toBeUndefined();
    expect(capabilities.vector).toBeUndefined();
    expect(capabilities.contributions?.rebuild).toBe(false);
  });
});
