import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

import type {
  AtomicSqlBatchExecutor,
  AtomicSqlRow,
  CompiledAtomicSqlStatement,
} from "../src/backend/capabilities/atomic-sql-program";
import {
  hasAtomicSqlProgramRegistration,
  registerAtomicSqlProgram,
} from "../src/backend/capabilities/atomic-sql-program";
import {
  type AtomicTransportConformanceFixture,
  type AtomicTransportEquality,
  runAtomicTransportConformance,
} from "../src/backend/conformance/atomic-transport";
import { deriveBackend } from "../src/backend/derive-backend";
import { createSqliteExecutionAdapter } from "../src/backend/drizzle/execution";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import {
  type GraphBackend,
  supportsRootAtomicBatch,
  type TransactionBackend,
} from "../src/backend/types";

type FakeState = Readonly<{
  primary: readonly string[];
  sidecar: readonly string[];
}>;

interface MutableFakeState {
  primary: string[];
  sidecar: string[];
}

const equal: AtomicTransportEquality = (actual, expected) =>
  JSON.stringify(actual) === JSON.stringify(expected);

const ORDERED_STATEMENTS: readonly CompiledAtomicSqlStatement[] = [
  { sql: "ORDERED first", params: ["first"] },
  { sql: "ORDERED second", params: ["second"] },
];

const PARAMETER_STATEMENTS: readonly CompiledAtomicSqlStatement[] = [
  { sql: "PARAMETERS", params: ["alpha", 7, undefined, new Date(0)] },
];

const ROLLBACK_STATEMENTS: readonly CompiledAtomicSqlStatement[] = [
  { sql: "INSERT primary", params: ["row-1"] },
  { sql: "FAIL after sidecar", params: ["sidecar-1"] },
];

function snapshotState(state: MutableFakeState): MutableFakeState {
  return structuredClone(state);
}

function createFixture(
  atomic: boolean,
): AtomicTransportConformanceFixture<FakeState> {
  let state: MutableFakeState = { primary: [], sidecar: [] };
  let receivedStatements: readonly CompiledAtomicSqlStatement[] | undefined;
  const executeAtomicBatch: AtomicSqlBatchExecutor = async <TRow>(
    statements: readonly CompiledAtomicSqlStatement[],
  ) => {
    await Promise.resolve();
    receivedStatements = structuredClone(statements);
    if (statements.length === 0) return [];
    if (statements[0]?.sql.startsWith("ORDERED")) {
      return statements.map((statement: CompiledAtomicSqlStatement) => [
        { slot: statement.params[0] },
      ]) as unknown as readonly (readonly TRow[])[];
    }
    if (statements[0]?.sql === "PARAMETERS") {
      return [
        [{ params: [...statements[0].params] }],
      ] as unknown as readonly (readonly TRow[])[];
    }

    const before = snapshotState(state);
    state.primary = [...state.primary, String(statements[0]?.params[0])];
    state.sidecar = [...state.sidecar, String(statements[1]?.params[0])];
    if (statements[1]?.sql === "FAIL after sidecar") {
      if (atomic) state = structuredClone(before);
      throw new Error("intentional later-statement failure");
    }
    return statements.map(() => [] as readonly TRow[]);
  };
  const root = {
    capabilities: { execution: { atomicBatch: "root" } },
  } as GraphBackend;
  registerAtomicSqlProgram(root, executeAtomicBatch);
  const derived = deriveBackend(root, {});
  const transaction = {} as TransactionBackend;

  return {
    executeAtomicBatch,
    equal,
    orderedResults: {
      statements: ORDERED_STATEMENTS,
      expected: [[{ slot: "first" }], [{ slot: "second" }]],
    },
    parameterPreservation: {
      statements: PARAMETER_STATEMENTS,
      expected: structuredClone(PARAMETER_STATEMENTS),
      observe: () => receivedStatements,
    },
    rollback: {
      prepare: () => {
        state = { primary: [], sidecar: [] };
      },
      statements: ROLLBACK_STATEMENTS,
      observe: () => snapshotState(state),
      expectedBefore: { primary: [], sidecar: [] },
      errorMatches: (error) =>
        error instanceof Error &&
        error.message === "intentional later-statement failure",
    },
    emptyBatch: {
      prepare: () => {
        state = { primary: [], sidecar: [] };
      },
      observe: () => snapshotState(state),
      expected: { primary: [], sidecar: [] },
    },
    provenance: {
      exactRootRegistration: () =>
        supportsRootAtomicBatch(root) && hasAtomicSqlProgramRegistration(root),
      derivedBackendIsolation: () =>
        !supportsRootAtomicBatch(derived) &&
        !hasAtomicSqlProgramRegistration(derived),
      transactionBackendIsolation: () =>
        !hasAtomicSqlProgramRegistration(transaction),
    },
  };
}

