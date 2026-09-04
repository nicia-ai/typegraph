/**
 * The backend's `catalog` probe member (`BackendCatalogProbes`):
 * physical-schema introspection exercised against both bundled engines, and
 * against a `transaction()` handle each opens — the recorded-time schema and
 * migration checks that resolve this member from `TransactionBackend` need
 * a transaction-scoped probe to read that transaction's own session, not
 * the outer connection's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CatalogIndexBehavior,
  requireCatalog,
} from "../src/backend/capabilities/catalog";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type GraphBackend,
  type NormalizedColumnKind,
} from "../src/backend/types";
import { ConfigurationError } from "../src/errors";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledStatementSql } from "../src/query/sql-intent";
import { assertCurrentRecordedSchema } from "../src/store/recorded-capture";
import { requireDefined } from "../src/utils/presence";

/** The default physical name of `recordedClock` on both bundled schemas. */
const RECORDED_CLOCK_TABLE = "typegraph_recorded_clock";

type CatalogFixture = Readonly<{
  backend: GraphBackend;
  /** `recordedClock.recorded_at`'s normalized kind on this dialect. */
  wallTimeKind: NormalizedColumnKind;
  /**
   * A declared column type this dialect classifies as `"other"` /
   * `"text"` (never `"integer"`) whose own spelling is NOT the normalized
   * kind's name — `VARCHAR(10)` classifies as text-like on both dialects,
   * but SQLite's declared-type text stays `"varchar(10)"` while
   * PostgreSQL's `information_schema` reports the length-free
   * `"character varying"`. Used to prove a diagnostic reports the raw
   * declared type, not the coarser kind, since a column whose kind and
   * declared-type spelling happened to coincide couldn't tell the two
   * apart.
   */
  mismatchedRevisionColumnDdl: string;
  mismatchedRevisionDeclaredType: string;
  /** This dialect's full `indexBehavior` bag — see `CatalogIndexBehavior`. */
  expectedIndexBehavior: CatalogIndexBehavior;
  close: () => Promise<void>;
}>;

function createSqliteFixture(): CatalogFixture {
  const { backend } = createLocalSqliteBackend();
  return {
    backend,
    wallTimeKind: "text",
    mismatchedRevisionColumnDdl: "VARCHAR(10)",
    mismatchedRevisionDeclaredType: "varchar(10)",
    expectedIndexBehavior: {
      concurrentBuilds: false,
      hasInvalidIndexState: false,
      supportsGinFamily: false,
    },
    close: () => backend.close(),
  };
}

async function createPostgresFixture(): Promise<CatalogFixture> {
  const { backend } = await createLocalPgliteBackend({ vector: false });
  return {
    backend,
    wallTimeKind: "timestamp-with-time-zone",
    mismatchedRevisionColumnDdl: "VARCHAR(10)",
    mismatchedRevisionDeclaredType: "character varying",
    expectedIndexBehavior: {
      concurrentBuilds: true,
      hasInvalidIndexState: true,
      supportsGinFamily: true,
    },
    close: () => backend.close(),
  };
}

async function captureConfigurationError(
  promise: Promise<unknown>,
): Promise<ConfigurationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("Expected ConfigurationError");
}

