/**
 * `deriveEngineProfile` (`src/backend/drizzle/engine/derive-profile.ts`): the
 * worked example a caller building a custom profile follows, pinned so it
 * cannot silently stop reflecting what derivation actually does.
 *
 * Every profile here starts from a real `buildSqliteEngineProfile` or
 * `buildPostgresEngineProfile` result, exactly like
 * `engine-profile-refusals.test.ts` — `deriveEngineProfile` is meant to be
 * called on that return value, never on a hand-built object.
 */
import type { Transaction as PgliteTransactionHandle } from "@electric-sql/pglite";
import { PGlite } from "@electric-sql/pglite";
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAdapterStoreWithSchema, defineGraph, defineNode } from "../src";
import { isSchemaFencedInsertEligible } from "../src/backend/capabilities/schema-fenced-insert";
import {
  type FenceSql,
  isFirstPartyFactory,
  resolveWriteFencePlan,
} from "../src/backend/capabilities/write-fence";
import {
  createSqlBackend,
  deriveEngineProfile,
  type SqlEngineProfile,
} from "../src/backend/drizzle/engine";
import type { AnyPgTransaction } from "../src/backend/drizzle/execution/postgres-execution";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { buildPostgresEngineProfile } from "../src/backend/drizzle/postgres";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import { ConfigurationError } from "../src/errors";
import { sql, type SqlFragment } from "../src/query/sql-fragment";

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

/**
 * Builds a real PostgreSQL profile plus the PGlite client it is built on, so
 * a test can instrument that client's own query surface before writes run.
 */
async function createRealPostgresProfileWithClient(): Promise<{
  profile: SqlEngineProfile<AnyPgTransaction>;
  client: PGlite;
}> {
  const client = await PGlite.create();
  cleanups.push(() => client.close());
  const profile = buildPostgresEngineProfile(drizzlePg(client), {
    vector: false,
  });
  return { profile, client };
}

// ============================================================
// A minimal statement-capture pair, in the same spirit as
// `engine-profile-parity.test.ts`'s own (private) capture helpers: a write
// under an identity-enabled graph runs its identity-lock statement inside a
// real transaction, so both PGlite surfaces — the top-level client and the
// `Transaction` handle `client.transaction(...)` opens — must be watched, or
// the in-transaction statement is invisible to the capture.
// ============================================================

type CapturedStatement = Readonly<{ sql: string; params: unknown }>;

function wrapPostgresTransactionCapture(
  tx: PgliteTransactionHandle,
  collected: CapturedStatement[],
): PgliteTransactionHandle {
  return new Proxy(tx, {
    get(target, property, _receiver) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (property !== "query") return bound;
      return (...args: unknown[]) => {
        const [sqlText, params] = args;
        if (typeof sqlText === "string") {
          collected.push({ sql: sqlText, params: params ?? [] });
        }
        return bound(...args);
      };
    },
  });
}

function instrumentPostgresCapture(
  client: PGlite,
  collected: CapturedStatement[],
): void {
  const originalQuery = client.query.bind(client);
  vi.spyOn(client, "query").mockImplementation(
    (...args: unknown[]): ReturnType<PGlite["query"]> => {
      const [sqlText, params] = args;
      if (typeof sqlText === "string") {
        collected.push({ sql: sqlText, params: params ?? [] });
      }
      return (
        originalQuery as (...a: unknown[]) => ReturnType<PGlite["query"]>
      )(...args);
    },
  );

  const originalTransaction = client.transaction.bind(client);
  vi.spyOn(client, "transaction").mockImplementation(
    (
      callback: (tx: PgliteTransactionHandle) => Promise<unknown>,
    ): ReturnType<PGlite["transaction"]> =>
      (
        originalTransaction as (
          fn: (tx: PgliteTransactionHandle) => Promise<unknown>,
        ) => ReturnType<PGlite["transaction"]>
      )((tx: PgliteTransactionHandle) =>
        callback(wrapPostgresTransactionCapture(tx, collected)),
      ),
  );
}

// ============================================================
// Case 1 — a derived PostgreSQL profile's custom fenceSql spelling is what
// the identity lock actually emits, not the bundled spelling.
// ============================================================

/**
 * A valid but distinct advisory-lock spelling: `hashtext` of ONE
 * concatenated string rather than the bundled two-argument
 * `pg_advisory_xact_lock(hashtext($namespace), hashtext($key))` form.
 */
function customAdvisoryLock(
  namespace: string,
  key: string | number,
): SqlFragment {
  const keyText = typeof key === "number" ? String(key) : key;
  return sql`SELECT pg_advisory_xact_lock(hashtext(${namespace} || ':' || ${keyText}))`;
}

