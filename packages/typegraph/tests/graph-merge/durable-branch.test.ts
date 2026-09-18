/**
 * Durable working-copy branches: `branchDurable()` + `reopenDurableBranch()`.
 *
 * Two durable hosts are exercised:
 *
 *  - `createFakeDurableHost()` — an in-memory host that persists each working
 *    copy as a live better-sqlite3 `Database` plus a `Map` of the host-attested
 *    {@link DurableBranchOrigin}. Its `close()` releases only the TypeGraph
 *    backend's own statement queue (the raw `Database` stays open), so
 *    `branch.close()` genuinely models "the process dropped its connection"
 *    while the working copy survives. It is the vehicle for the tamper,
 *    locator-swap, evolution, and seal-abort cases.
 *
 *  - `createFileBackedStrategy()` — a STATELESS, file-backed host whose locator
 *    is a directory holding `working-copy.sqlite` and `origin.json`. Nothing is
 *    kept in memory, so a brand-new strategy instance over the same root proves
 *    reattachment does not depend on process-local strategy state.
 */
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
} from "../../src";
import { deriveBackend } from "../../src/backend/derive-backend";
import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import type { GraphBackend } from "../../src/backend/types";
import type { EngineRevision, LineageMembers } from "../../src/backend/types";
import {
  applyMergePlan,
  asBaseVersion,
  asBranchId,
  branchDurable,
  BranchError,
  destroyDurableBranch,
  type DurableBranchOrigin,
  type DurableWorkingCopyStrategy,
  isErr,
  isOk,
  planMerge,
  reopenDurableBranch,
  unwrap,
} from "../../src/graph-merge";
import { cloneWorkingCopyStrategy } from "../../src/graph-merge/working-copy";
import { storeBackend } from "../../src/store/runtime-port";
import { createSqliteMergeBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
  from: [Person],
  to: [Person],
});

const graph = defineGraph({
  id: "durable-branch-test",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});
type G = typeof graph;

/** A graph with a different id — a descriptor for `graph` must not reopen it. */
const otherGraph = defineGraph({
  id: "durable-branch-other",
  nodes: { Person: { type: Person } },
  edges: {},
});

/** The SAME graph id with a different schema — a same-id wrong definition. */
const WidenedPerson = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number() }),
});
const divergentGraph = defineGraph({
  id: "durable-branch-test",
  nodes: { Person: { type: WidenedPerson } },
  edges: {},
});

/** The opaque, JSON-serializable locator the fake in-memory strategy stores. */
type LocatorDescriptor = Readonly<{ locator: string }>;

/**
 * A fixed engine revision, attached to every working-copy backend the fake
 * opens so `captureBranchForkState` records a non-absent `forkRevision` — the
 * fence the tamper test needs. `changesSince` answers `unbounded`, so the merge
 * always falls back to the full diff rather than trusting a fake delta.
 */
const FIXED_REVISION = "engine-r7" as EngineRevision;
const FIXED_LINEAGE: LineageMembers = {
  revision: () => Promise.resolve(FIXED_REVISION),
  changesSince: () => Promise.resolve({ kind: "unbounded" }),
};

/** Simulates a JSON store round-trip of a descriptor. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The host-side equality the fake/backed strategies verify before destroy. */
function sameOrigin(a: DurableBranchOrigin, b: DurableBranchOrigin): boolean {
  const anchor = (value: DurableBranchOrigin["schemaAnchor"]): string =>
    value === undefined ? "absent" : `${value.version}:${value.hash}`;
  return (
    a.graphId === b.graphId &&
    a.definitionHash === b.definitionHash &&
    a.branchId === b.branchId &&
    a.base === b.base &&
    a.forkRevision === b.forkRevision &&
    anchor(a.schemaAnchor) === anchor(b.schemaAnchor)
  );
}

type FakeDurableHost = Readonly<{
  strategy: DurableWorkingCopyStrategy<G, LocatorDescriptor>;
  /** Overrides the complete origin the host attests for a locator. */
  attest: (locator: string, origin: DurableBranchOrigin) => void;
  /** How many working-copy connections have been closed. */
  connectionCloses: () => number;
  /** Locators whose allocation was aborted (create/capture/seal failure). */
  aborted: () => readonly string[];
  /** Locators that still have a live allocation. */
  liveLocators: () => readonly string[];
  /** Makes the NEXT seal call reject with `error` (one-shot). */
  failNextSeal: (error: Error) => void;
  /** Makes created stores fail their fork-state capture (one-shot). */
  failNextCapture: (error: Error) => void;
  /** Makes the NEXT abort call reject with `error` (one-shot). */
  failNextAbort: (error: Error) => void;
  /** Closes every still-open working-copy `Database`. */
  closeAll: () => void;
}>;