describe.each([
  { label: "sqlite", build: () => Promise.resolve(createSqliteFixture()) },
  { label: "postgres (PGlite)", build: createPostgresFixture },
])("catalog probes ($label)", ({ build }) => {
  let fixture: CatalogFixture;

  beforeAll(async () => {
    fixture = await build();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("reports tableExists true for a real table and false for an absent one", async () => {
    const catalog = requireCatalog(fixture.backend, "test");

    await expect(catalog.tableExists(RECORDED_CLOCK_TABLE)).resolves.toBe(true);
    await expect(
      catalog.tableExists("zz_catalog_probe_table_does_not_exist"),
    ).resolves.toBe(false);
  });

  it("resolves tablesExist for a real table, a missing name, and the empty-input short circuit", async () => {
    const catalog = requireCatalog(fixture.backend, "test");

    await expect(catalog.tablesExist([])).resolves.toEqual([]);

    const states = await catalog.tablesExist([
      RECORDED_CLOCK_TABLE,
      "zz_catalog_probe_table_does_not_exist",
    ]);
    expect(states).toEqual([
      { name: RECORDED_CLOCK_TABLE, exists: true },
      { name: "zz_catalog_probe_table_does_not_exist", exists: false },
    ]);
  });

  it("resolves indexStates for a real index, a missing name, and the empty-input short circuit", async () => {
    const catalog = requireCatalog(fixture.backend, "test");
    const indexName = "zz_catalog_probe_states_idx";
    await requireDefined(fixture.backend.executeDdl)(
      `CREATE INDEX ${indexName} ON ${RECORDED_CLOCK_TABLE} (revision)`,
    );

    await expect(catalog.indexStates([])).resolves.toEqual([]);

    const states = await catalog.indexStates([
      indexName,
      "zz_catalog_probe_index_does_not_exist",
    ]);
    expect(states).toEqual([
      { name: indexName, exists: true, invalid: false },
      {
        name: "zz_catalog_probe_index_does_not_exist",
        exists: false,
        invalid: false,
      },
    ]);
  });

  it("classifies the recorded clock's revision and wall-time columns by normalized kind", async () => {
    const catalog = requireCatalog(fixture.backend, "test");

    const columns = await catalog.columnTypes(RECORDED_CLOCK_TABLE);
    const kindByName = new Map(
      columns.map((column) => [column.name, column.kind] as const),
    );

    expect(kindByName.get("revision")).toBe("integer");
    expect(kindByName.get("recorded_at")).toBe(fixture.wallTimeKind);
  });

  it("also reports each column's raw declared type alongside its normalized kind", async () => {
    const catalog = requireCatalog(fixture.backend, "test");

    const columns = await catalog.columnTypes(RECORDED_CLOCK_TABLE);
    const declaredTypeByName = new Map(
      columns.map((column) => [column.name, column.declaredType] as const),
    );

    // Present, non-empty, and lower-cased — the exact spelling is dialect's
    // own (`"integer"` vs `"bigint"`), asserted precisely by the
    // incompatibility-diagnostic test below.
    expect(declaredTypeByName.get("revision")).toEqual(
      expect.stringMatching(/^[a-z]/),
    );
  });

  it("reports this dialect's whole indexBehavior bag, not just individual fields", () => {
    const catalog = requireCatalog(fixture.backend, "test");

    // The WHOLE bag, not one field at a time: a typo or a swapped value on
    // an untouched field would slip past a narrower per-field assertion.
    expect(catalog.indexBehavior).toEqual(fixture.expectedIndexBehavior);
  });

  it("leaves a VALID index in place — dropInvalidIndex is a no-op for it on every engine", async () => {
    const catalog = requireCatalog(fixture.backend, "test");
    const indexName = "zz_catalog_probe_valid_idx";
    await requireDefined(fixture.backend.executeDdl)(
      `CREATE INDEX ${indexName} ON ${RECORDED_CLOCK_TABLE} (revision)`,
    );

    await catalog.dropInvalidIndex(indexName);

    const [state] = await catalog.indexStates([indexName]);
    expect(requireDefined(state)).toEqual({
      name: indexName,
      exists: true,
      invalid: false,
    });
  });

  it("exposes catalog on a transaction() handle, reading that transaction's own uncommitted state", async () => {
    const indexName = "zz_catalog_probe_tx_idx";
    let sawIndexInsideTransaction = false;

    await expect(
      fixture.backend.transaction(async (tx) => {
        expect(tx.catalog).toBeDefined();
        await requireDefined(tx.executeStatement)(
          asCompiledStatementSql(
            sql.raw(
              `CREATE INDEX ${indexName} ON ${RECORDED_CLOCK_TABLE} (revision)`,
            ),
          ),
        );
        // Read through the TRANSACTION's own catalog, not the outer
        // backend's — this is the fact under test: the index this
        // transaction just created, and has not committed, is visible to a
        // probe bound to its own session. Genuine SESSION binding is only
        // exercised by the PGlite arm: better-sqlite3 has exactly one
        // connection for the whole backend, root and transaction alike, so
        // its arm passes regardless of whether `tx.catalog` is bound to a
        // distinct session — it still proves the wiring reaches
        // `tx.catalog` and returns the right answer, just not the
        // session-isolation fact PGlite's arm actually tests.
        const [state] = await requireDefined(tx.catalog).indexStates([
          indexName,
        ]);
        sawIndexInsideTransaction = requireDefined(state).exists;
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    expect(sawIndexInsideTransaction).toBe(true);

    // Post-rollback, the ROOT backend's catalog must see the index gone —
    // proving the transaction-scoped read above was genuinely bound to the
    // rolled-back session, not a fabricated or leaked answer.
    const catalog = requireCatalog(fixture.backend, "test");
    const [afterRollback] = await catalog.indexStates([indexName]);
    expect(requireDefined(afterRollback).exists).toBe(false);
  });

  it("reports the raw declared type, not the normalized kind, in a recorded-schema incompatibility diagnostic", async () => {
    const scratchTable = "zz_recorded_schema_probe_clock";
    await requireDefined(fixture.backend.executeDdl)(
      `CREATE TABLE ${scratchTable} (revision ${fixture.mismatchedRevisionColumnDdl} NOT NULL)`,
    );
    // Only `recordedClock` is redirected to the scratch table; `recordedNodes`
    // / `recordedEdges` keep resolving to the fixture's real, already
    // schema-compatible tables, so the only incompatibility this produces is
    // the one under test.
    const schema = createSqlSchema({
      ...fixture.backend.tableNames,
      recordedClock: scratchTable,
    });

    const error = await captureConfigurationError(
      assertCurrentRecordedSchema(fixture.backend, schema),
    );

    expect(error.details["code"]).toBe("RECORDED_SCHEMA_INCOMPATIBLE");
    const incompatible = error.details["incompatible"] as readonly Readonly<{
      table: string;
      column: string;
      actual: unknown;
    }>[];
    const revisionEntry = incompatible.find(
      (entry) => entry.table === scratchTable && entry.column === "revision",
    );
    // Pinned: reverting `schema-version.ts` to report `column.kind` here
    // instead of `column.declaredType` makes this fail — the mismatched
    // column's kind ("text" on SQLite, "other" on PostgreSQL) is not this
    // dialect's actual declared type spelling.
    expect(requireDefined(revisionEntry).actual).toBe(
      fixture.mismatchedRevisionDeclaredType,
    );
  });
});

describe("recorded-schema incompatibility diagnostic — SQLite typeless column", () => {
  it("reports 'missing', not the empty string, for a column declared with no type at all", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const scratchTable = "zz_recorded_schema_probe_clock_typeless";
      // SQLite alone accepts a column with no declared type
      // (`CREATE TABLE t (revision, ...)`); its catalog then reports that
      // column with declaredType "" rather than omitting it, so the
      // diagnostic must still classify it as "missing" for a human reading
      // the incompatibility rather than surfacing the empty string.
      await requireDefined(backend.executeDdl)(
        `CREATE TABLE ${scratchTable} (revision, recorded_at TEXT NOT NULL)`,
      );
      const schema = createSqlSchema({
        ...backend.tableNames,
        recordedClock: scratchTable,
      });

      const error = await captureConfigurationError(
        assertCurrentRecordedSchema(backend, schema),
      );

      expect(error.details["code"]).toBe("RECORDED_SCHEMA_INCOMPATIBLE");
      const incompatible = error.details["incompatible"] as readonly Readonly<{
        table: string;
        column: string;
        actual: unknown;
      }>[];
      const revisionEntry = incompatible.find(
        (entry) => entry.table === scratchTable && entry.column === "revision",
      );
      // Pinned: removing `schema-version.ts`'s empty-declared-type
      // conditional makes this report "" instead of "missing" — verified
      // load-bearing by temporarily reverting to
      // `column?.declaredType ?? "missing"`, watching this fail, and
      // restoring the conditional.
      expect(requireDefined(revisionEntry).actual).toBe("missing");
    } finally {
      await backend.close();
    }
  });
});