describe("atomic transport conformance runner", () => {
  it("accepts an atomic transport with ordered slots and no rollback leak", async () => {
    const report = await runAtomicTransportConformance(createFixture(true));

    expect(report.passed).toEqual([
      "ordered result slots",
      "parameter preservation",
      "later-statement rollback",
      "empty batch",
      "provenance: exact root registration",
      "provenance: derived backend isolation",
      "provenance: transaction backend isolation",
    ]);
  });

  it("catches a transport that leaks primary and sidecar writes", async () => {
    await expect(
      runAtomicTransportConformance(createFixture(false)),
    ).rejects.toMatchObject({
      name: "AtomicTransportConformanceError",
      details: { check: "later-statement rollback" },
    });
  });

  it("catches a transport that mutates bound parameters", async () => {
    const fixture = createFixture(true);
    const invalidFixture = {
      ...fixture,
      executeAtomicBatch: async <TRow>(
        statements: readonly CompiledAtomicSqlStatement[],
      ) => {
        const alteredStatements = statements.map((statement) =>
          statement.sql === "PARAMETERS" ?
            { ...statement, params: ["mutated"] }
          : statement,
        );
        return fixture.executeAtomicBatch<TRow>(alteredStatements);
      },
    } satisfies AtomicTransportConformanceFixture<FakeState>;

    await expect(
      runAtomicTransportConformance(invalidFixture),
    ).rejects.toMatchObject({
      name: "AtomicTransportConformanceError",
      details: { check: "parameter preservation" },
    });
  });

  it("rejects a provenance check that does not prove its boundary", async () => {
    const fixture = createFixture(true);
    const invalidFixture = {
      ...fixture,
      provenance: {
        ...fixture.provenance,
        derivedBackendIsolation: () => false,
      },
    } satisfies AtomicTransportConformanceFixture<FakeState>;

    await expect(
      runAtomicTransportConformance(invalidFixture),
    ).rejects.toMatchObject({
      name: "AtomicTransportConformanceError",
      details: { check: "provenance: derived backend isolation" },
    });
  });

  it("requires the transport to return an empty slot list for an empty batch", async () => {
    const fixture = createFixture(true);
    const invalidFixture = {
      ...fixture,
      executeAtomicBatch: async <TRow>(
        statements: readonly CompiledAtomicSqlStatement[],
      ) =>
        statements.length === 0 ?
          [[{ unexpected: true }] as unknown as readonly TRow[]]
        : fixture.executeAtomicBatch<TRow>(statements),
    } satisfies AtomicTransportConformanceFixture<FakeState>;

    await expect(
      runAtomicTransportConformance(invalidFixture),
    ).rejects.toMatchObject({
      name: "AtomicTransportConformanceError",
      details: { check: "empty-batch result" },
    });
  });

  it("retains the row type at the fixture boundary", () => {
    const row: AtomicSqlRow = { marker: "fixture" };
    expect(row["marker"]).toBe("fixture");
  });
});

type LibsqlSnapshot = Readonly<{
  primary: readonly string[];
  sidecar: readonly string[];
}>;

function idsFromLibsqlRows(rows: readonly unknown[]): readonly string[] {
  return rows.map((row) => {
    if (typeof row !== "object" || row === null) {
      throw new TypeError("libSQL returned a non-object row");
    }
    const id = (row as Readonly<Record<string, unknown>>)["id"];
    if (typeof id !== "string") {
      throw new TypeError("libSQL returned a non-string conformance id");
    }
    return id;
  });
}

async function readLibsqlSnapshot(
  client: ReturnType<typeof createClient>,
): Promise<LibsqlSnapshot> {
  const [primary, sidecar] = await Promise.all([
    client.execute("SELECT id FROM atomic_transport_primary ORDER BY id"),
    client.execute("SELECT id FROM atomic_transport_sidecar ORDER BY id"),
  ]);
  return {
    primary: idsFromLibsqlRows(primary.rows),
    sidecar: idsFromLibsqlRows(sidecar.rows),
  };
}

