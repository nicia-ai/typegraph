/**
 * The managed write state (the write session of a `store.transaction`
 * attempt and the schema fences its session leased) lives on the transaction
 * session, and every reader resolves it from the operation it holds.
 *
 * Two operations of one session therefore share it, and an operation of
 * another session over the very same transaction object does not: the state
 * is the session's, not the object's.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  applyMergePlanInTransaction,
  branch,
  planMerge,
} from "../src/graph-merge";
import { unwrap } from "../src/graph-merge/result";
import { asBranchId } from "../src/graph-merge/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import * as nodeClaims from "../src/store/claims/node-claims";
import {
  enterOperation,
  openTransactionSession,
  type Operation,
  operationEntrySession,
  type TransactionSession,
} from "../src/store/operation-scope";
import * as managedWrite from "../src/store/operations/managed-write-state";
import * as writeTransaction from "../src/store/operations/write-transaction";
import {
  forceWriteTransactionRevision,
  hasLeasedSchemaFence,
  hasPendingWriteTransactionRevision,
  lockSchemaVersionForStoreWrite,
  withWriteTransactionSession,
} from "../src/store/operations/write-transaction";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Widget = defineNode("Widget", {
  schema: z.object({ label: z.string() }),
});
const Owner = defineNode("Owner", { schema: z.object({ name: z.string() }) });
const ownedBy = defineEdge("ownedBy", { schema: z.object({}) });
const graph = defineGraph({
  id: "managed_write_state",
  nodes: {
    Widget: {
      type: Widget,
      unique: [
        {
          name: "label_key",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Owner: { type: Owner },
  },
  edges: {
    // `cardinality: "one"` makes the create a constrained write, so its frame
    // consults the write session before taking the engine writer slot.
    ownedBy: { type: ownedBy, from: [Widget], to: [Owner], cardinality: "one" },
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeContext(schemaVersion: number | undefined) {
  return {
    graphId: graph.id,
    schemaVersion,
    historyEnabled: false,
    revisionTrackingEnabled: false,
    revisionSchema: createSqlSchema(createTestBackend().tableNames),
  };
}

describe("managed write state on the transaction session", () => {
  it("a lease taken in one call is seen by the next call of the same session and not by another session", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const active = await backend.getActiveSchema(store.graphId);
    const schemaVersion = requireDefined(active?.version);
    const ctx = writeContext(schemaVersion);

    const observed = await backend.transaction(async (transaction) => {
      const session = openTransactionSession(transaction);
      const first = enterOperation(session);
      const fence = vi.spyOn(first.backend, "lockSchemaVersionForWrite");
      return withWriteTransactionSession(
        session,
        first.backend,
        first.backend,
        ctx,
        "reusable",
        async () => {
          const leasedBefore = hasLeasedSchemaFence(ctx, first);
          await lockSchemaVersionForStoreWrite(ctx, first);
          const afterFirstCall = fence.mock.calls.length;

          const next: Operation = enterOperation(session);
          const leasedForNext = hasLeasedSchemaFence(ctx, next);
          await lockSchemaVersionForStoreWrite(ctx, next);
          const afterNextCall = fence.mock.calls.length;

          // Another session over the SAME transaction object: a second
          // binding of the transaction, as a target joining through a public
          // signature is.
          const other = enterOperation(openTransactionSession(transaction));
          const sameObject = other.backend === first.backend;
          const leasedForOther = hasLeasedSchemaFence(ctx, other);
          await lockSchemaVersionForStoreWrite(ctx, other);
          const afterOtherCall = fence.mock.calls.length;
          return {
            sameObject,
            leasedBefore,
            afterFirstCall,
            leasedForNext,
            afterNextCall,
            leasedForOther,
            afterOtherCall,
          };
        },
      );
    });

    expect(observed).toEqual({
      sameObject: true,
      leasedBefore: false,
      // The first call acquires the fence and leases it on the session.
      afterFirstCall: 1,
      // The next call of the same session reuses the lease: no statement.
      leasedForNext: true,
      afterNextCall: 1,
      // Another session over the same object holds no lease and acquires.
      leasedForOther: false,
      afterOtherCall: 2,
    });
  });

  it("the write session is seen by every operation of the session that seeded it and by no other session", async () => {
    const backend = createTestBackend();
    const ctx = writeContext(undefined);

    await backend.transaction(async (transaction) => {
      const session = openTransactionSession(transaction);
      const first = enterOperation(session);
      expect(managedWrite.managedWriteState(first)?.writeSession).toBe(
        undefined,
      );
      await withWriteTransactionSession(
        session,
        first.backend,
        first.backend,
        ctx,
        "reusable",
        () => {
          const seeded = managedWrite.managedWriteState(first)?.writeSession;
          expect(seeded).toBeDefined();
          const next = enterOperation(session);
          expect(managedWrite.managedWriteState(next)?.writeSession).toBe(
            seeded,
          );
          const other = enterOperation(openTransactionSession(transaction));
          expect(other.backend).toBe(first.backend);
          expect(
            managedWrite.managedWriteState(other)?.writeSession,
          ).toBeUndefined();

          expect(hasPendingWriteTransactionRevision(next)).toBe(false);
          expect(forceWriteTransactionRevision(other)).toBe(false);
          expect(hasPendingWriteTransactionRevision(next)).toBe(false);
          expect(forceWriteTransactionRevision(next)).toBe(true);
          expect(hasPendingWriteTransactionRevision(first)).toBe(true);
          expect(hasPendingWriteTransactionRevision(other)).toBe(false);
          return Promise.resolve();
        },
      );
      // The attempt's scope ended: the session no longer carries it.
      expect(managedWrite.managedWriteState(first)?.writeSession).toBe(
        undefined,
      );
    });
  });

  it("the frame spine, node claims, writer slot and merge's pristine check and forced revision resolve the attempt's own write session", async () => {
    const [target] = await createStoreWithSchema(graph, createTestBackend(), {
      revisionTracking: true,
    });
    await target.nodes.Owner.create({ name: "base" }, { id: "owner" });
    const source = unwrap(
      await branch(target, () => Promise.resolve(createTestBackend()), {
        id: asBranchId("managed-write-state"),
      }),
    );
    await source.store.nodes.Widget.create({ label: "merged" }, { id: "m" });
    const artifact = unwrap(await planMerge(target, [source]));

    const seeds: TransactionSession[] = [];
    const seedWriteSession = writeTransaction.withWriteTransactionSession;
    vi.spyOn(
      writeTransaction,
      "withWriteTransactionSession",
    ).mockImplementation((session, ...rest) => {
      seeds.push(session);
      return seedWriteSession(session, ...rest);
    });
    // Every read of the state, with the session of the operation it was
    // read through and the write session it resolved.
    const reads: {
      reader: string;
      session: TransactionSession | undefined;
      writeSession: unknown;
    }[] = [];
    const readState = managedWrite.managedWriteState;
    vi.spyOn(managedWrite, "managedWriteState").mockImplementation((entry) => {
      const state = readState(entry);
      reads.push({
        reader: readerOf(new Error("read").stack ?? ""),
        session: operationEntrySession(entry),
        writeSession: state?.writeSession,
      });
      return state;
    });
    const claimSessions: (TransactionSession | undefined)[] = [];
    const withNodeCreateClaims = nodeClaims.withNodeCreateClaims;
    vi.spyOn(nodeClaims, "withNodeCreateClaims").mockImplementation(
      (ctx, ...rest) => {
        claimSessions.push(operationEntrySession(ctx.operation));
        return withNodeCreateClaims(ctx, ...rest);
      },
    );

    const seededWriteSessions: unknown[] = [];
    await target.transaction(async (tx) => {
      // Merge apply first: it refuses a transaction that already wrote.
      await applyMergePlanInTransaction(target, tx, artifact);
      const widget = await tx.nodes.Widget.create({ label: "claimed" });
      await tx.edges.ownedBy.create(
        { kind: "Widget", id: widget.id },
        { kind: "Owner", id: "owner" },
        {},
      );
      const seed = requireDefined(seeds[0]);
      seededWriteSessions.push(seed.managedWrite.writeSession);
    });

    expect(seeds).toHaveLength(1);
    const seed = requireDefined(seeds[0]);
    const writeSession = requireDefined(seededWriteSessions[0]);
    const readers = new Set(reads.map((read) => read.reader));
    expect([...readers]).toEqual(
      expect.arrayContaining([
        "frame",
        "ensureAdoptedConstraintWriterSlot",
        "hasPendingWriteTransactionRevision",
        "forceWriteTransactionRevision",
      ]),
    );
    // Every read, by every reader, resolved the attempt's own session and
    // its one write session.
    for (const read of reads) {
      expect(read.session).toBe(seed);
      expect(read.writeSession).toBe(writeSession);
    }
    expect(claimSessions.length).toBeGreaterThan(0);
    for (const claimSession of claimSessions) {
      expect(claimSession).toBe(seed);
    }
  });
});

/**
 * Which reader a state read came from: the named reader on the stack, or
 * `frame` for the write frame's own anonymous body. The stack runs: this
 * test's spy, the spied accessor, the reader's helper (`writeSessionOf`,
 * `schemaFenceLeases`) or the reader itself, then its caller.
 */
function readerOf(stack: string): string {
  const named = [
    "ensureAdoptedConstraintWriterSlot",
    "markWriteTransactionAborted",
    "hasPendingWriteTransactionRevision",
    "forceWriteTransactionRevision",
    "withWriteTransactionSession",
    "withTransactionSchemaFenceLease",
    "lockSchemaVersionForStoreWrite",
    "hasLeasedSchemaFence",
    "memoizeLeasedSchemaFence",
  ];
  const callers = stack.split("\n").slice(3, 5).join("\n");
  return (
    named.find((name) => callers.includes(name)) ??
    (callers.includes("write-transaction.ts") ? "frame" : callers)
  );
}