function customAdvisoryLockWithIsolation(
  namespace: string,
  key: string | number,
): SqlFragment {
  const keyText = typeof key === "number" ? String(key) : key;
  return sql`
    SELECT
      pg_advisory_xact_lock(hashtext(${namespace} || ':' || ${keyText})),
      current_setting('transaction_isolation') AS transaction_isolation
  `;
}

const CUSTOM_LOCK_TABLE_MODE_CLAUSE = {
  share: "IN SHARE MODE",
  "share-row-exclusive": "IN SHARE ROW EXCLUSIVE MODE",
  "access-exclusive": "IN ACCESS EXCLUSIVE MODE",
} as const satisfies Record<
  "share" | "share-row-exclusive" | "access-exclusive",
  string
>;

function customLockTables(
  tables: readonly string[],
  mode: "share" | "share-row-exclusive" | "access-exclusive",
): SqlFragment {
  return sql`LOCK TABLE ${sql.join(
    tables.map((table) => sql.identifier(table)),
    sql`, `,
  )} ${sql.raw(CUSTOM_LOCK_TABLE_MODE_CLAUSE[mode])}`;
}

function customIsolationFact(): SqlFragment {
  // The `transaction_isolation` alias is a hard contract, not a stylistic
  // choice: `assertRecordedCaptureTransactionIsolation` reads the row back
  // by that column name regardless of which `FenceSql` produced it.
  return sql`SELECT current_setting('transaction_isolation') AS transaction_isolation`;
}

const customFenceSql: FenceSql = {
  advisoryLock: customAdvisoryLock,
  advisoryLockWithIsolation: customAdvisoryLockWithIsolation,
  lockTables: customLockTables,
  isolationFact: customIsolationFact,
};

/** A one-argument `hashtext(...)` call is the custom spelling's signature. */
const CUSTOM_ADVISORY_LOCK_MARKER = "hashtext($1 || ':' || $2)";
/**
 * The bundled spelling's signature: TWO separately hashed arguments to
 * `pg_advisory_xact_lock`, joined by a comma — never produced by
 * {@link customAdvisoryLock} above.
 */
