/**
 * The separation relation is never readable in a state that UNDER-REPORTS
 * separations — on the paths where a schema commit is refused, and on the paths
 * where the relation is already present but holds none of this graph's rows.
 *
 * Both were reachable while the provisioning decision was "does the table
 * exist":
 *
 *  - A gated identity migration (a `sameIdAcrossKinds` flip) created the
 *    relation BEFORE the commit that was then refused as breaking. The relation
 *    was left present and empty, so `isSeparated` answered "not separated" for
 *    a pair a live `different` assertion separates — and because the next open
 *    saw the table PRESENT, the upgrade never re-triggered and the wrong answer
 *    was permanent.
 *  - Identity DDL is database-global while the assertion ledger is per graph,
 *    so any other graph creating the relation first had exactly the same effect
 *    on this graph's fill.
 *
 * The fix is one predicate: this graph has live `different` assertions and no
 * separation rows. Nothing here depends on timing — each sequence is run
 * step by step.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
  IdentityContradictionError,
  IdentitySeparationViolationError,
} from "../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../src/backend/sqlite/local";
import { type SchemaCommitPreflightBackend } from "../src/backend/types";
import { ensureIdentitySchemaStorage } from "../src/identity/schema-transition";
import { separationRebuildRequired } from "../src/identity/separation";
import { rebuildIdentityClosureForContext } from "../src/identity/service";
import { createSqlSchema } from "../src/query/compiler/schema";
import { buildKindRegistry } from "../src/registry/builders";
import { getActiveSchema, migrateSchema } from "../src/schema";
import { storeRuntime } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";
import { matchingObject } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const GRAPH_ID = "identity_separation_heal";

const foldGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/** The same graph with the profile flipped — a BREAKING identity change. */
const ignoreGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const SEPARATION_TABLE = "typegraph_identity_separation";

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  return (result.db as unknown as { $client: Database.Database }).$client;
}

function separationTableExists(result: LocalSqliteBackendResult): boolean {
  const rows = rawClient(result)
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .all(SEPARATION_TABLE) as { name: string }[];
  return rows.length > 0;
}

function separationRowCount(result: LocalSqliteBackendResult): number {
  const row = rawClient(result)
    .prepare(`SELECT COUNT(*) AS n FROM ${SEPARATION_TABLE}`)
    .get() as { n: number };
  return row.n;
}

/** A graph carrying one live `different` assertion, and no separation storage. */
async function seedSeparatedPairWithoutRelation(
  result: LocalSqliteBackendResult,
): Promise<void> {
  const [seeded] = await createStoreWithSchema(foldGraph, result.backend);
  const alice = await seeded.nodes.Person.create(
    { name: "Alice" },
    { id: "alice" },
  );
  const bob = await seeded.nodes.Person.create({ name: "Bob" }, { id: "bob" });
  await seeded.identity.assertDifferent(alice, bob);
  expect(separationRowCount(result)).toBe(1);
  // The database shape this whole file is about: a deployment provisioned
  // before the separation relation existed, whose ledger already records a
  // separation the derived relation cannot answer for.
  rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);
}

const alice = { kind: "Person", id: "alice" } as const;
const bob = { kind: "Person", id: "bob" } as const;

