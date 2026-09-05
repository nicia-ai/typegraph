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

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { isSchemaFencedInsertEligible } from "../src/backend/capabilities/schema-fenced-insert";
import {
  type FenceSql,
  isFirstPartyFactory,
  resolveFenceStatements,
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
import {
  renderPostgres,
  sql,
  type SqlFragment,
} from "../src/query/sql-fragment";

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
 * The bare `pg_advisory_xact_lock(...)` call, with no `SELECT` around it —
 * `hashtext` of ONE concatenated string rather than the bundled
 * two-argument `pg_advisory_xact_lock(hashtext($namespace), hashtext($key))`
 * form. `resolveFenceStatements` wraps this in the standalone-statement form
 * every ordinary lock site consumes; `postgres-schema-write-fence.ts`'s
 * fused statement embeds this bare form directly when this `FenceSql` backs
 * a derived profile — the same split the bundled `advisoryLockExpression`
 * (`postgres-fence-sql.ts`) makes. Both readers call this SAME function, so
 * they cannot spell the lock differently — see case 1c below.
 */
function customAdvisoryLockExpression(
  namespace: string,
  key: string | number,
): SqlFragment {
  const keyText = typeof key === "number" ? String(key) : key;
  return sql`pg_advisory_xact_lock(hashtext(${namespace} || ':' || ${keyText}))`;
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

/**
 * The bare `current_setting('transaction_isolation')` read, with no
 * `SELECT`/alias around it — `resolveFenceStatements` wraps this in the
 * standalone-statement form; `postgres-schema-write-fence.ts`'s fused
 * statement embeds this bare form directly. The `transaction_isolation`
 * alias `resolveFenceStatements` gives its derived `isolationFact` /
 * `advisoryLockWithIsolation` is a hard contract, not a stylistic choice:
 * `assertRecordedCaptureTransactionIsolation` reads the row back by that
 * column name regardless of which `FenceSql` produced it.
 */
function customIsolationFactExpression(): SqlFragment {
  return sql`current_setting('transaction_isolation')`;
}

const customFenceSql: FenceSql = {
  lockTables: customLockTables,
  advisoryLockExpression: customAdvisoryLockExpression,
  isolationFactExpression: customIsolationFactExpression,
};

/**
 * The custom spelling's signature: ONE `hashtext(...)` call over a
 * concatenated string, never a namespace/key pair separately hashed. Keyed
 * on bind-parameter PLACEHOLDERS (`$\d+`), not fixed numbers: the fused
 * schema + graph-write statement binds the schema fence's own `graphId` /
 * `expectedVersion` params ahead of the lock's, so the lock's own
 * placeholders land at `$3`/`$4` there and `$1`/`$2` in the identity lock's
 * standalone statement — both are the SAME spelling, just at a different
 * position in their own statement's parameter list.
 */
const CUSTOM_ADVISORY_LOCK_PATTERN =
  /pg_advisory_xact_lock\(hashtext\(\$\d+ \|\| ':' \|\| \$\d+\)\)/;
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

// ============================================================
// Case 1b's own graph — a cardinality-constrained edge, not history/identity,
// is what needs the graph-write lock here: `edgeWriteNeedsConstraintFence`
// (`src/store/constraints.ts`) fences every edge cardinality but `"many"`,
// so a `"one"` edge create sets `fencesConstraintProbe` and reaches the same
// `combinedSchemaGraphFence` branch a history-enabled write does — without
// opening recorded-time capture, which on PostgreSQL needs `fenceSql` for an
// entirely different, dialect-gated reason (its own isolation-level read,
// `assertRecordedCaptureTransactionIsolation` in `store/recorded-capture/
// guards.ts`) that a `pessimisticLocks` posture cannot satisfy either way.
// ============================================================

const PortableFenceProbePerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const portableFenceProbeKnows = defineEdge("knows", {
  schema: z.object({}),
});

const portableFenceProbeGraph = defineGraph({
  id: "engine_profile_derivation_portable_fence_probe",
  nodes: { Person: { type: PortableFenceProbePerson } },
  edges: {
    knows: {
      type: portableFenceProbeKnows,
      from: [PortableFenceProbePerson],
      to: [PortableFenceProbePerson],
      cardinality: "one",
    },
  },
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

    // One OTHER statement in this capture also names `pg_advisory_xact_lock`
    // but is never expected to carry the custom spelling: the schema-version
    // commit's own lock, spelled through `advisoryLockSingleExpression` — a
    // ONE-argument call occupying a deliberately different lock space than
    // every namespaced two-argument lock (see `postgres.ts`'s own doc
    // comment), so `BUNDLED_ADVISORY_LOCK_PATTERN` below (which matches only
    // the TWO-argument form) never matches it regardless.
    //
    // History capture's recorded-graph-write lock — `operationStrategy
    // .buildLockSchemaVersionAndGraphWrite`, FUSED into the schema-fence CTE
    // (the `"graph_write_lock"` CTE below) — now takes the resolved fence
    // target's own spelling as a parameter instead of hardcoding the bundled
    // one, so it carries the SAME custom spelling the identity lock
    // (`lockIdentityGraph`) does. Both are asserted below with no
    // `graph_write_lock` exclusion.
    const customSpellingStatements = captured.filter((statement) =>
      CUSTOM_ADVISORY_LOCK_PATTERN.test(statement.sql),
    );
    expect(customSpellingStatements.length).toBeGreaterThan(0);

    const fusedGraphWriteLockStatements = captured.filter((statement) =>
      statement.sql.includes("graph_write_lock"),
    );
    expect(fusedGraphWriteLockStatements.length).toBeGreaterThan(0);
    for (const statement of fusedGraphWriteLockStatements) {
      expect(CUSTOM_ADVISORY_LOCK_PATTERN.test(statement.sql)).toBe(true);
    }

    const bundledTwoArgumentSpellingStatements = captured.filter((statement) =>
      BUNDLED_ADVISORY_LOCK_PATTERN.test(statement.sql),
    );
    expect(bundledTwoArgumentSpellingStatements).toHaveLength(0);
  });

  it("case 1c: for a derived custom spelling, resolveFenceStatements's portable advisoryLock statement and the fused graph_write_lock CTE's embedded expression render the IDENTICAL expression text — they now cannot differ", () => {
    // No live connection needed: this isolates the claim case 1 proves
    // end-to-end (both readers of `customFenceSql` agree) down to the exact
    // mechanism that makes it true. `resolveFenceStatements`'s `advisoryLock`
    // is `SELECT ${fenceSql.advisoryLockExpression(...)}` — it calls the
    // SAME `advisoryLockExpression` function `postgres-schema-write-fence
    // .ts`'s fused CTE embeds directly, so the portable statement and the
    // fused embedding can never spell the lock differently: there is only
    // ever one `advisoryLockExpression` call to diverge from.
    const derivedStatements = resolveFenceStatements(customFenceSql);
    const namespace = "typegraph:identity";
    const key = "graph-1";

    const portableStatementText = renderPostgres(
      derivedStatements.advisoryLock(namespace, key),
    ).sql;
    const fusedEmbeddedExpressionText = renderPostgres(
      customFenceSql.advisoryLockExpression(namespace, key),
    ).sql;

    expect(fusedEmbeddedExpressionText).toMatch(CUSTOM_ADVISORY_LOCK_PATTERN);
    expect(portableStatementText).toBe(`SELECT ${fusedEmbeddedExpressionText}`);
  });

  it("case 1b: a derived PostgreSQL profile with fenceSql: undefined and pessimisticLocks.serializedWriters has no lockSchemaVersionAndGraphWrite member on the root or a transaction() handle, and a graph-write-lock-needing write still succeeds through the portable path", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      fenceSql: undefined,
      declaredCapabilities: {
        ...baseProfile.declaredCapabilities,
        pessimisticLocks: {
          advisoryLocks: false,
          tableLocks: false,
          serializedWriters: true,
        },
      },
    });

    const backend = createSqlBackend(derivedProfile);
    // Before the fix this member existed regardless of `fenceSql` — the
    // fused statement spelled the BUNDLED lock unconditionally, silently
    // ignoring a derived profile's dropped spelling — so this assertion is
    // the direct proof: it fails against the unfixed code, and passes only
    // because the member now builds solely when `fenceSql` is also present.
    expect(backend.lockSchemaVersionAndGraphWrite).toBeUndefined();
    await backend.transaction((tx) => {
      expect(tx.lockSchemaVersionAndGraphWrite).toBeUndefined();
      return Promise.resolve();
    });

    const [store] = await createAdapterStoreWithSchema(
      portableFenceProbeGraph,
      backend,
    );

    const alice = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice-portable" },
    );
    const bob = await store.nodes.Person.create(
      { name: "Bob" },
      { id: "bob-portable" },
    );

    // A `"one"`-cardinality edge create is a constrained write
    // (`edgeWriteNeedsConstraintFence`), so it needs the per-graph write
    // lock exactly as a history-enabled write does. Reaching the fused
    // member would throw (it does not exist); this only succeeds if the
    // Store fell back to the two-statement portable fence
    // (`lockSchemaVersionForStoreWrite` + `lockRecordedGraphWrite`), which
    // needs no `fenceSql` at all under an `engine-serialized` plan.
    const edge = await store.edges.knows.create(alice, bob, {});
    expect(edge).toBeDefined();
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

