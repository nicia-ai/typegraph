/**
 * Conformance coverage for the write-fence declaration: does a real backend
 * built from a given `mechanism`/`drain` pair actually behave the way that
 * declaration promises, end to end, rather than only at the level of the
 * pure `resolveWriteFencePlan`/`requireWriteFence` functions (already
 * covered exhaustively by `tests/lock-fence-plan.test.ts`)?
 *
 * Five configurations: this lane's own bundled backend (PostgreSQL resolves
 * `{advisory, table-lock}`; SQLite resolves `engine-serialized`), plus three
 * backends derived from `buildPostgresEngineProfile` through
 * `deriveEngineProfile` with `declaredCapabilities.writeFence` overridden —
 * `{advisory, quiescent}`, `{caller-serialized}`, and
 * `{advisory, none}`. Every derived case only applies on a PostgreSQL-dialect
 * lane (SQLite and libsql skip it: there is no SQLite equivalent of "a
 * PostgreSQL profile with a different drain").
 *
 * Three things are checked wherever the configuration makes them
 * meaningful: a keyed acquisition blocks a concurrent acquisition of the
 * same key, and the read that follows observes the previous holder's
 * commit; a drain site (the identity-enablement node
 * lock, `lockIdentityEnablementNodes`) takes the table lock under
 * `"table-lock"`, takes no statement under `"quiescent"`, and refuses naming
 * the drain under `"none"`; and the session's real isolation level reaches
 * the coordination token `lockRecordedGraphWrite` mints, which match-key
 * convergence later reads back.
 *
 * Two of those need genuinely independent physical connections to mean
 * anything (a single-process engine cannot demonstrate one session blocking
 * another), so they run only when `context.serverLaneConcurrency` is `true`
 * — the two server-PostgreSQL lanes registered against a real, provisioned
 * database (`pnpm test:postgres`), never the in-process PGlite lane. Rather
 * than provision a database of their own (this module is imported by every
 * lane's shared suite at once, so a module-scoped
 * `provisionPostgresTestDatabase` call would race every one of those lanes
 * over the SAME isolated database name), they reuse
 * `context.createSerializedBackend()` twice: two independent connections to
 * the CURRENT lane's own already-migrated database. Every other assertion
 * needs only one live PostgreSQL-dialect connection and runs on an
 * in-process PGlite client, so it exercises every PostgreSQL-dialect lane
 * (the Docker lane, the `postgres-js` lane, and the zero-Docker PGlite lane)
 * regardless of `serverLaneConcurrency`.
 *
 * `row` (the portable, non-advisory keyed fence) adds two more
 * configurations, both derived the same way. `{row, quiescent, wait}` — the
 * fences relation on a lock-based engine, so a second acquirer of one key
 * blocks exactly like an advisory lock — runs assertions 2 (freshness), 3
 * (drain) and 4 (isolation fact) on both an in-process PGlite connection and
 * a real server-lane connection, plus assertion 1 (mutual exclusion) on two
 * real server-lane connections; `capabilities.writeFence` is declared
 * directly on the connection at construction (a PGlite profile derivation
 * for the in-process case, `context.createSerializedBackend({ capabilities
 * })` for the server-lane case), never retrofitted onto an already-built
 * backend, because both cases only ever exercise a KEYED lock site that reads
 * `resolveWriteFencePlan` off the object it is handed directly.
 * `{row, quiescent, commit-time}` — the fences relation on an
 * optimistic-concurrency engine: at `REPEATABLE READ`, PostgreSQL blocks the
 * second acquirer of one key on the fence row's lock and, once the holder
 * commits, raises a serialization failure (SQLSTATE 40001) from that
 * acquirer's own acquiring statement rather than letting it proceed — this
 * needs a real engine's actual commit-conflict behavior under
 * `REPEATABLE READ` (real PostgreSQL, not a simulation), so it
 * runs only on two real server-lane connections, each forced to that
 * isolation by a `deriveBackend` decorator over `transaction`/
 * `transactionWithNative`: this configuration exercises the schema-version
 * write fence, which resolves its plan off a `WriteFenceTarget` closed over
 * at CONSTRUCTION — a member no later `deriveBackend` overlay can reach — so
 * `mechanism: "row"` has to be declared on the connection from the start,
 * through `createSerializedBackend`'s own `capabilities` option, exactly like
 * `{row, quiescent, wait}` above.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  type FenceSql,
  resolveWriteFencePlan,
  type WriteFenceDeclaration,
} from "../../../src/backend/capabilities/write-fence";
import {
  assertGraphCommandConvergenceIsolation,
  graphCommandCoordinationIsolation,
  mintGraphCommandCoordination,
} from "../../../src/backend/command-contract";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generateVectorlessPostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import {
  createSqlBackend,
  deriveEngineProfile,
  type SqlEngineProfile,
} from "../../../src/backend/drizzle/engine";
import { type AnyPgTransaction } from "../../../src/backend/drizzle/execution/postgres-execution";
import { buildPostgresEngineProfile } from "../../../src/backend/drizzle/postgres";
import { postgresFenceSql } from "../../../src/backend/drizzle/postgres-fence-sql";
import {
  type AdapterBackend,
  type BackendCapabilities,
  type GraphBackend,
} from "../../../src/backend/types";
import {
  lockIdentityEnablementNodes,
  lockIdentityGraph,
} from "../../../src/identity/service-read";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { lockRecordedGraphWrite } from "../../../src/store/recorded-capture";
import { generateId } from "../../../src/utils/id";
import { requireDefined } from "../../../src/utils/presence";
import { createLoggedPgliteClient } from "../../lock-fence-test-utils";
import { type IntegrationTestContext } from "./test-context";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Overrides a real `buildPostgresEngineProfile` result's declared write
 * fence through `deriveEngineProfile` — never a hand-copied profile
 * literal.
 */
