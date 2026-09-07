/**
 * The `"optimistic-retry"` tier: a `row`-mechanism write fence with
 * `conflict: "commit-time"` derives `capabilities.execution.unitOfWork:
 * "optimistic-retry"` on an interactive backend, and every store-owned unit
 * built on `runInWriteTransaction` — plus `rebuildContribution` and the
 * index-materialization claim/record calls — replays a commit-time conflict
 * to success within budget, using the SAME fault-injection harness
 * `tests/transaction-retry.test.ts` drives the `"interactive"` tier through.
 *
 * A `row`-mechanism declaration derives `"optimistic-retry"` on BOTH bundled
 * engines once `conflict: "commit-time"` is declared
 * (`finalizeEngineCapabilities`, `src/backend/drizzle/engine/capabilities.ts`)
 * — real engine support for the `row` mechanism itself is irrelevant here,
 * since every assertion below only needs a real transaction to roll back and
 * a real fault to classify, both of which the fault injector provides on
 * either driver.
 */
import { PGlite } from "@electric-sql/pglite";
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type BackendCapabilities,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
  TransactionConflictError,
} from "../src";
import { generateVectorlessPostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import type { SqlEngineProfile } from "../src/backend/drizzle/engine";
import { createSqlBackend } from "../src/backend/drizzle/engine";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { buildPostgresEngineProfile } from "../src/backend/drizzle/postgres";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import { createPostgresBackend } from "../src/backend/postgres";
import { defineNodeIndex } from "../src/indexes";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../src/interchange";
import {
  isOptimisticRetryTier,
  requiresOptimisticRetryUnit,
  resolveWriteTransactionMode,
  runRetriedUnit,
} from "../src/store/operations/write-transaction";
import { requireDefined } from "../src/utils/presence";
import {
  createTransactionFaultInjector,
  type FaultInjectableEngine,
  type TransactionFaultInjector,
} from "./transaction-fault-injector";

/**
 * The one `row`-mechanism, `conflict: "commit-time"` declaration every test
 * in this file derives its tier from: a portable keyed fence backed by the
 * never-dropped fences relation, whose two acquirers both proceed and the
 * loser's COMMIT fails — the ONE `conflict` value that (with an interactive
 * backend, true on both bundled engines) derives `"optimistic-retry"`.
 * `drain: "quiescent"` is the simplest legal drain for a mechanism this file
 * never exercises a drain site through.
 */
const ROW_COMMIT_TIME_WRITE_FENCE = {
  mechanism: "row",
  drain: "quiescent",
  conflict: "commit-time",
} as const;

const OPTIMISTIC_RETRY_CAPABILITIES: Partial<BackendCapabilities> = {
  writeFence: ROW_COMMIT_TIME_WRITE_FENCE,
};

/** What `failAtStatementCall`-shaped local fault triggers in this file match. */
const WRITE_STATEMENT_PATTERN = /^\s*(INSERT|UPDATE|DELETE)\b/i;

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const OPTIMISTIC_RETRY_GRAPH = defineGraph({
  id: "optimistic-retry-tier",
  nodes: { Person: { type: Person } },
  edges: {},
});

const ENGINES: readonly FaultInjectableEngine[] = ["sqlite", "pglite"];

const injectorsToClose: TransactionFaultInjector[] = [];
afterEach(async () => {
  await Promise.all(
    injectorsToClose.splice(0).map((injector) => injector.close()),
  );
});

/**
 * Builds a fault-injected backend declaring {@link OPTIMISTIC_RETRY_CAPABILITIES}
 * and a store on it, armed only after the store's own schema bootstrap has
 * run — exactly `transaction-retry.test.ts`'s `buildFaultyStore`, plus the
 * capabilities override and the tier assertion every caller here relies on.
 */
async function buildOptimisticRetryStore(
  engine: FaultInjectableEngine,
  faultOptions: Omit<
    Parameters<typeof createTransactionFaultInjector>[1],
    "capabilities"
  >,
  storeOptions?: Parameters<typeof createStoreWithSchema>[2],
) {
  const injector = await createTransactionFaultInjector(engine, {
    ...faultOptions,
    capabilities: OPTIMISTIC_RETRY_CAPABILITIES,
  });
  injectorsToClose.push(injector);
  expect(injector.backend.capabilities.execution.unitOfWork).toBe(
    "optimistic-retry",
  );
  const [store] = await createStoreWithSchema(
    OPTIMISTIC_RETRY_GRAPH,
    injector.backend,
    storeOptions,
  );
  injector.arm();
  return { injector, store };
}

describe.each(ENGINES)("optimistic-retry tier (%s)", (engine) => {
  it("a node create whose first commit is faulted succeeds on attempt 2, with hooks seen exactly once", async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const errors: Error[] = [];
    const { injector, store } = await buildOptimisticRetryStore(
      engine,
      { shape: "40001", failCommits: 1 },
      {
        hooks: {
          onOperationStart: (ctx) => starts.push(ctx.attempt ?? 1),
          onOperationEnd: () => ends.push(1),
          onError: (_ctx, error) => errors.push(error),
        },
      },
    );

    const created = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "alice" },
    );

    expect(created.id).toBe("alice");
    // The internal retry lives entirely inside runInWriteTransaction: the
    // outer operation-hook boundary wraps the whole (possibly replayed)
    // unit, so onOperationStart/onOperationEnd fire exactly once each,
    // exactly as they do under the "interactive" tier.
    expect(injector.commitAttempts()).toBe(2);
    expect(starts).toEqual([1]);
    expect(ends).toEqual([1]);
    expect(errors).toEqual([]);
    expect(await store.nodes.Person.getById(created.id)).toBeDefined();
  });

  it("a nested unit inside store.transaction never retries on its own", async () => {
    const { injector, store } = await buildOptimisticRetryStore(engine, {
      shape: "40001",
      failAtStatementCall: 1,
    });

    let caught: unknown;
    try {
      await store.transaction(async (tx) => {
        await tx.nodes.Person.create({ name: "Alice" }, { id: "alice" });
      });
    } catch (error) {
      caught = error;
    }

    // A write inside store.transaction(fn) runs against a TransactionBackend
    // with no `transaction` member of its own — resolveWriteTransactionMode
    // reads "existing", so requiresOptimisticRetryUnit is false regardless
    // of the tier, and the conflict propagates unchanged to store.transaction
    // itself, which (with no `retry` option) allows exactly one attempt.
    expect(caught).toBeInstanceOf(TransactionConflictError);
    expect((caught as TransactionConflictError).details).toEqual({
      operation: "store.transaction()",
      attempts: 1,
    });
    expect(injector.commitAttempts()).toBe(1);
    expect(await store.nodes.Person.getById("alice" as never)).toBeUndefined();
  });

  it("import through the fault injector reports the second attempt's counts", async () => {
    const { injector, store } = await buildOptimisticRetryStore(engine, {
      shape: "40001",
      failCommits: 1,
    });

    const data: GraphData = {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: { type: "external", description: "optimistic-retry test" },
      nodes: [
        { kind: "Person", id: "alice", properties: { name: "Alice" } },
        { kind: "Person", id: "bob", properties: { name: "Bob" } },
      ],
      edges: [],
    };

    const result = await importGraph(store, data, { onConflict: "skip" });

    expect(injector.commitAttempts()).toBe(2);
    expect(result.success).toBe(true);
    // The first attempt's commit conflicted after inserting both nodes for
    // real; had their counts survived into the second attempt (the bug a
    // counter hoisted outside the write-plan attempt would reintroduce),
    // this would read 4, not 2.
    expect(result.nodes.created).toBe(2);
    expect(await store.nodes.Person.count()).toBe(2);
  });
});