describe("atomic transport conformance: libSQL file client", () => {
  it("proves the production batch adapter contract end to end", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-transport-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "conformance.db")}`,
    });

    try {
      const { backend, db } = await createLibsqlBackend(client);
      await client.execute(
        "CREATE TABLE atomic_transport_primary (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      await client.execute(
        "CREATE TABLE atomic_transport_sidecar (id TEXT PRIMARY KEY, primary_id TEXT NOT NULL)",
      );

      const adapter = createSqliteExecutionAdapter(db);
      const executeAtomicBatch = adapter.executeAtomicBatch;
      if (executeAtomicBatch === undefined) {
        throw new Error(
          "libSQL file client did not expose atomic batch execution",
        );
      }
      let observedStatements: readonly CompiledAtomicSqlStatement[] | undefined;
      const observedExecutor: AtomicSqlBatchExecutor = <TRow>(
        statements: readonly CompiledAtomicSqlStatement[],
      ) => {
        observedStatements = statements.map((statement) => ({
          ...statement,
          params: [...statement.params],
        }));
        return executeAtomicBatch<TRow>(statements);
      };

      let transactionBackend: TransactionBackend | undefined;
      await backend.transaction((transaction) => {
        transactionBackend = transaction;
        return Promise.resolve();
      });
      const certifiedTransactionBackend = transactionBackend;
      if (certifiedTransactionBackend === undefined) {
        throw new Error(
          "libSQL backend did not expose its transaction backend",
        );
      }
      const derivedBackend = deriveBackend(backend, {});

      const report = await runAtomicTransportConformance<LibsqlSnapshot>({
        executeAtomicBatch: observedExecutor,
        equal,
        orderedResults: {
          statements: [
            { sql: "SELECT ? AS slot", params: ["first"] },
            { sql: "SELECT ? AS slot", params: ["second"] },
          ],
          expected: [[{ slot: "first" }], [{ slot: "second" }]],
        },
        parameterPreservation: {
          statements: [
            {
              sql: "SELECT ? AS first, ? AS second, ? AS third",
              params: ["alpha", 7, "gamma"],
            },
          ],
          expected: [
            {
              sql: "SELECT ? AS first, ? AS second, ? AS third",
              params: ["alpha", 7, "gamma"],
            },
          ],
          observe: () => observedStatements,
        },
        rollback: {
          prepare: async () => {
            await client.execute("DELETE FROM atomic_transport_sidecar");
            await client.execute("DELETE FROM atomic_transport_primary");
          },
          statements: [
            {
              sql: "INSERT INTO atomic_transport_primary (id, value) VALUES (?, ?)",
              params: ["primary-1", "value"],
            },
            {
              sql: "INSERT INTO atomic_transport_sidecar (id, primary_id) VALUES (?, ?)",
              params: ["sidecar-1", "primary-1"],
            },
            {
              sql: "INSERT INTO atomic_transport_sidecar (id, primary_id) VALUES (?, ?)",
              params: ["sidecar-1", "primary-1"],
            },
          ],
          observe: () => readLibsqlSnapshot(client),
          expectedBefore: { primary: [], sidecar: [] },
        },
        emptyBatch: {
          prepare: async () => {
            await client.execute("DELETE FROM atomic_transport_sidecar");
            await client.execute("DELETE FROM atomic_transport_primary");
          },
          observe: () => readLibsqlSnapshot(client),
          expected: { primary: [], sidecar: [] },
        },
        provenance: {
          exactRootRegistration: () =>
            supportsRootAtomicBatch(backend) &&
            hasAtomicSqlProgramRegistration(backend),
          derivedBackendIsolation: () =>
            !supportsRootAtomicBatch(derivedBackend) &&
            !hasAtomicSqlProgramRegistration(derivedBackend),
          transactionBackendIsolation: () =>
            !hasAtomicSqlProgramRegistration(certifiedTransactionBackend),
        },
      });

      expect(report.passed).toEqual([
        "ordered result slots",
        "parameter preservation",
        "later-statement rollback",
        "empty batch",
        "provenance: exact root registration",
        "provenance: derived backend isolation",
        "provenance: transaction backend isolation",
      ]);
      expect(observedStatements).toEqual([]);

      await backend.close();
      client.close();
    } finally {
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