function deriveWriteFenceProfile(
  base: SqlEngineProfile<AnyPgTransaction>,
  writeFence: WriteFenceDeclaration,
  fenceSqlOverride?: FenceSql,
): SqlEngineProfile<AnyPgTransaction> {
  return deriveEngineProfile(base, {
    declaredCapabilities: {
      ...base.declaredCapabilities,
      writeFence,
    },
    ...(fenceSqlOverride === undefined ? {} : { fenceSql: fenceSqlOverride }),
  });
}

function withAdvisoryDrainCapabilities(
  capabilities: BackendCapabilities,
  drain: Extract<WriteFenceDeclaration, { mechanism: "advisory" }>["drain"],
): BackendCapabilities {
  return {
    ...capabilities,
    writeFence: { mechanism: "advisory", drain },
  };
}

/**
 * Overrides an already-live backend's declared write fence in place, through
 * `deriveBackend` — never a spread — for the two real-connection tests below,
 * which have a ready-made `GraphBackend` from
 * `context.createSerializedBackend()` rather than the raw Drizzle database a
 * profile needs to be built from.
 *
 * `deriveBackend` decorates the ROOT object only: `transaction` still
 * delegates to the base factory's own closure, which builds its `tx`
 * argument from the capabilities it closed over at construction, not from
 * whatever this wrapper's `capabilities` property reports. So the override
 * also replaces `transaction` itself, deriving the SAME override onto the
 * `tx` handle the real implementation hands to its callback — every lock
 * site a test below reaches runs inside `backend.transaction(...)`, and
 * without this the override would never reach `resolveWriteFencePlan` at
 * all. Each level re-derives from its OWN base capabilities (root's, or the
 * live transaction's) rather than reusing one captured copy, so a real
 * transaction's own `execution.atomicBatch: "session"` fact survives the
 * override instead of being replaced by the root's `"none"`.
 */
function deriveAdvisoryDrainOverride(
  backend: GraphBackend,
  drain: Extract<WriteFenceDeclaration, { mechanism: "advisory" }>["drain"],
): GraphBackend {
  return deriveBackend(backend, {
    capabilities: withAdvisoryDrainCapabilities(backend.capabilities, drain),
    transaction: (fn, options) =>
      backend.transaction(
        (tx) =>
          fn(
            deriveBackend(tx, {
              capabilities: withAdvisoryDrainCapabilities(
                tx.capabilities,
                drain,
              ),
            }),
          ),
        options,
      ),
  });
}

type ConformanceStatement = Readonly<{
  query: string;
  params: readonly unknown[];
}>;

/**
 * A real, in-process PostgreSQL-dialect connection (PGlite, no Docker), built
 * from the one shared capture primitive
 * (`tests/lock-fence-test-utils.ts`'s `createLoggedPgliteClient`) rather than
 * a second, independent driver-patch-plus-logger implementation — as a
 * profile rather than a backend, so a test can derive it through
 * `deriveEngineProfile` afterward. Seeded with
 * `generateVectorlessPostgresMigrationSQL`, the same DDL source
 * `buildPostgresEngineProfile`'s own `{ vector: false }` call below declares
 * this backend runs without.
 */
async function createConformancePostgresFixture(): Promise<
  Readonly<{
    profile: SqlEngineProfile<AnyPgTransaction>;
    statements: ConformanceStatement[];
    close: () => Promise<void>;
  }>
> {
  const { db, statements, close } = await createLoggedPgliteClient({
    ddl: generateVectorlessPostgresMigrationSQL(),
  });
  const profile = buildPostgresEngineProfile(db, { vector: false });
  return { profile, statements, close };
}

function capturedLockTableStatement(
  statements: readonly ConformanceStatement[],
): boolean {
  return statements.some((statement) => statement.query.includes("LOCK TABLE"));
}

/**
 * The one `{row, quiescent, wait}` declaration every test in that group below
 * derives its backend from: a lock-based fences relation, so a second
 * acquirer of one key blocks exactly like an advisory lock.
 */
const ROW_QUIESCENT_WAIT_WRITE_FENCE: Extract<
  WriteFenceDeclaration,
  { mechanism: "row" }
> = { mechanism: "row", drain: "quiescent", conflict: "wait" };