describe("requiresOptimisticRetryUnit — the mode gate", () => {
  it('is true only for an opened transaction under the optimistic-retry tier; a nested unit\'s mode is always "existing"', async () => {
    const sqlite = new RealDatabase(":memory:");
    try {
      const base = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
        executionProfile: { isSync: true },
      });
      const profile: SqlEngineProfile<AnySqliteDatabase> = {
        ...base,
        declaredCapabilities: {
          ...base.declaredCapabilities,
          writeFence: ROW_COMMIT_TIME_WRITE_FENCE,
        },
      };
      const backend = createSqlBackend(profile);

      expect(isOptimisticRetryTier(backend)).toBe(true);
      expect(resolveWriteTransactionMode(backend)).toBe("opened");
      expect(requiresOptimisticRetryUnit(backend)).toBe(true);

      await backend.transaction(async (tx) => {
        await Promise.resolve();
        // The tier is a property of the DECLARATION, unchanged inside the
        // transaction — it is the MODE that must gate the nested case.
        expect(isOptimisticRetryTier(tx)).toBe(true);
        expect(resolveWriteTransactionMode(tx)).toBe("existing");
        expect(requiresOptimisticRetryUnit(tx)).toBe(false);
      });
    } finally {
      sqlite.close();
    }
  });
});

