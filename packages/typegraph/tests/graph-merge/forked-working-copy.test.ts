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

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
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
  it("forks a file-backed SQLite database by copying its file, and merges a fork write back to the base", async () => {
    const basePath = createTemporaryDbPath("base-roundtrip");
    const { backend: baseBackend } = openFileBackend(basePath);
    const [baseStore] = await createStoreWithSchema(graph, baseBackend);
    const widget = await baseStore.nodes.Widget.create({ name: "Original" });

    const branchResult = await branch<G>(
      baseStore,
      rejectMakeBackend,
      undefined,
      fileForkStrategy(basePath, "roundtrip-fork"),
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

    await getStoreBackend(forkBranch.store).close();
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

    await expect(strategy.create(baseStore)).rejects.toBe(connectFailure);
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

    await expect(strategy.create(baseStore)).rejects.toBeInstanceOf(
      BranchError,
    );
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

      await getStoreBackend(forkBranch.store).close();
      await getStoreBackend(cloneBranch.store).close();
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

      await getStoreBackend(forkBranch.store).close();
      await getStoreBackend(cloneBranch.store).close();
      await baseBackend.close();
    },
  );
});