describe("separation relation under a refused identity migration", () => {
  it("creates nothing when the gated commit is refused, and heals on the next open", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);

      // The gated upgrade: flipping `sameIdAcrossKinds` is breaking, so the
      // commit never happens. The provisioning this open performs must not
      // outlive the commit it belongs to.
      await expect(
        createStoreWithSchema(ignoreGraph, result.backend),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          details: matchingObject({
            code: "IDENTITY_PROFILE_MIGRATION_PENDING",
          }),
        }),
      );

      // The mechanism: the CREATE was handed to the commit transaction as DDL,
      // and that transaction never opened. ABSENT is a safe state — every read
      // raises IDENTITY_STORAGE_MISSING. PRESENT-and-empty is not.
      expect(separationTableExists(result)).toBe(false);

      // And the observable truth, from a store on the semantics the database
      // actually committed: the pair is still separated.
      const [reopened] = await createStoreWithSchema(foldGraph, result.backend);
      expect(separationRowCount(result)).toBe(1);
      expect(await reopened.identity.areDifferent(alice, bob)).toBe(true);
      await expect(
        reopened.identity.assertSame(alice, bob),
      ).rejects.toBeInstanceOf(IdentityContradictionError);
      await expect(
        storeRuntime(reopened).validateIdentity(),
      ).resolves.toBeUndefined();
    } finally {
      await result.backend.close();
    }
  });

  it("heals a separation relation that is present but holds none of this graph's rows", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [seeded] = await createStoreWithSchema(foldGraph, result.backend);
      const first = await seeded.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await seeded.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await seeded.identity.assertDifferent(first, second);

      // Exactly the state an older version stranded, and the state another
      // graph's provisioning produces: the relation exists, and answers "not
      // separated" for a pair the ledger separates. Under a table-existence
      // check this is invisible — `missingTables` is empty, so no fill runs and
      // the wrong answer is permanent.
      rawClient(result).exec(`DELETE FROM ${SEPARATION_TABLE}`);
      expect(separationRowCount(result)).toBe(0);

      const [reopened] = await createStoreWithSchema(foldGraph, result.backend);

      expect(separationRowCount(result)).toBe(1);
      expect(await reopened.identity.areDifferent(alice, bob)).toBe(true);
      await expect(
        reopened.identity.assertSame(alice, bob),
      ).rejects.toBeInstanceOf(IdentityContradictionError);
    } finally {
      await result.backend.close();
    }
  });

  it("leaves an already-correct empty relation alone", async () => {
    const result = createLocalSqliteBackend();
    try {
      // No `different` assertion anywhere: zero rows IS the projection, so the
      // predicate must not read emptiness as a debt and rebuild on every open.
      const [seeded] = await createStoreWithSchema(foldGraph, result.backend);
      await seeded.nodes.Person.create({ name: "Alice" }, { id: "alice" });
      expect(separationRowCount(result)).toBe(0);

      const [reopened] = await createStoreWithSchema(foldGraph, result.backend);
      expect(separationRowCount(result)).toBe(0);
      expect(await reopened.identity.areDifferent(alice, bob)).toBe(false);
    } finally {
      await result.backend.close();
    }
  });
});

/** The shape node-postgres reports for a catalog duplicate-key failure. */
function duplicateKeyError(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "pg_type_typname_nsp_index"',
    ),
    { code: "23505", constraint: "pg_type_typname_nsp_index" },
  );
}

/**
 * Replaces `executeSchemaDdl` on a preflight/fence target so its first
 * `remaining` calls lose the catalog race.
 *
 * A Proxy rather than a spread: these targets carry their methods on a
 * prototype, which a spread would drop.
 */
function targetLosingDdlRace<T extends object>(
  target: T,
  remaining: { count: number },
): T {
  return new Proxy(target, {
    get(source, property, receiver) {
      const value: unknown = Reflect.get(source, property, receiver);
      if (property !== "executeSchemaDdl" || typeof value !== "function") {
        return value;
      }
      return (ddl: string) => {
        if (remaining.count > 0) {
          remaining.count -= 1;
          return Promise.reject(duplicateKeyError());
        }
        return (value as (statement: string) => Promise<void>).call(
          source,
          ddl,
        );
      };
    },
  });
}

/**
 * The fenced upgrade, with the first N CREATE statements losing the catalog
 * race.
 *
 * The injection is at the DDL STATEMENT, which is where PostgreSQL actually
 * raises 23505 — the CREATE inside the fence — and no longer at
 * `schemaWriteTransaction` itself. That distinction is now load-bearing: the
 * retry fires only for a failure the identity DDL reported, so an equally
 * 23505-shaped failure from anywhere else in the attempt (the fill, the CAS)
 * stays loud on the first try rather than being re-run as a presumed race.
 */
