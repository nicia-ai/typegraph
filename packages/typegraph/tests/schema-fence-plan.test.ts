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
 * There is no `unfenced` row here: both consumers read a `fenceTarget`
 * `createSqlBackend` closes over once at construction, from the SAME
 * finalized capabilities its own construction-time gate already required to
 * carry a `writeFence` declaration — so, unlike the call-time-parameter lock
 * sites `tests/lock-fence-plan.test.ts` covers, no backend this factory
 * builds can ever reach these two consumers in an unfenced state, and no
 * overlay applied to the returned backend can change that closure after the
 * fact. `requireWriteFence`'s own `unfenced` refusal is covered directly
 * where it IS reachable — the "undeclared non-factory" rows in
 * `tests/lock-fence-plan.test.ts` — rather than restated here.
 *
 * Asserted on the SQL each site actually emits, never on a boolean, so the
 * test fails for the reason a caller would hit.
 *
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
    // `writeFence: { mechanism: "advisory", drain: "table-lock" }`, which
    // resolves `lock`.
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