describe("registerFirstPartyProfile freezes the trust-bearing bags a derived profile shares with its base by reference", () => {
  it("a derived SQLite profile's shared resourceAudit and declaredCapabilities (including a nested capability leaf) throw on assignment and leave the base unchanged", () => {
    const baseProfile = createRealSqliteProfile();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      autocommit: { singleStatementDurable: false },
    });

    // Neither override names `resourceAudit` or `declaredCapabilities`, so
    // `deriveEngineProfile`'s `{...base, ...overrides}` carries the SAME
    // objects forward — the sharing this freeze exists to make safe.
    expect(derivedProfile.resourceAudit).toBe(baseProfile.resourceAudit);
    expect(derivedProfile.declaredCapabilities).toBe(
      baseProfile.declaredCapabilities,
    );

    const originalResourceAuditKind = baseProfile.resourceAudit.kind;
    const flippedResourceAuditKind =
      originalResourceAuditKind === "serialized" ? "independent" : "serialized";
    expect(() => {
      (derivedProfile.resourceAudit as { kind: string }).kind =
        flippedResourceAuditKind;
    }).toThrow(TypeError);
    expect(baseProfile.resourceAudit.kind).toBe(originalResourceAuditKind);

    const originalWindowFunctions =
      baseProfile.declaredCapabilities.windowFunctions;
    expect(() => {
      (
        derivedProfile.declaredCapabilities as { windowFunctions: boolean }
      ).windowFunctions = !originalWindowFunctions;
    }).toThrow(TypeError);
    expect(baseProfile.declaredCapabilities.windowFunctions).toBe(
      originalWindowFunctions,
    );

    // A nested capability leaf, two levels deep — proves the freeze is not
    // limited to `declaredCapabilities`'s own top-level fields.
    const originalInteractiveTransactions =
      baseProfile.declaredCapabilities.execution.interactiveTransactions;
    expect(() => {
      (
        derivedProfile.declaredCapabilities.execution as {
          interactiveTransactions: boolean;
        }
      ).interactiveTransactions = !originalInteractiveTransactions;
    }).toThrow(TypeError);
    expect(
      baseProfile.declaredCapabilities.execution.interactiveTransactions,
    ).toBe(originalInteractiveTransactions);
  });

  it("a derived PostgreSQL profile's shared resourceAudit and declaredCapabilities.pessimisticLocks throw on assignment and leave the base unchanged", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      autocommit: { singleStatementDurable: false },
    });

    const originalResourceAuditKind = baseProfile.resourceAudit.kind;
    expect(() => {
      (derivedProfile.resourceAudit as { kind: string }).kind =
        "flipped-for-the-test";
    }).toThrow(TypeError);
    expect(baseProfile.resourceAudit.kind).toBe(originalResourceAuditKind);

    const originalPessimisticLocks =
      baseProfile.declaredCapabilities.pessimisticLocks;
    expect(() => {
      (
        derivedProfile.declaredCapabilities as { pessimisticLocks: unknown }
      ).pessimisticLocks = undefined;
    }).toThrow(TypeError);
    expect(baseProfile.declaredCapabilities.pessimisticLocks).toBe(
      originalPessimisticLocks,
    );
  });

  it("a derived PostgreSQL profile's shared fenceSql container throws on assignment and leaves the base unchanged, without freezing its function values", async () => {
    const { profile: baseProfile } =
      await createRealPostgresProfileWithClient();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      autocommit: { singleStatementDurable: false },
    });

    // Neither override names `fenceSql`, so `deriveEngineProfile`'s
    // `{...base, ...overrides}` carries the SAME `fenceSql` object forward —
    // the sharing this freeze exists to make safe, exactly like
    // `resourceAudit` and `declaredCapabilities` above.
    expect(derivedProfile.fenceSql).toBe(baseProfile.fenceSql);

    const originalAdvisoryLockExpression =
      baseProfile.fenceSql?.advisoryLockExpression;
    expect(() => {
      (
        derivedProfile.fenceSql as { advisoryLockExpression: unknown }
      ).advisoryLockExpression = () => {
        throw new Error("unreachable");
      };
    }).toThrow(TypeError);
    expect(baseProfile.fenceSql?.advisoryLockExpression).toBe(
      originalAdvisoryLockExpression,
    );

    // The freeze is shallow: it binds the CONTAINER's own fields, never the
    // function values themselves, which stay ordinary callable functions.
    expect(typeof derivedProfile.fenceSql?.advisoryLockExpression).toBe(
      "function",
    );
    expect(
      Object.isFrozen(derivedProfile.fenceSql?.advisoryLockExpression),
    ).toBe(false);
  });

  it("an overridden declaredCapabilities literal on a derived profile is a fresh, unfrozen object — spreading a frozen source does not freeze the copy", () => {
    const baseProfile = createRealSqliteProfile();
    const derivedProfile = deriveEngineProfile(baseProfile, {
      declaredCapabilities: { ...baseProfile.declaredCapabilities },
    });

    expect(derivedProfile.declaredCapabilities).not.toBe(
      baseProfile.declaredCapabilities,
    );
    expect(Object.isFrozen(derivedProfile.declaredCapabilities)).toBe(false);
    expect(() => {
      (
        derivedProfile.declaredCapabilities as { windowFunctions: boolean }
      ).windowFunctions = !derivedProfile.declaredCapabilities.windowFunctions;
    }).not.toThrow();
  });
});