/**
 * The one `{row, quiescent, commit-time}` declaration the assertion-5 group
 * below derives its backend from: an optimistic-concurrency fences relation,
 * where PostgreSQL at `REPEATABLE READ` blocks the second acquirer of one
 * key on the fence row and raises a serialization failure from that
 * acquirer's own acquiring statement once the holder commits, rather than
 * letting both proceed — the owner then retries the loser to success.
 */
const ROW_QUIESCENT_COMMIT_TIME_WRITE_FENCE: Extract<
  WriteFenceDeclaration,
  { mechanism: "row" }
> = { mechanism: "row", drain: "quiescent", conflict: "commit-time" };

/**
 * Forces every transaction `backend` opens — through either `transaction` or
 * `transactionWithNative` — to REPEATABLE READ, regardless of what the
 * caller requests (a store-owned write asks for none). Real PostgreSQL fails
 * a second writer of a row another transaction has just committed a change
 * to with a genuine `40001` on the conflicting statement the instant it
 * unblocks, rather than waiting for it and applying cleanly the way READ
 * COMMITTED does — the engine behavior a `conflict: "commit-time"`
 * declaration promises, and what `optimistic-retry` exists to recover from.
 *
 * `capabilities.writeFence` itself is never touched here: it must be
 * declared on `backend` at CONSTRUCTION (`createSerializedBackend`'s own
 * `capabilities` option, below), because the schema-version write fence this
 * configuration exercises resolves its plan off a `WriteFenceTarget` closed
 * over when the backend was built — a member no later `deriveBackend`
 * overlay can reach, unlike the keyed sites `deriveAdvisoryDrainOverride`
 * above overrides, which read `resolveWriteFencePlan` off the object they are
 * handed directly.
 */
function deriveRepeatableReadTransactions(
  backend: AdapterBackend<unknown>,
): AdapterBackend<unknown> {
  return deriveBackend(backend, {
    transaction: (fn, options) =>
      backend.transaction(fn, {
        ...options,
        isolationLevel: "repeatable_read",
      }),
    transactionWithNative: (fn, options) =>
      backend.transactionWithNative(fn, {
        ...options,
        isolationLevel: "repeatable_read",
      }),
  });
}

/**
 * The one node kind the assertion-5 store-owned-create tests below share —
 * unconstrained and history-off, so the only fence a managed create on it
 * ever takes is the schema-version write fence every schema-managed write
 * takes regardless of history or revision tracking.
 */
const ConformanceOptimisticPerson = defineNode("ConformancePerson", {
  schema: z.object({ name: z.string() }),
});