const BUNDLED_ADVISORY_LOCK_PATTERN =
  /pg_advisory_xact_lock\(hashtext\(\$\d+\),/;

const DerivationPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const derivationIdentityGraph = defineGraph({
  id: "engine_profile_derivation_identity",
  nodes: { Person: { type: DerivationPerson } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

describe("deriveEngineProfile", () => {
  it("case 1: a derived PostgreSQL profile's custom fenceSql spelling backs the identity lock, never the bundled spelling", async () => {
    const { profile: baseProfile, client } =
      await createRealPostgresProfileWithClient();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      fenceSql: customFenceSql,
    });

    const captured: CapturedStatement[] = [];
    instrumentPostgresCapture(client, captured);

    const backend = createSqlBackend(derivedProfile);
    const [store] = await createAdapterStoreWithSchema(
      derivationIdentityGraph,
      backend,
      { history: true },
    );

    const alice = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );
    const bob = await store.nodes.Person.create({ name: "Bob" }, { id: "bob" });
    await store.identity.assertDifferent(alice, bob);

    // Two OTHER statements in this capture also name
    // `pg_advisory_xact_lock`, neither of them the identity lock this test
    // targets: the schema-version commit's own lock (spelled directly
    // through `advisoryLockSingleExpression`, a single-argument call
    // unconditionally bundled — see `postgres.ts`'s own doc comment) and
    // history capture's recorded-graph-write lock, which `operationStrategy
    // .buildLockSchemaVersionAndGraphWrite` FUSES into the schema-fence CTE
    // (the `"graph_write_lock"` CTE below) using the bundled spelling
    // directly, by construction: that fused command lives on
    // `profile.strategy`, a field `deriveEngineProfile` cannot touch (see
    // `DERIVABLE_ENGINE_PROFILE_KEYS`), so overriding `fenceSql` alone never
    // reaches it — a real, documented limit of fenceSql-only derivation, not
    // a defect this test polices. What IS derivable, and what this
    // assertion actually targets, is the identity lock
    // (`lockIdentityGraph`), the only OTHER two-argument advisory-lock call
    // this trace contains.
    const customSpellingStatements = captured.filter((statement) =>
      statement.sql.includes(CUSTOM_ADVISORY_LOCK_MARKER),
    );
    expect(customSpellingStatements.length).toBeGreaterThan(0);

    const bundledTwoArgumentSpellingStatements = captured.filter(
      (statement) =>
        BUNDLED_ADVISORY_LOCK_PATTERN.test(statement.sql) &&
        !statement.sql.includes("graph_write_lock"),
    );
    expect(bundledTwoArgumentSpellingStatements).toHaveLength(0);
  });

  it("case 2: a derived SQLite profile with an all-false pessimisticLocks declaration refuses the identity lock as unfenced (declared-none)", async () => {
    const baseProfile = createRealSqliteProfile();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      declaredCapabilities: {
        ...baseProfile.declaredCapabilities,
        pessimisticLocks: {
          advisoryLocks: false,
          tableLocks: false,
          serializedWriters: false,
        },
      },
    });

    const backend = createSqlBackend(derivedProfile);

    // An identity-enabled graph's FIRST schema commit runs the identity
    // subsystem's own schema-commit preflight (`identitySchemaCommitPreflight`,
    // `src/identity/schema-transition.ts`), which takes this same per-graph
    // fence before a single row is ever written — so the refusal fires here,
    // opening the store, rather than needing a write afterward to reach it.
    let thrown: unknown;
    try {
      await createAdapterStoreWithSchema(derivationIdentityGraph, backend);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe("WRITE_FENCE_UNAVAILABLE");
    expect(configurationError.details["reason"]).toBe("declared-none");
  });

  it("case 3: an override outside the derivable set throws ENGINE_PROFILE_OVERRIDE_UNSUPPORTED naming the key", () => {
    const baseProfile = createRealSqliteProfile();

    let thrown: unknown;
    try {
      deriveEngineProfile(baseProfile, {
        execution: baseProfile.execution,
      } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "ENGINE_PROFILE_OVERRIDE_UNSUPPORTED",
    );
    expect(configurationError.details["key"]).toBe("execution");
    expect(configurationError.message).toContain("execution");
  });

  it("case 4: isFirstPartyFactory is false for a derived root and for a transaction() handle it opens, true for the bundled root", async () => {
    const baseProfile = createRealSqliteProfile();
    const bundledBackend = createSqlBackend(baseProfile);
    expect(isFirstPartyFactory(bundledBackend)).toBe(true);

    const derivedProfile = deriveEngineProfile(baseProfile, {
      autocommit: { singleStatementDurable: false },
    });
    const derivedBackend = createSqlBackend(derivedProfile);

    expect(isFirstPartyFactory(derivedBackend)).toBe(false);
    await derivedBackend.transaction((tx) => {
      expect(isFirstPartyFactory(tx)).toBe(false);
      return Promise.resolve();
    });
  });

  it("case 5: a derived profile's root and a transaction() handle it opens resolve the same write-fence plan and schema-fenced-insert eligibility", async () => {
    const baseProfile = createRealSqliteProfile();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      declaredCapabilities: {
        ...baseProfile.declaredCapabilities,
        pessimisticLocks: {
          advisoryLocks: false,
          tableLocks: true,
          serializedWriters: false,
        },
      },
    });

    const backend = createSqlBackend(derivedProfile);

    const rootPlan = resolveWriteFencePlan(backend);
    const rootReason =
      rootPlan.kind === "unfenced" ? rootPlan.reason : undefined;
    expect(rootPlan.kind).toBe("unfenced");
    expect(rootReason).toBe("table-locks-only");
    expect(isSchemaFencedInsertEligible(backend)).toBe(false);

    await backend.transaction((tx) => {
      const txPlan = resolveWriteFencePlan(tx);
      const txReason = txPlan.kind === "unfenced" ? txPlan.reason : undefined;
      expect(txPlan.kind).toBe(rootPlan.kind);
      expect(txReason).toBe(rootReason);
      expect(isSchemaFencedInsertEligible(tx)).toBe(
        isSchemaFencedInsertEligible(backend),
      );
      return Promise.resolve();
    });
  });

  it("case 6: fenceSql: undefined alone still refuses at createSqlBackend (WRITE_FENCE_SQL_UNAVAILABLE); paired with a declaredCapabilities override that also stops claiming advisoryLocks it resolves engine-serialized", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();

    // Half 1: dropping the spelling alone leaves `declaredCapabilities
    // .pessimisticLocks.advisoryLocks: true` in place (the bundled
    // PostgreSQL declaration), so `createSqlBackend`'s eager fence-plan
    // resolution has a lock plan with nothing to spell it with.
    const droppedFenceSqlOnly = deriveEngineProfile(baseProfile, {
      fenceSql: undefined,
    });
    let thrown: unknown;
    try {
      createSqlBackend(droppedFenceSqlOnly);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details["code"]).toBe(
      "WRITE_FENCE_SQL_UNAVAILABLE",
    );

    // Half 2: pairing the dropped spelling with a `pessimisticLocks`
    // declaration that claims `serializedWriters` instead of
    // `advisoryLocks` gives `resolveWriteFencePlan` an `engine-serialized`
    // plan, which needs no `fenceSql` at all — this is what successfully
    // removes the spelling, not `fenceSql: undefined` on its own.
    const droppedFenceSqlWithSerializedWriters = deriveEngineProfile(
      baseProfile,
      {
        fenceSql: undefined,
        declaredCapabilities: {
          ...baseProfile.declaredCapabilities,
          pessimisticLocks: {
            advisoryLocks: false,
            tableLocks: false,
            serializedWriters: true,
          },
        },
      },
    );
    const backend = createSqlBackend(droppedFenceSqlWithSerializedWriters);
    expect(resolveWriteFencePlan(backend).kind).toBe("engine-serialized");
  });

  it("case 7: a derived profile's assembly is the SAME object as the base profile's own", () => {
    const baseProfile = createRealSqliteProfile();

    const derivedProfile = deriveEngineProfile(baseProfile, {
      autocommit: { singleStatementDurable: false },
    });

    // `assembly` is not in `DERIVABLE_ENGINE_PROFILE_KEYS`, so
    // `{...base, ...overrides}` carries `base.assembly` forward untouched —
    // the derived profile resolves to the identical `buildOperations` /
    // `lateMembers` pair the base builder closed over, not a copy.
    expect(derivedProfile.assembly).toBe(baseProfile.assembly);
  });
});

