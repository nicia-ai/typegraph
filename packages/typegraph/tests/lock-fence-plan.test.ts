/**
 * T15 — the write-fence plan, at each of the 8 lock sites, across 5 postures.
 *
 * Postures (the SQLite factory is exercised on a real better-sqlite3
 * connection; the other four are exercised on a real PGlite PostgreSQL
 * connection, since only a PostgreSQL-dialect connection can actually run
 * `pg_advisory_xact_lock` / `LOCK TABLE` SQL when the plan resolves to
 * `"lock"`):
 *
 *  1. SQLite factory — declared `{advisoryLocks:false, tableLocks:false,
 *     serializedWriters:true}` (A1). Every site resolves `engine-serialized`.
 *  2. PostgreSQL factory — declared `{advisoryLocks:true, tableLocks:true,
 *     serializedWriters:false}` (A2). Every site resolves `lock`.
 *  3. declared-unfenced — a PostgreSQL factory backend whose `capabilities`
 *     OVERRIDE (a real factory option, so it flows into every closure the
 *     factory builds at construction) declares `pessimisticLocks` all-false.
 *     Every site resolves `unfenced` and refuses (except J1, which degrades).
 *  4. declared-advisory-only — `{advisoryLocks:true, tableLocks:false,
 *     serializedWriters:false}`. Advisory-lock sites (J1, J2, J3, J5, J7)
 *     succeed exactly as posture 2; table-lock sites (J4, J6, J8) refuse.
 *  5. undeclared non-factory (PostgreSQL dialect) — a real PostgreSQL
 *     connection wrapped so `capabilities.pessimisticLocks` is ABSENT and the
 *     first-party mark is NOT carried (M-5's defect population). Every site
 *     resolves `unfenced`, identically to posture 3.
 *
 * J1/J2 via `lockRecordedGraphWrite`/`allocateRecordedCommit` (both exported
 * directly, called with no Store at all — the full DDL bundled backends
 * already carry every table these two touch). J3/J4 direct
 * (`lockIdentityGraph`/`lockIdentityEnablementNodes`). J5 via
 * `ensureIdentitySchemaStorage`, reached through the same "separation
 * relation dropped, live different-assertion, reopen" upgrade recipe
 * `tests/identity-separation-upgrade-heal.test.ts` uses to reach the fenced
 * DDL branch. J6 via `openProvenanceStore` on a fresh, unclaimed graph id.
 * J7/J8 via `createContributionMaterializer(...).rebuildContribution(...)`
 * with the same mock-deps technique `tests/contribution-materializer.test.ts`
 * already uses — the one pair of sites whose fence target is captured inside
 * a per-construction closure the `overlayCapabilities` wrapper cannot reach
 * (see that helper's doc in `tests/lock-fence-test-utils.ts`), so the
 * "undeclared non-factory" posture is exercised by constructing the
 * materializer directly with an unmarked, undeclared `fenceTarget` rather
 * than through a first-party factory (which, after A1/A2, can never produce
 * one).
 *
 * *Mutation A*: flip `serializedWriters` to `false` on `SQLITE_CAPABILITIES`
 * → the SQLite rows demand locks SQLite cannot take (J2-J8 refuse) — those
 * rows fail.
 * *Mutation B*: make the unmarked-absent arm derive from dialect → the
 * undeclared-non-factory rows emit advisory locks; that posture's rows fail.
 * *Mutation C*: make `requireWriteFence` ignore `requires` → the
 * declared-advisory-only J4/J6/J8 rows stop refusing and emit `LOCK TABLE`;
 * those rows fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  fts5Strategy,
} from "../src";
import {
  type ContributionMaterializerDeps,
  createContributionMaterializer,
} from "../src/backend/drizzle/contribution-materializations";
import { openProvenanceStore } from "../src/graph-merge";
import { ensureIdentitySchemaStorage } from "../src/identity/schema-transition";
import { rebuildIdentityClosureForContext } from "../src/identity/service";
import {
  lockIdentityEnablementNodes,
  lockIdentityGraph,
} from "../src/identity/service-read";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  renderPostgres,
  renderSqlite,
  type SqlFragment,
} from "../src/query/sql-fragment";
import { buildKindRegistry } from "../src/registry/builders";
import {
  allocateRecordedCommit,
  lockRecordedGraphWrite,
} from "../src/store/recorded-capture/clock";
import {
  ADVISORY_ONLY_CAPABILITIES,
  createLoggedPostgresBackend,
  createLoggedSqliteBackend,
  type LoggedBackend,
  overlayCapabilities,
  UNFENCED_CAPABILITIES,
} from "./lock-fence-test-utils";

const IDENTITY_ADVISORY_LOCK = "typegraph:identity";
const IDENTITY_DDL_ADVISORY_LOCK = "typegraph:identity-ddl";
const RECORDED_GRAPH_WRITE_ADVISORY_LOCK = "typegraph:recorded-graph-write";
const RECORDED_CLOCK_ADVISORY_LOCK = "typegraph:recorded-clock";
const CONTRIBUTION_DDL_ADVISORY_LOCK = "typegraph:contribution-ddl";

/**
 * Some advisory-lock call sites interpolate the namespace key as a bound
 * parameter (`clock.ts`'s `graphAdvisoryLockSql`, `contribution-materializations.ts`'s
 * `lockContributionDdl`); `identity/service-read.ts`'s `lockIdentityGraph`
 * writes the namespace as a literal directly in the SQL text. Checking both
 * the rendered text and the bound params covers either spelling.
 */
