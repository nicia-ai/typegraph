/**
 * Concurrent identity writers on a `history: true` store: a second session's
 * assertion or retraction waits on the first session's open identity
 * transaction (observed as a lock wait on the server, not inferred from
 * timing), and once both commit the transition log records them in revision
 * order and `replay` agrees with `asOfRecorded` membership at every step.
 */
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import {
  asRecordedInstant,
  recordedInstantRevision,
} from "../../../src/core/temporal";
import { requireDefined } from "../../../src/utils/presence";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const databaseUrl = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", { schema: z.object({}) });

const LOCK_WAIT_DEADLINE_MS = 10_000;
const LOCK_WAIT_POLL_MS = 10;

let pool: Pool | undefined;
let probe: Pool | undefined;

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({ connectionString: databaseUrl, max: 2 });
  const observer = new Pool({ connectionString: databaseUrl, max: 1 });
  await runServerSuiteSetup(
    "concurrent identity history",
    [candidate, observer],
    async () => {
      await candidate.query(generatePostgresMigrationSQL());
    },
  );
  pool = candidate;
  probe = observer;
});

afterAll(async () => {
  await pool?.end();
  await probe?.end();
});

async function backendPid(client: PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  return requireDefined(result.rows[0]).pid;
}

/** Resolves once session `pid` waits on a lock; fails if `operation` settles first. */
async function expectLockWait(
  pid: number,
  operation: Promise<unknown>,
): Promise<void> {
  const state = { settled: false };
  void operation.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS;
  while (Date.now() < deadline) {
    expect(state.settled, "the second writer did not wait").toBe(false);
    const waiting = await requireDefined(probe).query<{ waiting: boolean }>(
      `SELECT wait_event_type = 'Lock' AS waiting
       FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    );
    if (waiting.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_POLL_MS));
  }
  throw new Error(
    `Session ${String(pid)} never waited on a lock within ${String(LOCK_WAIT_DEADLINE_MS)} ms.`,
  );
}

async function twoSessions(id: string) {
  const activePool = requireDefined(pool);
  const first = await activePool.connect();
  const second = await activePool.connect();
  const release = () => {
    first.release();
    second.release();
  };
  try {
    const graph = defineGraph({
      id,
      nodes: { Person: { type: Person } },
      edges: {},
      identity: { sameIdAcrossKinds: "ignore" },
    });
    const [holder] = await createStoreWithSchema(
      graph,
      createPostgresBackend(drizzle(first)),
      { history: true },
    );
    const [waiter] = await createStoreWithSchema(
      graph,
      createPostgresBackend(drizzle(second)),
      { history: true },
    );
    return { holder, waiter, waiterPid: await backendPid(second), release };
  } catch (error) {
    release();
    throw error;
  }
}

function ref(id: string) {
  return { kind: "Person" as const, id };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "concurrent identity writers with history",
  () => {
    it.each(["assertSame", "retract"] as const)(
      "orders a waiting %s after the open identity transaction, and replay matches asOfRecorded",
      async (waitingWrite) => {
        const { holder, waiter, waiterPid, release } = await twoSessions(
          `concurrent_identity_history_${waitingWrite}`,
        );
        const inside = createGate();
        const commit = createGate();
        let holding: Promise<unknown> | undefined;
        let waiting: Promise<unknown> | undefined;
        try {
          for (const id of ["a", "b", "c"]) {
            await holder.nodes.Person.create({}, { id });
          }
          const seeded = await holder.identity.assertSame(ref("b"), ref("c"));

          holding = holder.transaction(async (tx) => {
            await tx.identity.assertSame(ref("a"), ref("b"));
            inside.open();
            await commit.opened;
          });
          expect(await raceTimeout(inside.opened, 5000)).not.toBe(
            TIMEOUT_SENTINEL,
          );
          waiting =
            waitingWrite === "assertSame" ?
              waiter.identity.assertSame(ref("c"), ref("a"))
            : waiter.identity.retractAssertion(seeded.assertion.id);
          await expectLockWait(waiterPid, waiting);
          commit.open();
          await holding;
          await waiting;

          const history = await holder.identity.transitionsOf(ref("a"));
          const revisions = history.transitions.map((transition) =>
            recordedInstantRevision(asRecordedInstant(transition.recorded)),
          );
          console.info("transition revisions", history.transitions);
          expect(revisions).toEqual(
            revisions.toSorted((left, right) => left - right),
          );

          const replay = await holder.identity.replay(ref("a"));
          expect(replay.steps.length).toBeGreaterThanOrEqual(
            waitingWrite === "retract" ? 2 : 1,
          );
          for (const step of replay.steps) {
            const members = await holder
              .asOfRecorded(asRecordedInstant(step.transition.recorded))
              .identity.membersOf(ref("a"));
            expect(
              step.after.map((member) => member.id).toSorted(),
              `replay step at ${step.transition.recorded}`,
            ).toEqual(members.map((member) => member.id).toSorted());
          }
          const current = await holder.identity.membersOf(ref("a"));
          const finalMembers = current.map((member) => member.id).toSorted();
          expect(finalMembers).toEqual(
            waitingWrite === "retract" ? ["a", "b"] : ["a", "b", "c"],
          );
        } finally {
          commit.open();
          await Promise.allSettled([holding, waiting]);
          release();
        }
      },
    );
  },
);