function backendLosingCreateRace(
  result: LocalSqliteBackendResult,
  failures: number,
): Readonly<{ backend: GraphBackend; attempts: () => number }> {
  const fence = requireDefined(result.backend.schemaWriteTransaction);
  const remaining = { count: failures };
  let attempts = 0;
  return {
    attempts: () => attempts,
    backend: {
      ...result.backend,
      schemaWriteTransaction: <T>(
        graphId: string,
        fn: Parameters<typeof fence<T>>[1],
      ): Promise<T> => {
        attempts += 1;
        return fence(graphId, (target) =>
          fn(targetLosingDdlRace(target, remaining)),
        );
      },
    },
  };
}

describe("fenced upgrade against a concurrent creator", () => {
  it("retries the whole attempt once when the catalog race aborts it", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);
      const racing = backendLosingCreateRace(result, 1);

      // Postgres aborts the whole transaction on 23505, so the in-place retry
      // the unfenced create sites use is unavailable: the fenced attempt is
      // re-run instead, against a database where the winner's table is now
      // committed.
      await ensureIdentitySchemaStorage(
        racing.backend,
        createSqlSchema(result.backend.tableNames),
        {
          graphId: GRAPH_ID,
          enablement: false,
          registry: buildKindRegistry(foldGraph),
          recomputeDerivedRelations: (target) =>
            rebuildIdentityClosureForContext<typeof foldGraph>({
              backend: target,
              graphId: GRAPH_ID,
              registry: buildKindRegistry(foldGraph),
              schema: createSqlSchema(result.backend.tableNames),
              sameIdAcrossKinds: "fold",
            }),
        },
      );

      expect(racing.attempts()).toBe(2);
      expect(separationRowCount(result)).toBe(1);
    } finally {
      await result.backend.close();
    }
  });

  it("stays loud when the retry cannot clear the failure", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);
      const racing = backendLosingCreateRace(result, 2);

      // Bounded at one retry: a second 23505 is no longer a race with a
      // creator that is about to commit, and swallowing it would turn a real
      // uniqueness failure into an upgrade that silently did nothing.
      await expect(
        ensureIdentitySchemaStorage(
          racing.backend,
          createSqlSchema(result.backend.tableNames),
          {
            graphId: GRAPH_ID,
            enablement: false,
            registry: buildKindRegistry(foldGraph),
            recomputeDerivedRelations: () => Promise.resolve(),
          },
        ),
      ).rejects.toThrow(/duplicate key value/);
      expect(racing.attempts()).toBe(2);
      expect(separationTableExists(result)).toBe(false);
    } finally {
      await result.backend.close();
    }
  });

  it("does not re-run the attempt for a duplicate key raised by the FILL", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);
      const racing = backendLosingCreateRace(result, 0);

      // The retry is scoped to the identity DDL, which is the only statement
      // in the attempt that is idempotent-by-construction. A 23505 from the
      // closure/separation FILL is a real duplicate write: re-running it would
      // hide the defect behind an attempt that looks like a lost race, and the
      // classifier's own contract says so.
      await expect(
        ensureIdentitySchemaStorage(
          racing.backend,
          createSqlSchema(result.backend.tableNames),
          {
            graphId: GRAPH_ID,
            enablement: false,
            registry: buildKindRegistry(foldGraph),
            recomputeDerivedRelations: () =>
              Promise.reject(duplicateKeyError()),
          },
        ),
      ).rejects.toThrow(/duplicate key value/);
      expect(racing.attempts()).toBe(1);
    } finally {
      await result.backend.close();
    }
  });
});

/**
 * Writes an assertion the CURRENT registry cannot see: a live `different`
 * naming a node kind this graph no longer declares.
 *
 * Raw SQL on purpose. The managed paths that create this state — a kind dropped
 * while identity was disabled, an assertion ledger retained across a
 * re-enablement — reach it through cascades whose own behavior is not what is
 * under test here; what is under test is that the fill decision agrees with the
 * fill about whether such a row counts.
 */