/** Options for {@link createFakeDurableHost}. */
type FakeDurableHostOptions = Readonly<{
  /**
   * When true, `create` deletes the freshly cloned schema row, so the durable
   * working copy has no active schema row (an UNMANAGED branch): its captured
   * `schemaAnchor` is absent and only the graph-id + definition-hash identity
   * can fence it. The tables and seeded rows remain.
   */
  unmanaged?: boolean;
}>;

/**
 * Builds the fake durable host. `create` seeds a persistent in-memory database
 * from the base via the ordinary clone strategy; `seal` records the attested
 * origin; `reopen` reconnects to that database; `destroy` verifies then deletes.
 */
function createFakeDurableHost(
  options: FakeDurableHostOptions = {},
): FakeDurableHost {
  const databases = new Map<string, Database.Database>();
  const origins = new Map<string, DurableBranchOrigin>();
  const abortedLocators: string[] = [];
  let sequence = 0;
  let closes = 0;
  let sealFailure: Error | undefined;
  let captureFailure: Error | undefined;
  let abortFailure: Error | undefined;

  const openDurableBackend = (database: Database.Database): GraphBackend => {
    const raw = createSqliteBackend(drizzle(database), {
      executionProfile: { isSync: true },
    });
    return deriveBackend(raw, {
      lineage: FIXED_LINEAGE,
      close: async () => {
        closes += 1;
        await raw.close();
      },
    });
  };

  const requireDatabase = (locator: string): Database.Database => {
    const database = databases.get(locator);
    if (database === undefined) {
      throw new Error(`durable working copy "${locator}" does not exist`);
    }
    return database;
  };

  const strategy: DurableWorkingCopyStrategy<G, LocatorDescriptor> = {
    type: "fake-in-memory-durable-host",
    version: 1,
    create: async (baseStore, base) => {
      sequence += 1;
      const locator = `working-copy-${sequence}`;
      const database = new Database(":memory:");
      databases.set(locator, database);
      if (captureFailure !== undefined) {
        const error = captureFailure;
        captureFailure = undefined;
        // Surface the injected failure from the created store's first
        // fork-state read (`getActiveSchema`) rather than opening a store that
        // cannot be captured.
        const rejecting = deriveBackend(openDurableBackend(database), {
          getActiveSchema: () => Promise.reject(error),
        });
        return {
          store: createStore(baseStore.graph, rejecting, {
            revisionTracking: true,
          }),
          descriptor: { locator },
        };
      }
      const seed = cloneWorkingCopyStrategy<G>(() =>
        Promise.resolve(openDurableBackend(database)),
      );
      const store = await seed.create(baseStore, base);
      if (options.unmanaged === true) {
        // Model an UNMANAGED working copy: the tables and rows exist, but no
        // active schema row does, so the fork captures no `schemaAnchor`.
        database
          .prepare("DELETE FROM typegraph_schema_versions WHERE graph_id = ?")
          .run(baseStore.graphId);
      }
      return { store, descriptor: { locator } };
    },
    seal: async (descriptor, origin) => {
      if (sealFailure !== undefined) {
        const error = sealFailure;
        sealFailure = undefined;
        throw error;
      }
      origins.set(descriptor.locator, origin);
    },
    abort: async (descriptor) => {
      if (abortFailure !== undefined) {
        const error = abortFailure;
        abortFailure = undefined;
        throw error;
      }
      abortedLocators.push(descriptor.locator);
      const database = databases.get(descriptor.locator);
      if (database !== undefined) {
        database.close();
        databases.delete(descriptor.locator);
      }
      origins.delete(descriptor.locator);
    },
    reopen: async (reopenedGraph, descriptor) => {
      const database = requireDatabase(descriptor.locator);
      const origin = origins.get(descriptor.locator);
      if (origin === undefined) {
        throw new Error(
          `durable working copy "${descriptor.locator}" was never sealed`,
        );
      }
      const store = createStore(reopenedGraph, openDurableBackend(database), {
        revisionTracking: true,
      });
      return { store, origin };
    },
    destroy: async (descriptor, expectedOrigin) => {
      const database = requireDatabase(descriptor.locator);
      const stored = origins.get(descriptor.locator);
      if (stored === undefined) {
        throw new Error(
          `durable working copy "${descriptor.locator}" was never sealed`,
        );
      }
      if (!sameOrigin(stored, expectedOrigin)) {
        throw new Error(
          `refusing to destroy "${descriptor.locator}": stored origin does not match the descriptor's expected origin`,
        );
      }
      database.close();
      databases.delete(descriptor.locator);
      origins.delete(descriptor.locator);
    },
  };

  return {
    strategy,
    attest: (locator, origin) => {
      origins.set(locator, origin);
    },
    connectionCloses: () => closes,
    aborted: () => [...abortedLocators],
    liveLocators: () => [...databases.keys()],
    failNextSeal: (error) => {
      sealFailure = error;
    },
    failNextCapture: (error) => {
      captureFailure = error;
    },
    failNextAbort: (error) => {
      abortFailure = error;
    },
    closeAll: () => {
      for (const database of databases.values()) database.close();
      databases.clear();
      origins.clear();
    },
  };
}

