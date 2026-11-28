/**
 * Two copies of TypeGraph in one process reach each other's Stores through the
 * Store runtime port's global symbol. The symbol names the port's version, so
 * a copy that advertises another version finds no port on the Store and
 * refuses it with the incompatible-version `TypeError`, before the engine is
 * asked to run anything.
 *
 * The other version is real code: main's `src` at the last commit whose port
 * is `store-runtime-v1` ({@link V1_PORT_COMMIT}), extracted from git and
 * loaded as a second module tree beside this one. Two copies of one version
 * are two evaluations of the same tree (`vi.resetModules()`), as an ES module
 * and a CommonJS build of one release are.
 *
 * The cross-version case needs each copy's own backend over the same engine,
 * so it cannot take the shared integration suite's one backend factory; it
 * opens better-sqlite3, libSQL and PGlite itself, through each copy's own
 * adapter.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import type * as DdlModule from "../src/backend/drizzle/ddl";
import type * as PostgresModule from "../src/backend/postgres";
import type * as LibsqlModule from "../src/backend/sqlite/libsql";
import type * as LocalSqliteModule from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import type * as CoreModule from "../src/core";
import type * as ErrorsModule from "../src/errors";
import type * as InterchangeModule from "../src/interchange";
import type * as StoreModule from "../src/store";

/**
 * The last commit of main whose Store runtime port is `store-runtime-v1`.
 * Pinned, so the other version stays the same code after this change lands.
 */
const V1_PORT_COMMIT = "5d11f1c340c32ff9f2236e2162806b35318a362e";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const CURRENT_SRC = path.join(PACKAGE_DIR, "src");

const INCOMPATIBLE_STORE =
  "Cannot access this Store's runtime port. The Store may come from an incompatible TypeGraph version.";

/**
 * One copy of the library: the modules a test calls, from one evaluation of
 * one `src` tree. Typed by this copy's declarations; only members both
 * versions share are called.
 */
type LibraryCopy = Readonly<{
  core: typeof CoreModule;
  errors: typeof ErrorsModule;
  store: typeof StoreModule;
  interchange: typeof InterchangeModule;
  local: typeof LocalSqliteModule;
  libsql: typeof LibsqlModule;
  postgres: typeof PostgresModule;
  ddl: typeof DdlModule;
}>;

async function importFrom<Module>(
  sourceRoot: string,
  relative: string,
): Promise<Module> {
  const url = pathToFileURL(path.join(sourceRoot, relative)).href;
  return (await import(/* @vite-ignore */ url)) as Module;
}

/** A fresh evaluation of the `src` tree at `srcRoot`. */
async function loadCopy(sourceRoot: string): Promise<LibraryCopy> {
  vi.resetModules();
  return {
    core: await importFrom(sourceRoot, "core/index.ts"),
    errors: await importFrom(sourceRoot, "errors/index.ts"),
    store: await importFrom(sourceRoot, "store/index.ts"),
    interchange: await importFrom(sourceRoot, "interchange/index.ts"),
    local: await importFrom(sourceRoot, "backend/sqlite/local.ts"),
    libsql: await importFrom(sourceRoot, "backend/sqlite/libsql.ts"),
    postgres: await importFrom(sourceRoot, "backend/postgres/index.ts"),
    ddl: await importFrom(sourceRoot, "backend/drizzle/ddl.ts"),
  };
}

/**
 * Extracts the package's `src` at {@link V1_PORT_COMMIT} into a temporary
 * directory whose `node_modules` is this package's, so the tree resolves the
 * same dependencies. A shallow checkout fetches the one commit first.
 */
function extractV1Source(directory: string): string {
  const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  }).trim();
  try {
    execFileSync("git", ["cat-file", "-e", `${V1_PORT_COMMIT}^{commit}`], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
  } catch {
    execFileSync(
      "git",
      ["fetch", "--no-tags", "--depth=1", "origin", V1_PORT_COMMIT],
      { cwd: repositoryRoot, stdio: "ignore" },
    );
  }
  const archive = execFileSync(
    "git",
    ["archive", V1_PORT_COMMIT, "packages/typegraph/src"],
    { cwd: repositoryRoot, maxBuffer: 256 * 1024 * 1024 },
  );
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  const packageDirectory = path.join(directory, "packages/typegraph");
  symlinkSync(
    path.join(PACKAGE_DIR, "node_modules"),
    path.join(packageDirectory, "node_modules"),
    "dir",
  );
  return path.join(packageDirectory, "src");
}

/**
 * Records every call to `methods` on the engine client `target`, from now on.
 * A statement, a transaction, a prepared query: whatever the backend asks the
 * engine for goes through one of them.
 */
function recordCalls(
  target: object,
  methods: readonly string[],
): readonly string[] {
  const calls: string[] = [];
  for (const method of methods) {
    const original: unknown = Reflect.get(target, method);
    if (typeof original !== "function") {
      throw new TypeError(`The engine client has no ${method} method.`);
    }
    const invoke = original as (...callArguments: unknown[]) => unknown;
    Reflect.set(target, method, (...args: unknown[]): unknown => {
      calls.push(method);
      return invoke.apply(target, args);
    });
  }
  return calls;
}