function insertUnregisteredKindAssertion(
  result: LocalSqliteBackendResult,
): void {
  const now = "2020-01-01T00:00:00.000Z";
  rawClient(result)
    .prepare(
      `INSERT INTO typegraph_identity_assertions
         (graph_id, id, rel, a_kind, a_id, b_kind, b_id,
          valid_from, valid_to, created_at, updated_at, deleted_at)
       VALUES (?, ?, 'different', 'Ghost', 'g1', 'Ghost', 'g2',
               ?, NULL, ?, ?, NULL)`,
    )
    .run(GRAPH_ID, "ghost-assertion", now, now, now);
}

/** Counts the two things a derived-relation upgrade cannot do without. */
function upgradeActivityBackend(result: LocalSqliteBackendResult): Readonly<{
  backend: GraphBackend;
  fences: () => number;
  closureRewrites: () => number;
  reset: () => void;
}> {
  const fence = requireDefined(result.backend.schemaWriteTransaction);
  const closureTable = createSqlSchema(result.backend.tableNames).tables
    .identityClosure;
  let fences = 0;
  let closureRewrites = 0;

  function countIfClosureRewrite(query: unknown): void {
    // Every rebuild starts by clearing the graph's closure, so one statement
    // naming that table is the fill's unmistakable signature — on the fenced
    // path and on the self-heal path alike.
    const chunks = (query as { chunks?: readonly unknown[] }).chunks ?? [];
    const text = chunks
      .map((piece) => {
        const part = piece as { kind?: string; value?: unknown };
        return part.kind === "text" || part.kind === "identifier" ?
            String(part.value)
          : "";
      })
      .join(" ");
    if (text.includes(closureTable) && text.includes("DELETE")) {
      closureRewrites += 1;
    }
  }

  // A Proxy rather than a spread: transaction targets carry methods on a
  // prototype that spreading would drop. The rebuild runs against a
  // transaction target, so counting only the top-level backend would miss it
  // entirely — and the test would pass whatever the predicate decided.
  function countStatements<T extends object>(target: T): T {
    return new Proxy(target, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property !== "executeStatement") return value;
        return (...args: unknown[]) => {
          countIfClosureRewrite(args[0]);
          return method.apply(source, args);
        };
      },
    });
  }

  return {
    closureRewrites: () => closureRewrites,
    fences: () => fences,
    reset: () => {
      fences = 0;
      closureRewrites = 0;
    },
    backend: countStatements({
      ...result.backend,
      transaction: (fn, options) =>
        result.backend.transaction((tx) => fn(countStatements(tx)), options),
      schemaWriteTransaction: <T>(
        graphId: string,
        fn: Parameters<typeof fence<T>>[1],
      ): Promise<T> => {
        fences += 1;
        return fence(graphId, async (target) => fn(countStatements(target)));
      },
    } satisfies GraphBackend),
  };
}

describe("a live assertion the registry does not declare", () => {
  it("does not make the upgrade re-run on every open", async () => {
    const result = createLocalSqliteBackend();
    try {
      await createStoreWithSchema(foldGraph, result.backend);
      insertUnregisteredKindAssertion(result);
      rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);

      // The fill projects through the registry, so this assertion contributes
      // NO separation row — the relation is complete while empty. A predicate
      // that counted it would demand a rebuild that cannot produce what it
      // asked for, and would demand it again at every open, each time taking
      // the database-scoped identity DDL lock.
      const observed = upgradeActivityBackend(result);
      await createStoreWithSchema(foldGraph, observed.backend);
      expect(separationTableExists(result)).toBe(true);
      expect(separationRowCount(result)).toBe(0);

      observed.reset();
      await createStoreWithSchema(foldGraph, observed.backend);
      expect(observed.fences()).toBe(0);
      expect(observed.closureRewrites()).toBe(0);

      // A third open, to show the answer is stable rather than alternating.
      observed.reset();
      await createStoreWithSchema(foldGraph, observed.backend);
      expect(observed.fences()).toBe(0);
      expect(observed.closureRewrites()).toBe(0);
    } finally {
      await result.backend.close();
    }
  });

  it("still upgrades when a registered kind owes rows", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);
      insertUnregisteredKindAssertion(result);

      // The unregistered row is noise; the registered pair still owes a row, so
      // the fenced CREATE+FILL must run exactly as it does without the noise.
      const observed = upgradeActivityBackend(result);
      await createStoreWithSchema(foldGraph, observed.backend);
      expect(observed.fences()).toBeGreaterThan(0);
      expect(separationRowCount(result)).toBe(1);

      observed.reset();
      await createStoreWithSchema(foldGraph, observed.backend);
      expect(observed.fences()).toBe(0);
    } finally {
      await result.backend.close();
    }
  });
});

