/**
 * `createSqlBackend`'s `caller-serialized` write-fence queue
 * (`src/backend/drizzle/engine/create-sql-backend.ts`): the in-process half
 * of the promise a `writeFence: { mechanism: "caller-serialized" }`
 * declaration makes — every write unit this backend issues is serialized
 * through one queue, reads are not, a root write submitted from inside a
 * transaction callback is refused rather than deadlocking, adopting an
 * externally owned transaction is refused outright, and the members wrapped
 * are exactly the taxonomy's mutation-capable classes plus the two
 * transaction openers.
 *
 * Both bundled dialects declare a `caller-serialized` write fence here
 * through `capabilities.writeFence` — the SAME override shape
 * `tests/engine-profile-refusals.test.ts` uses to prove the two bundled
 * factories accept it — so every case below exercises the real
 * `createSqlBackend` path, not a hand-built fixture.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import {
  buildCallerSerializedBackend,
  QUEUED_ROOT_MEMBER_KEYS,
  UNQUEUED_ROOT_MEMBER_REASONS,
} from "../src/backend/drizzle/engine/create-sql-backend";
import type { AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { GRAPH_BACKEND_MEMBER_CLASSES } from "../src/backend/member-classes";
import { createPostgresBackend } from "../src/backend/postgres";
import {
  __restoreQueueTaskContextForTesting,
  __setQueueTaskContextForTesting,
  createSerializedExecutionQueue,
} from "../src/backend/serialized-execution-queue";
import { type AdapterBackend } from "../src/backend/types";
import { WRITE_MEMBER_KEYS } from "../src/store/operations/write-members";
import {
  createLoggedPostgresBackend,
  createLoggedSqliteBackend,
  type LoggedBackend,
} from "./lock-fence-test-utils";

const CALLER_SERIALIZED_CAPABILITIES = {
  writeFence: { mechanism: "caller-serialized" },
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
      Promise.resolve(
        createLoggedSqliteBackend(CALLER_SERIALIZED_CAPABILITIES),
      ),
  },
  {
    name: "postgres",
    build: () => createLoggedPostgresBackend(CALLER_SERIALIZED_CAPABILITIES),
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

    it("refuses a root write submitted from inside a transaction callback, naming the reentrant-submission code and subject", async () => {
      const logged = await build();
      cleanups.push(logged.close);
      const [store] = await createStoreWithSchema(queueGraph, logged.backend);

      let caught: unknown;
      try {
        await store.transaction(async () => {
          await store.nodes.Person.create({ name: "Reentrant" });
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details).toEqual(
        expect.objectContaining({
          code: "SERIALIZED_QUEUE_REENTRANT_SUBMISSION",
          subject: "caller-serialized",
        }),
      );

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

// ============================================================
// adoptTransaction is refused outright, not queued and not left unqueued.
// ============================================================

describe("adoptTransaction is refused under caller-serialized", () => {
  it("sqlite: refuses with CALLER_SERIALIZED_REFUSES_ADOPTION", () => {
    const client = new Database(":memory:");
    try {
      const backend = createSqliteBackend(drizzleBetterSqlite3(client), {
        capabilities: CALLER_SERIALIZED_CAPABILITIES,
      });
      let caught: unknown;
      try {
        backend.adoptTransaction(undefined as unknown as AnySqliteDatabase);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details).toEqual(
        expect.objectContaining({
          code: "CALLER_SERIALIZED_REFUSES_ADOPTION",
          member: "adoptTransaction",
        }),
      );
    } finally {
      client.close();
    }
  });

  it("postgres (PGlite): refuses with CALLER_SERIALIZED_REFUSES_ADOPTION", async () => {
    const client = await PGlite.create();
    try {
      const backend = createPostgresBackend(drizzlePglite(client), {
        capabilities: CALLER_SERIALIZED_CAPABILITIES,
        vector: false,
      });
      let caught: unknown;
      try {
        backend.adoptTransaction(undefined as never);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details).toEqual(
        expect.objectContaining({
          code: "CALLER_SERIALIZED_REFUSES_ADOPTION",
          member: "adoptTransaction",
        }),
      );
    } finally {
      await client.close();
    }
  });
});

// ============================================================
// Reentrancy detection modes: "detect" (best-effort, SQLite's own queue)
// vs. "require" (the caller-serialized promise depends on it working).
// ============================================================

describe("serialized-execution-queue reentrancy modes", () => {
  afterEach(() => {
    __restoreQueueTaskContextForTesting();
  });

  it("require: refuses every submission with CALLER_SERIALIZED_REQUIRES_ASYNC_CONTEXT when the AsyncLocalStorage context is unavailable", async () => {
    __setQueueTaskContextForTesting(undefined);
    const queue = createSerializedExecutionQueue({
      reentrancy: "require",
      subject: "test-subject",
    });

    let caught: unknown;
    try {
      await queue.runExclusive(() => Promise.resolve("ok"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).details).toEqual(
      expect.objectContaining({
        code: "CALLER_SERIALIZED_REQUIRES_ASYNC_CONTEXT",
        subject: "test-subject",
      }),
    );
  });

  it("detect: runs the task without detection when the AsyncLocalStorage context is unavailable", async () => {
    __setQueueTaskContextForTesting(undefined);
    const queue = createSerializedExecutionQueue({
      reentrancy: "detect",
      subject: "test-subject",
    });

    await expect(queue.runExclusive(() => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );
  });

  it("require: a submission made before the AsyncLocalStorage loader resolves still detects a nested reentrant submission", async () => {
    const realContext = new AsyncLocalStorage<ReadonlySet<object>>();
    // The loader "resolves" 20ms after this queue is constructed — the
    // submission below is made synchronously, well before that.
    __setQueueTaskContextForTesting(realContext, 20);
    const queue = createSerializedExecutionQueue({
      reentrancy: "require",
      subject: "test-subject",
    });

    let nestedError: unknown;
    const outerResult = queue.runExclusive(async () => {
      try {
        await queue.runExclusive(() => Promise.resolve("nested"));
      } catch (error) {
        nestedError = error;
      }
      return "outer-done";
    });

    await expect(outerResult).resolves.toBe("outer-done");
    expect(nestedError).toBeInstanceOf(ConfigurationError);
    expect((nestedError as ConfigurationError).details).toEqual(
      expect.objectContaining({
        code: "SERIALIZED_QUEUE_REENTRANT_SUBMISSION",
        subject: "test-subject",
      }),
    );
  });
});

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
// Direct proof that the wrapping covers exactly QUEUED_ROOT_MEMBER_KEYS,
// isolated from the closures `createSqlBackend` builds fresh on every
// construction (see `buildCallerSerializedBackend`'s own doc comment for why
// this needs a single shared base object rather than two independent
// backends).
// ============================================================

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
  it("wraps every QUEUED_ROOT_MEMBER_KEYS member this backend implements, replaces adoptTransaction, and leaves every read/identity member alone", () => {
    const { backend: plainBackend, close } = buildPlainSqliteBackend();
    cleanups.push(close);
    const queuedBackend = buildCallerSerializedBackend(plainBackend);

    const wrapped: string[] = [];
    const untouched: string[] = [];
    // Every QUEUED_ROOT_MEMBER_KEYS member this plain SQLite backend
    // actually implements — an in-memory backend with no vector strategy
    // omits the OPTIONAL embedding members, exactly as `buildQueuedWriteUnits`
    // itself skips a member `Reflect.get` reports as absent, so the set this
    // test expects to see wrapped is that subset, not the full list.
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

    // adoptTransaction is REPLACED (with the refusal), not merely absent
    // from the wrap loop above and left to fall through to the plain
    // backend's own implementation.
    expect(queuedBackend.adoptTransaction).not.toBe(
      plainBackend.adoptTransaction,
    );

    for (const key of [
      ...GRAPH_BACKEND_MEMBER_CLASSES.read,
      ...GRAPH_BACKEND_MEMBER_CLASSES.identity,
    ]) {
      const plainMember: unknown = Reflect.get(plainBackend, key);
      if (typeof plainMember !== "function") continue;
      expect(Reflect.get(queuedBackend, key)).toBe(plainMember);
    }
  });
});

// ============================================================
// Totality ratchet: every member the taxonomy classifies (plus the two
// `AdapterBackend`-only members `transactionWithNative`/`adoptTransaction`)
// falls into EXACTLY ONE of QUEUED_ROOT_MEMBER_KEYS or
// UNQUEUED_ROOT_MEMBER_REASONS, so a member reclassified into a
// mutation-capable class, or a brand-new backend member, cannot land
// unqueued (or double-counted) silently.
//
// Mutation check: delete the `close` entry from
// `UNQUEUED_ROOT_MEMBER_REASONS` in create-sql-backend.ts — `close` then
// appears in neither bucket and the "every member is covered" assertion
// below fails, naming `close` as uncovered. Restoring the entry passes
// again.
// ============================================================

const ASSEMBLED_ROOT_MEMBER_KEYS: readonly string[] = [
  ...Object.values(GRAPH_BACKEND_MEMBER_CLASSES).flat(),
  "transactionWithNative",
  "adoptTransaction",
];

describe("caller-serialized queue: total member inventory", () => {
  it("QUEUED_ROOT_MEMBER_KEYS is exactly the mutation-capable classes and the two transaction openers, matching WRITE_MEMBER_KEYS at minimum", () => {
    const queuedSet = new Set<string>(QUEUED_ROOT_MEMBER_KEYS);
    for (const key of WRITE_MEMBER_KEYS) {
      expect(queuedSet.has(key)).toBe(true);
    }
    expect(queuedSet.has("transaction")).toBe(true);
    expect(queuedSet.has("transactionWithNative")).toBe(true);
    expect(queuedSet.has("clearGraph")).toBe(true);
  });

  it("partitions every assembled-root member into queued or a documented unqueued reason, with no member in both", () => {
    const queuedSet = new Set<string>(QUEUED_ROOT_MEMBER_KEYS);
    const unqueuedKeys = Object.keys(UNQUEUED_ROOT_MEMBER_REASONS);
    const unqueuedSet = new Set(unqueuedKeys);
    const assembledSet = new Set(ASSEMBLED_ROOT_MEMBER_KEYS);

    const overlap = [...queuedSet].filter((key) => unqueuedSet.has(key));
    expect(overlap).toEqual([]);

    const uncovered = ASSEMBLED_ROOT_MEMBER_KEYS.filter(
      (key) => !queuedSet.has(key) && !unqueuedSet.has(key),
    );
    expect(uncovered).toEqual([]);

    const stray = [...queuedSet, ...unqueuedSet].filter(
      (key) => !assembledSet.has(key),
    );
    expect(stray).toEqual([]);

    for (const reason of Object.values(UNQUEUED_ROOT_MEMBER_REASONS)) {
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("adoptTransaction is the one member documented as refused rather than queued or silently unqueued", () => {
    expect(QUEUED_ROOT_MEMBER_KEYS).not.toContain("adoptTransaction");
    expect(UNQUEUED_ROOT_MEMBER_REASONS["adoptTransaction"]).toMatch(
      /refused/i,
    );
  });
});
