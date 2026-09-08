/**
 * `forkedWorkingCopyStrategy` — a working-copy strategy over a host-level
 * database fork rather than a streamed-interchange clone.
 *
 * SQLite's file-backed local backend is the fork substrate here: a plain
 * `copyFileSync` of the database file is a complete, byte-for-byte fork
 * PROVIDED nothing is mid-transaction when the copy is taken. Every backend in
 * this file opts out of WAL (`pragmas: false`, SQLite's rollback-journal
 * default) specifically so that "nothing is mid-transaction" reduces to "no
 * `-journal` sidecar file exists between statements" — true after every commit
 * — and the fork never needs a WAL checkpoint step.
 */
import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../src";
import { deriveBackend } from "../../src/backend/derive-backend";
import { createSqliteTables } from "../../src/backend/drizzle/schema/sqlite";
import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { computeBaseVersion } from "../../src/graph-merge/base-version";
import { branch } from "../../src/graph-merge/branch";
import { BranchError } from "../../src/graph-merge/errors";
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import { enumerateAllNodes } from "../../src/graph-merge/state-diff";
import { asBranchId } from "../../src/graph-merge/types";
import {
  cloneWorkingCopyStrategy,
  forkedWorkingCopyStrategy,
  type ForkHandle,
} from "../../src/graph-merge/working-copy";
import { createSqlSchema } from "../../src/query/compiler/schema";
import { getStoreBackend } from "./test-utils";

const Widget = defineNode("Widget", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "forked-working-copy-test",
  nodes: { Widget: { type: Widget } },
  edges: {},
});
type G = typeof graph;

/** A fork handle over a plain file-copy of a file-backed SQLite database. */
type SqliteFileFork = Readonly<{
  filePath: string;
  dispose: () => Promise<void>;
}>;

/**
 * `branch()`'s `makeBackend` parameter is documented as "ignored when an
 * explicit strategy is supplied" — every test below passes this instead of a
 * real factory so a regression that started calling it fails loudly.
 */
function rejectMakeBackend(): Promise<never> {
  return Promise.reject(
    new Error("makeBackend must not be called when a strategy is supplied"),
  );
}

const temporaryFiles: string[] = [];