/**
 * Injects the contradiction the separation relation exists to reject: a live
 * `different` between two nodes a validated `same` already fused into one
 * class. No application call can produce it — only a raw write, a planner bug,
 * or a hand-run repair — and its projection is a DEGENERATE pair the CHECK
 * refuses, so the relation's correct content for that assertion is no row.
 */
function injectContradictedDifferent(
  result: LocalSqliteBackendResult,
  first: Readonly<{ kind: string; id: string }>,
  second: Readonly<{ kind: string; id: string }>,
): void {
  const now = new Date().toISOString();
  rawClient(result)
    .prepare(
      `INSERT INTO typegraph_identity_assertions
         (graph_id, id, rel, a_kind, a_id, b_kind, b_id,
          valid_from, valid_to, created_at, updated_at, deleted_at)
       VALUES (?, ?, 'different', ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
    )
    .run(
      GRAPH_ID,
      `injected-different-${first.id}-${second.id}`,
      first.kind,
      first.id,
      second.kind,
      second.id,
      now,
      now,
      now,
    );
}

describe("a live different-assertion inside one class", () => {
  it("is not mistaken for an unfilled relation, on the read path or at open", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(foldGraph, result.backend);
      const first = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await store.nodes.Person.create(
        { name: "Ally" },
        { id: "ally" },
      );
      const third = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await store.identity.assertSame(first, second);
      injectContradictedDifferent(result, first, second);
      expect(separationRowCount(result)).toBe(0);

      // Zero rows is the ONLY content this relation can hold for that
      // assertion, so it is not an unfilled relation and must not be reported
      // as one: the fault is a self-contradictory ledger, whose typed error
      // comes from the writer and the CHECK, and whose remedy is not a rebuild.
      expect(await store.identity.areDifferent(first, third)).toBe(false);

      // The contradiction is still caught where it is actually enforced.
      await expect(
        store.identity.assertDifferent(first, third),
      ).rejects.toBeInstanceOf(IdentitySeparationViolationError);

      // And the database still OPENS. A predicate that counted the injected row
      // would demand a rebuild at every open, and that rebuild aborts on the
      // degenerate pair — turning a ledger fault into a store that cannot be
      // constructed at all, with an error naming storage rather than the
      // contradiction.
      const [reopened] = await createStoreWithSchema(foldGraph, result.backend);
      expect(await reopened.identity.areSame(first, second)).toBe(true);
    } finally {
      await result.backend.close();
    }
  });
});

/** A second identity-enabled graph sharing the database's identity relations. */
const otherGraph = defineGraph({
  id: `${GRAPH_ID}_other`,
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

describe("a handle that outlives the relation's absence", () => {
  it("stays loud instead of reading a relation another graph created empty", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [handle] = await createStoreWithSchema(foldGraph, result.backend);
      const first = await handle.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await handle.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await handle.identity.assertDifferent(first, second);

      // The relation goes away under a LIVE handle. Every read of it is loud
      // from here on — that is the safe state, and the handle has no way to
      // provision anything, because provisioning happens at open.
      rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);
      await expect(handle.identity.areDifferent(alice, bob)).rejects.toThrow(
        expect.objectContaining({
          details: matchingObject({ code: "IDENTITY_STORAGE_MISSING" }),
        }),
      );

      // Another graph's open recreates the SHARED relation. Correctly empty for
      // that graph — and empty for this one, whose fill only runs at ITS open.
      // Without the ledger check, this handle would now silently transition
      // from loud failure to a confident "not separated" for a pair its own
      // ledger separates, and `assertSame` would fuse the two classes.
      await createStoreWithSchema(otherGraph, result.backend);
      expect(separationTableExists(result)).toBe(true);
      expect(separationRowCount(result)).toBe(0);

      await expect(handle.identity.areDifferent(alice, bob)).rejects.toThrow(
        expect.objectContaining({
          details: matchingObject({
            code: "IDENTITY_STORAGE_MISSING",
            reason: "unfilled",
          }),
        }),
      );
      await expect(handle.identity.assertSame(first, second)).rejects.toThrow(
        expect.objectContaining({
          details: matchingObject({
            code: "IDENTITY_STORAGE_MISSING",
            reason: "unfilled",
          }),
        }),
      );

      // The documented remedy, and the only thing that can run the fill.
      const [reopened] = await createStoreWithSchema(foldGraph, result.backend);
      expect(separationRowCount(result)).toBe(1);
      expect(await reopened.identity.areDifferent(alice, bob)).toBe(true);
    } finally {
      await result.backend.close();
    }
  });

  it("answers a graph that genuinely has no separations without reading the ledger twice", async () => {
    const result = createLocalSqliteBackend();
    try {
      // The other side of the guard: zero rows is the CORRECT content here, so
      // the ledger probe finds nothing and the answer is an ordinary `false`.
      const [store] = await createStoreWithSchema(foldGraph, result.backend);
      const first = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      expect(await store.identity.areDifferent(first, second)).toBe(false);
      await expect(
        store.identity.assertSame(first, second),
      ).resolves.toBeDefined();
    } finally {
      await result.backend.close();
    }
  });
});

describe("separationRebuildRequired", () => {
  /** The four states the fill decision distinguishes, read directly. */
  it("answers from this graph's own rows and its own live assertions", async () => {
    const result = createLocalSqliteBackend();
    const schema = createSqlSchema(result.backend.tableNames);
    const required = async (relationExists: boolean): Promise<boolean> =>
      separationRebuildRequired(result.backend, schema, GRAPH_ID, {
        relationExists,
        registry: buildKindRegistry(foldGraph),
      });
    try {
      const [store] = await createStoreWithSchema(foldGraph, result.backend);
      const first = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );

      // No assertion: an empty relation is the whole projection.
      expect(await required(true)).toBe(false);

      await store.identity.assertDifferent(first, second);
      // Filled by the write itself — nothing is owed.
      expect(await required(true)).toBe(false);

      rawClient(result).exec(`DELETE FROM ${SEPARATION_TABLE}`);
      // The under-reporting state, and the only one that answers `true`.
      expect(await required(true)).toBe(true);
      // The same answer without reading the relation at all, for the caller
      // deciding whether a not-yet-created relation needs a fill with its
      // CREATE.
      expect(await required(false)).toBe(true);

      // Retraction ends the assertion, so the projection is empty again. The
      // probe shares the current-coordinate filter the rebuild projects from;
      // a bare `rel = 'different'` count would answer `true` here forever and
      // re-derive the closure on every open.
      await store.identity.retractDifferentAssertion(first, second);
      expect(await required(true)).toBe(false);
    } finally {
      await result.backend.close();
    }
  });
});

describe("in-commit provisioning capability", () => {
  it("refuses when the commit transaction cannot run the CREATE", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);
      const activeRow = requireDefined(
        await getActiveSchema(result.backend, GRAPH_ID),
      );

      // A custom backend whose `commitSchemaVersionWithPreflight` hands back a
      // transaction with no DDL primitive. The preflight cannot create the
      // relation it is about to fill, and the alternative — create it outside
      // this transaction — is the readable-empty publish the invariant forbids.
      const commitWithPreflight = requireDefined(
        result.backend.commitSchemaVersionWithPreflight,
      );
      const withoutDdl: GraphBackend = {
        ...result.backend,
        commitSchemaVersionWithPreflight: (params, preflight) =>
          commitWithPreflight(params, (target) => {
            const stripped: Record<string, unknown> = { ...target };
            Reflect.deleteProperty(stripped, "executeSchemaDdl");
            return preflight(stripped as SchemaCommitPreflightBackend);
          }),
      };

      await expect(
        migrateSchema(withoutDdl, foldGraph, activeRow.version),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          details: matchingObject({
            code: "IDENTITY_UPGRADE_REQUIRES_ATOMIC_DDL",
            graphId: GRAPH_ID,
            missingPorts: ["executeSchemaDdl"],
          }),
        }),
      );
      expect(separationTableExists(result)).toBe(false);

      // The same migration on the unmodified backend provisions and fills
      // inside the commit, so the refusal is about the missing capability and
      // not about the migration itself.
      await migrateSchema(result.backend, foldGraph, activeRow.version);
      expect(separationRowCount(result)).toBe(1);
    } finally {
      await result.backend.close();
    }
  });

  it("completes the schema commit when its in-commit CREATE loses the catalog race", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);
      const activeRow = requireDefined(
        await getActiveSchema(result.backend, GRAPH_ID),
      );

      // #445: the commit path issues the SAME idempotent identity DDL as the
      // fenced path, inside the caller's schema-commit transaction — where
      // PostgreSQL will accept nothing but a rollback once the CREATE reports
      // 23505. Two replicas booting at once therefore failed the whole schema
      // commit on a statement that is a no-op by construction. The commit is
      // the smallest retryable unit, so it is what gets re-run.
      const commitWithPreflight = requireDefined(
        result.backend.commitSchemaVersionWithPreflight,
      );
      const remaining = { count: 1 };
      let commits = 0;
      const racing: GraphBackend = {
        ...result.backend,
        commitSchemaVersionWithPreflight: (params, preflight) => {
          commits += 1;
          return commitWithPreflight(params, (target) =>
            preflight(targetLosingDdlRace(target, remaining)),
          );
        },
      };

      await migrateSchema(racing, foldGraph, activeRow.version);

      // Re-run once, and the second attempt provisioned AND filled the
      // relation in one commit — the atomicity the in-commit DDL exists for.
      expect(commits).toBe(2);
      expect(remaining.count).toBe(0);
      expect(separationRowCount(result)).toBe(1);
    } finally {
      await result.backend.close();
    }
  });

  it("stays loud when the in-commit CREATE keeps losing", async () => {
    const result = createLocalSqliteBackend();
    try {
      await seedSeparatedPairWithoutRelation(result);
      const activeRow = requireDefined(
        await getActiveSchema(result.backend, GRAPH_ID),
      );
      const commitWithPreflight = requireDefined(
        result.backend.commitSchemaVersionWithPreflight,
      );
      const remaining = { count: 2 };
      let commits = 0;
      const racing: GraphBackend = {
        ...result.backend,
        commitSchemaVersionWithPreflight: (params, preflight) => {
          commits += 1;
          return commitWithPreflight(params, (target) =>
            preflight(targetLosingDdlRace(target, remaining)),
          );
        },
      };

      // Bounded at one, exactly as on the fenced path: a second failure is no
      // longer a creator about to commit, and the schema commit must not
      // silently do nothing.
      await expect(
        migrateSchema(racing, foldGraph, activeRow.version),
      ).rejects.toThrow(/duplicate key value/);
      expect(commits).toBe(2);
      expect(separationTableExists(result)).toBe(false);
    } finally {
      await result.backend.close();
    }
  });
});