describe("deriveEngineProfile refuses the declaredCapabilities/resourceAudit sub-fields the bundled PostgreSQL builder bakes into its execution adapter", () => {
  it("refuses declaredCapabilities.maxBindParameters when it differs from the base profile's own value", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();

    let thrown: unknown;
    try {
      deriveEngineProfile(baseProfile, {
        declaredCapabilities: {
          ...baseProfile.declaredCapabilities,
          maxBindParameters:
            (baseProfile.declaredCapabilities.maxBindParameters ?? 0) + 1,
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "ENGINE_PROFILE_OVERRIDE_UNSUPPORTED",
    );
    expect(configurationError.details["key"]).toBe(
      "declaredCapabilities.maxBindParameters",
    );
  });

  it("refuses declaredCapabilities.execution.interactiveTransactions when it differs from the base profile's own value", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();

    let thrown: unknown;
    try {
      deriveEngineProfile(baseProfile, {
        declaredCapabilities: {
          ...baseProfile.declaredCapabilities,
          execution: {
            ...baseProfile.declaredCapabilities.execution,
            interactiveTransactions:
              !baseProfile.declaredCapabilities.execution
                .interactiveTransactions,
          },
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "ENGINE_PROFILE_OVERRIDE_UNSUPPORTED",
    );
    expect(configurationError.details["key"]).toBe(
      "declaredCapabilities.execution.interactiveTransactions",
    );
  });

  it("refuses resourceAudit.kind when it differs from the base profile's own value", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();
    const flippedResourceAudit =
      baseProfile.resourceAudit.kind === "serialized" ?
        { kind: "independent" as const }
      : { kind: "serialized" as const, resource: {} };

    let thrown: unknown;
    try {
      deriveEngineProfile(baseProfile, { resourceAudit: flippedResourceAudit });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const configurationError = thrown as ConfigurationError;
    expect(configurationError.details["code"]).toBe(
      "ENGINE_PROFILE_OVERRIDE_UNSUPPORTED",
    );
    expect(configurationError.details["key"]).toBe("resourceAudit.kind");
  });

  it("still allows a declaredCapabilities override that changes only pessimisticLocks, keeping maxBindParameters and execution.interactiveTransactions equal to the base profile's own values", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();

    const derivedProfile = deriveEngineProfile(baseProfile, {
      declaredCapabilities: {
        ...baseProfile.declaredCapabilities,
        pessimisticLocks: {
          advisoryLocks: false,
          tableLocks: false,
          serializedWriters: true,
        },
      },
    });

    expect(derivedProfile.declaredCapabilities.maxBindParameters).toBe(
      baseProfile.declaredCapabilities.maxBindParameters,
    );
    expect(
      derivedProfile.declaredCapabilities.execution.interactiveTransactions,
    ).toBe(baseProfile.declaredCapabilities.execution.interactiveTransactions);
  });
});