function createTemporaryDbPath(label: string): string {
  const dbPath = path.join(
    tmpdir(),
    `typegraph-fork-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  temporaryFiles.push(dbPath);
  return dbPath;
}

afterEach(() => {
  for (const dbPath of temporaryFiles.splice(0)) {
    if (existsSync(dbPath)) unlinkSync(dbPath);
  }
});

function openFileBackend(filePath: string) {
  return createLocalSqliteBackend({ path: filePath, pragmas: false });
}

/** Forks `sourcePath` by copying its file to a fresh temporary path. */
function copyDatabaseFile(sourcePath: string, label: string): SqliteFileFork {
  const forkedPath = createTemporaryDbPath(label);
  copyFileSync(sourcePath, forkedPath);
  return {
    filePath: forkedPath,
    dispose: async () => {
      if (existsSync(forkedPath)) unlinkSync(forkedPath);
    },
  };
}

/** The strategy under test, wired to `copyDatabaseFile`/`openFileBackend`. */
function fileForkStrategy(sourcePath: string, label: string) {
  return forkedWorkingCopyStrategy<G, SqliteFileFork>({
    fork: () => Promise.resolve(copyDatabaseFile(sourcePath, label)),
    connect: (fork) => Promise.resolve(openFileBackend(fork.filePath).backend),
  });
}

describe("forkedWorkingCopyStrategy", () => {
  it("forks a file-backed SQLite database by copying its file, merges a fork write back to the base, and releases the fork only when forkBranch.close() runs its composed close", async () => {
    const basePath = createTemporaryDbPath("base-roundtrip");
    const { backend: baseBackend } = openFileBackend(basePath);
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    const widget = await baseStore.nodes.Widget.create({ name: "Original" });

    // A spy, not `copyDatabaseFile`'s own dispose, so this test observes
    // exactly when the composed close (connection + fork) releases the fork
    // file — see the assertions after the merge below.
    const forkedPath = createTemporaryDbPath("roundtrip-fork");
    const dispose = vi.fn(async () => {
      if (existsSync(forkedPath)) unlinkSync(forkedPath);
    });
    const strategy = forkedWorkingCopyStrategy<
      G,
      ForkHandle & { filePath: string }
    >({
      fork: () => {
        copyFileSync(basePath, forkedPath);
        return Promise.resolve({ filePath: forkedPath, dispose });
      },
      connect: (fork) =>
        Promise.resolve(openFileBackend(fork.filePath).backend),
    });

    const branchResult = await branch<G>(
      baseStore,
      rejectMakeBackend,
      undefined,
      strategy,
    );
    expect(isOk(branchResult)).toBe(true);
    const forkBranch = unwrap(branchResult);

    await forkBranch.store.nodes.Widget.update(widget.id, {
      name: "Forked Edit",
    });

    // The base is unaffected before the merge commits.
    expect((await baseStore.nodes.Widget.getById(widget.id))?.name).toBe(
      "Original",
    );

    const mergeResult = await merge<G>(baseStore, [forkBranch], {});
    expect(isOk(mergeResult)).toBe(true);

    // The base sees the fork's write after commit.
    expect((await baseStore.nodes.Widget.getById(widget.id))?.name).toBe(
      "Forked Edit",
    );

    // The fork survives the whole merge — `dispose` releases it only when
    // `forkBranch.close()` runs, never earlier and never on its own.
    expect(dispose).not.toHaveBeenCalled();
    expect(existsSync(forkedPath)).toBe(true);

    await forkBranch.close();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(existsSync(forkedPath)).toBe(false);

    // Idempotent: a second close is a no-op, not a second teardown attempt.
    await forkBranch.close();
    expect(dispose).toHaveBeenCalledTimes(1);

    await baseBackend.close();
  });

  it("coalesces every branch close onto one backend release, even when the backend's own close is not idempotent and the calls are concurrent", async () => {
    const { backend: baseBackend } = createLocalSqliteBackend();
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Original" });

    // The clone strategy hands makeBackend's backend to the branch bare (a
    // fork's composed close is already managed), and the GraphBackend
    // contract does not promise an idempotent close — so this backend
    // tolerates exactly one, and the branch handle must not rely on more.
    let releases = 0;
    const makeBackend = () => {
      const { backend } = createLocalSqliteBackend();
      return Promise.resolve(
        deriveBackend(backend, {
          close: async () => {
            releases += 1;
            if (releases > 1) throw new Error("closed twice");
            await backend.close();
          },
        }),
      );
    };
    const cloneBranch = unwrap(await branch<G>(baseStore, makeBackend));

    await Promise.all([cloneBranch.close(), cloneBranch.close()]);
    await cloneBranch.close();

    expect(releases).toBe(1);

    await baseBackend.close();
  });

  it("retries a failed branch close instead of caching the rejection, so a transient teardown failure does not orphan the working copy", async () => {
    const { backend: baseBackend } = createLocalSqliteBackend();
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Original" });

    let attempts = 0;
    const makeBackend = () => {
      const { backend } = createLocalSqliteBackend();
      return Promise.resolve(
        deriveBackend(backend, {
          close: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("transient teardown failure");
            await backend.close();
          },
        }),
      );
    };
    const cloneBranch = unwrap(await branch<G>(baseStore, makeBackend));

    await expect(cloneBranch.close()).rejects.toThrow(
      "transient teardown failure",
    );
    await expect(cloneBranch.close()).resolves.toBeUndefined();
    await cloneBranch.close();

    expect(attempts).toBe(2);

    await baseBackend.close();
  });

  it("disposes the fork and leaves nothing open when connect() fails; the base remains usable", async () => {
    const { backend: baseBackend } = createLocalSqliteBackend();
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Alive" });

    const dispose = vi.fn(() => Promise.resolve());
    const connectFailure = new Error("connect() boom");
    const strategy = forkedWorkingCopyStrategy<G, ForkHandle>({
      fork: () => Promise.resolve({ dispose }),
      connect: () => Promise.reject(connectFailure),
    });

    await expect(
      strategy.create(baseStore, await computeBaseVersion(baseStore)),
    ).rejects.toBe(connectFailure);
    expect(dispose).toHaveBeenCalledTimes(1);

    // The base is untouched and still readable/writable.
    expect(
      (await baseStore.nodes.Widget.find()).map((found) => found.name),
    ).toEqual(["Alive"]);
    await baseStore.nodes.Widget.create({ name: "Still works" });

    await baseBackend.close();
  });

  it("refuses a fork whose content diverges from its base, closing the backend (and disposing the fork) first", async () => {
    const basePath = createTemporaryDbPath("base-mismatch");
    const { backend: baseBackend } = openFileBackend(basePath);
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Original" });

    const forkedPath = createTemporaryDbPath("fork-mismatch");
    copyFileSync(basePath, forkedPath);
    // Diverge the copy directly, bypassing TypeGraph — the copy is no longer
    // the base, byte for byte.
    const divergentBackend = openFileBackend(forkedPath).backend;
    await createStore(graph, divergentBackend).nodes.Widget.create({
      name: "Extra",
    });
    await divergentBackend.close();

    const dispose = vi.fn(async () => {
      if (existsSync(forkedPath)) unlinkSync(forkedPath);
    });
    const strategy = forkedWorkingCopyStrategy<
      G,
      ForkHandle & { filePath: string }
    >({
      fork: () => Promise.resolve({ filePath: forkedPath, dispose }),
      connect: (fork) =>
        Promise.resolve(openFileBackend(fork.filePath).backend),
    });

    await expect(
      strategy.create(baseStore, await computeBaseVersion(baseStore)),
    ).rejects.toBeInstanceOf(BranchError);
    expect(dispose).toHaveBeenCalledTimes(1);

    await baseBackend.close();
  });

  it("refuses a fork whose physical copy races ahead of the base@V branch() already stamped, even though the base is unchanged by the time the strategy checks it", async () => {
    const basePath = createTemporaryDbPath("base-race");
    const { backend: baseBackend } = openFileBackend(basePath);
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Original" });

    // `branch()` stamps `base` off `baseStore` BEFORE calling `fork()` — see
    // branch.ts. This `fork()` then writes to `baseStore` (simulating the
    // base advancing while the host prepares the fork) and only copies the
    // file AFTER that write commits, so the physical fork's content matches
    // the ADVANCED state, not the state `base` was stamped from. Comparing
    // against the passed `base` catches this; recomputing `baseStore`'s
    // version fresh inside the strategy (after the race has already
    // resolved) would not, since by then base and fork agree.
    const forkedPath = createTemporaryDbPath("race-fork");
    const dispose = vi.fn(async () => {
      if (existsSync(forkedPath)) unlinkSync(forkedPath);
    });
    const strategy = forkedWorkingCopyStrategy<
      G,
      ForkHandle & { filePath: string }
    >({
      fork: async () => {
        await baseStore.nodes.Widget.create({ name: "Raced In" });
        copyFileSync(basePath, forkedPath);
        return { filePath: forkedPath, dispose };
      },
      connect: (fork) =>
        Promise.resolve(openFileBackend(fork.filePath).backend),
    });

    const branchResult = await branch<G>(
      baseStore,
      rejectMakeBackend,
      undefined,
      strategy,
    );
    expect(isOk(branchResult)).toBe(false);
    if (isOk(branchResult)) throw new Error("unreachable");
    expect(branchResult.error).toBeInstanceOf(BranchError);
    expect(branchResult.error.cause).toBeInstanceOf(BranchError);
    expect(dispose).toHaveBeenCalledTimes(1);

    await baseBackend.close();
  });

  it(
    "preserves a base tombstone (and its created_at/version) through a fork " +
      "but not through a clone, and detects an identical property conflict " +
      "through either",
    async () => {
      const basePath = createTemporaryDbPath("base-tombstone");
      const { backend: baseBackend } = openFileBackend(basePath);
      const [baseStore] = await createStoreWithSchema(graph, baseBackend);
      const keep = await baseStore.nodes.Widget.create({ name: "Keep" });
      const gone = await baseStore.nodes.Widget.create({ name: "Gone" });
      await baseStore.nodes.Widget.delete(gone.id);

      const baseRows = await enumerateAllNodes(
        getStoreBackend(baseStore),
        baseStore.graphId,
        "Widget",
      );
      const baseGoneRow = baseRows.find((row) => row.id === gone.id);
      expect(baseGoneRow?.deleted_at).toBeDefined();

      const FORK_BRANCH = asBranchId("fork-branch");
      const CLONE_BRANCH = asBranchId("clone-branch");
      const forkBranch = unwrap(
        await branch<G>(
          baseStore,
          rejectMakeBackend,
          { id: FORK_BRANCH },
          fileForkStrategy(basePath, "tombstone-fork"),
        ),
      );
      const cloneDbPath = createTemporaryDbPath("tombstone-clone");
      const cloneBranch = unwrap(
        await branch<G>(
          baseStore,
          rejectMakeBackend,
          { id: CLONE_BRANCH },
          cloneWorkingCopyStrategy<G>(() =>
            Promise.resolve(openFileBackend(cloneDbPath).backend),
          ),
        ),
      );

      // The fork carries the tombstone unchanged (same created_at/updated_at/
      // version/deleted_at as the base row).
      const forkRows = await enumerateAllNodes(
        getStoreBackend(forkBranch.store),
        forkBranch.store.graphId,
        "Widget",
      );
      const forkGoneRow = forkRows.find((row) => row.id === gone.id);
      expect(forkGoneRow).toEqual(baseGoneRow);

      // The clone never received the soft-deleted row at all: interchange
      // exports only live rows (see working-copy.ts's fidelity note), so the
      // clone has no row for it whatsoever — not a live resurrection, an
      // absence.
      const cloneRows = await enumerateAllNodes(
        getStoreBackend(cloneBranch.store),
        cloneBranch.store.graphId,
        "Widget",
      );
      expect(cloneRows.some((row) => row.id === gone.id)).toBe(false);

      // A modify-on-both-sides conflict — the fork branch and the clone
      // branch editing the SAME base property — is detected identically
      // regardless of which strategy produced the branch.
      await forkBranch.store.nodes.Widget.update(keep.id, {
        name: "Fork Edit",
      });
      await cloneBranch.store.nodes.Widget.update(keep.id, {
        name: "Clone Edit",
      });

      const mergeResult = await merge<G>(baseStore, [forkBranch, cloneBranch], {
        onPropertyConflict: "flag",
        branchOrder: [FORK_BRANCH, CLONE_BRANCH],
      });
      expect(isOk(mergeResult)).toBe(true);
      if (!isOk(mergeResult)) throw mergeResult.error;

      const nameConflict = mergeResult.data.conflicts.find(
        (conflict) => conflict.property === "name",
      );
      expect(nameConflict).toBeDefined();
      expect(nameConflict?.values.map((value) => value.value).sort()).toEqual([
        "Clone Edit",
        "Fork Edit",
      ]);

      await forkBranch.close();
      await cloneBranch.close();
      await baseBackend.close();
    },
  );

  it(
    "answers a pre-fork asOfRecorded from a history-on fork; a clone " +
      "refuses asOfRecorded entirely (it never enables history)",
    async () => {
      const basePath = createTemporaryDbPath("base-history");
      const { backend: baseBackend } = openFileBackend(basePath);
      const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
        history: true,
      });
      const widget = await baseStore.nodes.Widget.create({ name: "v1" });
      const beforeUpdate = await baseStore.recordedNow();
      expect(beforeUpdate).toBeDefined();
      if (beforeUpdate === undefined) throw new Error("unreachable");
      await baseStore.nodes.Widget.update(widget.id, { name: "v2" });

      // The fork's history is intact: it physically carries the base's
      // recorded relations, so it answers a RECORDED-BEFORE-THE-FORK instant
      // with the state as of that instant ("v1", before the "v2" update).
      const forkBranch = unwrap(
        await branch<G>(
          baseStore,
          rejectMakeBackend,
          { id: asBranchId("history-fork") },
          fileForkStrategy(basePath, "history-fork"),
        ),
      );
      expect(forkBranch.store.historyEnabled).toBe(true);
      const forkView = forkBranch.store.asOfRecorded(beforeUpdate);
      const widgetAtForkT0 = await forkView.nodes.Widget.getById(widget.id);
      expect(widgetAtForkT0?.name).toBe("v1");

      // The clone strategy deliberately never turns `history` on for its
      // fresh store (streamed interchange cannot carry recorded relations —
      // see working-copy.ts's own doc comment), so a clone-based branch has
      // NO recorded read binding at all: `asOfRecorded` refuses synchronously
      // for every instant, not only a pre-clone one.
      const cloneDbPath = createTemporaryDbPath("history-clone");
      const cloneBranch = unwrap(
        await branch<G>(
          baseStore,
          rejectMakeBackend,
          { id: asBranchId("history-clone") },
          cloneWorkingCopyStrategy<G>(() =>
            Promise.resolve(openFileBackend(cloneDbPath).backend),
          ),
        ),
      );
      expect(cloneBranch.store.historyEnabled).toBe(false);
      expect(() => cloneBranch.store.asOfRecorded(beforeUpdate)).toThrow(
        ConfigurationError,
      );

      await forkBranch.close();
      await cloneBranch.close();
      await baseBackend.close();
    },
  );

  it("propagates a hook configured on the base onto the fork: the hook fires for a write on the fork", async () => {
    const basePath = createTemporaryDbPath("base-hooks");
    const { backend: baseBackend } = openFileBackend(basePath);
    const onOperationEnd = vi.fn();
    const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
      hooks: { onOperationEnd },
    });
    const widget = await baseStore.nodes.Widget.create({ name: "Original" });
    onOperationEnd.mockClear();

    const forkBranch = unwrap(
      await branch<G>(
        baseStore,
        rejectMakeBackend,
        { id: asBranchId("hooks-fork") },
        fileForkStrategy(basePath, "hooks-fork"),
      ),
    );

    // The fork was attached with a fresh Store (forkedWorkingCopyStrategy's
    // own createStore call), so it carries its OWN hooks configuration — the
    // base's `onOperationEnd` only fires for the fork's write if
    // Store.workingCopyOptions actually threaded it through.
    expect(onOperationEnd).not.toHaveBeenCalled();
    await forkBranch.store.nodes.Widget.update(widget.id, {
      name: "Fork Edit",
    });
    expect(onOperationEnd).toHaveBeenCalledTimes(1);

    await forkBranch.close();
    await baseBackend.close();
  });

  it(
    "propagates custom table names onto the fork when they come only from " +
      "the base's backend factory, with no explicit `schema` option " +
      "(the documented fallback covered by tests/custom-table-names.test.ts)",
    async () => {
      const CUSTOM_NAMES = {
        recordedClock: "app_recorded_clock",
        revisionOrigins: "app_revision_origins",
      };
      const basePath = createTemporaryDbPath("base-backend-only-names");
      const { backend: baseBackend } = createLocalSqliteBackend({
        path: basePath,
        pragmas: false,
        tables: createSqliteTables(CUSTOM_NAMES),
      });
      // No `schema` option: the base relies entirely on its backend's own
      // `tableNames` to resolve its custom names, exactly like
      // tests/custom-table-names.test.ts. Comparing forkOptions.schema
      // (undefined here) against a DEFAULT fallback instead of reading
      // through Store.revisionSchema would wrongly refuse this fork.
      const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
        revisionTracking: true,
      });
      const widget = await baseStore.nodes.Widget.create({ name: "Original" });
      const baseVersion = await computeBaseVersion(baseStore);

      const forkedPath = createTemporaryDbPath("backend-only-names-fork");
      const strategy = forkedWorkingCopyStrategy<
        G,
        ForkHandle & { filePath: string }
      >({
        fork: () => {
          copyFileSync(basePath, forkedPath);
          return Promise.resolve({
            filePath: forkedPath,
            dispose: async () => {
              if (existsSync(forkedPath)) unlinkSync(forkedPath);
            },
          });
        },
        connect: (fork) =>
          Promise.resolve(
            createLocalSqliteBackend({
              path: fork.filePath,
              pragmas: false,
              tables: createSqliteTables(CUSTOM_NAMES),
            }).backend,
          ),
      });

      const branchResult = await branch<G>(
        baseStore,
        rejectMakeBackend,
        undefined,
        strategy,
      );
      expect(isOk(branchResult)).toBe(true);
      const forkBranch = unwrap(branchResult);
      expect(await computeBaseVersion(forkBranch.store)).toBe(baseVersion);

      await forkBranch.store.nodes.Widget.update(widget.id, {
        name: "Forked Edit",
      });
      const mergeResult = await merge<G>(baseStore, [forkBranch], {});
      expect(isOk(mergeResult)).toBe(true);
      expect((await baseStore.nodes.Widget.getById(widget.id))?.name).toBe(
        "Forked Edit",
      );

      await forkBranch.close();
      await baseBackend.close();
    },
  );

  it(
    "accepts a fork whose connect() backend binds the SAME custom table " +
      "names the base used (schema inheritance follows from the fence)",
    async () => {
      const CUSTOM_NAMES = {
        recordedClock: "app_recorded_clock",
        revisionOrigins: "app_revision_origins",
      };
      const basePath = createTemporaryDbPath("base-custom-schema");
      const { backend: baseBackend } = createLocalSqliteBackend({
        path: basePath,
        pragmas: false,
        tables: createSqliteTables(CUSTOM_NAMES),
      });
      const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
        revisionTracking: true,
        schema: createSqlSchema(CUSTOM_NAMES),
      });
      const widget = await baseStore.nodes.Widget.create({ name: "Original" });
      const baseVersion = await computeBaseVersion(baseStore);

      const forkedPath = createTemporaryDbPath("custom-schema-fork");
      // connect() reconstructs the SAME custom table bindings the base
      // backend used. forkedWorkingCopyStrategy checks this (see
      // working-copy.ts): a fork is the same physical database as the base,
      // so a backend bound to different table names would read and write
      // through tables the fork's rows were never written to.
      const strategy = forkedWorkingCopyStrategy<
        G,
        ForkHandle & { filePath: string }
      >({
        fork: () => {
          copyFileSync(basePath, forkedPath);
          return Promise.resolve({
            filePath: forkedPath,
            dispose: async () => {
              if (existsSync(forkedPath)) unlinkSync(forkedPath);
            },
          });
        },
        connect: (fork) =>
          Promise.resolve(
            createLocalSqliteBackend({
              path: fork.filePath,
              pragmas: false,
              tables: createSqliteTables(CUSTOM_NAMES),
            }).backend,
          ),
      });

      const branchResult = await branch<G>(
        baseStore,
        rejectMakeBackend,
        undefined,
        strategy,
      );
      expect(isOk(branchResult)).toBe(true);
      const forkBranch = unwrap(branchResult);
      expect(await computeBaseVersion(forkBranch.store)).toBe(baseVersion);

      await forkBranch.store.nodes.Widget.update(widget.id, {
        name: "Forked Edit",
      });
      const mergeResult = await merge<G>(baseStore, [forkBranch], {});
      expect(isOk(mergeResult)).toBe(true);
      expect((await baseStore.nodes.Widget.getById(widget.id))?.name).toBe(
        "Forked Edit",
      );

      await forkBranch.close();
      await baseBackend.close();
    },
  );

  it(
    "refuses a fork whose connect() backend does not bind the base's " +
      "custom SQL schema table names, closing the backend first",
    async () => {
      // Only the revision-tracking tables are renamed — the node/edge tables
      // stay at their default names — so a mismatch here is isolated to
      // exactly the fields forkStoreOptions inherits through `schema`,
      // without also depending on node/edge table bindings.
      const CUSTOM_NAMES = {
        recordedClock: "app_recorded_clock",
        revisionOrigins: "app_revision_origins",
      };
      const basePath = createTemporaryDbPath("base-schema-mismatch");
      const { backend: baseBackend } = createLocalSqliteBackend({
        path: basePath,
        pragmas: false,
        tables: createSqliteTables(CUSTOM_NAMES),
      });
      const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
        revisionTracking: true,
        schema: createSqlSchema(CUSTOM_NAMES),
      });
      await baseStore.nodes.Widget.create({ name: "Original" });

      const forkedPath = createTemporaryDbPath("schema-mismatch-fork");
      const dispose = vi.fn(async () => {
        if (existsSync(forkedPath)) unlinkSync(forkedPath);
      });
      // connect() opens a PLAIN backend on the forked file — default table
      // bindings, disagreeing with the custom recordedClock/revisionOrigins
      // names the base's (and therefore the fork's inherited) schema names.
      const strategy = forkedWorkingCopyStrategy<
        G,
        ForkHandle & { filePath: string }
      >({
        fork: () => {
          copyFileSync(basePath, forkedPath);
          return Promise.resolve({ filePath: forkedPath, dispose });
        },
        connect: (fork) =>
          Promise.resolve(openFileBackend(fork.filePath).backend),
      });

      await expect(
        strategy.create(baseStore, await computeBaseVersion(baseStore)),
      ).rejects.toBeInstanceOf(BranchError);
      expect(dispose).toHaveBeenCalledTimes(1);

      // The base is untouched and still readable/writable.
      expect(
        (await baseStore.nodes.Widget.find()).map((found) => found.name),
      ).toEqual(["Original"]);

      await baseBackend.close();
    },
  );

  it("refuses a fork whose connect() returns the base store's own backend outright (object identity), disposing only the fork and leaving the base open", async () => {
    const sqlite = new Database(":memory:");
    // Declared "independent" so this test isolates the object-identity arm:
    // an undeclared better-sqlite3 backend is marked "serialized", which
    // would let sharesSerializedTransactionResource catch a self-aliased
    // backend too (any backend equals itself) and mask a broken identity
    // check. Marking it independent takes that arm out of play.
    const baseBackend = createSqliteBackend(drizzle(sqlite), {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Original" });

    const dispose = vi.fn(() => Promise.resolve());
    const strategy = forkedWorkingCopyStrategy<G, ForkHandle>({
      fork: () => Promise.resolve({ dispose }),
      // A cached-factory bug: `connect()` hands back the BASE's own backend
      // instead of opening a connection to the fork.
      connect: () => Promise.resolve(getStoreBackend(baseStore)),
    });

    await expect(
      strategy.create(baseStore, await computeBaseVersion(baseStore)),
    ).rejects.toBeInstanceOf(BranchError);
    // Only the fork is released — the aliased backend is the base's, and
    // closing it here would close the base out from under its owner.
    expect(dispose).toHaveBeenCalledTimes(1);

    expect(
      (await baseStore.nodes.Widget.find()).map((found) => found.name),
    ).toEqual(["Original"]);
    await baseStore.nodes.Widget.create({ name: "Still works" });

    sqlite.close();
  });

  it("refuses a fork whose connect() returns a backend derived FROM the base's backend through deriveBackend", async () => {
    const sqlite = new Database(":memory:");
    // Declared "independent" for the same isolation reason as the object-
    // identity test above: deriveBackend also CARRIES a "serialized" audit
    // onto the derived backend, so an undeclared base would let
    // sharesSerializedTransactionResource catch this case too and mask a
    // broken isBackendDerivedFrom check.
    const baseBackend = createSqliteBackend(drizzle(sqlite), {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Original" });

    const dispose = vi.fn(() => Promise.resolve());
    const strategy = forkedWorkingCopyStrategy<G, ForkHandle>({
      fork: () => Promise.resolve({ dispose }),
      // A decorator over the base's own backend is still the base's
      // connection underneath — deriveBackend carries derivation lineage
      // (isBackendDerivedFrom), regardless of the resource audit, even with
      // an empty overlay.
      connect: () =>
        Promise.resolve(deriveBackend(getStoreBackend(baseStore), {})),
    });

    await expect(
      strategy.create(baseStore, await computeBaseVersion(baseStore)),
    ).rejects.toBeInstanceOf(BranchError);
    expect(dispose).toHaveBeenCalledTimes(1);

    expect(
      (await baseStore.nodes.Widget.find()).map((found) => found.name),
    ).toEqual(["Original"]);

    sqlite.close();
  });

  it("refuses a fork whose connect() returns the ROOT backend the base's own backend was derived from (reverse-derivation arm)", async () => {
    const sqlite = new Database(":memory:");
    // Declared "independent" so the shared-resource arm cannot mask a broken
    // reverse-lineage check, exactly as the forward-derivation test above.
    const rootBackend = createSqliteBackend(drizzle(sqlite), {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });
    // The BASE store sits on a decorator over the root; connect() hands back
    // the root itself. Object identity differs and the root is not derived
    // from the base, so only the base-derived-from-connected direction of
    // isBackendDerivedFrom catches this.
    const [baseStore] = await createStoreWithSchema(
      graph,
      deriveBackend(rootBackend, {}),
    );
    await baseStore.nodes.Widget.create({ name: "Original" });

    const dispose = vi.fn(() => Promise.resolve());
    const strategy = forkedWorkingCopyStrategy<G, ForkHandle>({
      fork: () => Promise.resolve({ dispose }),
      connect: () => Promise.resolve(rootBackend),
    });

    await expect(
      strategy.create(baseStore, await computeBaseVersion(baseStore)),
    ).rejects.toBeInstanceOf(BranchError);
    expect(dispose).toHaveBeenCalledTimes(1);

    expect(
      (await baseStore.nodes.Widget.find()).map((found) => found.name),
    ).toEqual(["Original"]);

    sqlite.close();
  });

  it("refuses a fork whose connect() returns a SECOND createSqliteBackend wrapper over the SAME better-sqlite3 Database as the base (shared-resource arm)", async () => {
    const sqlite = new Database(":memory:");
    const baseBackend = createSqliteBackend(drizzle(sqlite), {
      executionProfile: { isSync: true },
    });
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    await baseStore.nodes.Widget.create({ name: "Original" });

    const dispose = vi.fn(() => Promise.resolve());
    const strategy = forkedWorkingCopyStrategy<G, ForkHandle>({
      fork: () => Promise.resolve({ dispose }),
      // A SEPARATE createSqliteBackend/drizzle() wrapper, but over the exact
      // same `sqlite` Database handle — two independently-constructed
      // objects sharing one connection, not an identity or derivation
      // relationship, so only sharesSerializedTransactionResource catches
      // this.
      connect: () =>
        Promise.resolve(
          createSqliteBackend(drizzle(sqlite), {
            executionProfile: { isSync: true },
          }),
        ),
    });

    await expect(
      strategy.create(baseStore, await computeBaseVersion(baseStore)),
    ).rejects.toBeInstanceOf(BranchError);
    expect(dispose).toHaveBeenCalledTimes(1);

    expect(
      (await baseStore.nodes.Widget.find()).map((found) => found.name),
    ).toEqual(["Original"]);

    sqlite.close();
  });
});
