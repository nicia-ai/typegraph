/**
 * `createSqlBackend`'s `caller-serialized` write-fence queue
 * (`src/backend/drizzle/engine/create-sql-backend.ts`): the in-process half
 * of the promise a `writeFence: { mechanism: "caller-serialized" }`
 * declaration makes — every write unit this backend issues is serialized
 * through one queue, reads are not, a root write submitted from inside a
 * transaction callback is refused rather than deadlocking, and the members
 * wrapped are exactly the write-member taxonomy plus the two transaction
 * openers.
 *
 * Both bundled dialects declare a `caller-serialized` write fence here
 * through `capabilities.writeFence` — the SAME override shape
 * `tests/engine-profile-refusals.test.ts` uses to prove the two bundled
 * factories accept it — so every case below exercises the real
 * `createSqlBackend` path, not a hand-built fixture.
 */
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import { buildCallerSerializedBackend } from "../src/backend/drizzle/engine/create-sql-backend";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { GRAPH_BACKEND_MEMBER_CLASSES } from "../src/backend/member-classes";
import { type AdapterBackend } from "../src/backend/types";
import { WRITE_MEMBER_KEYS } from "../src/store/operations/write-members";
import {
  createLoggedPostgresBackend,
  createLoggedSqliteBackend,
  type LoggedBackend,
} from "./lock-fence-test-utils";

const CALLER_SERIALIZED_QUIESCENT = {
  writeFence: { mechanism: "caller-serialized", drain: "quiescent" },
} as const;

const QueuePerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const queueGraph = defineGraph({
  id: "caller_serialized_queue",
  nodes: { Person: { type: QueuePerson } },
  edges: {},
});

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Every statement in `logged` whose params (JSON-stringified) mention `needle`. */
function statementIndicesMentioning(
  logged: LoggedBackend,
  needle: string,
): number[] {
  return logged.statements.flatMap((statement, index) =>
    JSON.stringify(statement.params).includes(needle) ? [index] : [],
  );
}

type QueuedEngine = Readonly<{
  name: "sqlite" | "postgres";
  build: () => Promise<LoggedBackend>;
}>;

const QUEUED_ENGINES: readonly QueuedEngine[] = [
  {
    name: "sqlite",
    build: () =>
      Promise.resolve(createLoggedSqliteBackend(CALLER_SERIALIZED_QUIESCENT)),
  },
  {
    name: "postgres",
    build: () => createLoggedPostgresBackend(CALLER_SERIALIZED_QUIESCENT),
  },
];

describe.each(QUEUED_ENGINES)(
  "caller-serialized queue ($name)",
  ({ build }) => {
    it("never interleaves two concurrent root creates' statements", async () => {
      const logged = await build();
      cleanups.push(logged.close);
      const [store] = await createStoreWithSchema(queueGraph, logged.backend);
      logged.reset();

      await Promise.all([
        store.nodes.Person.create({ name: "QueueOrderAlpha" }),
        store.nodes.Person.create({ name: "QueueOrderBravo" }),
      ]);

      const alphaIndices = statementIndicesMentioning(
        logged,
        "QueueOrderAlpha",
      );
      const bravoIndices = statementIndicesMentioning(
        logged,
        "QueueOrderBravo",
      );
      expect(alphaIndices.length).toBeGreaterThan(0);
      expect(bravoIndices.length).toBeGreaterThan(0);

      const lastAlpha = Math.max(...alphaIndices);
      const firstBravo = Math.min(...bravoIndices);
      const lastBravo = Math.max(...bravoIndices);
      const firstAlpha = Math.min(...alphaIndices);

      // Whichever create the queue ran first, EVERY one of its statements —
      // through its commit — precedes every statement of the other: the two
      // index ranges never overlap.
      const alphaThenBravo = lastAlpha < firstBravo;
      const bravoThenAlpha = lastBravo < firstAlpha;
      expect(alphaThenBravo || bravoThenAlpha).toBe(true);
    });

    it("refuses a root write submitted from inside a transaction callback", async () => {
      const logged = await build();
      cleanups.push(logged.close);
      const [store] = await createStoreWithSchema(queueGraph, logged.backend);

      await expect(
        store.transaction(async () => {
          await store.nodes.Person.create({ name: "Reentrant" });
        }),
      ).rejects.toThrow(ConfigurationError);

      // The rejected transaction rolled back cleanly; the queue is not stuck
      // holding a slot the failed submission never released.
      await store.nodes.Person.create({ name: "AfterRejection" });
      const people = await store.nodes.Person.find({ limit: 10 });
      expect(people.map((person) => person.name).toSorted()).toEqual([
        "AfterRejection",
      ]);
    });
  },
);