/** A same-id strategy whose descriptor format tag differs. */
function foreignStrategy(
  host: FakeDurableHost,
): DurableWorkingCopyStrategy<G, LocatorDescriptor> {
  return { ...host.strategy, type: "some-other-strategy" };
}

/** The opaque, file-backed locator: a directory name under the strategy root. */
type FileLocator = Readonly<{ id: string }>;

/**
 * A stateless, file-backed durable host. Every allocation lives in its own
 * directory under `rootDir`:
 *
 *   - `working-copy.sqlite` — the mutated working copy;
 *   - `origin.json` — the host-attested immutable origin, written by `seal`.
 *
 * The strategy holds NO maps — a fresh instance over the same `rootDir`
 * reconnects to everything the previous instance wrote, which is the restart
 * proof. `destroy` re-reads `origin.json` and refuses a mismatched expected
 * origin before deleting the directory.
 */
function createFileBackedStrategy(
  rootDir: string,
): DurableWorkingCopyStrategy<G, FileLocator> {
  const directoryOf = (locator: FileLocator): string =>
    path.join(rootDir, locator.id);
  const databasePathOf = (locator: FileLocator): string =>
    path.join(directoryOf(locator), "working-copy.sqlite");
  const originPathOf = (locator: FileLocator): string =>
    path.join(directoryOf(locator), "origin.json");

  const openFileBackend = (locator: FileLocator): GraphBackend => {
    const database = new Database(databasePathOf(locator));
    const raw = createSqliteBackend(drizzle(database), {
      executionProfile: { isSync: true },
    });
    return deriveBackend(raw, {
      close: async () => {
        await raw.close();
        database.close();
      },
    });
  };

  const readOrigin = async (
    locator: FileLocator,
  ): Promise<DurableBranchOrigin> => {
    const parsed = JSON.parse(
      await readFile(originPathOf(locator), "utf8"),
    ) as DurableBranchOrigin;
    return parsed;
  };

  return {
    type: "file-backed-sqlite-durable-host",
    version: 1,
    create: async (baseStore, base) => {
      const locator: FileLocator = { id: randomUUID() };
      await rm(directoryOf(locator), { recursive: true, force: true });
      await mkdir(directoryOf(locator), { recursive: true });
      const seed = cloneWorkingCopyStrategy<G>(() =>
        Promise.resolve(openFileBackend(locator)),
      );
      const store = await seed.create(baseStore, base);
      return { store, descriptor: locator };
    },
    seal: async (locator, origin) => {
      await writeFile(originPathOf(locator), JSON.stringify(origin), "utf8");
    },
    abort: async (locator) => {
      await rm(directoryOf(locator), { recursive: true, force: true });
    },
    reopen: async (reopenedGraph, locator) => {
      const origin = await readOrigin(locator);
      const store = createStore(reopenedGraph, openFileBackend(locator), {
        revisionTracking: true,
      });
      return { store, origin };
    },
    destroy: async (locator, expectedOrigin) => {
      // Atomic claim: rename the allocation out of its public locator BEFORE
      // reading its origin, so no concurrent reopen can observe a
      // half-destroyed copy and a failed verification can be rolled back by
      // renaming it home.
      const claimed = path.join(
        rootDir,
        `.claimed-${locator.id}-${randomUUID()}`,
      );
      await rename(directoryOf(locator), claimed);
      let stored: DurableBranchOrigin;
      try {
        stored = JSON.parse(
          await readFile(path.join(claimed, "origin.json"), "utf8"),
        ) as DurableBranchOrigin;
      } catch (error) {
        await rename(claimed, directoryOf(locator));
        throw error;
      }
      if (!sameOrigin(stored, expectedOrigin)) {
        await rename(claimed, directoryOf(locator));
        throw new Error(
          `refusing to destroy "${locator.id}": stored origin does not match the descriptor's expected origin`,
        );
      }
      await rm(claimed, { recursive: true, force: true });
    },
  };
}