/** The driver client under a Drizzle database. */
function driverClient(db: object): object {
  const client: unknown = Reflect.get(db, "$client");
  if (typeof client !== "object" || client === null) {
    throw new TypeError("The Drizzle database exposes no driver client.");
  }
  return client;
}

/** A database on one engine, behind one copy's adapter. */
type OpenedEngine = Readonly<{
  backend: GraphBackend;
  /** Starts recording the calls the backend makes into the engine. */
  record: () => readonly string[];
}>;

type Engine = Readonly<{
  name: string;
  open: (copy: LibraryCopy) => Promise<OpenedEngine>;
}>;

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).toReversed()) await close();
});

let scratchDirectory = "";

const ENGINES: readonly Engine[] = [
  {
    name: "better-sqlite3",
    open: (copy) => {
      const { backend, db } = copy.local.createLocalSqliteBackend();
      closers.push(() => backend.close());
      return Promise.resolve({
        backend,
        record: () =>
          recordCalls(driverClient(db), [
            "prepare",
            "exec",
            "transaction",
            "pragma",
          ]),
      });
    },
  },
  {
    name: "libSQL",
    open: async (copy) => {
      const file = path.join(
        scratchDirectory,
        `libsql-${crypto.randomUUID()}.db`,
      );
      const client = createClient({ url: `file:${file}` });
      const { backend } = await copy.libsql.createLibsqlBackend(client);
      closers.push(async () => {
        await backend.close();
        client.close();
      });
      return {
        backend,
        record: () =>
          recordCalls(client, [
            "execute",
            "batch",
            "transaction",
            "executeMultiple",
          ]),
      };
    },
  },
  {
    name: "PGlite",
    open: async (copy) => {
      const client = await PGlite.create();
      closers.push(() => client.close());
      await client.exec(copy.ddl.generatePostgresDDL().join("\n\n"));
      const backend = copy.postgres.createPostgresBackend(drizzle(client), {
        vector: false,
      });
      return {
        backend,
        record: () =>
          recordCalls(client, ["query", "exec", "transaction", "sql"]),
      };
    },
  },
];

const HOUR_MS = 60 * 60 * 1000;

function defineScenarioGraph(copy: LibraryCopy, id: string, identity: boolean) {
  const Person = copy.core.defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const Author = copy.core.defineNode("Author", {
    schema: z.object({ penName: z.string() }),
  });
  return copy.core.defineGraph({
    id,
    nodes: { Person: { type: Person }, Author: { type: Author } },
    edges: {},
    ...(identity ? { identity: { sameIdAcrossKinds: "fold" } } : {}),
  });
}

/** Two people and, when the graph declares identity, one assertion joining them. */
function importPayload(
  copy: LibraryCopy,
  identity: boolean,
): InterchangeModule.GraphData {
  const validFrom = new Date(Date.now() - HOUR_MS).toISOString();
  return {
    formatVersion: copy.interchange.FORMAT_VERSION,
    exportedAt: validFrom,
    source: { type: "external" },
    nodes: [
      { kind: "Person", id: "a", properties: { name: "A" }, validFrom },
      { kind: "Person", id: "b", properties: { name: "B" }, validFrom },
    ],
    edges: [],
    ...(identity ?
      {
        identity: {
          profile: "typegraph-identity-v1",
          mode: "state",
          assertions: [
            {
              id: "assertion-cross-copy",
              relation: "same",
              a: { kind: "Person", id: "a" },
              b: { kind: "Person", id: "b" },
              validFrom,
            },
          ],
        },
      }
    : {}),
  };
}

const IMPORT_OPTIONS = {
  onConflict: "error",
  onUnknownProperty: "error",
} as const;

async function openHistoryStore(
  engine: Engine,
  copy: LibraryCopy,
  graphId: string,
  identity: boolean,
) {
  const opened = await engine.open(copy);
  const graph = defineScenarioGraph(copy, graphId, identity);
  const [store] = await copy.store.createStoreWithSchema(
    graph,
    opened.backend,
    { history: true },
  );
  return { store, record: opened.record };
}

type ScenarioStore = Awaited<ReturnType<typeof openHistoryStore>>["store"];

async function storedPersonIds(store: ScenarioStore): Promise<string[]> {
  const people = await store.nodes.Person.find();
  return people.map((person) => person.id).toSorted();
}

/** Seeds `store` through its own copy's importer. */
async function seed(
  storeCopy: LibraryCopy,
  store: ScenarioStore,
  identity: boolean,
): Promise<void> {
  const result = await storeCopy.interchange.importGraph(
    store,
    importPayload(storeCopy, identity),
    IMPORT_OPTIONS,
  );
  expect(result.errors).toEqual([]);
}