class CustomConflictError extends Error {}

function recognizesCustomConflict(error: unknown): boolean {
  return error instanceof CustomConflictError;
}

/** A SQLSTATE-shaped code no bundled engine emits (never 40001/40P01). */
function recognizesNonStandardConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as Error & { code?: string }).code === "TG001"
  );
}

function buildOptimisticRetrySqliteBackend(
  serializationFailure?: (error: unknown) => boolean,
) {
  const sqlite = new RealDatabase(":memory:");
  const base = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
    executionProfile: { isSync: true },
  });
  const profile: SqlEngineProfile<AnySqliteDatabase> = {
    ...base,
    declaredCapabilities: {
      ...base.declaredCapabilities,
      writeFence: ROW_COMMIT_TIME_WRITE_FENCE,
    },
    ...(serializationFailure === undefined ?
      {}
    : { execution: { ...base.execution, serializationFailure } }),
  };
  return {
    backend: createSqlBackend(profile),
    close: () => sqlite.close(),
  };
}

describe("profile-declared serialization-failure classifier", () => {
  it("a classifier that recognizes a custom error shape makes the owner retry it; without it, the same shape is not retried", async () => {
    const { backend: withClassifier, close: closeWith } =
      buildOptimisticRetrySqliteBackend(recognizesCustomConflict);
    try {
      expect(withClassifier.capabilities.execution.unitOfWork).toBe(
        "optimistic-retry",
      );
      let attempts = 0;
      const result = await runRetriedUnit(
        {
          operation: "custom-classifier-test",
          attempts: 2,
          target: withClassifier,
        },
        async () => {
          await Promise.resolve();
          attempts += 1;
          if (attempts < 2) throw new CustomConflictError("custom conflict");
          return "ok";
        },
      );
      expect(result).toBe("ok");
      expect(attempts).toBe(2);
    } finally {
      closeWith();
    }

    const { backend: withoutClassifier, close: closeWithout } =
      buildOptimisticRetrySqliteBackend();
    try {
      let attempts = 0;
      await expect(
        runRetriedUnit(
          {
            operation: "custom-classifier-test",
            attempts: 2,
            target: withoutClassifier,
          },
          async () => {
            await Promise.resolve();
            attempts += 1;
            throw new CustomConflictError("custom conflict");
          },
        ),
      ).rejects.toBeInstanceOf(CustomConflictError);
      expect(attempts).toBe(1);
    } finally {
      closeWithout();
    }
  });
});