describe("durable branch", () => {
  let host: FakeDurableHost;
  let cleanups: (() => Promise<void>)[];
  let tempDirs: string[];

  beforeEach(() => {
    host = createFakeDurableHost();
    cleanups = [];
    tempDirs = [];
  });

  afterEach(async () => {
    host.closeAll();
    for (const cleanup of cleanups) {
      await cleanup();
    }
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function seedBase() {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    const [baseStore] = await createStoreWithSchema(graph, fixture.backend, {
      revisionTracking: true,
    });
    const alice = await baseStore.nodes.Person.create({ name: "Alice" });
    return { baseStore, aliceId: alice.id };
  }

  /**
   * A fake host whose working copies have NO active schema row — an unmanaged
   * branch, where only the graph id + definition-hash identity can fence it.
   */
  function createUnmanagedHost(): FakeDurableHost {
    const unmanagedHost = createFakeDurableHost({ unmanaged: true });
    cleanups.push(async () => {
      unmanagedHost.closeAll();
    });
    return unmanagedHost;
  }

  it("reopens the same mutated working copy from a serialized descriptor, then plans and applies a merge", async () => {
    const { baseStore, aliceId } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    expect(created.branch.forkRevision).toBe(FIXED_REVISION);

    await created.branch.store.nodes.Person.update(aliceId, {
      name: "Alice (durable)",
    });
    const bob = await created.branch.store.nodes.Person.create({
      name: "Bob (durable)",
    });

    // Drop the process's connection. The host keeps the working copy.
    await created.branch.close();

    const descriptor = wire(created.descriptor);
    const reopened = unwrap(
      await reopenDurableBranch(graph, descriptor, host.strategy),
    );

    expect(reopened.id).toBe(created.descriptor.branchId);
    expect(reopened.base).toBe(created.descriptor.base);
    expect(reopened.forkRevision).toBe(FIXED_REVISION);
    expect((await reopened.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice (durable)",
    );
    expect((await reopened.store.nodes.Person.getById(bob.id))?.name).toBe(
      "Bob (durable)",
    );

    const applied = await applyMergePlan(
      baseStore,
      wire(unwrap(await planMerge(baseStore, [reopened]))),
    );
    if (isErr(applied)) throw applied.error;

    expect((await baseStore.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice (durable)",
    );
    expect((await baseStore.nodes.Person.getById(bob.id))?.name).toBe(
      "Bob (durable)",
    );

    await reopened.close();
  });

  it("refuses a wrong strategy, wrong descriptor version, malformed envelope, and wrong graph", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await created.branch.close();

    const wrongStrategy = await reopenDurableBranch(
      graph,
      created.descriptor,
      foreignStrategy(host),
    );
    expect(isErr(wrongStrategy)).toBe(true);
    if (isErr(wrongStrategy)) {
      expect(wrongStrategy.error).toBeInstanceOf(BranchError);
      expect(wrongStrategy.error.message).toContain("strategy");
    }

    const wrongVersion = await reopenDurableBranch(
      graph,
      { ...created.descriptor, version: 999 },
      host.strategy,
    );
    expect(isErr(wrongVersion)).toBe(true);

    const malformed = await reopenDurableBranch(
      graph,
      { ...created.descriptor, branchId: asBranchId("") },
      host.strategy,
    );
    expect(isErr(malformed)).toBe(true);

    // A different graph id short-circuits before the host is touched.
    const before = host.connectionCloses();
    const wrongGraph = await reopenDurableBranch(
      otherGraph,
      created.descriptor,
      host.strategy as unknown as DurableWorkingCopyStrategy<
        typeof otherGraph,
        LocatorDescriptor
      >,
    );
    expect(isErr(wrongGraph)).toBe(true);
    expect(host.connectionCloses()).toBe(before);
  });

  it("refuses a tampered base, branch id, or fork revision, closing the opened backend and leaving the copy reopenable", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await created.branch.close();

    const tampers: readonly Partial<typeof created.descriptor>[] = [
      { base: asBaseVersion("tampered-base") },
      { branchId: asBranchId("tampered-branch") },
      { forkRevision: "tampered-revision" as EngineRevision },
    ];
    for (const tamper of tampers) {
      const before = host.connectionCloses();
      const result = await reopenDurableBranch(
        graph,
        { ...created.descriptor, ...tamper },
        host.strategy,
      );
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(BranchError);
        expect(result.error.message).toContain("disagree");
      }
      // The backend the strategy opened was closed on the refusal.
      expect(host.connectionCloses()).toBe(before + 1);
    }

    // The copy itself was never touched.
    const reopened = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    await reopened.close();
  });

  it("refuses a descriptor whose schemaAnchor was deleted or changed, even though the envelope otherwise matches", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await created.branch.close();
    const anchor = created.descriptor.schemaAnchor;
    expect(anchor).toBeDefined();

    const withoutAnchor: Record<string, unknown> = {
      ...created.descriptor,
    };
    delete withoutAnchor["schemaAnchor"];

    const changed = {
      ...created.descriptor,
      schemaAnchor: { version: anchor?.version ?? 0, hash: "tampered-hash" },
    };

    for (const tampered of [withoutAnchor, changed]) {
      const before = host.connectionCloses();
      const result = await reopenDurableBranch(
        graph,
        tampered as typeof created.descriptor,
        host.strategy,
      );
      expect(isErr(result)).toBe(true);
      if (isErr(result)) expect(result.error).toBeInstanceOf(BranchError);
      expect(host.connectionCloses()).toBe(before + 1);
    }

    const reopened = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    await reopened.close();
  });

  it("refuses a same-id divergent graph against the host-attested anchor, closing the opened backend and leaving the copy reopenable", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await created.branch.close();

    const before = host.connectionCloses();
    const result = await reopenDurableBranch(
      divergentGraph,
      created.descriptor,
      host.strategy as unknown as DurableWorkingCopyStrategy<
        typeof divergentGraph,
        LocatorDescriptor
      >,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBeInstanceOf(BranchError);
    expect(host.connectionCloses()).toBe(before + 1);

    const reopened = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    await reopened.close();
  });

  it("attests definition identity for an unmanaged branch: a same-id divergent graph is refused with no schema anchor", async () => {
    const unmanaged = createUnmanagedHost();
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, unmanaged.strategy),
    );
    expect(created.descriptor.schemaAnchor).toBeUndefined();
    expect(created.descriptor.definitionHash.length).toBeGreaterThan(0);
    await created.branch.close();

    const before = unmanaged.connectionCloses();
    const result = await reopenDurableBranch(
      divergentGraph,
      created.descriptor,
      unmanaged.strategy as unknown as DurableWorkingCopyStrategy<
        typeof divergentGraph,
        LocatorDescriptor
      >,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BranchError);
      expect(result.error.message).toContain("definition");
    }
    // The backend the strategy opened was closed on the refusal.
    expect(unmanaged.connectionCloses()).toBe(before + 1);

    // The copy itself was never touched and still reopens honestly.
    const reopened = unwrap(
      await reopenDurableBranch(graph, created.descriptor, unmanaged.strategy),
    );
    await reopened.close();
  });

  it("refuses an unmanaged branch reopened with a different graph or a relabeled descriptor graphId", async () => {
    const unmanaged = createUnmanagedHost();
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, unmanaged.strategy),
    );
    await created.branch.close();

    // A different graph id short-circuits before the host is touched.
    const before = unmanaged.connectionCloses();
    const wrongGraph = await reopenDurableBranch(
      otherGraph,
      created.descriptor,
      unmanaged.strategy as unknown as DurableWorkingCopyStrategy<
        typeof otherGraph,
        LocatorDescriptor
      >,
    );
    expect(isErr(wrongGraph)).toBe(true);
    expect(unmanaged.connectionCloses()).toBe(before);

    // Relabeled descriptor graphId: the host attests the branch's real graph
    // id, so the fence refuses after the reconnect.
    const relabeled = { ...created.descriptor, graphId: otherGraph.id };
    const relabelBefore = unmanaged.connectionCloses();
    const relabeledResult = await reopenDurableBranch(
      otherGraph,
      relabeled,
      unmanaged.strategy as unknown as DurableWorkingCopyStrategy<
        typeof otherGraph,
        LocatorDescriptor
      >,
    );
    expect(isErr(relabeledResult)).toBe(true);
    expect(unmanaged.connectionCloses()).toBe(relabelBefore + 1);

    const reopened = unwrap(
      await reopenDurableBranch(graph, created.descriptor, unmanaged.strategy),
    );
    await reopened.close();
  });

  it("destroy verifies the full unmanaged origin: a relabeled graphId or definitionHash refuses and the copy survives", async () => {
    const unmanaged = createUnmanagedHost();
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, unmanaged.strategy),
    );
    await created.branch.close();

    const tampers = [
      { graphId: otherGraph.id },
      { definitionHash: "tampered-definition" },
    ];
    for (const tamper of tampers) {
      const result = await destroyDurableBranch(
        { ...created.descriptor, ...tamper },
        unmanaged.strategy,
      );
      expect(isErr(result)).toBe(true);
    }
    expect(unmanaged.liveLocators()).toEqual([
      created.descriptor.store.locator,
    ]);

    const destroyed = await destroyDurableBranch(
      created.descriptor,
      unmanaged.strategy,
    );
    expect(isOk(destroyed)).toBe(true);
    expect(unmanaged.liveLocators()).toEqual([]);
  });

  it("reports a failed abort truthfully: both failures and the retry locator are exposed, and the orphan is still abortable", async () => {
    const { baseStore } = await seedBase();
    const sealFailure = new Error("seal boom");
    const abortFailure = new Error("abort boom");
    host.failNextSeal(sealFailure);
    host.failNextAbort(abortFailure);

    const result = await branchDurable<G, LocatorDescriptor>(
      baseStore,
      host.strategy,
    );

    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toBeInstanceOf(BranchError);
    // The original capture/seal failure is the cause; the cleanup failure is
    // surfaced separately rather than swallowed.
    expect(result.error.cause).toBe(sealFailure);
    expect(result.error.details["allocationAborted"]).toBe(false);
    expect(result.error.details["cleanupFailure"]).toBe(abortFailure);
    // The opaque locator is recoverable, and the message never claims a failed
    // abort removed the allocation.
    expect(result.error.details["descriptor"]).toEqual({
      locator: "working-copy-1",
    });
    expect(result.error.message).toContain("could NOT abort");
    expect(host.aborted()).toEqual([]);
    expect(host.liveLocators()).toEqual(["working-copy-1"]);
    expect(host.connectionCloses()).toBe(1);

    // The exposed descriptor is exactly what an operator retries abort with.
    await host.strategy.abort(
      result.error.details["descriptor"] as LocatorDescriptor,
    );
    expect(host.liveLocators()).toEqual([]);
  });

  it("refuses a mismatched host-attested origin, closing the opened backend and leaving the copy reopenable", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await created.branch.close();

    host.attest(created.descriptor.store.locator, {
      graphId: created.descriptor.graphId,
      definitionHash: created.descriptor.definitionHash,
      branchId: asBranchId("a-different-branch"),
      base: created.descriptor.base,
      schemaAnchor: created.descriptor.schemaAnchor,
      forkRevision: created.descriptor.forkRevision,
    });

    const before = host.connectionCloses();
    const result = await reopenDurableBranch(
      graph,
      created.descriptor,
      host.strategy,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBeInstanceOf(BranchError);
    expect(host.connectionCloses()).toBe(before + 1);

    // Restore the honest attestation; the copy itself was never touched.
    host.attest(created.descriptor.store.locator, {
      graphId: created.descriptor.graphId,
      definitionHash: created.descriptor.definitionHash,
      branchId: created.descriptor.branchId,
      base: created.descriptor.base,
      schemaAnchor: created.descriptor.schemaAnchor,
      forkRevision: created.descriptor.forkRevision,
    });
    const reopened = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    await reopened.close();
  });

  it("keeps a legitimately schema-evolved branch reopenable: the anchor is fork metadata, not current schema", async () => {
    const { baseStore, aliceId } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    const anchorVersion = created.descriptor.schemaAnchor?.version;

    // A schema operation runs on the branch after forking: its committed schema
    // row advances, but the at-fork anchor must remain valid fork metadata.
    const noteExtension = defineGraphExtension({
      nodes: {
        Note: {
          properties: { text: { type: "string" } },
        },
      },
    });
    const evolved = await created.branch.store.evolve(noteExtension);
    const note = await evolved.getNodeCollection("Note")?.create({
      text: "evolved",
    });
    if (note === undefined)
      throw new Error("Note collection was not available");
    const evolvedVersion = (
      await storeBackend(
        evolved as unknown as Parameters<typeof storeBackend>[0],
      ).getActiveSchema(graph.id)
    )?.version;
    expect(evolvedVersion).not.toBe(anchorVersion);

    await created.branch.close();

    const reopened = unwrap(
      await reopenDurableBranch(graph, wire(created.descriptor), host.strategy),
    );
    // The anchor is unchanged; only the live schema moved.
    expect(reopened.schemaAnchor).toEqual(created.descriptor.schemaAnchor);
    expect((await reopened.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice",
    );
    // Rehydrate the branch's CURRENT (evolved) schema — the fork-time
    // definition is still what reopened, but the persisted extension is read
    // back so the Note written before the restart is reachable.
    const rehydrated = await reopened.store.evolve(noteExtension);
    expect(
      (await rehydrated.getNodeCollection("Note")?.getById(note.id))?.["text"],
    ).toBe("evolved");
    await reopened.close();
  });

  it("closes the opened store and aborts the persistent allocation when sealing fails", async () => {
    const { baseStore } = await seedBase();
    const failure = new Error("seal boom");
    host.failNextSeal(failure);

    const result = await branchDurable<G, LocatorDescriptor>(
      baseStore,
      host.strategy,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BranchError);
      expect(result.error.cause).toBe(failure);
    }
    // The allocation was busy? No — it was released: nothing is live, the
    // locator was aborted, and the store's connection was closed.
    expect(host.aborted()).toEqual(["working-copy-1"]);
    expect(host.liveLocators()).toEqual([]);
    expect(host.connectionCloses()).toBe(1);
  });

  it("closes the opened store and aborts the persistent allocation when fork-state capture fails", async () => {
    const { baseStore } = await seedBase();
    const failure = new Error("capture boom");
    host.failNextCapture(failure);

    const result = await branchDurable<G, LocatorDescriptor>(
      baseStore,
      host.strategy,
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BranchError);
      expect(result.error.cause).toBe(failure);
    }
    expect(host.aborted()).toEqual(["working-copy-1"]);
    expect(host.liveLocators()).toEqual([]);
    expect(host.connectionCloses()).toBe(1);
  });

  it("two reopen handles preserve branch identity and share the mutated copy across independent connections", async () => {
    const { baseStore, aliceId } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await created.branch.store.nodes.Person.update(aliceId, {
      name: "Shared",
    });
    await created.branch.close();

    const first = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    const second = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );

    expect(first.id).toBe(created.descriptor.branchId);
    expect(second.id).toBe(created.descriptor.branchId);

    expect((await first.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Shared",
    );

    // Closing one handle's connection leaves the other (and the copy) intact.
    await first.close();
    expect((await second.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Shared",
    );
    await second.close();

    const third = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    expect((await third.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Shared",
    );
    await third.close();
  });

  it("only explicit destroy deletes the working copy; close() never does, and reopen then fails", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await created.branch.close();

    const viaReopen = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    await viaReopen.close();

    const destroyed = await destroyDurableBranch(
      created.descriptor,
      host.strategy,
    );
    expect(isOk(destroyed)).toBe(true);

    const result = await reopenDurableBranch(
      graph,
      created.descriptor,
      host.strategy,
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BranchError);
      expect(result.error.cause).toBeInstanceOf(Error);
    }
  });

  it("refuses a locator swap on destroy: the envelope names A but the locator is B, so B is not destroyed", async () => {
    const { baseStore } = await seedBase();
    const branchA = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    const branchB = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    await branchA.branch.close();
    await branchB.branch.close();

    const swapped = {
      ...branchA.descriptor,
      store: branchB.descriptor.store,
    };
    const result = await destroyDurableBranch(swapped, host.strategy);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBeInstanceOf(BranchError);

    // Both working copies survive the refused swap.
    expect([...host.liveLocators()].sort()).toEqual([
      branchA.descriptor.store.locator,
      branchB.descriptor.store.locator,
    ]);
    const reopenedB = unwrap(
      await reopenDurableBranch(graph, branchB.descriptor, host.strategy),
    );
    await reopenedB.close();

    // The honest descriptor still destroys only its own copy.
    const destroyed = await destroyDurableBranch(
      branchA.descriptor,
      host.strategy,
    );
    expect(isOk(destroyed)).toBe(true);
    expect(host.liveLocators()).toEqual([branchB.descriptor.store.locator]);
  });

  it("a destroyed working copy cannot be reopened even for a matching descriptor that was serialized earlier", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );
    const serialized = wire(created.descriptor);

    const destroyed = await destroyDurableBranch(
      created.descriptor,
      host.strategy,
    );
    expect(isOk(destroyed)).toBe(true);
    await created.branch.close();

    const result = await reopenDurableBranch(graph, serialized, host.strategy);
    expect(isErr(result)).toBe(true);
  });

  it("returns a normal GraphBranch whose close() is idempotent", async () => {
    const { baseStore } = await seedBase();
    const created = unwrap(
      await branchDurable<G, LocatorDescriptor>(baseStore, host.strategy),
    );

    await created.branch.close();
    await created.branch.close();

    const reopened = unwrap(
      await reopenDurableBranch(graph, created.descriptor, host.strategy),
    );
    await reopened.close();
    await reopened.close();
  });

  it("reattaches from a file-backed locator with a fresh stateless strategy and JSON descriptor", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "typegraph-durable-"));
    tempDirs.push(rootDir);

    const { baseStore, aliceId } = await seedBase();

    // First lifecycle: a strategy instance with no state but the root dir.
    const firstStrategy = createFileBackedStrategy(rootDir);
    const created = unwrap(
      await branchDurable<G, FileLocator>(baseStore, firstStrategy),
    );
    await created.branch.store.nodes.Person.update(aliceId, {
      name: "Alice (restart)",
    });
    const bob = await created.branch.store.nodes.Person.create({
      name: "Bob (restart)",
    });
    await created.branch.close();

    // Serialize the descriptor, then discard the first strategy instance and
    // every in-memory handle it touched: only the filesystem remains.
    const serialized = wire(created.descriptor);
    expect(serialized.store).toEqual(created.descriptor.store);

    // Second lifecycle: a brand-new strategy instance over the same root.
    const restartedStrategy = createFileBackedStrategy(rootDir);
    const reopened = unwrap(
      await reopenDurableBranch(graph, serialized, restartedStrategy),
    );

    expect(reopened.id).toBe(serialized.branchId);
    expect(reopened.base).toBe(serialized.base);
    expect((await reopened.store.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice (restart)",
    );
    expect((await reopened.store.nodes.Person.getById(bob.id))?.name).toBe(
      "Bob (restart)",
    );

    const applied = await applyMergePlan(
      baseStore,
      wire(unwrap(await planMerge(baseStore, [reopened]))),
    );
    if (isErr(applied)) throw applied.error;
    expect((await baseStore.nodes.Person.getById(aliceId))?.name).toBe(
      "Alice (restart)",
    );
    expect((await baseStore.nodes.Person.getById(bob.id))?.name).toBe(
      "Bob (restart)",
    );

    await reopened.close();

    // Explicit teardown removes the on-disk allocation.
    const destroyed = await destroyDurableBranch(serialized, restartedStrategy);
    expect(isOk(destroyed)).toBe(true);
  });

  it("file-backed reopen refuses a tampered on-disk descriptor and destroy refuses a swapped locator", async () => {
    const rootDir = await mkdtemp(path.join(tmpdir(), "typegraph-durable-"));
    tempDirs.push(rootDir);
    const { baseStore } = await seedBase();
    const strategy = createFileBackedStrategy(rootDir);

    const branchA = unwrap(
      await branchDurable<G, FileLocator>(baseStore, strategy),
    );
    const branchB = unwrap(
      await branchDurable<G, FileLocator>(baseStore, strategy),
    );
    await branchA.branch.close();
    await branchB.branch.close();

    // Tampered descriptor: the base token is relabeled.
    const tampered = {
      ...branchA.descriptor,
      base: asBaseVersion("tampered-base"),
    };
    const refused = await reopenDurableBranch(graph, tampered, strategy);
    expect(isErr(refused)).toBe(true);

    // Swapped locator on destroy: the envelope names A, the locator is B's.
    const swapped = { ...branchA.descriptor, store: branchB.descriptor.store };
    const swapResult = await destroyDurableBranch(swapped, strategy);
    expect(isErr(swapResult)).toBe(true);

    // B survives the refused swap and is still reopenable.
    const reopenedB = unwrap(
      await reopenDurableBranch(graph, branchB.descriptor, strategy),
    );
    await reopenedB.close();

    const destroyedA = await destroyDurableBranch(branchA.descriptor, strategy);
    expect(isOk(destroyedA)).toBe(true);
    const destroyedB = await destroyDurableBranch(branchB.descriptor, strategy);
    expect(isOk(destroyedB)).toBe(true);
  });
});
