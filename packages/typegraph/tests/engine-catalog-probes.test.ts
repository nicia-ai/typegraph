/**
 * The backend's `catalog` probe member (`BackendCatalogProbes`):
 * physical-schema introspection exercised against both bundled engines, and
 * against a `transaction()` handle each opens — the recorded-time schema and
 * migration checks that resolve this member from `TransactionBackend` need
 * a transaction-scoped probe to read that transaction's own session, not
 * the outer connection's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireCatalog } from "../src/backend/capabilities/catalog";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type GraphBackend,
  type NormalizedColumnKind,
} from "../src/backend/types";
import { sql } from "../src/query/sql-fragment";
import { asCompiledStatementSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";

/** The default physical name of `recordedClock` on both bundled schemas. */
const RECORDED_CLOCK_TABLE = "typegraph_recorded_clock";

type CatalogFixture = Readonly<{
  backend: GraphBackend;
  /** `recordedClock.recorded_at`'s normalized kind on this dialect. */
  wallTimeKind: NormalizedColumnKind;
  close: () => Promise<void>;
}>;

function createSqliteFixture(): CatalogFixture {
  const { backend } = createLocalSqliteBackend();
  return {
    backend,
    wallTimeKind: "text",
    close: () => backend.close(),
  };
}

async function createPostgresFixture(): Promise<CatalogFixture> {
  const { backend } = await createLocalPgliteBackend({ vector: false });
  return {
    backend,
    wallTimeKind: "timestamp-with-time-zone",
    close: () => backend.close(),
  };
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
        // probe bound to its own session.
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
});
