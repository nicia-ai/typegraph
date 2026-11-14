import { describe, expect, it } from "vitest";

import { createStore, recordedRelation } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type {
  GraphBackend,
  TransactionBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledStatementSql,
  type CompiledRowsSql,
} from "../../../src/query/sql-intent";
import { advanceRevisionClock } from "../../../src/store/recorded-capture";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type Read = Readonly<{ sql: string; session: boolean }>;
type SessionOptions = Readonly<{
  isolationLevel?: TransactionOptions["isolationLevel"];
  beforeSession?: () => Promise<void>;
  afterRead?: (query: string) => Promise<void>;
}>;

/** Records the row statements at the execution target, including transaction reads. */
function observeReads(
  base: GraphBackend,
  reads: Read[],
  options?: SessionOptions,
): GraphBackend {
  function members(
    target: TransactionBackend,
    session: boolean,
  ): Pick<TransactionBackend, "execute" | "executeRaw"> {
    return {
      async execute<T>(query: CompiledRowsSql): Promise<readonly T[]> {
        const text = requireDefined(base.compileSql)(query).sql;
        reads.push({ sql: text, session });
        const rows = await target.execute<T>(query);
        if (session) await options?.afterRead?.(text);
        return rows;
      },
      ...(target.executeRaw === undefined ?
        {}
      : {
          executeRaw: async <T>(
            text: string,
            params: readonly unknown[],
          ): Promise<readonly T[]> => {
            reads.push({ sql: text, session });
            const rows = await requireDefined(target.executeRaw)<T>(
              text,
              params,
            );
            if (session) await options?.afterRead?.(text);
            return rows;
          },
        }),
    };
  }
  return deriveBackend(base, {
    ...members(base, false),
    transaction: (fn, requested) =>
      base.transaction(
        async (target) => {
          await options?.beforeSession?.();
          return fn(deriveBackend(target, members(target, true)));
        },
        options?.isolationLevel === undefined ?
          requested
        : { ...requested, isolationLevel: options.isolationLevel },
      ),
  });
}

function ownerReads(reads: readonly Read[]): readonly Read[] {
  return reads.filter((read) => read.sql.includes("revision_origins"));
}

export function registerRecordedOwnershipStatementIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("recorded ownership statement work", () => {
    it("bounds point, query, adjacency and iterative ownership reads", async () => {
      const writer = await context.createHistoryStore(integrationTestGraph);
      const alice = await writer.nodes.Person.create({ name: "Alice" });
      const bob = await writer.nodes.Person.create({ name: "Bob" });
      await writer.edges.knows.create(alice, bob, { since: "2020" });
      const anchor = requireDefined(await writer.recordedNow());
      const reads: Read[] = [];
      const base = context.getBackend();
      const store = createStore(
        integrationTestGraph,
        observeReads(base, reads),
        { history: true },
      );
      const view = store.asOfRecorded(anchor);
      await view.nodes.Person.getById(alice.id);
      expect(reads).toHaveLength(3);
      expect(ownerReads(reads)).toHaveLength(2);
      reads.length = 0;
      await view
        .query()
        .from("Person", "person")
        .select((fields) => fields.person.name)
        .execute();
      expect(reads).toHaveLength(3);
      expect(ownerReads(reads)).toHaveLength(2);
      reads.length = 0;
      await view.adjacency(alice, {
        direction: "out",
        edgeKinds: ["knows"],
        candidateLimit: 1,
      });
      expect(reads).toHaveLength(4);
      expect(ownerReads(reads)).toHaveLength(2);
      reads.length = 0;
      expect(
        await view.algorithms.weaklyConnectedComponents({ edges: ["knows"] }),
      ).toMatchObject([{ size: 2 }, { size: 2 }]);
      const sessionOwners = ownerReads(reads).filter((read) => read.session);
      // A session fact earns the optimization. SQLite and adapters without
      // that fact retain their portable guards rather than guessing isolation.
      const sessionDataReads = reads.filter(
        (read) => read.session && !read.sql.includes("revision_origins"),
      );
      const expectedSessionChecks =
        base.fenceSql?.isolationFactExpression === undefined ?
          1 + 2 * sessionDataReads.length
        : 1;
      expect(sessionOwners).toHaveLength(expectedSessionChecks);
      expect(ownerReads(reads)).toHaveLength(expectedSessionChecks + 2);
      reads.length = 0;
      await view.algorithms.weaklyConnectedComponents({ edges: ["knows"] });
      expect(ownerReads(reads).filter((read) => read.session)).toHaveLength(
        sessionOwners.length,
      );
    });

    it("reads the allocation clock and existing owner together for captured writes", async () => {
      const writer = await context.createHistoryStore(integrationTestGraph);
      const node = await writer.nodes.Person.create({ name: "first" });
      const reads: Read[] = [];
      const store = createStore(
        integrationTestGraph,
        observeReads(context.getBackend(), reads),
        { history: true },
      );
      await store.nodes.Person.update(node.id, { name: "second" });
      const allocationReads = reads.filter(
        (read) =>
          read.sql.includes("recorded_clock") &&
          read.sql.includes("revision_origins"),
      );
      expect(allocationReads).toHaveLength(1);
      expect(
        reads.some((read) => /SELECT\s+origin\s+FROM/u.test(read.sql)),
      ).toBe(false);
    });

    it("distinguishes an absent clock from a malformed persisted clock", async () => {
      const writer = await context.createHistoryStore(integrationTestGraph);
      await writer.allocationOwner();
      const base = context.getBackend();
      const schema = createSqlSchema({
        ...base.tableNames,
        recordedClock: "ownership_nullable_clock",
      });
      const statement = requireDefined(base.executeStatement);
      await statement(
        asCompiledStatementSql(
          sql`CREATE TABLE ${schema.recordedClockTable} (graph_id TEXT PRIMARY KEY, revision BIGINT, recorded_at TEXT)`,
        ),
      );
      try {
        await statement(
          asCompiledStatementSql(
            sql`INSERT INTO ${schema.recordedClockTable} (graph_id, revision, recorded_at) VALUES (${writer.graphId}, NULL, ${"2026-01-01T00:00:00.000Z"})`,
          ),
        );
        await expect(
          base.transaction((target) =>
            advanceRevisionClock(target, schema, writer.graphId, false),
          ),
        ).rejects.toThrow(
          "Recorded clock row contained an invalid revision or wall time",
        );
      } finally {
        await statement(
          asCompiledStatementSql(sql`DROP TABLE ${schema.recordedClockTable}`),
        );
      }
    });

    it("uses actual session isolation when a backend rewrites the requested snapshot", async () => {
      const base = context.getBackend();
      if (base.fenceSql?.isolationFactExpression === undefined) return;
      const writer = await context.createHistoryStore(integrationTestGraph);
      await writer.nodes.Person.create({ name: "Alice" });
      const reads: Read[] = [];
      const store = createStore(
        integrationTestGraph,
        observeReads(base, reads, { isolationLevel: "read_committed" }),
        { history: true },
      );
      const view = store.asOfRecorded(
        requireDefined(await writer.recordedNow()),
      );
      await view.algorithms.weaklyConnectedComponents({ edges: ["knows"] });
      expect(
        ownerReads(reads).filter((read) => read.session).length,
      ).toBeGreaterThan(1);
    });

    it("keeps external provider checks inside each algorithm session", async () => {
      const writer = await context.createHistoryStore(integrationTestGraph);
      await writer.nodes.Person.create({ name: "Alice" });
      const anchor = requireDefined(await writer.recordedNow());
      const owner = await writer.allocationOwner();
      let checks = 0;
      const store = createStore(integrationTestGraph, context.getBackend(), {
        recordedRead: recordedRelation({
          schema: writer.revisionSchema,
          owner: () => {
            checks += 1;
            return Promise.resolve(
              checks < 3 ? owner : { ...owner, origin: "retired" },
            );
          },
        }),
      });
      await expect(
        store
          .asOfRecorded(anchor)
          .algorithms.weaklyConnectedComponents({ edges: ["knows"] }),
      ).rejects.toMatchObject({ code: "GRAPH_ALLOCATION_OWNER_MISMATCH" });
      expect(checks).toBe(3);
    });

    it("refuses a retired owner on the actual session before reading graph data", async () => {
      if (!context.serverLaneConcurrency) return;
      const writer = await context.createHistoryStore(integrationTestGraph);
      await writer.nodes.Person.create({ name: "Alice" });
      const anchor = requireDefined(await writer.recordedNow());
      const owner = await writer.allocationOwner();
      const reads: Read[] = [];
      const store = createStore(
        integrationTestGraph,
        observeReads(context.getBackend(), reads, {
          beforeSession: async () => {
            await writer.rotateAllocationOwner(owner);
          },
        }),
        { history: true },
      );
      await expect(
        store
          .asOfRecorded(anchor)
          .algorithms.weaklyConnectedComponents({ edges: ["knows"] }),
      ).rejects.toMatchObject({ code: "GRAPH_ALLOCATION_OWNER_MISMATCH" });
      expect(reads.filter((read) => read.session)).toHaveLength(1);
      expect(ownerReads(reads).filter((read) => read.session)).toHaveLength(1);
    });

    it("refuses an origin rotated after the algorithm snapshot was pinned", async () => {
      if (!context.serverLaneConcurrency) return;
      const writer = await context.createHistoryStore(integrationTestGraph);
      await writer.nodes.Person.create({ name: "Alice" });
      const anchor = requireDefined(await writer.recordedNow());
      const owner = await writer.allocationOwner();
      let rotated = false;
      const store = createStore(
        integrationTestGraph,
        observeReads(context.getBackend(), [], {
          afterRead: async (query) => {
            if (rotated || !query.includes("transaction_isolation")) return;
            rotated = true;
            await writer.rotateAllocationOwner(owner);
          },
        }),
        { history: true },
      );
      await expect(
        store
          .asOfRecorded(anchor)
          .algorithms.weaklyConnectedComponents({ edges: ["knows"] }),
      ).rejects.toMatchObject({ code: "GRAPH_ALLOCATION_OWNER_MISMATCH" });
      expect(rotated).toBe(true);
    });

    it("retains a pinned topology while a concurrent captured write changes live edges", async () => {
      if (!context.serverLaneConcurrency) return;
      const writer = await context.createHistoryStore(integrationTestGraph);
      const alice = await writer.nodes.Person.create({ name: "Alice" });
      const bob = await writer.nodes.Person.create({ name: "Bob" });
      const edge = await writer.edges.knows.create(alice, bob, {
        since: "2020",
      });
      const anchor = requireDefined(await writer.recordedNow());
      let changed = false;
      const store = createStore(
        integrationTestGraph,
        observeReads(context.getBackend(), [], {
          afterRead: async (query) => {
            if (changed || !query.includes("transaction_isolation")) return;
            changed = true;
            await writer.edges.knows.delete(edge.id);
          },
        }),
        { history: true },
      );
      expect(
        await store
          .asOfRecorded(anchor)
          .algorithms.weaklyConnectedComponents({ edges: ["knows"] }),
      ).toMatchObject([{ size: 2 }, { size: 2 }]);
      expect(changed).toBe(true);
      expect(
        await writer
          .asOfRecorded(requireDefined(await writer.recordedNow()))
          .algorithms.weaklyConnectedComponents({ edges: ["knows"] }),
      ).toMatchObject([{ size: 1 }, { size: 1 }]);
    });
  });
}