// Racing two root writes' internal steps, or a read against a slow root
// write, through a REAL driver is not a clean proof either way: both
// bundled dialects self-serialize independently of this feature — PGlite
// processes every `.query()`/`.transaction()` call on its one client through
// its own internal queue, and better-sqlite3's per-connection queue
// (`sqlite.ts`, unrelated to `buildCallerSerializedBackend`) already
// serializes every `transaction()` call — so two concurrent root creates
// never interleaving, or a slow write blocking a read, would be true with or
// without the wrapping this suite targets; dropping the queue could not
// reveal that. A minimal stub backend sidesteps this: `insertNode` and
// `getNode` are the only two members with a real implementation, so any
// ordering or blocking observed can only be evidence about the wrapping
// itself, and removing it changes these tests' outcome for real.
type StubBackendMember = (...args: readonly unknown[]) => Promise<unknown>;

function notUsedStubMember(): Promise<never> {
  return Promise.reject(new Error("not used by this test"));
}

function buildStubBackend(
  members: Readonly<{
    insertNode: StubBackendMember;
    getNode: StubBackendMember;
  }>,
): AdapterBackend<unknown> {
  const notUsed: StubBackendMember = notUsedStubMember;
  const stub = {
    dialect: "sqlite",
    commands: { session: "root" as const, execute: notUsed },
    insertNode: members.insertNode,
    getNode: members.getNode,
    transaction: notUsed,
    transactionWithNative: notUsed,
    close: () => Promise.resolve(),
  };
  // Deliberately partial: `buildQueuedWriteUnits` reads every member through
  // `Reflect.get` and skips whatever is absent, so a stub naming only the
  // two members this test exercises is a faithful (if minimal) backend for
  // it, not a shortcut around real member resolution.
  return stub as unknown as AdapterBackend<unknown>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("caller-serialized queue: write serialization (stub)", () => {
  it("never interleaves two concurrent queued writes' internal steps", async () => {
    const steps: string[] = [];
    // Each call logs a step, YIELDS (twice), then logs the next — real room
    // for a second concurrent call's steps to land in between if this
    // backend's `insertNode` were not routed through one queue.
    let callCount = 0;
    const stub = buildStubBackend({
      insertNode: async () => {
        callCount += 1;
        const label = callCount === 1 ? "A" : "B";
        steps.push(`${label}:start`);
        await delay(10);
        steps.push(`${label}:middle`);
        await delay(10);
        steps.push(`${label}:end`);
        return { id: label };
      },
      getNode: () => Promise.resolve({ id: "unused" }),
    });
    const queuedBackend = buildCallerSerializedBackend(stub);
    const queuedInsertNode =
      queuedBackend.insertNode as unknown as StubBackendMember;

    await Promise.all([queuedInsertNode(), queuedInsertNode()]);

    const aEnd = steps.indexOf("A:end");
    const bStart = steps.indexOf("B:start");
    const bEnd = steps.indexOf("B:end");
    const aStart = steps.indexOf("A:start");
    // Whichever call the queue ran first, every one of its steps — through
    // its own last step — precedes every step of the other.
    const aThenB = aEnd < bStart;
    const bThenA = bEnd < aStart;
    expect(aThenB || bThenA).toBe(true);
  });
});

describe("caller-serialized queue: reads bypass it", () => {
  it("resolves a concurrent read before a slow queued write settles", async () => {
    let writeSettled = false;
    const stub = buildStubBackend({
      insertNode: async () => {
        await delay(150);
        writeSettled = true;
        return { id: "slow-write" };
      },
      getNode: () => Promise.resolve({ id: "read" }),
    });
    const queuedBackend = buildCallerSerializedBackend(stub);
    const queuedInsertNode =
      queuedBackend.insertNode as unknown as StubBackendMember;
    const queuedGetNode = queuedBackend.getNode as unknown as StubBackendMember;

    const writePromise = queuedInsertNode();
    await delay(20);

    const readResult = await queuedGetNode();
    expect(readResult).toEqual({ id: "read" });
    // The read above resolved while the slow write was still pending — it
    // was never queued behind it.
    expect(writeSettled).toBe(false);

    await writePromise;
    expect(writeSettled).toBe(true);
  });
});

// ============================================================
// Direct proof that the wrapping covers exactly the write-member taxonomy
// plus the two transaction openers, and nothing else — isolated from the
// closures `createSqlBackend` builds fresh on every construction (see
// `buildCallerSerializedBackend`'s own doc comment for why this needs a
// single shared base object rather than two independent backends).
// ============================================================

const QUEUED_ROOT_MEMBER_KEYS = [
  ...WRITE_MEMBER_KEYS,
  "transaction",
  "transactionWithNative",
] as const;

function buildPlainSqliteBackend(): Readonly<{
  backend: AdapterBackend<AnySqliteDatabase>;
  close: () => Promise<void>;
}> {
  const client = new Database(":memory:");
  const backend = createSqliteBackend(drizzleBetterSqlite3(client));
  return {
    backend,
    close: () => {
      client.close();
      return Promise.resolve();
    },
  };
}

describe("buildCallerSerializedBackend member coverage", () => {
  it("wraps every taxonomy write member and the two transaction openers, and leaves every read member alone", () => {
    const { backend: plainBackend, close } = buildPlainSqliteBackend();
    cleanups.push(close);
    const queuedBackend = buildCallerSerializedBackend(plainBackend);

    const wrapped: string[] = [];
    const untouched: string[] = [];
    // Every taxonomy write member this plain SQLite backend actually
    // implements — an in-memory backend with no vector strategy omits the
    // OPTIONAL embedding members, exactly as `buildQueuedWriteUnits` itself
    // skips a member `Reflect.get` reports as absent, so the set this test
    // expects to see wrapped is the same subset, not the full taxonomy.
    const implementedKeys = QUEUED_ROOT_MEMBER_KEYS.filter(
      (key) =>
        key === "commands" ||
        typeof Reflect.get(plainBackend, key) === "function",
    );
    // `commands` is a port object, not a bare function: its own identity
    // changing is not proof that its `execute` changed, so that one member's
    // `execute` is compared separately below rather than inside this loop.
    const plainCommandsExecute = plainBackend.commands.execute;
    const queuedCommandsExecute = queuedBackend.commands.execute;
    for (const key of implementedKeys) {
      const plainMember: unknown = Reflect.get(plainBackend, key);
      if (Reflect.get(queuedBackend, key) === plainMember) {
        untouched.push(key);
      } else {
        wrapped.push(key);
      }
    }
    expect(untouched).toEqual([]);
    expect(wrapped.toSorted()).toEqual([...implementedKeys].toSorted());
    expect(queuedCommandsExecute).not.toBe(plainCommandsExecute);

    for (const key of GRAPH_BACKEND_MEMBER_CLASSES.read) {
      const plainMember: unknown = Reflect.get(plainBackend, key);
      if (typeof plainMember !== "function") continue;
      expect(Reflect.get(queuedBackend, key)).toBe(plainMember);
    }
  });
});