describe("optimistic-retry tier — rebuildContribution and the index-materialization claim (pglite)", () => {
  const Article = defineNode("Article", {
    schema: z.object({ title: searchable({ language: "english" }) }),
  });
  const FULLTEXT_GRAPH = defineGraph({
    id: "optimistic-retry-fulltext",
    nodes: { Article: { type: Article } },
    edges: {},
  });
  const INDEX_GRAPH = defineGraph({
    id: "optimistic-retry-index",
    nodes: { Person: { type: Person } },
    edges: {},
    indexes: [defineNodeIndex(Person, { fields: ["name"] })],
  });
  // A UNIQUE index declared over data that already violates it: the build's
  // own `CREATE UNIQUE INDEX` genuinely fails (no fault injection needed),
  // reaching the failure-path `recordIndexMaterialization` call below.
  const UNIQUE_INDEX_GRAPH = defineGraph({
    id: "optimistic-retry-unique-index",
    nodes: { Person: { type: Person } },
    edges: {},
    indexes: [defineNodeIndex(Person, { fields: ["name"], unique: true })],
  });
  const CONTRIBUTION_MARKER_TABLE = "typegraph_contribution_materializations";

  // Builds a fresh PGlite-backed backend whose first write statement after
  // arming faults with a SQLSTATE-shaped code no bundled engine uses
  // (`TG001`, never 40001/40P01), optionally declaring `serializationFailure`
  // on the profile, then attempts `rebuildContribution("fulltext")` on it.
  // `rebuildContribution` has no backend reference of its own to classify
  // against but `deps.fenceTarget` — the object `createSqlBackend` registers
  // a declared classifier on beside the backend it returns (see
  // `create-sql-backend.ts`) — so this proves the registration and the
  // `target` threaded into `rebuildContribution`'s `runRetriedUnit` call are
  // both live, not just the default SQLSTATE fallback the other
  // rebuildContribution test above already exercises.
  async function attemptRebuild(
    serializationFailure?: (error: unknown) => boolean,
  ): Promise<Readonly<{ succeeded: boolean; faulted: boolean }>> {
    const client = await PGlite.create();
    await client.exec(generateVectorlessPostgresMigrationSQL());
    let armed = false;
    let faulted = false;
    let injectedOnce = false;
    try {
      const db = drizzlePglite(client, {
        logger: {
          logQuery(query: string): void {
            if (
              !armed ||
              injectedOnce ||
              !WRITE_STATEMENT_PATTERN.test(query)
            ) {
              return;
            }
            injectedOnce = true;
            faulted = true;
            const error = new Error("injected non-standard conflict");
            (error as Error & { code: string }).code = "TG001";
            throw error;
          },
        },
      });
      const profile = buildPostgresEngineProfile(db, {
        vector: false,
        capabilities: OPTIMISTIC_RETRY_CAPABILITIES,
      });
      const backend = createSqlBackend({
        ...profile,
        ...(serializationFailure === undefined ?
          {}
        : { execution: { ...profile.execution, serializationFailure } }),
      });
      const [store] = await createStoreWithSchema(FULLTEXT_GRAPH, backend);
      await store.nodes.Article.create({ title: "hello world" });
      armed = true;
      try {
        await store.rebuildContribution("fulltext");
        return { succeeded: true, faulted };
      } catch {
        return { succeeded: false, faulted };
      }
    } finally {
      await client.close();
    }
  }

  it("rebuildContribution with a first-attempt fault succeeds, and its pre-reads run inside the attempt (the marker read fires twice)", async () => {
    // A hand-built PGlite client and logger, rather than the shared fault
    // injector or `createLoggedPgliteClient`: `rebuildContribution`'s fence
    // opens its transaction through `db.transaction(...)` directly
    // (`runSchemaWriteTransaction`, `src/backend/drizzle/postgres.ts`),
    // bypassing the `AdapterBackend.transaction()` member the injector's
    // `failCommits` trigger wraps, and a statement issued INSIDE that
    // transaction routes through drizzle's own session — invisible to a
    // `client.query` patch, which sees only TOP-LEVEL statements (see
    // `lock-fence-test-utils.ts`'s own doc comment on the same split). Both
    // the fault trigger and the read count below therefore hook the
    // `logger` option, the one seam that sees every statement, in or out of
    // a transaction alike.
    const client = await PGlite.create();
    await client.exec(generateVectorlessPostgresMigrationSQL());
    const statements: string[] = [];
    let armed = false;
    let statementCalls = 0;
    let faulted = false;
    function onStatement(sqlText: string): void {
      statements.push(sqlText);
      if (!armed || !WRITE_STATEMENT_PATTERN.test(sqlText)) return;
      statementCalls += 1;
      if (statementCalls === 1) {
        faulted = true;
        const error = new Error("injected 40001 fault");
        (error as Error & { code: string }).code = "40001";
        throw error;
      }
    }
    const db = drizzlePglite(client, {
      logger: {
        logQuery(query: string): void {
          onStatement(query);
        },
      },
    });
    try {
      const backend = createPostgresBackend(db, {
        vector: false,
        capabilities: OPTIMISTIC_RETRY_CAPABILITIES,
      });
      expect(backend.capabilities.execution.unitOfWork).toBe(
        "optimistic-retry",
      );
      const [store] = await createStoreWithSchema(FULLTEXT_GRAPH, backend);
      await store.nodes.Article.create({ title: "hello world" });
      statements.splice(0);

      armed = true;
      const result = await store.rebuildContribution("fulltext");

      expect(faulted).toBe(true);
      expect(result.rebuilt.length).toBeGreaterThan(0);
      const markerReads = statements.filter(
        (statement) =>
          /^\s*select/i.test(statement) &&
          statement.includes(CONTRIBUTION_MARKER_TABLE),
      );
      // One marker read per attempt: had the pre-reads stayed OUTSIDE the
      // retried closure (read once, before the fenced transaction), this
      // would read 1 regardless of how many attempts ran.
      expect(markerReads.length).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("a profile-declared classifier lets rebuildContribution retry a non-standard conflict shape; without one the same shape is not retried", async () => {
    // No classifier declared: the same non-standard shape hits the default
    // SQLSTATE/message rules, which do not recognize it, so the first
    // attempt's failure propagates unchanged instead of retrying.
    const withoutClassifier = await attemptRebuild();
    expect(withoutClassifier.faulted).toBe(true);
    expect(withoutClassifier.succeeded).toBe(false);

    // The classifier is registered on `fenceTarget`, the only backend
    // reference `rebuildContribution` holds, and threaded as this unit's
    // `target` — so the one-time fault above is recognized and replayed to
    // a committed second attempt.
    const withClassifier = await attemptRebuild(recognizesNonStandardConflict);
    expect(withClassifier.faulted).toBe(true);
    expect(withClassifier.succeeded).toBe(true);
  });

  it("the claim call is retried once when the first attempt's claim upsert conflicts", async () => {
    const injector = await createTransactionFaultInjector("pglite", {
      shape: "40001",
      failAtStatementCall: 1,
      capabilities: OPTIMISTIC_RETRY_CAPABILITIES,
    });
    injectorsToClose.push(injector);
    expect(injector.backend.capabilities.execution.unitOfWork).toBe(
      "optimistic-retry",
    );
    const [store] = await createStoreWithSchema(INDEX_GRAPH, injector.backend);

    injector.arm();
    const result = await store.materializeIndexes();

    expect(result.results.some((entry) => entry.status === "failed")).toBe(
      false,
    );
    expect(result.results.every((entry) => entry.status === "created")).toBe(
      true,
    );
    expect(injector.lastFault()).toBeDefined();
  });

  it("a first-attempt conflict on the failure-path record is retried", async () => {
    const injector = await createTransactionFaultInjector("pglite", {
      shape: "40001",
      // On this driver stack, one logical write statement is observed
      // TWICE by this injector before it really executes (once via the
      // drizzle logger, once via the direct client.query patch right
      // before the call reaches PGlite) — so counts come in pairs. The
      // claim upsert is the first pair (1, 2); the build's own
      // `CREATE UNIQUE INDEX` is DDL, not a counted write statement; the
      // failure-path `recordIndexMaterialization` call is the next pair
      // (3, 4). Targeting 4 aborts the record's first attempt before any
      // real execution.
      failAtStatementCall: 4,
      capabilities: OPTIMISTIC_RETRY_CAPABILITIES,
    });
    injectorsToClose.push(injector);
    expect(injector.backend.capabilities.execution.unitOfWork).toBe(
      "optimistic-retry",
    );
    const [store] = await createStoreWithSchema(
      UNIQUE_INDEX_GRAPH,
      injector.backend,
    );
    // Duplicate `name` values, written before the unique index exists, so
    // the eventual `CREATE UNIQUE INDEX` fails for real.
    await store.nodes.Person.create({ name: "duplicate" });
    await store.nodes.Person.create({ name: "duplicate" });

    injector.arm();
    const result = await store.materializeIndexes();

    // The build itself genuinely failed (a real unique violation, not the
    // injected fault) — proving this reached the failure path at all.
    expect(result.results).toHaveLength(1);
    expect(requireDefined(result.results[0]).status).toBe("failed");
    // The injected 40001 landed on the failure-path record's first
    // attempt. Had that write not been routed through the retry owner, it
    // would have thrown out of `materializeWithClaim` uncaught instead of
    // `materializeIndexes` resolving with the failed entry above.
    expect(injector.lastFault()).toBeDefined();
  });
});