function advisoryLockIndices(
  statements: LoggedBackend["statements"],
  key: string,
): readonly number[] {
  return statements
    .map((statement, index) => ({ statement, index }))
    .filter(
      ({ statement }) =>
        statement.query.includes("pg_advisory_xact_lock") &&
        (statement.query.includes(key) || statement.params.includes(key)),
    )
    .map(({ index }) => index);
}

function tableLockIndices(
  statements: LoggedBackend["statements"],
  tableFragment: string,
): readonly number[] {
  return statements
    .map((statement, index) => ({ statement, index }))
    .filter(
      ({ statement }) =>
        statement.query.includes("LOCK TABLE") &&
        statement.query.includes(tableFragment),
    )
    .map(({ index }) => index);
}

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const identityGraph = defineGraph({
  id: "lock-fence-plan-identity",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

let freshGraphCounter = 0;
function freshGraphId(): string {
  freshGraphCounter += 1;
  return `lock-fence-plan-fresh-${String(freshGraphCounter)}`;
}

describe("T15 — J1 lockRecordedGraphWrite", () => {
  it("SQLite factory: no advisory lock, no throw", async () => {
    const logged = createLoggedSqliteBackend();
    try {
      logged.reset();
      await expect(
        lockRecordedGraphWrite(logged.backend, "graph-a"),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(
          logged.statements,
          RECORDED_GRAPH_WRITE_ADVISORY_LOCK,
        ),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("PostgreSQL factory: advisory lock present, no throw", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      logged.reset();
      await expect(
        lockRecordedGraphWrite(logged.backend, "graph-a"),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(
          logged.statements,
          RECORDED_GRAPH_WRITE_ADVISORY_LOCK,
        ),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("declared-unfenced: degrades — no advisory lock, no throw", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      logged.reset();
      await expect(
        lockRecordedGraphWrite(logged.backend, "graph-a"),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(
          logged.statements,
          RECORDED_GRAPH_WRITE_ADVISORY_LOCK,
        ),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("declared-advisory-only: advisory lock present, no throw", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: ADVISORY_ONLY_CAPABILITIES,
    });
    try {
      logged.reset();
      await expect(
        lockRecordedGraphWrite(logged.backend, "graph-a"),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(
          logged.statements,
          RECORDED_GRAPH_WRITE_ADVISORY_LOCK,
        ),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("undeclared non-factory (postgres): degrades — no advisory lock, no throw", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      logged.reset();
      await expect(
        lockRecordedGraphWrite(target, "graph-a"),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(
          logged.statements,
          RECORDED_GRAPH_WRITE_ADVISORY_LOCK,
        ),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });
});

describe("T15 — J2 lockRecordedClock (via allocateRecordedCommit)", () => {
  const schema = createSqlSchema();

  it("SQLite factory: seed-upsert, no advisory lock", async () => {
    const logged = createLoggedSqliteBackend();
    try {
      logged.reset();
      await expect(
        allocateRecordedCommit(logged.backend, schema, "graph-b", false),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(logged.statements, RECORDED_CLOCK_ADVISORY_LOCK),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("PostgreSQL factory: advisory lock present", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      logged.reset();
      await expect(
        allocateRecordedCommit(logged.backend, schema, "graph-b", false),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(logged.statements, RECORDED_CLOCK_ADVISORY_LOCK),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("declared-unfenced: refuses before any clock statement", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      logged.reset();
      await expect(
        allocateRecordedCommit(logged.backend, schema, "graph-b", false),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
      expect(
        advisoryLockIndices(logged.statements, RECORDED_CLOCK_ADVISORY_LOCK),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("declared-advisory-only: advisory lock present", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: ADVISORY_ONLY_CAPABILITIES,
    });
    try {
      logged.reset();
      await expect(
        allocateRecordedCommit(logged.backend, schema, "graph-b", false),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(logged.statements, RECORDED_CLOCK_ADVISORY_LOCK),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("undeclared non-factory (postgres): refuses", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      logged.reset();
      await expect(
        allocateRecordedCommit(target, schema, "graph-b", false),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });
});

describe("T15 — J3 lockIdentityGraph", () => {
  it("SQLite factory: no advisory lock, no throw", async () => {
    const logged = createLoggedSqliteBackend();
    try {
      logged.reset();
      await expect(
        lockIdentityGraph(logged.backend, "graph-c"),
      ).resolves.toBeUndefined();
      expect(
        advisoryLockIndices(logged.statements, IDENTITY_ADVISORY_LOCK),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("PostgreSQL factory: advisory lock present", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      logged.reset();
      await expect(
        lockIdentityGraph(logged.backend, "graph-c"),
      ).resolves.toBeUndefined();
      expect(
        advisoryLockIndices(logged.statements, IDENTITY_ADVISORY_LOCK),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("declared-unfenced: refuses", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      await expect(
        lockIdentityGraph(logged.backend, "graph-c"),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });

  it("declared-advisory-only: advisory lock present", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: ADVISORY_ONLY_CAPABILITIES,
    });
    try {
      logged.reset();
      await expect(
        lockIdentityGraph(logged.backend, "graph-c"),
      ).resolves.toBeUndefined();
      expect(
        advisoryLockIndices(logged.statements, IDENTITY_ADVISORY_LOCK),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("undeclared non-factory (postgres): refuses", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      await expect(lockIdentityGraph(target, "graph-c")).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });
});

describe("T15 — J4 lockIdentityEnablementNodes", () => {
  const schema = createSqlSchema();

  it("SQLite factory: no table lock, no throw", async () => {
    const logged = createLoggedSqliteBackend();
    try {
      logged.reset();
      await expect(
        lockIdentityEnablementNodes(logged.backend, schema),
      ).resolves.toBeUndefined();
      expect(tableLockIndices(logged.statements, "nodes")).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("PostgreSQL factory: table lock present", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      logged.reset();
      // `LOCK TABLE` is only legal inside an explicit transaction block —
      // real callers always reach this site from inside one (identity
      // enablement runs under the backend's schema-write fence).
      await expect(
        logged.backend.transaction((tx) =>
          lockIdentityEnablementNodes(tx, schema),
        ),
      ).resolves.toBeUndefined();
      expect(tableLockIndices(logged.statements, "nodes")).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("declared-unfenced: refuses", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      await expect(
        lockIdentityEnablementNodes(logged.backend, schema),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });

  it("declared-advisory-only: refuses (needs tableLocks), no LOCK TABLE", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: ADVISORY_ONLY_CAPABILITIES,
    });
    try {
      logged.reset();
      await expect(
        lockIdentityEnablementNodes(logged.backend, schema),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
      expect(tableLockIndices(logged.statements, "nodes")).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("undeclared non-factory (postgres): refuses", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      await expect(lockIdentityEnablementNodes(target, schema)).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });
});

/**
 * Seeds an identity-enabled graph with one live `different` assertion, then
 * physically drops the separation relation — the upgrade shape
 * `tests/identity-separation-upgrade-heal.test.ts` uses — so a subsequent
 * `ensureIdentitySchemaStorage(..., enablement: false, ...)` call detects
 * `separationMissing && rebuildRequired` and takes the FENCED branch that
 * calls `lockIdentityDdl` (J5).
 */
async function seedIdentityUpgrade(logged: LoggedBackend): Promise<void> {
  const [seeded] = await createStoreWithSchema(identityGraph, logged.backend);
  const alice = await seeded.nodes.Person.create(
    { name: "Alice" },
    { id: "alice" },
  );
  const bob = await seeded.nodes.Person.create({ name: "Bob" }, { id: "bob" });
  await seeded.identity.assertDifferent(alice, bob);
  await logged.execRaw("DROP TABLE typegraph_identity_separation");
}

/**
 * `ensureIdentitySchemaStorage` only takes the FENCED `provisionDerivedRelations`
 * branch (the one that calls `lockIdentityDdl`) when `recomputeDerivedRelations`
 * is supplied — absent, it takes the schema-commit branch instead
 * (`provisioningForCommit`, which hands DDL back as data for a caller's own
 * commit transaction to run, never calling `lockIdentityDdl` itself). This is
 * the same callback `store.ts:6350` supplies on the non-commit-gated path.
 */
function identityProvisioningOptions(
  schema: ReturnType<typeof createSqlSchema>,
  registry: ReturnType<typeof buildKindRegistry>,
) {
  return {
    graphId: identityGraph.id,
    enablement: false as const,
    registry,
    recomputeDerivedRelations: (
      target: Parameters<typeof rebuildIdentityClosureForContext>[0]["backend"],
    ) =>
      rebuildIdentityClosureForContext({
        backend: target,
        graphId: identityGraph.id,
        registry,
        schema,
        sameIdAcrossKinds: "fold",
      }),
  };
}

describe("T15 — J5 lockIdentityDdl (via ensureIdentitySchemaStorage)", () => {
  const schema = createSqlSchema();
  const registry = buildKindRegistry(identityGraph);

  it("SQLite factory: no advisory lock, no throw", async () => {
    const logged = createLoggedSqliteBackend();
    try {
      await seedIdentityUpgrade(logged);
      logged.reset();
      await expect(
        ensureIdentitySchemaStorage(
          logged.backend,
          schema,
          identityProvisioningOptions(schema, registry),
        ),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(logged.statements, IDENTITY_DDL_ADVISORY_LOCK),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("PostgreSQL factory: advisory lock present", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      await seedIdentityUpgrade(logged);
      logged.reset();
      await expect(
        ensureIdentitySchemaStorage(
          logged.backend,
          schema,
          identityProvisioningOptions(schema, registry),
        ),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(logged.statements, IDENTITY_DDL_ADVISORY_LOCK),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("declared-unfenced: refuses", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      await seedIdentityUpgrade(logged);
      const target = overlayCapabilities(logged.backend, {
        ...logged.backend.capabilities,
        pessimisticLocks: UNFENCED_CAPABILITIES,
      });
      logged.reset();
      await expect(
        ensureIdentitySchemaStorage(
          target,
          schema,
          identityProvisioningOptions(schema, registry),
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
      expect(
        advisoryLockIndices(logged.statements, IDENTITY_DDL_ADVISORY_LOCK),
      ).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("declared-advisory-only: advisory lock present", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      await seedIdentityUpgrade(logged);
      const target = overlayCapabilities(logged.backend, {
        ...logged.backend.capabilities,
        pessimisticLocks: ADVISORY_ONLY_CAPABILITIES,
      });
      logged.reset();
      await expect(
        ensureIdentitySchemaStorage(
          target,
          schema,
          identityProvisioningOptions(schema, registry),
        ),
      ).resolves.toBeDefined();
      expect(
        advisoryLockIndices(logged.statements, IDENTITY_DDL_ADVISORY_LOCK),
      ).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("undeclared non-factory (postgres): refuses", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      await seedIdentityUpgrade(logged);
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      logged.reset();
      await expect(
        ensureIdentitySchemaStorage(
          target,
          schema,
          identityProvisioningOptions(schema, registry),
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });
});

describe("T15 — J6 drainUnfencedRowWriters (via openProvenanceStore)", () => {
  it("SQLite factory: no table lock, no throw", async () => {
    const logged = createLoggedSqliteBackend();
    try {
      logged.reset();
      await expect(
        openProvenanceStore(logged.backend, freshGraphId()),
      ).resolves.toBeDefined();
      expect(tableLockIndices(logged.statements, "nodes")).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("PostgreSQL factory: table lock present", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      logged.reset();
      await expect(
        openProvenanceStore(logged.backend, freshGraphId()),
      ).resolves.toBeDefined();
      expect(tableLockIndices(logged.statements, "nodes")).toHaveLength(1);
    } finally {
      await logged.close();
    }
  });

  it("declared-unfenced: refuses", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: UNFENCED_CAPABILITIES,
    });
    try {
      await expect(
        openProvenanceStore(logged.backend, freshGraphId()),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });

  it("declared-advisory-only: refuses (needs tableLocks), no LOCK TABLE", async () => {
    const logged = await createLoggedPostgresBackend({
      pessimisticLocks: ADVISORY_ONLY_CAPABILITIES,
    });
    try {
      logged.reset();
      await expect(
        openProvenanceStore(logged.backend, freshGraphId()),
      ).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
      expect(tableLockIndices(logged.statements, "nodes")).toHaveLength(0);
    } finally {
      await logged.close();
    }
  });

  it("undeclared non-factory (postgres): refuses", async () => {
    const logged = await createLoggedPostgresBackend();
    try {
      const { pessimisticLocks: _pessimisticLocks, ...undeclared } =
        logged.backend.capabilities;
      const target = overlayCapabilities(logged.backend, undeclared);
      await expect(openProvenanceStore(target, freshGraphId())).rejects.toThrow(
        expect.objectContaining({
          details: expect.objectContaining({
            code: "WRITE_FENCE_UNAVAILABLE",
          }) as unknown,
        }),
      );
    } finally {
      await logged.close();
    }
  });
});

/**
 * A mock `ContributionMaterializerDeps` exercising only J7/J8's fence — the
 * technique `tests/contribution-materializer.test.ts` already uses. Every
 * `execute`/`executeStatement`/`executeSchemaDdl` call is recorded as its
 * REAL rendered SQL (`renderPostgres`/`renderSqlite`), so "emitted SQL" is
 * asserted on genuine parameterized text without a live database.
 * `tableExists` reports `true` and `getMarkers`/the foreign-graph probe
 * report empty, so a successful rebuild always takes the RECREATE path —
 * the one path that takes both J7 and J8.
 */
function mockContributionDeps(
  fenceTarget: ContributionMaterializerDeps["fenceTarget"],
  statements: { query: string; params: readonly unknown[] }[],
): ContributionMaterializerDeps {
  function record(fragment: unknown): void {
    const rendered =
      fenceTarget.dialect === "postgres" ?
        renderPostgres(fragment as SqlFragment)
      : renderSqlite(fragment as SqlFragment);
    statements.push({ query: rendered.sql, params: rendered.params });
  }
  return {
    dialect: fenceTarget.dialect,
    fenceTarget,
    fulltextStrategy: fts5Strategy,
    fulltextTableName: "typegraph_node_fulltext",
    vectorStrategy: undefined,
    execDdl: () => Promise.resolve(),
    ensureMarkerTable: () => Promise.resolve(),
    getMarkers: () => Promise.resolve([]),
    recordMarker: () => Promise.resolve(),
    deleteMarker: () => Promise.resolve(),
    tableExists: () => Promise.resolve(true),
    schemaWriteTransaction: async (_graphId, fn) => {
      const tx = {
        execute: (query: unknown): Promise<readonly unknown[]> => {
          record(query);
          return Promise.resolve([]);
        },
        executeStatement: (query: unknown): Promise<void> => {
          record(query);
          return Promise.resolve();
        },
        executeSchemaDdl: (statement: string): Promise<void> => {
          statements.push({ query: statement, params: [] });
          return Promise.resolve();
        },
        recordContributionMaterialization: (): Promise<void> =>
          Promise.resolve(),
      };
      return fn(tx as never);
    },
  };
}

/** Whether any statement is the contribution-DDL advisory lock. */
function hasContributionAdvisoryLock(
  statements: readonly { query: string; params: readonly unknown[] }[],
): boolean {
  return statements.some(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      (statement.query.includes(CONTRIBUTION_DDL_ADVISORY_LOCK) ||
        statement.params.includes(CONTRIBUTION_DDL_ADVISORY_LOCK)),
  );
}

/** Whether any statement is a `LOCK TABLE`. */
function hasTableLock(
  statements: readonly { query: string; params: readonly unknown[] }[],
): boolean {
  return statements.some((statement) => statement.query.includes("LOCK TABLE"));
}

function rebuild(deps: ContributionMaterializerDeps) {
  const materializer = createContributionMaterializer(deps);
  return materializer.rebuildContribution("graph-fulltext", "fulltext", () =>
    Promise.resolve({ processed: 0, repopulated: 0, skipped: 0 }),
  );
}

describe("T15 — J7/J8 lockContributionDdl / lockSharedFulltextTable", () => {
  it("SQLite factory: no lock statements, no throw", async () => {
    const statements: { query: string; params: readonly unknown[] }[] = [];
    const deps = mockContributionDeps(
      {
        dialect: "sqlite",
        capabilities: {
          transactions: true,
          windowFunctions: true,
          pessimisticLocks: {
            advisoryLocks: false,
            tableLocks: false,
            serializedWriters: true,
          },
        },
      },
      statements,
    );
    await expect(rebuild(deps)).resolves.toBeDefined();
    expect(hasContributionAdvisoryLock(statements)).toBe(false);
    expect(hasTableLock(statements)).toBe(false);
  });

  it("PostgreSQL factory: contribution + table lock both present", async () => {
    const statements: { query: string; params: readonly unknown[] }[] = [];
    const deps = mockContributionDeps(
      {
        dialect: "postgres",
        capabilities: {
          transactions: true,
          windowFunctions: true,
          pessimisticLocks: {
            advisoryLocks: true,
            tableLocks: true,
            serializedWriters: false,
          },
        },
      },
      statements,
    );
    await expect(rebuild(deps)).resolves.toBeDefined();
    expect(hasContributionAdvisoryLock(statements)).toBe(true);
    expect(hasTableLock(statements)).toBe(true);
  });

  it("declared-unfenced: refuses before any lock statement", async () => {
    const statements: { query: string; params: readonly unknown[] }[] = [];
    const deps = mockContributionDeps(
      {
        dialect: "postgres",
        capabilities: {
          transactions: true,
          windowFunctions: true,
          pessimisticLocks: {
            advisoryLocks: false,
            tableLocks: false,
            serializedWriters: false,
          },
        },
      },
      statements,
    );
    await expect(rebuild(deps)).rejects.toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          code: "WRITE_FENCE_UNAVAILABLE",
        }) as unknown,
      }),
    );
    expect(statements).toHaveLength(0);
  });

  it("declared-advisory-only: contribution lock present, no LOCK TABLE, refuses", async () => {
    const statements: { query: string; params: readonly unknown[] }[] = [];
    const deps = mockContributionDeps(
      {
        dialect: "postgres",
        capabilities: {
          transactions: true,
          windowFunctions: true,
          pessimisticLocks: {
            advisoryLocks: true,
            tableLocks: false,
            serializedWriters: false,
          },
        },
      },
      statements,
    );
    await expect(rebuild(deps)).rejects.toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          code: "WRITE_FENCE_UNAVAILABLE",
        }) as unknown,
      }),
    );
    expect(hasContributionAdvisoryLock(statements)).toBe(true);
    expect(hasTableLock(statements)).toBe(false);
  });

  it("undeclared non-factory (postgres): refuses, no lock statement", async () => {
    const statements: { query: string; params: readonly unknown[] }[] = [];
    const deps = mockContributionDeps(
      {
        dialect: "postgres",
        capabilities: { transactions: true, windowFunctions: true },
      },
      statements,
    );
    await expect(rebuild(deps)).rejects.toThrow(
      expect.objectContaining({
        details: expect.objectContaining({
          code: "WRITE_FENCE_UNAVAILABLE",
        }) as unknown,
      }),
    );
    expect(statements).toHaveLength(0);
  });
});
