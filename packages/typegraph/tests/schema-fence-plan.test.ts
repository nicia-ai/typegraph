/**
 * J14/J15 — the Postgres schema fence's two halves consult the resolved
 * {@link resolveWriteFencePlan} instead of emitting their locks
 * unconditionally.
 *
 * These are the only two DEGRADING lock sites: J1-J8 call `requireWriteFence`
 * and refuse an `unfenced` backend, while these two skip the lock and keep
 * the compare-and-swap they fence. `unfenced` is the CAS-only posture the
 * capability model names, and it is what makes a Postgres-wire engine with no
 * locking primitive (DoltgreSQL, `dolthub/doltgresql#2600`) usable for
 * everything except `history` / `revisionTracking` and Operational Identity,
 * which their own construction gates still refuse.
 *
 * Asserted on the SQL each site actually emits, never on a boolean, so the
 * test fails for the reason a Doltgres user would.
 *
 * *Mutation*: make `acquireSchemaWriteFence` ignore the plan and always take
 * the lock → the two unfenced rows fail (advisory lock and `FOR UPDATE`
 * reappear). *Mutation*: make `lockActiveSchemaVersion` always append
 * `FOR SHARE` → the unfenced writer row fails. *Mutation*: make either site
 * always skip → the corresponding fenced row fails. *Mutation*: drop the
 * version assertion from the unfenced path → the CAS row fails.
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

function emitted(logged: LoggedBackend, pattern: RegExp): boolean {
  return logged.statements.some((statement) => pattern.test(statement.query));
}

/**
 * Bootstraps a store and returns the statements the schema commit emitted,
 * separated from the ones a subsequent managed write emits — the two halves
 * are gated by one plan but reached from different call paths.
 */
async function measure(
  capabilities: Parameters<typeof createLoggedPostgresBackend>[0],
  graphId: string,
): Promise<
  Readonly<{
    logged: LoggedBackend;
    commit: readonly string[];
    write: readonly string[];
  }>
> {
  const logged = await createLoggedPostgresBackend(capabilities);
  logged.reset();
  const graph = graphFor(graphId);
  const [store] = await createStoreWithSchema(graph, logged.backend);
  const commit = logged.statements.map((statement) => statement.query);
  logged.reset();
  await store.nodes.Person.create({ name: "Alice" });
  const write = logged.statements.map((statement) => statement.query);
  return { logged, commit, write };
}

describe("J14/J15 — a fenced PostgreSQL backend still takes both locks", () => {
  it("emits the advisory lock and FOR UPDATE on commit, FOR SHARE on write", async () => {
    // No capabilities override: POSTGRES_CAPABILITIES declares
    // `{ advisoryLocks: true, tableLocks: true, serializedWriters: false }`,
    // which resolves `lock`.
    const { logged, commit, write } = await measure(undefined, "j14-fenced");
    try {
      expect(commit.some((query) => ADVISORY_LOCK.test(query))).toBe(true);
      expect(commit.some((query) => FOR_UPDATE.test(query))).toBe(true);
      expect(write.some((query) => FOR_SHARE.test(query))).toBe(true);
    } finally {
      await logged.close();
    }
  });
});

describe("J14/J15 — an unfenced PostgreSQL backend takes neither", () => {
  it("emits no advisory lock and no row-locking clause anywhere", async () => {
    const { logged, commit, write } = await measure(
      { pessimisticLocks: UNFENCED_CAPABILITIES },
      "j14-unfenced",
    );
    try {
      // The whole point: on DoltgreSQL every one of these is a hard error
      // (`function: 'pg_advisory_xact_lock' not found`, `locking clauses are
      // not yet supported`), so a single survivor fails bootstrap outright.
      expect(commit.filter((query) => ADVISORY_LOCK.test(query))).toEqual([]);
      expect(commit.filter((query) => FOR_UPDATE.test(query))).toEqual([]);
      expect(write.filter((query) => FOR_SHARE.test(query))).toEqual([]);
      // Degraded, not disabled: the commit still happened.
      expect(commit.length).toBeGreaterThan(0);
    } finally {
      await logged.close();
    }
  });

  it("keeps the compare-and-swap the skipped lock used to serialize", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      await createStoreWithSchema(graphFor("j15-cas"), logged.backend);
      // The write fence reads the active version WITHOUT `FOR SHARE` now, but
      // the version it reads still feeds `assertActiveSchemaVersion` — so a
      // writer holding a stale expectation is rejected exactly as before.
      // Only the WAIT is lost, never the check.
      const error = await requireDefined(logged.backend.transaction)(
        async (tx) =>
          requireDefined(tx.lockSchemaVersionForWrite)({
            graphId: "j15-cas",
            expectedVersion: 99,
          }),
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(StaleVersionError);
      expect(emitted(logged, FOR_SHARE)).toBe(false);
    } finally {
      await logged.close();
    }
  });
});
