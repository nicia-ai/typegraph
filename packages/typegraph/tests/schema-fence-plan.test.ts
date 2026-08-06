/**
 * The PostgreSQL schema fence's three consumers resolve one
 * {@link resolveWriteFencePlan} instead of emitting their locks
 * unconditionally, and they split on whether the lock is load-bearing.
 *
 * `acquireSchemaWriteFence` and `lockActiveSchemaVersion` fence a
 * read-then-write sequence that spans STATEMENTS, so they refuse an
 * `unfenced` backend like every other non-degradable fence: `commitSchemaVersion` reads the
 * active version and writes the flip in separate statements (its own comment
 * names this fence as what serializes that), and a managed write HOLDS its
 * `FOR SHARE` across the writes it guards. Dropping either lock leaves a
 * check-then-write window, not a slower-but-correct path.
 *
 * `schemaFenceInsertLockClause` is the one that degrades, because its
 * predicate is evaluated INSIDE the insert that depends on it. One statement
 * cannot race itself, so an empty clause is correct at any isolation level —
 * which is the posture SQLite has always run in.
 *
 * `unfenced` is what a Postgres-wire engine with no locking primitive
 * declares (DoltgreSQL, `dolthub/doltgresql#2600`). What it buys is a refusal
 * that names the missing capability, at construction, instead of a silent
 * race.
 *
 * Asserted on the SQL each site actually emits, never on a boolean, so the
 * test fails for the reason a caller would hit.
 *
 * *Mutation*: make `acquireSchemaWriteFence` ignore the plan and always take
 * the lock → the fenced rows still pass but the refusal row fails (the store
 * builds instead of refusing). *Mutation*: swap either `requireWriteFence`
 * call back to a bare `resolveWriteFencePlan` + `plan.kind === "lock"`
 * ternary → the refusal row fails, naming the fence that silently degraded.
 * *Mutation*: make `schemaFenceInsertLockClause` emit `FOR SHARE`
 * unconditionally → the SQLite degrade row fails. *Mutation*: make any site
 * always skip its lock → the corresponding fenced row fails.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  StaleVersionError,
} from "../src";
import { requireDefined } from "../src/utils/presence";
import {
  createLoggedPostgresBackend,
  createLoggedSqliteBackend,
  type LoggedBackend,
  UNFENCED_CAPABILITIES,
} from "./lock-fence-test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

function graphFor(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

const ADVISORY_LOCK = /pg_advisory_xact_lock/i;
const FOR_UPDATE = /for\s+update/i;
const FOR_SHARE = /for\s+share/i;
/** The fused managed insert: the fence rides in as a subquery it selects from. */
const FUSED_SCHEMA_FENCE_INSERT = /insert\s+into[\s\S]*schema_fence/i;

/**
 * Bootstraps a store and returns the statements the schema commit emitted,
 * separated from the ones a subsequent managed write emits — the sites are
 * gated by one plan but reached from different call paths.
 */
async function measure(
  logged: LoggedBackend,
  graphId: string,
): Promise<Readonly<{ commit: readonly string[]; write: readonly string[] }>> {
  logged.reset();
  const [store] = await createStoreWithSchema(
    graphFor(graphId),
    logged.backend,
  );
  const commit = logged.statements.map((statement) => statement.query);
  logged.reset();
  await store.nodes.Person.create({ name: "Alice" });
  const write = logged.statements.map((statement) => statement.query);
  return { commit, write };
}

describe("schema fence — a fenced PostgreSQL backend takes every lock", () => {
  it("emits the advisory lock and FOR UPDATE on commit, FOR SHARE on write", async () => {
    // No capabilities override: POSTGRES_CAPABILITIES declares
    // `{ advisoryLocks: true, tableLocks: true, serializedWriters: false }`,
    // which resolves `lock`.
    const logged = await createLoggedPostgresBackend();
    try {
      const { commit, write } = await measure(logged, "j14-fenced");
      expect(commit.some((query) => ADVISORY_LOCK.test(query))).toBe(true);
      expect(commit.some((query) => FOR_UPDATE.test(query))).toBe(true);
      // The fused insert carries its own FOR SHARE, so the lock shows up
      // INSIDE the INSERT rather than only as a standalone locking read.
      const fusedInsert = write.filter((query) =>
        FUSED_SCHEMA_FENCE_INSERT.test(query),
      );
      expect(fusedInsert.length).toBeGreaterThan(0);
      expect(fusedInsert.every((query) => FOR_SHARE.test(query))).toBe(true);
    } finally {
      await logged.close();
    }
  });
});

describe("schema fence — an unfenced PostgreSQL backend is refused, not degraded", () => {
  it("refuses the schema commit rather than running it without the lock", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      logged.reset();
      const error = await createStoreWithSchema(
        graphFor("j14-unfenced"),
        logged.backend,
      ).catch((error_: unknown) => error_);

      // The refusal names the missing capability rather than surfacing as a
      // SQL error, and it arrives before any lock statement was attempted.
      expect(error).toBeInstanceOf(Error);
      expect((error as { details?: { code?: string } }).details?.code).toBe(
        "WRITE_FENCE_UNAVAILABLE",
      );
      const attempted = logged.statements.map((statement) => statement.query);
      expect(attempted.filter((query) => ADVISORY_LOCK.test(query))).toEqual(
        [],
      );
      expect(attempted.filter((query) => FOR_UPDATE.test(query))).toEqual([]);
      expect(attempted.filter((query) => FOR_SHARE.test(query))).toEqual([]);
    } finally {
      await logged.close();
    }
  });

  it("refuses the managed write fence for the same reason", async () => {
    // Reached directly, because the store that would call it cannot be built
    // above. This is the half whose lock the transaction HOLDS across its
    // writes, so a degraded version would assert a version and then let the
    // flip it was checking for land before the write.
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      const error = await requireDefined(logged.backend.transaction)(
        async (tx) =>
          requireDefined(tx.lockSchemaVersionForWrite)({
            graphId: "j15-unfenced",
            expectedVersion: 1,
          }),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(Error);
      expect((error as { details?: { code?: string } }).details?.code).toBe(
        "WRITE_FENCE_UNAVAILABLE",
      );
      // Emphatically NOT a StaleVersionError: refusing for the missing
      // capability is the point, and reporting a stale version instead would
      // be the degraded behavior this test exists to forbid.
      expect(error).not.toBeInstanceOf(StaleVersionError);
    } finally {
      await logged.close();
    }
  });
});

describe("schema fence — the fused in-statement predicate runs without a lock clause", () => {
  it("fuses the fence into the insert on SQLite and still rejects a stale version", async () => {
    // SQLite resolves `engine-serialized` and has always passed an empty
    // clause here, so it is the shipped proof that an in-statement predicate
    // needs no lock: same fused INSERT, no locking clause, and the fence
    // still bites when the expected version is not the active one.
    const logged = createLoggedSqliteBackend();
    try {
      const { write } = await measure(logged, "j16-serialized");
      const fusedInsert = write.filter((query) =>
        FUSED_SCHEMA_FENCE_INSERT.test(query),
      );
      expect(fusedInsert.length).toBeGreaterThan(0);
      expect(fusedInsert.filter((query) => FOR_SHARE.test(query))).toEqual([]);

      const error = await requireDefined(logged.backend.transaction)(
        async (tx) =>
          requireDefined(tx.lockSchemaVersionForWrite)({
            graphId: "j16-serialized",
            expectedVersion: 99,
          }),
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(StaleVersionError);
    } finally {
      await logged.close();
    }
  });
});
