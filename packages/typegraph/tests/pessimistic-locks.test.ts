import { describe, expect, it } from "vitest";

import {
  type BackendCapabilities,
  type GraphBackend,
  POSTGRES_CAPABILITIES,
  SQLITE_CAPABILITIES,
  usesPessimisticLocks,
} from "../src/backend/types";
import { lockIdentityGraph } from "../src/identity/service";
import { lockRecordedGraphWrite } from "../src/store/recorded-capture";
import { assertCapturableBackend } from "../src/store/recorded-capture/guards";

const GRAPH_ID = "locks-graph";

/**
 * Records the SQL every lock site issues, so a test can assert on emission
 * rather than on a boolean the production code never consults.
 */
function createRecordingTarget(
  capabilities: BackendCapabilities,
): Readonly<{ target: GraphBackend; statements: string[] }> {
  const statements: string[] = [];
  const target = {
    dialect: "postgres",
    capabilities,
    execute: (query: unknown) => {
      statements.push(JSON.stringify(query));
      return Promise.resolve([]);
    },
  } as unknown as GraphBackend;
  return { target, statements };
}

describe("pessimisticLocks capability", () => {
  it("is declared false for SQLite and left supported for PostgreSQL", () => {
    expect(SQLITE_CAPABILITIES.pessimisticLocks).toBe(false);
    expect(usesPessimisticLocks({ capabilities: SQLITE_CAPABILITIES })).toBe(
      false,
    );
    expect(usesPessimisticLocks({ capabilities: POSTGRES_CAPABILITIES })).toBe(
      true,
    );
  });

  it("treats an absent flag as supported", () => {
    expect(
      usesPessimisticLocks({
        capabilities: { transactions: true, windowFunctions: true },
      }),
    ).toBe(true);
  });

  describe("recorded graph-write lock", () => {
    it("issues an advisory lock when the engine supports one", async () => {
      const { target, statements } = createRecordingTarget({
        ...POSTGRES_CAPABILITIES,
      });

      await lockRecordedGraphWrite(target, GRAPH_ID);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("pg_advisory_xact_lock");
    });

    it("skips the advisory lock when the engine declares it unsupported", async () => {
      const { target, statements } = createRecordingTarget({
        ...POSTGRES_CAPABILITIES,
        pessimisticLocks: false,
      });

      await lockRecordedGraphWrite(target, GRAPH_ID);

      expect(statements).toEqual([]);
    });
  });

  describe("identity graph lock", () => {
    it("issues an advisory lock when the engine supports one", async () => {
      const { target, statements } = createRecordingTarget({
        ...POSTGRES_CAPABILITIES,
      });

      await lockIdentityGraph(target, GRAPH_ID);

      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain("pg_advisory_xact_lock");
    });

    it("skips the advisory lock when the engine declares it unsupported", async () => {
      const { target, statements } = createRecordingTarget({
        ...POSTGRES_CAPABILITIES,
        pessimisticLocks: false,
      });

      await lockIdentityGraph(target, GRAPH_ID);

      expect(statements).toEqual([]);
    });
  });

  describe("history capture", () => {
    function capturableBackend(
      capabilities: BackendCapabilities,
    ): GraphBackend {
      return {
        dialect: "postgres",
        capabilities,
        tableNames: {},
        execute: () => Promise.resolve([]),
        executeStatement: () => Promise.resolve(undefined),
        transaction: () => Promise.resolve(undefined),
      } as unknown as GraphBackend;
    }

    it("accepts a PostgreSQL backend that can take advisory locks", () => {
      expect(() => {
        assertCapturableBackend(capturableBackend(POSTGRES_CAPABILITIES));
      }).not.toThrow();
    });

    // Recorded-clock allocation cannot be made safe without a lock, so this
    // state is refused rather than silently degraded.
    it("refuses a PostgreSQL backend that cannot take advisory locks", () => {
      expect(() => {
        assertCapturableBackend(
          capturableBackend({
            ...POSTGRES_CAPABILITIES,
            pessimisticLocks: false,
          }),
        );
      }).toThrow(/advisory locks/i);
    });

    it("still accepts SQLite, whose write transactions are already exclusive", () => {
      const backend = {
        dialect: "sqlite",
        capabilities: SQLITE_CAPABILITIES,
        tableNames: {},
        execute: () => Promise.resolve([]),
        executeStatement: () => Promise.resolve(undefined),
        transaction: () => Promise.resolve(undefined),
      } as unknown as GraphBackend;

      expect(() => {
        assertCapturableBackend(backend);
      }).not.toThrow();
    });
  });
});