export function registerWriteFenceConformanceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("write-fence conformance: mechanism and drain, end to end", () => {
    it("resolves this lane's own bundled mechanism and drain", () => {
      const backend = context.getBackend();
      const plan = resolveWriteFencePlan(backend);
      const expectedPlan =
        backend.dialect === "postgres" ?
          { kind: "lock", drain: "table-lock" }
        : { kind: "engine-serialized" };
      expect(plan).toMatchObject(expectedPlan);
    });

    it("the identity-enablement drain site behaves per the bundled mechanism", async () => {
      const backend = context.getBackend();
      const schema = createSqlSchema();
      const attempt =
        backend.dialect === "sqlite" ?
          lockIdentityEnablementNodes(backend, schema)
        : backend.transaction((tx) => lockIdentityEnablementNodes(tx, schema));
      await expect(attempt).resolves.toBeUndefined();
    });

    it('derived PostgreSQL profile {advisory, quiescent}: resolves "quiescent" and the drain site takes no table lock', async (ctx) => {
      if (context.getBackend().dialect !== "postgres") {
        ctx.skip();
        return;
      }
      const fixture = await createConformancePostgresFixture();
      try {
        const backend = createSqlBackend(
          deriveWriteFenceProfile(fixture.profile, {
            mechanism: "advisory",
            drain: "quiescent",
          }),
        );
        expect(resolveWriteFencePlan(backend)).toEqual(
          expect.objectContaining({
            kind: "lock",
            drain: "quiescent",
          }),
        );

        fixture.statements.splice(0);
        const schema = createSqlSchema();
        await backend.transaction((tx) =>
          lockIdentityEnablementNodes(tx, schema),
        );
        expect(capturedLockTableStatement(fixture.statements)).toBe(false);
      } finally {
        await fixture.close();
      }
    });

    it('derived PostgreSQL profile {caller-serialized}: resolves "caller-serialized" and the drain site takes no statement', async (ctx) => {
      if (context.getBackend().dialect !== "postgres") {
        ctx.skip();
        return;
      }
      const fixture = await createConformancePostgresFixture();
      try {
        const backend = createSqlBackend(
          deriveWriteFenceProfile(fixture.profile, {
            mechanism: "caller-serialized",
          }),
        );
        expect(resolveWriteFencePlan(backend)).toEqual({
          kind: "caller-serialized",
        });

        fixture.statements.splice(0);
        const schema = createSqlSchema();
        await backend.transaction((tx) =>
          lockIdentityEnablementNodes(tx, schema),
        );
        expect(
          fixture.statements.some(
            (statement) =>
              statement.query.includes("LOCK TABLE") ||
              statement.query.includes("pg_advisory"),
          ),
        ).toBe(false);
      } finally {
        await fixture.close();
      }
    });

    it('derived PostgreSQL profile {advisory, none}: resolves "none" and the drain site refuses, naming the drain', async (ctx) => {
      if (context.getBackend().dialect !== "postgres") {
        ctx.skip();
        return;
      }
      const fixture = await createConformancePostgresFixture();
      try {
        const backend = createSqlBackend(
          deriveWriteFenceProfile(fixture.profile, {
            mechanism: "advisory",
            drain: "none",
          }),
        );
        expect(resolveWriteFencePlan(backend)).toEqual(
          expect.objectContaining({
            kind: "lock",
            drain: "none",
          }),
        );

        const schema = createSqlSchema();
        await expect(
          backend.transaction((tx) => lockIdentityEnablementNodes(tx, schema)),
        ).rejects.toEqual(
          expect.objectContaining({
            details: expect.objectContaining({
              code: "WRITE_FENCE_UNAVAILABLE",
            }) as unknown,
          }),
        );
      } finally {
        await fixture.close();
      }
    });

    it("the session's real isolation reaches the coordination token for every advisory-mechanism config, and never for caller-serialized", async (ctx) => {
      if (context.getBackend().dialect !== "postgres") {
        ctx.skip();
        return;
      }
      const advisoryDrains: readonly Extract<
        WriteFenceDeclaration,
        { mechanism: "advisory" }
      >["drain"][] = ["table-lock", "quiescent", "none"];
      for (const drain of advisoryDrains) {
        const fixture = await createConformancePostgresFixture();
        try {
          const backend = createSqlBackend(
            deriveWriteFenceProfile(fixture.profile, {
              mechanism: "advisory",
              drain,
            }),
          );
          const graphId = `write-fence-conformance-${generateId()}`;
          await backend.transaction(async (tx) => {
            const lock = await lockRecordedGraphWrite(tx, graphId);
            const coordination = requireDefined(
              lock.coordination,
              "an advisory-mechanism lock always mints coordination",
            );
            expect(
              graphCommandCoordinationIsolation(
                tx.commands,
                graphId,
                coordination,
              ),
            ).toBe("read_committed");
          });
        } finally {
          await fixture.close();
        }
      }

      const fixture = await createConformancePostgresFixture();
      try {
        const backend = createSqlBackend(
          deriveWriteFenceProfile(fixture.profile, {
            mechanism: "caller-serialized",
          }),
        );
        await backend.transaction(async (tx) => {
          const lock = await lockRecordedGraphWrite(
            tx,
            `write-fence-conformance-${generateId()}`,
          );
          // No key was ever acquired, so there is nothing to certify: a
          // caller-serialized mechanism never mints a coordination token.
          expect(lock.coordination).toBeUndefined();
        });
      } finally {
        await fixture.close();
      }
    });

    it("a target with no isolationFactExpression refuses at construction, and an uncertified coordination refuses convergence", async (ctx) => {
      if (context.getBackend().dialect !== "postgres") {
        ctx.skip();
        return;
      }
      const fixture = await createConformancePostgresFixture();
      try {
        const incompleteFenceSql = {
          advisoryLockExpression: postgresFenceSql.advisoryLockExpression,
          lockTables: postgresFenceSql.lockTables,
        } as unknown as FenceSql;

        // `createSqlBackend` resolves the write-fence plan eagerly at
        // construction (the same gate that lets both bundled factories
        // refuse an incomplete `fenceSql` before a caller can reach it), so
        // this declaration never produces a usable backend to test
        // `lockRecordedGraphWrite` against — the refusal is synchronous,
        // right here.
        expect(() =>
          createSqlBackend(
            deriveWriteFenceProfile(
              fixture.profile,
              { mechanism: "advisory", drain: "table-lock" },
              incompleteFenceSql,
            ),
          ),
        ).toThrow(
          expect.objectContaining({
            details: expect.objectContaining({
              code: "WRITE_FENCE_SQL_UNAVAILABLE",
              member: "isolationFactExpression",
            }) as unknown,
          }),
        );

        // A coordination that never had a real isolation fact read into it
        // (exactly what the target above could never have produced, since it
        // cannot even be constructed) fails match-key convergence's own gate
        // the same way — the fact never reaches the token, so convergence
        // never trusts it. Any working command port demonstrates the gate;
        // this reuses the fixture's own default-declared backend rather than
        // building a third one.
        const backend = createSqlBackend(fixture.profile);
        const uncertified = mintGraphCommandCoordination(
          backend.commands,
          "write-fence-conformance-uncertified",
          "unknown",
        );
        expect(() => {
          assertGraphCommandConvergenceIsolation(backend.commands, uncertified);
        }).toThrow(
          expect.objectContaining({
            details: expect.objectContaining({
              code: "MATCH_KEY_CONVERGENCE_REQUIRES_FRESH_SNAPSHOT",
            }) as unknown,
          }),
        );
      } finally {
        await fixture.close();
      }
    });

    describe("server-lane concurrency (requires genuinely independent connections: a single process cannot demonstrate one session blocking another)", () => {
      it("a keyed advisory acquisition blocks a concurrent acquisition of the same key and then sees its commit, under every advisory-mechanism drain", async (ctx) => {
        if (
          context.getBackend().dialect !== "postgres" ||
          !context.serverLaneConcurrency
        ) {
          ctx.skip();
          return;
        }
        const advisoryDrains: readonly Extract<
          WriteFenceDeclaration,
          { mechanism: "advisory" }
        >["drain"][] = ["table-lock", "quiescent", "none"];
        for (const drain of advisoryDrains) {
          const connectionA = await context.createSerializedBackend();
          const connectionB = await context.createSerializedBackend();
          try {
            const backendA = deriveAdvisoryDrainOverride(
              connectionA.backend,
              drain,
            );
            const backendB = deriveAdvisoryDrainOverride(
              connectionB.backend,
              drain,
            );
            const graphId = `write-fence-conformance-${generateId()}`;
            const nodeId = generateId();
            const marker = generateId();

            // The two transactions below share ONE key (`graphId`), so if
            // the advisory lock genuinely excludes a concurrent acquisition
            // of that key, B cannot even start reading until A commits —
            // sequential `await`s on two backends could never distinguish
            // that from B simply running after A finished on its own.
            // Mutation-proven: deleting the `acquireKeyed` call from
            // `lockIdentityGraph`'s `lock` arm (`src/identity/service-read.ts`)
            // left `stillBlocked` false, since nothing then stopped B's
            // transaction from starting immediately.
            let releaseHolder: (() => void) | undefined;
            const holdLockOpen = new Promise<void>((resolve) => {
              releaseHolder = resolve;
            });
            let holderFinished = false;
            const holderTransaction = backendA
              .transaction(async (tx) => {
                // The override must reach the transaction handle the lock
                // site actually resolves, not only the root proxy.
                expect(resolveWriteFencePlan(tx)).toMatchObject({ drain });
                await lockIdentityGraph(tx, graphId);
                await tx.execute(
                  asCompiledRowsSql(sql`
                    INSERT INTO typegraph_nodes
                      (graph_id, kind, id, props, created_at, updated_at)
                    VALUES
                      ('write-fence-conformance', 'ConformanceProbe', ${nodeId}, ${JSON.stringify({ marker })}::jsonb, now(), now())
                  `),
                );
                await holdLockOpen;
              })
              .then(() => {
                holderFinished = true;
              });

            // No earlier signal than "the lock is actually held" is
            // available from the driver, so this waits a fixed interval for
            // connection A's advisory lock to land before connection B
            // races it.
            await delay(100);

            const readerTransaction = backendB.transaction(async (tx) => {
              await lockIdentityGraph(tx, graphId);
              const rows = await tx.execute<{ props: { marker: string } }>(
                asCompiledRowsSql(sql`
                  SELECT props FROM typegraph_nodes
                  WHERE graph_id = 'write-fence-conformance' AND id = ${nodeId}
                `),
              );
              return rows[0]?.props.marker;
            });

            const stillBlocked = await Promise.race([
              readerTransaction.then(() => false),
              delay(300).then(() => true),
            ]);
            // Snapshot and release before asserting, exactly as the
            // table-lock test below does: a failing `expect` must never
            // leave connection A parked on `holdLockOpen` forever.
            const holderFinishedBeforeRelease = holderFinished;
            releaseHolder?.();
            await holderTransaction;
            const markerSeenByReader = await readerTransaction;

            expect(stillBlocked).toBe(true);
            expect(holderFinishedBeforeRelease).toBe(false);
            expect(holderFinished).toBe(true);
            expect(markerSeenByReader).toBe(marker);
          } finally {
            await connectionA.close();
            await connectionB.close();
          }
        }
      });

      it("a table-lock drain blocks a concurrent row writer until the holder commits", async (ctx) => {
        if (
          context.getBackend().dialect !== "postgres" ||
          !context.serverLaneConcurrency
        ) {
          ctx.skip();
          return;
        }
        const connectionA = await context.createSerializedBackend();
        const connectionB = await context.createSerializedBackend();
        try {
          const backendA = connectionA.backend;
          const backendB = connectionB.backend;
          const schema = createSqlSchema();
          const nodeId = generateId();

          let releaseHolder: (() => void) | undefined;
          const holdLockOpen = new Promise<void>((resolve) => {
            releaseHolder = resolve;
          });
          let holderFinished = false;
          const holderTransaction = backendA
            .transaction(async (tx) => {
              await lockIdentityEnablementNodes(tx, schema);
              await holdLockOpen;
            })
            .then(() => {
              holderFinished = true;
            });

          // No earlier signal than "the lock is actually held" is available
          // from the driver, so this waits a fixed interval for connection
          // A's `LOCK TABLE` to land before connection B races it.
          await delay(100);

          const writerTransaction = backendB.transaction((tx) =>
            tx.execute(
              asCompiledRowsSql(sql`
                INSERT INTO typegraph_nodes
                  (graph_id, kind, id, props, created_at, updated_at)
                VALUES
                  ('write-fence-conformance', 'ConformanceProbe', ${nodeId}, '{}'::jsonb, now(), now())
              `),
            ),
          );

          const stillBlocked = await Promise.race([
            writerTransaction.then(() => false),
            delay(300).then(() => true),
          ]);
          // Snapshot before releasing: if the drain never actually blocked
          // (a broken guard), `writerTransaction` already settled above and
          // holding the lock open any longer serves nothing. Releasing and
          // awaiting both transactions BEFORE any assertion — rather than
          // after — means a failing `expect` below never leaves connection
          // A's transaction parked on `holdLockOpen` forever, which would
          // otherwise hang this test's `finally` on a connection that can
          // never close.
          const holderFinishedBeforeRelease = holderFinished;
          releaseHolder?.();
          await holderTransaction;
          await writerTransaction;

          expect(stillBlocked).toBe(true);
          expect(holderFinishedBeforeRelease).toBe(false);
          expect(holderFinished).toBe(true);
        } finally {
          await connectionA.close();
          await connectionB.close();
        }
      });
    });

    describe("row mechanism: {row, quiescent, wait} and {row, quiescent, commit-time}", () => {
      it('derived PostgreSQL profile {row, quiescent, wait} on PGlite: resolves "row"/"wait"; a read after re-acquiring a key observes the previous holder\'s commit (assertion 2), the drain site takes no table lock under "quiescent" (assertion 3), and the session\'s real isolation reaches the coordination token (assertion 4)', async (ctx) => {
        if (context.getBackend().dialect !== "postgres") {
          ctx.skip();
          return;
        }
        const fixture = await createConformancePostgresFixture();
        try {
          const backend = createSqlBackend(
            deriveWriteFenceProfile(
              fixture.profile,
              ROW_QUIESCENT_WAIT_WRITE_FENCE,
            ),
          );
          expect(resolveWriteFencePlan(backend)).toEqual(
            expect.objectContaining({
              kind: "row",
              drain: "quiescent",
              conflict: "wait",
            }),
          );

          // Assertion 2: a transaction that re-acquires the SAME key
          // observes the write the previous holder already committed.
          const graphId = `write-fence-conformance-row-${generateId()}`;
          const nodeId = generateId();
          const marker = generateId();
          await backend.transaction(async (tx) => {
            await lockIdentityGraph(tx, graphId);
            await tx.execute(
              asCompiledRowsSql(sql`
                INSERT INTO typegraph_nodes
                  (graph_id, kind, id, props, created_at, updated_at)
                VALUES
                  ('write-fence-conformance', 'ConformanceProbe', ${nodeId}, ${JSON.stringify({ marker })}::jsonb, now(), now())
              `),
            );
          });
          const observedMarker = await backend.transaction(async (tx) => {
            await lockIdentityGraph(tx, graphId);
            const rows = await tx.execute<{ props: { marker: string } }>(
              asCompiledRowsSql(sql`
                SELECT props FROM typegraph_nodes
                WHERE graph_id = 'write-fence-conformance' AND id = ${nodeId}
              `),
            );
            return rows[0]?.props.marker;
          });
          expect(observedMarker).toBe(marker);

          // Assertion 3: drain "quiescent" — a table-lock site takes no
          // statement.
          fixture.statements.splice(0);
          const schema = createSqlSchema();
          await backend.transaction((tx) =>
            lockIdentityEnablementNodes(tx, schema),
          );
          expect(capturedLockTableStatement(fixture.statements)).toBe(false);

          // Assertion 4: the session's real isolation reaches the
          // coordination token `lockRecordedGraphWrite` mints — the row
          // mechanism's `isolationFactExpression` rides the SAME acquisition
          // statement `postgresFenceSql` already supplies.
          await backend.transaction(async (tx) => {
            const lock = await lockRecordedGraphWrite(tx, graphId);
            const coordination = requireDefined(
              lock.coordination,
              "a row-mechanism lock always mints coordination",
            );
            expect(
              graphCommandCoordinationIsolation(
                tx.commands,
                graphId,
                coordination,
              ),
            ).toBe("read_committed");
          });
        } finally {
          await fixture.close();
        }
      });

      it('{row, quiescent, wait} on the server lane: resolves "row"/"wait" on a real connection; a read after re-acquiring a key observes the previous holder\'s commit (assertion 2), the drain site under "quiescent" resolves cleanly (assertion 3 — the "no LOCK TABLE statement" proof itself runs above, on PGlite, which supports statement capture), and the session\'s real isolation reaches the coordination token (assertion 4)', async (ctx) => {
        if (
          context.getBackend().dialect !== "postgres" ||
          !context.serverLaneConcurrency
        ) {
          ctx.skip();
          return;
        }
        const connection = await context.createSerializedBackend({
          capabilities: { writeFence: ROW_QUIESCENT_WAIT_WRITE_FENCE },
        });
        try {
          const backend = connection.backend;
          expect(resolveWriteFencePlan(backend)).toEqual(
            expect.objectContaining({
              kind: "row",
              drain: "quiescent",
              conflict: "wait",
            }),
          );

          const graphId = `write-fence-conformance-row-server-${generateId()}`;
          const nodeId = generateId();
          const marker = generateId();
          await backend.transaction(async (tx) => {
            await lockIdentityGraph(tx, graphId);
            await tx.execute(
              asCompiledRowsSql(sql`
                INSERT INTO typegraph_nodes
                  (graph_id, kind, id, props, created_at, updated_at)
                VALUES
                  ('write-fence-conformance', 'ConformanceProbe', ${nodeId}, ${JSON.stringify({ marker })}::jsonb, now(), now())
              `),
            );
          });
          const observedMarker = await backend.transaction(async (tx) => {
            await lockIdentityGraph(tx, graphId);
            const rows = await tx.execute<{ props: { marker: string } }>(
              asCompiledRowsSql(sql`
                SELECT props FROM typegraph_nodes
                WHERE graph_id = 'write-fence-conformance' AND id = ${nodeId}
              `),
            );
            return rows[0]?.props.marker;
          });
          expect(observedMarker).toBe(marker);

          const schema = createSqlSchema();
          await expect(
            backend.transaction((tx) =>
              lockIdentityEnablementNodes(tx, schema),
            ),
          ).resolves.toBeUndefined();

          await backend.transaction(async (tx) => {
            const lock = await lockRecordedGraphWrite(tx, graphId);
            const coordination = requireDefined(
              lock.coordination,
              "a row-mechanism lock always mints coordination",
            );
            expect(
              graphCommandCoordinationIsolation(
                tx.commands,
                graphId,
                coordination,
              ),
            ).toBe("read_committed");
          });
        } finally {
          await connection.close();
        }
      });

      describe("server-lane concurrency (requires genuinely independent connections: a single process cannot demonstrate one session blocking another)", () => {
        it("row/quiescent/wait: a keyed row acquisition blocks a concurrent acquisition of the same key and then sees its commit (assertion 1, scoped to waiting mechanisms)", async (ctx) => {
          if (
            context.getBackend().dialect !== "postgres" ||
            !context.serverLaneConcurrency
          ) {
            ctx.skip();
            return;
          }
          const connectionA = await context.createSerializedBackend({
            capabilities: { writeFence: ROW_QUIESCENT_WAIT_WRITE_FENCE },
          });
          const connectionB = await context.createSerializedBackend({
            capabilities: { writeFence: ROW_QUIESCENT_WAIT_WRITE_FENCE },
          });
          try {
            const backendA = connectionA.backend;
            const backendB = connectionB.backend;
            const graphId = `write-fence-conformance-row-${generateId()}`;
            const nodeId = generateId();
            const marker = generateId();

            // Warm the fence row for this key BEFORE the concurrency phase,
            // uncontended, and let it commit. A real deployment's fence row
            // is essentially always already committed by the time a second
            // writer contends for it; acquiring a brand-new key below would
            // make the holder's acquisition a speculative INSERT, which
            // PostgreSQL blocks a conflicting concurrent INSERT against
            // regardless of the row's ON CONFLICT action — so this exact
            // test would pass even if `acquireKeyed`'s `DO UPDATE` were
            // replaced with a `DO NOTHING` that takes no row lock on an
            // existing row. Warming the row first forces the holder's
            // acquisition onto the `DO UPDATE` arm actually under test.
            await backendA.transaction((tx) => lockIdentityGraph(tx, graphId));

            let releaseHolder: (() => void) | undefined;
            const holdLockOpen = new Promise<void>((resolve) => {
              releaseHolder = resolve;
            });
            let holderFinished = false;
            const holderTransaction = backendA
              .transaction(async (tx) => {
                expect(resolveWriteFencePlan(tx)).toMatchObject({
                  kind: "row",
                  conflict: "wait",
                });
                await lockIdentityGraph(tx, graphId);
                await tx.execute(
                  asCompiledRowsSql(sql`
                    INSERT INTO typegraph_nodes
                      (graph_id, kind, id, props, created_at, updated_at)
                    VALUES
                      ('write-fence-conformance', 'ConformanceProbe', ${nodeId}, ${JSON.stringify({ marker })}::jsonb, now(), now())
                  `),
                );
                await holdLockOpen;
              })
              .then(() => {
                holderFinished = true;
              });

            // No earlier signal than "the fence row is actually held" is
            // available from the driver, so this waits a fixed interval for
            // connection A's acquisition to land before connection B races
            // it — the same convention the advisory-mechanism test above
            // follows.
            await delay(100);

            const readerTransaction = backendB.transaction(async (tx) => {
              await lockIdentityGraph(tx, graphId);
              const rows = await tx.execute<{ props: { marker: string } }>(
                asCompiledRowsSql(sql`
                  SELECT props FROM typegraph_nodes
                  WHERE graph_id = 'write-fence-conformance' AND id = ${nodeId}
                `),
              );
              return rows[0]?.props.marker;
            });

            const stillBlocked = await Promise.race([
              readerTransaction.then(() => false),
              delay(300).then(() => true),
            ]);
            const holderFinishedBeforeRelease = holderFinished;
            releaseHolder?.();
            await holderTransaction;
            const markerSeenByReader = await readerTransaction;

            expect(stillBlocked).toBe(true);
            expect(holderFinishedBeforeRelease).toBe(false);
            expect(holderFinished).toBe(true);
            expect(markerSeenByReader).toBe(marker);
          } finally {
            await connectionA.close();
            await connectionB.close();
          }
        });

        it("row/quiescent/commit-time under REPEATABLE READ: two concurrent store-owned creates acquire the same fence row, the second blocks and then fails with a serialization failure once the holder commits, and the owner retries it to success within budget, with hooks observed exactly once (assertion 5)", async (ctx) => {
          if (
            context.getBackend().dialect !== "postgres" ||
            !context.serverLaneConcurrency
          ) {
            ctx.skip();
            return;
          }
          const connectionA = await context.createSerializedBackend({
            capabilities: { writeFence: ROW_QUIESCENT_COMMIT_TIME_WRITE_FENCE },
          });
          const connectionB = await context.createSerializedBackend({
            capabilities: { writeFence: ROW_QUIESCENT_COMMIT_TIME_WRITE_FENCE },
          });
          try {
            const backendA = deriveRepeatableReadTransactions(
              connectionA.backend,
            );
            const backendB = deriveRepeatableReadTransactions(
              connectionB.backend,
            );
            expect(backendA.capabilities.execution.unitOfWork).toBe(
              "optimistic-retry",
            );
            expect(backendB.capabilities.execution.unitOfWork).toBe(
              "optimistic-retry",
            );

            const graph = defineGraph({
              id: `write-fence-conformance-optimistic-${generateId()}`,
              nodes: {
                ConformancePerson: { type: ConformanceOptimisticPerson },
              },
              edges: {},
            });

            // Bootstrap the schema through A first: B joins the SAME,
            // already-committed schema version rather than racing A to
            // commit it, so the only conflict under test below is the WRITE
            // fence, never the schema commit.
            const [storeA] = await createAdapterStoreWithSchema(
              graph,
              backendA,
            );
            const starts: number[] = [];
            const ends: number[] = [];
            const errors: Error[] = [];
            const [storeB] = await createAdapterStoreWithSchema(
              graph,
              backendB,
              {
                hooks: {
                  onOperationStart: (opContext) =>
                    starts.push(opContext.attempt ?? 1),
                  onOperationEnd: () => ends.push(1),
                  onError: (_opContext, error) => errors.push(error),
                },
              },
            );

            const holderNodeId = generateId();
            const conflictingNodeId = generateId();

            // A holds the fence row open past its own create by staying
            // inside an explicit `store.transaction`, using the same
            // hold-then-observe idiom as every other concurrency test in
            // this file — deterministic, rather than hoping two bare
            // `Promise.all`-launched creates happen to overlap.
            let releaseHolder: (() => void) | undefined;
            const holdLockOpen = new Promise<void>((resolve) => {
              releaseHolder = resolve;
            });
            let holderFinished = false;
            const holderTransaction = storeA
              .transaction(async (tx) => {
                await tx.nodes.ConformancePerson.create(
                  { name: "holder" },
                  { id: holderNodeId },
                );
                await holdLockOpen;
              })
              .then(() => {
                holderFinished = true;
              });

            // No earlier signal than "the fence row is actually held" is
            // available from the driver, so this waits a fixed interval for
            // connection A's nested create to land before connection B
            // races it.
            await delay(100);

            const conflictingCreate = storeB.nodes.ConformancePerson.create(
              { name: "loser" },
              { id: conflictingNodeId },
            );

            const stillBlocked = await Promise.race([
              conflictingCreate.then(() => false),
              delay(300).then(() => true),
            ]);
            const holderFinishedBeforeRelease = holderFinished;
            releaseHolder?.();
            await holderTransaction;

            // B's attempt was genuinely blocked on A's held fence row
            // (proving the two acquisitions actually contended on ONE key),
            // and once A committed, B's blocked statement woke to a real
            // REPEATABLE READ serialization failure on the very next
            // statement. The only way `conflictingCreate` resolves rather
            // than rejects with `TransactionConflictError` after that is
            // that `runInWriteTransaction` retried the whole unit and its
            // second attempt — a fresh transaction opened past A's commit —
            // succeeded.
            const conflictingCreated = await conflictingCreate;
            expect(conflictingCreated.id).toBe(conflictingNodeId);

            expect(stillBlocked).toBe(true);
            expect(holderFinishedBeforeRelease).toBe(false);
            expect(holderFinished).toBe(true);
            // The internal retry lives entirely inside `runInWriteTransaction`:
            // the outer operation-hook boundary wraps the whole (possibly
            // replayed) unit, so `onOperationStart`/`onOperationEnd` fire
            // exactly once each on B, exactly as they do under the
            // "interactive" tier.
            expect(starts).toEqual([1]);
            expect(ends).toEqual([1]);
            expect(errors).toEqual([]);
            expect(
              await storeB.nodes.ConformancePerson.getById(
                conflictingCreated.id,
              ),
            ).toBeDefined();
          } finally {
            await connectionA.close();
            await connectionB.close();
          }
        });
      });
    });
  });
}