/** Exports `store` through `exporterCopy`'s stream, identity in state mode. */
async function exportChunks(
  exporterCopy: LibraryCopy,
  store: ScenarioStore,
): Promise<readonly InterchangeModule.GraphInterchangeChunk[]> {
  const chunks: InterchangeModule.GraphInterchangeChunk[] = [];
  for await (const chunk of exporterCopy.interchange.exportGraphStream(store, {
    identityMode: "state",
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

let currentA: LibraryCopy;
let currentB: LibraryCopy;
let v1A: LibraryCopy;
let v1B: LibraryCopy;

beforeAll(async () => {
  scratchDirectory = mkdtempSync(path.join(tmpdir(), "typegraph-port-v1-"));
  const v1Source = extractV1Source(scratchDirectory);
  currentA = await loadCopy(CURRENT_SRC);
  currentB = await loadCopy(CURRENT_SRC);
  v1A = await loadCopy(v1Source);
  v1B = await loadCopy(v1Source);
}, 120_000);

afterAll(() => {
  rmSync(scratchDirectory, { recursive: true, force: true });
});

describe("the Store runtime port version", () => {
  it("loads four distinct copies of the library", () => {
    const importers = new Set(
      [currentA, currentB, v1A, v1B].map(
        (copy) => copy.interchange.importGraph,
      ),
    );
    expect(importers.size).toBe(4);
  });

  describe.each(ENGINES)("on $name", (engine) => {
    describe.each([
      { identity: false, label: "identity disabled" },
      { identity: true, label: "identity enabled" },
    ])("$label", ({ identity }) => {
      const suffix = `${engine.name.replaceAll(/\W/g, "_")}_${identity ? "identity" : "plain"}`;

      it("refuses an importer of this version into a v1 Store before any statement", async () => {
        const { store, record } = await openHistoryStore(
          engine,
          v1A,
          `port_version_new_into_v1_${suffix}`,
          identity,
        );
        const calls = record();

        const refusal: unknown = await currentA.interchange
          .importGraph(store, importPayload(currentA, identity), IMPORT_OPTIONS)
          .then(
            () => "imported" as const,
            (error: unknown) => error,
          );

        // The import boundary refuses a target whose port it cannot read
        // with its own typed error; the port's refusal is the cause.
        expect(refusal).toBeInstanceOf(currentA.errors.ConfigurationError);
        expect(refusal).toMatchObject({
          details: { target: "unregistered-ingestion-target" },
        });
        expect(refusal instanceof Error ? refusal.cause : refusal).toEqual(
          new TypeError(INCOMPATIBLE_STORE),
        );
        expect(calls).toEqual([]);
        expect(await storedPersonIds(store)).toEqual([]);
      });

      it("refuses a v1 export stream over a Store of this version before any statement", async () => {
        const { store, record } = await openHistoryStore(
          engine,
          currentA,
          `port_version_v1_export_new_${suffix}`,
          identity,
        );
        await seed(currentA, store, identity);
        const calls = record();

        await expect(exportChunks(v1A, store)).rejects.toThrow(
          new TypeError(INCOMPATIBLE_STORE),
        );
        expect(calls).toEqual([]);
        expect(await storedPersonIds(store)).toEqual(["a", "b"]);
      });

      for (const [versionLabel, storeCopy, otherCopy] of [
        ["this version", () => currentA, () => currentB],
        ["v1", () => v1A, () => v1B],
      ] as const) {
        it(`imports across two copies of ${versionLabel}`, async () => {
          const { store } = await openHistoryStore(
            engine,
            storeCopy(),
            `port_version_import_${versionLabel.replaceAll(" ", "_")}_${suffix}`,
            identity,
          );

          const result = await otherCopy().interchange.importGraph(
            store,
            importPayload(otherCopy(), identity),
            IMPORT_OPTIONS,
          );

          expect(result.errors).toEqual([]);
          expect(result.nodes.created).toBe(2);
          expect(result.identity).toEqual({
            created: identity ? 1 : 0,
            skipped: 0,
          });
          expect(await storedPersonIds(store)).toEqual(["a", "b"]);
          const classMembers =
            identity ?
              await store.identity.membersOf({ kind: "Person", id: "a" })
            : [];
          expect(classMembers.map((member) => member.id).toSorted()).toEqual(
            identity ? ["a", "b"] : [],
          );
        });

        it(`streams an export across two copies of ${versionLabel}`, async () => {
          const { store } = await openHistoryStore(
            engine,
            storeCopy(),
            `port_version_export_${versionLabel.replaceAll(" ", "_")}_${suffix}`,
            identity,
          );
          await seed(storeCopy(), store, identity);

          const chunks = await exportChunks(otherCopy(), store);

          const exportedIds = chunks
            .flatMap((chunk) => (chunk.type === "nodes" ? chunk.nodes : []))
            .map((node) => node.id)
            .toSorted();
          expect(exportedIds).toEqual(["a", "b"]);
          const assertionIds = chunks
            .flatMap((chunk) =>
              chunk.type === "identity" ? chunk.assertions : [],
            )
            .map((assertion) => assertion.id);
          expect(assertionIds).toEqual(
            identity ? ["assertion-cross-copy"] : [],
          );
        });
      }
    });
  });
});
