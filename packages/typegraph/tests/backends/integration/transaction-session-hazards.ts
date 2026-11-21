/**
 * Hazards of one transaction session shared by several TypeGraph calls,
 * reproduced on main.
 *
 * A static design review listed ways a call on a transaction session can
 * outlive, overlap or escape the boundary that is supposed to govern it. Each
 * case here drives one of them on every lane and asserts the CORRECT end state
 * in one comparison: a call reports success only for writes that commit, a
 * receipt or recorded capture agrees with the rows, and nothing lands outside
 * the transaction that issued it. Where more than one end state is correct
 * (a late call may be refused, or may finish and be counted), the case accepts
 * exactly those.
 *
 * Where main violates the case on a driver, it is `it.fails` on exactly that
 * driver (`knownFailingOn`) and holds on the others, so a repair flips it to a
 * failure naming the lanes that changed. A hazard that reproduces nowhere is
 * an ordinary case pinning the safe behaviour.
 *
 * Interleavings are forced, never timed: `gatedBackend` runs a test step right
 * after a chosen transaction-scoped backend member resolves, so a late call is
 * always cut between the same two statements. Cases that need a savepoint
 * which fails on demand, around a call no public unit can contain, open it
 * through `runRecordedTransactionSavepoint`, the one helper every TypeGraph
 * unit (hard-delete batches, import rounds, merge apply) runs through.
 */
/* eslint-disable vitest/no-standalone-expect -- every case is registered through knownFailingOn, which hands its body to it() or it.fails() */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { statementExecutionVerdict } from "../../../src/backend/capabilities/resolve";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import { GRAPH_BACKEND_PROJECTION_KEYS } from "../../../src/backend/graph-backend-keys";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type {
  AdapterBackend,
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { defineGraphExtension } from "../../../src/graph-extension";
import { branch } from "../../../src/graph-merge/branch";
import {
  applyMergePlanInTransaction,
  planMerge,
} from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { runRecordedTransactionSavepoint } from "../../../src/store/recorded-capture";
import { transactionBackend } from "../../../src/store/runtime-port";
import type { StoreHooks } from "../../../src/store/types";
import { requireDefined } from "../../../src/utils/presence";
import { unwrap } from "../../../src/utils/result";
import { createGate } from "../../concurrency-utils";
import type {
  IntegrationLaneDriver,
  IntegrationTestContext,
} from "./test-context";

const HzItem = defineNode("HzItem", {
  schema: z.object({ label: z.string() }),
});
const HzNote = defineNode("HzNote", {
  schema: z.object({ body: z.string() }),
});

let graphCounter = 0;

/** A fresh graph id per case; `HzItem.label` is unique, so a row has a claim. */
function buildGraph() {
  graphCounter += 1;
  return defineGraph({
    id: `transaction_session_hazards_${graphCounter}`,
    nodes: {
      HzItem: {
        type: HzItem,
        unique: [
          {
            name: "hz_item_label",
            fields: ["label"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      HzNote: { type: HzNote },
    },
    edges: {},
  });
}

const ALL_DRIVERS: readonly IntegrationLaneDriver[] = [
  "better-sqlite3",
  "libsql",
  "pglite",
  "node-postgres",
  "postgres-js",
];
const POSTGRES_DRIVERS: readonly IntegrationLaneDriver[] = [
  "pglite",
  "node-postgres",
  "postgres-js",
];

type Case = (title: string, body: () => Promise<void>) => void;

/** `it.fails` on the drivers main is known to violate the case on, else `it`. */
function knownFailingOn(
  context: IntegrationTestContext,
  drivers: readonly IntegrationLaneDriver[],
): Case {
  return drivers.includes(context.driver) ?
      (title, body) => {
        // eslint-disable-next-line vitest/valid-title -- every caller passes a literal title
        it.fails(title, body);
      }
    : (title, body) => {
        // eslint-disable-next-line vitest/valid-title -- every caller passes a literal title
        it(title, body);
      };
}

type Status = "fulfilled" | "rejected";

function statusOf(pending: Promise<unknown>): Promise<Status> {
  return pending.then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );
}

async function countOf(
  find: () => Promise<readonly unknown[]>,
): Promise<number> {
  const rows = await find();
  return rows.length;
}

async function ids(
  find: () => Promise<readonly Readonly<{ id: string }>[]>,
): Promise<readonly string[]> {
  const rows = await find();
  return rows.map((row) => row.id).toSorted();
}

type ItemCreator = Readonly<{
  nodes: Readonly<{
    HzItem: Readonly<{
      create: (props: { label: string }) => Promise<unknown>;
    }>;
  }>;
}>;

/** Whether a new `HzItem` may take `label`: false while a claim holds it. */
async function labelIsFree(
  store: ItemCreator,
  label: string,
): Promise<boolean> {
  return (await statusOf(store.nodes.HzItem.create({ label }))) === "fulfilled";
}

async function countRows(
  backend: GraphBackend,
  table: "nodes" | "recordedNodes",
  graphId: string,
): Promise<number> {
  const tables = requireDefined(backend.tableNames);
  const rows = await backend.execute<{ count: number | string }>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${sql.identifier(requireDefined(tables[table]))}
      WHERE graph_id = ${graphId}
    `),
  );
  return Number(requireDefined(rows[0]).count);
}

async function activeSchemaVersion(
  backend: GraphBackend,
  graphId: string,
): Promise<number> {
  const tables = requireDefined(backend.tableNames);
  const rows = await backend.execute<{ version: number | string }>(
    asCompiledRowsSql(sql`
      SELECT version
      FROM ${sql.identifier(requireDefined(tables.schemaVersions))}
      WHERE graph_id = ${graphId} AND is_active = TRUE
    `),
  );
  return Number(requireDefined(rows[0]).version);
}

/** Runs after a transaction-scoped backend member resolves, before its caller resumes. */
type AfterMember = (args: readonly unknown[]) => void | Promise<void>;

type GatedBackendOptions = Readonly<{
  /** Project `executeStatement` away from every transaction-scoped backend. */
  withoutTransactionStatements?: boolean;
  after?: Readonly<Partial<Record<string, AfterMember>>>;
}>;

/**
 * `backend`, whose transactions hand out a decorated transaction backend:
 * every member call is appended to `calls`, and `after[member]` runs once
 * that member resolves — before the TypeGraph code that called it resumes.
 */
function gatedBackend(
  backend: GraphBackend,
  options: GatedBackendOptions,
): Readonly<{ backend: GraphBackend; calls: string[] }> {
  const calls: string[] = [];
  function decorate(raw: TransactionBackend): TransactionBackend {
    const target =
      options.withoutTransactionStatements === true ?
        (projectBackendWithout(raw, [
          "executeStatement",
        ]) as unknown as TransactionBackend)
      : raw;
    const overrides: Record<string, unknown> = {};
    for (const key of GRAPH_BACKEND_PROJECTION_KEYS) {
      const member: unknown = (target as unknown as Record<string, unknown>)[
        key
      ];
      if (typeof member !== "function") continue;
      overrides[key] = async (...args: unknown[]) => {
        calls.push(key);
        const result: unknown = await (
          member as (...memberArguments: unknown[]) => Promise<unknown>
        ).apply(target, args);
        await options.after?.[key]?.(args);
        return result;
      };
    }
    return deriveBackend(target, overrides as never);
  }
  return {
    calls,
    backend: deriveBackend(backend, {
      transaction: (callback, transactionOptions) =>
        backend.transaction(
          (raw) => callback(decorate(raw)),
          transactionOptions,
        ),
    }),
  };
}

/** Rejections no handler claimed while `run` was in flight. */
async function unhandledRejectionsDuring(
  run: () => Promise<void>,
): Promise<readonly string[]> {
  const unhandled: string[] = [];
  const listener = (reason: unknown) => {
    unhandled.push(String(reason));
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    // One macrotask lets Node report a rejection orphaned by the last await.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

function savepointStatements(backend: GraphBackend) {
  const statements = statementExecutionVerdict(backend);
  if (!statements.supported) {
    throw new Error("Every integration lane provides statement execution.");
  }
  return statements;
}

/**
 * A merge plan creating `m1` and `m2` into a revision-tracked target. Once
 * `arm` is called, the target's next transaction fails right after the
 * apply has written both rows, so the adopted apply's savepoint rolls them
 * back.
 */
async function failingMerge(
  context: IntegrationTestContext,
  hooks: StoreHooks,
) {
  const graph = buildGraph();
  // Every driver writes the plan's claims in one batch after both rows.
  let armed = false;
  const gated = gatedBackend(context.getBackend(), {
    after: {
      insertUniqueBatch: () => {
        if (!armed) return;
        armed = false;
        throw new Error("injected failure after the merged rows landed");
      },
    },
  });
  const [target] = await createStoreWithSchema(graph, gated.backend, {
    revisionTracking: true,
    hooks,
  });
  const source = unwrap(
    await branch(target, () => context.createIsolatedBackend(), {
      id: asBranchId(`hazards-${graph.id}`),
    }),
  );
  await source.store.nodes.HzItem.create({ label: "m1" }, { id: "m1" });
  await source.store.nodes.HzItem.create({ label: "m2" }, { id: "m2" });
  const artifact = unwrap(await planMerge(target, [source]));
  return {
    target,
    artifact,
    arm: () => {
      armed = true;
    },
  };
}

/** A transaction context a hook captured, as the hook calls it. */
type CapturedTransaction = Readonly<{
  nodes: Readonly<{
    HzNote: Readonly<{
      create: (props: { body: string }) => Promise<unknown>;
    }>;
    HzItem: Readonly<{
      bulkHardDelete: (ids: readonly string[]) => Promise<unknown>;
    }>;
  }>;
}>;

type ReceiptOutcome = Readonly<{
  receipt: Readonly<{ writes: Readonly<{ total: number }> }>;
}>;

export function registerTransactionSessionHazardTests(
  context: IntegrationTestContext,
): void {
  describe("transaction session hazards", () => {
    describe("a re-adopted binding of a read-only transaction", () => {
      knownFailingOn(context, [])(
        "cannot write through store.withTransaction(tx.sql)",
        async () => {
          const graph = buildGraph();
          const [store] = await createAdapterStoreWithSchema(
            graph,
            context.getBackend(),
          );
          let aliasWrite: Status | undefined;
          // The store refuses the alias's write before any statement, on
          // every driver (the read-only-transaction-writes suite pins the
          // exact refusal); the transaction's own outcome is not the question.
          await statusOf(
            store.transaction(
              async (tx) => {
                const alias = store.withTransaction(
                  requireDefined((tx as Readonly<{ sql?: unknown }>).sql),
                );
                aliasWrite = await statusOf(
                  alias.nodes.HzNote.create({ body: "through the alias" }),
                );
              },
              { accessMode: "read_only" },
            ),
          );
          expect({
            aliasWrite,
            notes: await ids(() => store.nodes.HzNote.find()),
          }).toEqual({ aliasWrite: "rejected", notes: [] });
        },
      );
    });

    describe("a call that outlives its callback", () => {
      knownFailingOn(context, ALL_DRIVERS)(
        "commits all of a create cut between its node and claim statements, counted, or none of it",
        async () => {
          const graph = buildGraph();
          const nodesWritten = createGate();
          let transactionSettled: Promise<unknown> = Promise.resolve();
          const gated = gatedBackend(context.getBackend(), {
            after: {
              insertNodesBatchReturning: async () => {
                nodesWritten.open();
                await statusOf(transactionSettled);
              },
            },
          });
          const [store] = await createStoreWithSchema(graph, gated.backend);
          let late: Promise<Status> = Promise.resolve("rejected");
          let receiptTotal: number | undefined;
          const unhandled = await unhandledRejectionsDuring(async () => {
            transactionSettled = store.transactionWithReceipt(async (tx) => {
              late = statusOf(
                tx.nodes.HzItem.bulkCreate([
                  { props: { label: "n1" }, id: "n1" },
                  { props: { label: "n2" }, id: "n2" },
                ]),
              );
              await nodesWritten.opened;
            });
            const outcome = (await transactionSettled) as ReceiptOutcome;
            receiptTotal = outcome.receipt.writes.total;
            await late;
          });
          const observed = {
            late: await late,
            receiptTotal,
            items: await ids(() => store.nodes.HzItem.find()),
            n1Free: await labelIsFree(store, "n1"),
            unhandled,
          };
          expect([
            {
              late: "fulfilled",
              receiptTotal: 2,
              items: ["n1", "n2"],
              n1Free: false,
              unhandled: [],
            },
            {
              late: "rejected",
              receiptTotal: 0,
              items: [],
              n1Free: true,
              unhandled: [],
            },
          ]).toContainEqual(observed);
        },
      );

      knownFailingOn(context, ["better-sqlite3"])(
        "commits nothing of a create orphaned by a Promise.all whose sibling rejected",
        async () => {
          const graph = buildGraph();
          const nodesWritten = createGate();
          let transactionSettled: Promise<unknown> = Promise.resolve();
          const gated = gatedBackend(context.getBackend(), {
            after: {
              insertNodesBatchReturning: async () => {
                nodesWritten.open();
                await statusOf(transactionSettled);
              },
            },
          });
          const [store] = await createStoreWithSchema(graph, gated.backend);
          let late: Promise<Status> = Promise.resolve("rejected");
          let transaction: Status | undefined;
          const unhandled = await unhandledRejectionsDuring(async () => {
            transactionSettled = store.transaction(async (tx) => {
              const work = tx.nodes.HzItem.bulkCreate([
                { props: { label: "n1" }, id: "n1" },
                { props: { label: "n2" }, id: "n2" },
              ]);
              late = statusOf(work);
              await Promise.all([
                work,
                nodesWritten.opened.then(() => {
                  throw new Error("a sibling rejects");
                }),
              ]);
            });
            transaction = await statusOf(transactionSettled);
            await late;
          });
          expect({
            transaction,
            late: await late,
            items: await ids(() => store.nodes.HzItem.find()),
            n1Free: await labelIsFree(store, "n1"),
            unhandled,
          }).toEqual({
            transaction: "rejected",
            late: "rejected",
            items: [],
            n1Free: true,
            unhandled: [],
          });
        },
      );

      knownFailingOn(context, ALL_DRIVERS)(
        "commits all of a bulkHardDelete cut inside its savepoint, counted, or none of it",
        async () => {
          const graph = buildGraph();
          const rowsDeleted = createGate();
          let transactionSettled: Promise<unknown> = Promise.resolve();
          const gated = gatedBackend(context.getBackend(), {
            after: {
              hardDeleteNodesBatch: async () => {
                rowsDeleted.open();
                await statusOf(transactionSettled);
              },
            },
          });
          const [store] = await createStoreWithSchema(graph, gated.backend);
          await store.nodes.HzItem.bulkCreate([
            { props: { label: "s1" }, id: "s1" },
            { props: { label: "s2" }, id: "s2" },
            { props: { label: "s3" }, id: "s3" },
          ]);
          let late: Promise<Status> = Promise.resolve("rejected");
          let receiptTotal: number | undefined;
          const unhandled = await unhandledRejectionsDuring(async () => {
            transactionSettled = store.transactionWithReceipt(async (tx) => {
              late = statusOf(
                tx.nodes.HzItem.bulkHardDelete([
                  asNodeId("s1"),
                  asNodeId("s2"),
                ]),
              );
              await rowsDeleted.opened;
            });
            const outcome = (await transactionSettled) as ReceiptOutcome;
            receiptTotal = outcome.receipt.writes.total;
            await late;
          });
          const observed = {
            late: await late,
            receiptTotal,
            items: await ids(() => store.nodes.HzItem.find()),
            unhandled,
          };
          expect([
            {
              late: "fulfilled",
              receiptTotal: 2,
              items: ["s3"],
              unhandled: [],
            },
            {
              late: "rejected",
              receiptTotal: 0,
              items: ["s1", "s2", "s3"],
              unhandled: [],
            },
          ]).toContainEqual(observed);
        },
      );

      knownFailingOn(context, ["better-sqlite3"])(
        "never lands in the next transaction on the connection",
        async () => {
          const graph = buildGraph();
          const secondStarted = createGate();
          let armed = true;
          const gated = gatedBackend(context.getBackend(), {
            after: {
              lockSchemaVersionForWrite: async () => {
                if (!armed) return;
                armed = false;
                await secondStarted.opened;
              },
            },
          });
          const [store] = await createStoreWithSchema(graph, gated.backend);
          let late: Promise<Status> = Promise.resolve("rejected");
          await store.transaction((tx) => {
            late = statusOf(
              tx.nodes.HzItem.bulkCreate([
                { props: { label: "n1" }, id: "n1" },
                { props: { label: "n2" }, id: "n2" },
              ]),
            );
            return Promise.resolve();
          });
          const abort = new Error("the second transaction rolls back");
          await expect(
            store.transaction(async () => {
              secondStarted.open();
              await late;
              throw abort;
            }),
          ).rejects.toBe(abort);
          const observed = {
            late: await late,
            items: await ids(() => store.nodes.HzItem.find()),
          };
          // Refused, or landed in its own transaction: never reported
          // written while rolled back with somebody else's transaction.
          expect([
            { late: "rejected", items: [] },
            { late: "fulfilled", items: ["n1", "n2"] },
          ]).toContainEqual(observed);
        },
      );
    });

    describe("a call re-entered from a hook", () => {
      knownFailingOn(context, ALL_DRIVERS)(
        "never reports a write that merge apply's rollback removed",
        async () => {
          let captured: CapturedTransaction | undefined;
          let child: Promise<Status> = Promise.resolve("rejected");
          const { target, artifact, arm } = await failingMerge(context, {
            onOperationStart: (operation) => {
              if (operation.id !== "m1" || captured === undefined) return;
              child = statusOf(
                captured.nodes.HzNote.create({ body: "from a hook" }),
              );
            },
          });
          let apply: Status | undefined;
          arm();
          await target.transaction(async (tx) => {
            captured = tx as unknown as CapturedTransaction;
            apply = await statusOf(
              applyMergePlanInTransaction(target, tx, artifact),
            );
            captured = undefined;
            await child;
          });
          const observed = {
            apply,
            child: await child,
            notes: await countOf(() => target.nodes.HzNote.find()),
            items: await ids(() => target.nodes.HzItem.find()),
          };
          expect([
            { apply: "rejected", child: "rejected", notes: 0, items: [] },
            { apply: "rejected", child: "fulfilled", notes: 1, items: [] },
          ]).toContainEqual(observed);
        },
      );

      it("commits and counts a write a discard hook starts after merge apply rolled back", async () => {
        let captured: CapturedTransaction | undefined;
        let child: Promise<Status> = Promise.resolve("rejected");
        const { target, artifact, arm } = await failingMerge(context, {
          onError: () => {
            if (captured === undefined) return;
            const tx = captured;
            captured = undefined;
            child = statusOf(tx.nodes.HzNote.create({ body: "from onError" }));
          },
        });
        arm();
        const { result, receipt } = await target.transactionWithReceipt(
          async (tx) => {
            captured = tx as unknown as CapturedTransaction;
            const apply = await statusOf(
              applyMergePlanInTransaction(target, tx, artifact),
            );
            return { apply, child: await child };
          },
        );
        expect({
          ...result,
          receiptNotes: receipt.writes.nodes["HzNote"],
          notes: await countOf(() => target.nodes.HzNote.find()),
        }).toEqual({
          apply: "rejected",
          child: "fulfilled",
          receiptNotes: 1,
          notes: 1,
        });
      });

      knownFailingOn(context, ["postgres-js"])(
        "applies both of two bulkHardDelete units one hook starts at once",
        async () => {
          const graph = buildGraph();
          let captured: CapturedTransaction | undefined;
          const children: Promise<Status>[] = [];
          const [store] = await createStoreWithSchema(
            graph,
            context.getBackend(),
            {
              hooks: {
                onOperationStart: (operation: Readonly<{ kind: string }>) => {
                  if (operation.kind !== "HzNote" || captured === undefined)
                    return;
                  const tx = captured;
                  captured = undefined;
                  children.push(
                    statusOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s1")])),
                    statusOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s2")])),
                  );
                },
              },
            },
          );
          await store.nodes.HzItem.bulkCreate([
            { props: { label: "s1" }, id: "s1" },
            { props: { label: "s2" }, id: "s2" },
          ]);
          const { result, receipt } = await store.transactionWithReceipt(
            async (tx) => {
              captured = tx as unknown as CapturedTransaction;
              const note = await statusOf(
                tx.nodes.HzNote.create({ body: "starts the children" }),
              );
              return { note, children: await Promise.all(children) };
            },
          );
          expect({
            ...result,
            receiptTotal: receipt.writes.total,
            items: await ids(() => store.nodes.HzItem.find()),
            notes: await countOf(() => store.nodes.HzNote.find()),
          }).toEqual({
            note: "fulfilled",
            children: ["fulfilled", "fulfilled"],
            receiptTotal: 3,
            items: [],
            notes: 1,
          });
        },
      );

      knownFailingOn(context, ALL_DRIVERS)(
        "never reports a sibling write that a failing bulkHardDelete's rollback removed",
        async () => {
          const graph = buildGraph();
          const insideUnit = createGate();
          const siblingStarted = createGate();
          let sibling: Promise<Status> = Promise.resolve("rejected");
          const gated = gatedBackend(context.getBackend(), {
            after: {
              hardDeleteNodesBatch: async () => {
                insideUnit.open();
                await siblingStarted.opened;
                await sibling;
                throw new Error("injected failure after the delete");
              },
            },
          });
          const [store] = await createStoreWithSchema(graph, gated.backend);
          await store.nodes.HzItem.bulkCreate([
            { props: { label: "s1" }, id: "s1" },
          ]);
          const result = await store.transaction(async (tx) => {
            const unit = statusOf(
              tx.nodes.HzItem.bulkHardDelete([asNodeId("s1")]),
            );
            // Started while the unit's savepoint is open.
            await insideUnit.opened;
            sibling = statusOf(
              tx.nodes.HzNote.create({ body: "sibling" }, { id: "sibling" }),
            );
            siblingStarted.open();
            return { unit: await unit, sibling: await sibling };
          });
          const observed = {
            ...result,
            notes: await ids(() => store.nodes.HzNote.find()),
            items: await ids(() => store.nodes.HzItem.find()),
          };
          expect([
            {
              unit: "rejected",
              sibling: "fulfilled",
              notes: ["sibling"],
              items: ["s1"],
            },
            { unit: "rejected", sibling: "rejected", notes: [], items: ["s1"] },
          ]).toContainEqual(observed);
        },
      );
    });

    describe("two bindings of one native transaction", () => {
      knownFailingOn(context, ALL_DRIVERS)(
        "leaves no recorded row or receipt for a history write a plain binding's savepoint rolled back",
        async () => {
          const graph = buildGraph();
          const backend = context.getBackend();
          const [plain] = await createAdapterStoreWithSchema(graph, backend);
          const [history] = await createAdapterStoreWithSchema(graph, backend, {
            history: true,
          });
          const statements = savepointStatements(backend);
          const outcome = await backend.transactionWithNative(
            (_target, native) =>
              history.withRecordedTransaction(native, async (tx) =>
                statusOf(
                  runRecordedTransactionSavepoint(
                    transactionBackend(plain.withTransaction(native)),
                    statements,
                    "hazard_plain_unit",
                    async () => {
                      await tx.nodes.HzItem.create(
                        { label: "h1" },
                        { id: "h1" },
                      );
                      throw new Error("the plain binding's unit fails");
                    },
                  ),
                ),
              ),
          );
          expect({
            unit: outcome.result,
            receiptTotal: outcome.receipt.writes.total,
            receiptRecorded: outcome.receipt.recorded !== undefined,
            live: await countRows(backend, "nodes", graph.id),
            recorded: await countRows(backend, "recordedNodes", graph.id),
          }).toEqual({
            unit: "rejected",
            receiptTotal: 0,
            receiptRecorded: false,
            live: 0,
            recorded: 0,
          });
        },
      );

      knownFailingOn(context, ALL_DRIVERS)(
        "never reports a plain binding's write that a history binding's savepoint rolled back",
        async () => {
          const graph = buildGraph();
          const backend = context.getBackend();
          const [plain] = await createAdapterStoreWithSchema(graph, backend);
          const [history] = await createAdapterStoreWithSchema(graph, backend, {
            history: true,
          });
          const statements = savepointStatements(backend);
          let plainWrite: Status | undefined;
          await backend.transactionWithNative((_target, native) => {
            const plainTx = plain.withTransaction(native);
            return history.withRecordedTransaction(native, (tx) =>
              statusOf(
                runRecordedTransactionSavepoint(
                  transactionBackend(tx),
                  statements,
                  "hazard_history_unit",
                  async () => {
                    plainWrite = await statusOf(
                      plainTx.nodes.HzItem.create(
                        { label: "p1" },
                        { id: "p1" },
                      ),
                    );
                    throw new Error("the history binding's unit fails");
                  },
                ),
              ),
            );
          });
          const observed = {
            plainWrite,
            items: await ids(() => plain.nodes.HzItem.find()),
          };
          expect([
            { plainWrite: "fulfilled", items: ["p1"] },
            { plainWrite: "rejected", items: [] },
          ]).toContainEqual(observed);
        },
      );

      // SQLite has no factory for a backend over a caller's transaction.
      describe.runIf(POSTGRES_DRIVERS.includes(context.driver))(
        "a Store over createPostgresTransactionBackend",
        () => {
          async function withTransactionStore(
            run: (store: ItemCreatorWithTransaction) => Promise<void>,
          ): Promise<readonly string[]> {
            const graph = buildGraph();
            const backend = context.getBackend();
            const [setup] = await createAdapterStoreWithSchema(graph, backend);
            await setup.nodes.HzItem.create(
              { label: "taken" },
              { id: "taken" },
            );
            await backend.transactionWithNative(async (_target, native) => {
              const [store] = await createAdapterStoreWithSchema(
                graph,
                createPostgresBackend(
                  native as never,
                ) as AdapterBackend<unknown>,
              );
              await run(store as unknown as ItemCreatorWithTransaction);
            });
            return ids(() => setup.nodes.HzItem.find());
          }

          it("commits two overlapping creates", async () => {
            let creates: readonly Status[] = [];
            const items = await withTransactionStore(async (store) => {
              creates = await Promise.all([
                statusOf(
                  store.nodes.HzItem.create({ label: "a" }, { id: "a" }),
                ),
                statusOf(
                  store.nodes.HzItem.create({ label: "b" }, { id: "b" }),
                ),
              ]);
            });
            expect({ creates, items }).toEqual({
              creates: ["fulfilled", "fulfilled"],
              items: ["a", "b", "taken"],
            });
          });

          knownFailingOn(context, POSTGRES_DRIVERS)(
            "commits a create that succeeded beside an overlapping create that failed",
            async () => {
              let creates: readonly Status[] = [];
              const items = await withTransactionStore(async (store) => {
                creates = await Promise.all([
                  statusOf(
                    store.nodes.HzItem.create({ label: "c" }, { id: "c" }),
                  ),
                  statusOf(
                    store.nodes.HzItem.create({ label: "taken" }, { id: "d" }),
                  ),
                ]);
              });
              expect({ creates, items }).toEqual({
                creates: ["fulfilled", "rejected"],
                items: ["c", "taken"],
              });
            },
          );

          knownFailingOn(context, POSTGRES_DRIVERS)(
            "commits a create that overlapped a nested store.transaction() that rolled back",
            async () => {
              let outcomes: readonly Status[] = [];
              const items = await withTransactionStore(async (store) => {
                const innerWritten = createGate();
                const siblingStarted = createGate();
                let sibling: Promise<Status> = Promise.resolve("rejected");
                const nested = statusOf(
                  store.transaction(async (tx) => {
                    await tx.nodes.HzItem.create({ label: "e" }, { id: "e" });
                    innerWritten.open();
                    await siblingStarted.opened;
                    await sibling;
                    throw new Error("the nested transaction fails");
                  }),
                );
                await innerWritten.opened;
                sibling = statusOf(
                  store.nodes.HzItem.create({ label: "f" }, { id: "f" }),
                );
                siblingStarted.open();
                outcomes = await Promise.all([nested, sibling]);
              });
              expect({ outcomes, items }).toEqual({
                outcomes: ["rejected", "fulfilled"],
                items: ["f", "taken"],
              });
            },
          );
        },
      );
    });

    describe("an adopted callback inside another binding's savepoint", () => {
      knownFailingOn(context, ALL_DRIVERS)(
        "withRecordedTransaction never returns a receipt for writes the savepoint rolled back",
        async () => {
          const graph = buildGraph();
          const backend = context.getBackend();
          const [plain] = await createAdapterStoreWithSchema(graph, backend);
          const [history] = await createAdapterStoreWithSchema(graph, backend, {
            history: true,
          });
          const statements = savepointStatements(backend);
          let adopted:
            Readonly<{ status: Status; receiptTotal?: number }> | undefined;
          await backend.transactionWithNative((_target, native) =>
            statusOf(
              runRecordedTransactionSavepoint(
                transactionBackend(plain.withTransaction(native)),
                statements,
                "hazard_plain_unit",
                async () => {
                  adopted = await history
                    .withRecordedTransaction(native, async (tx) => {
                      await tx.nodes.HzItem.create(
                        { label: "r1" },
                        { id: "r1" },
                      );
                    })
                    .then(
                      ({ receipt }) => ({
                        status: "fulfilled" as const,
                        receiptTotal: receipt.writes.total,
                      }),
                      () => ({ status: "rejected" as const }),
                    );
                  throw new Error("the plain binding's unit fails");
                },
              ),
            ),
          );
          const observed = {
            adopted,
            live: await countRows(backend, "nodes", graph.id),
            recorded: await countRows(backend, "recordedNodes", graph.id),
          };
          expect([
            { adopted: { status: "rejected" }, live: 0, recorded: 0 },
            {
              adopted: { status: "fulfilled", receiptTotal: 1 },
              live: 1,
              recorded: 1,
            },
          ]).toContainEqual(observed);
        },
      );

      // libSQL refuses withEvolvedTransaction ('adoptSchemaWriteTransaction'),
      // so the case holds there.
      knownFailingOn(
        context,
        ALL_DRIVERS.filter((driver) => driver !== "libsql"),
      )(
        "withEvolvedTransaction never reports a schema version the savepoint rolled back",
        async () => {
          const graph = buildGraph();
          const backend = context.getBackend();
          const [plain] = await createAdapterStoreWithSchema(graph, backend);
          const [adopter] = await createAdapterStoreWithSchema(graph, backend);
          const plan = await adopter.planEvolution(
            defineGraphExtension({
              nodes: { HzTag: { properties: { label: { type: "string" } } } },
            }),
          );
          if (plan.status !== "change") throw new Error("Expected a change.");
          const statements = savepointStatements(backend);
          let evolved: Status | undefined;
          await backend.transactionWithNative((_target, native) =>
            statusOf(
              runRecordedTransactionSavepoint(
                transactionBackend(plain.withTransaction(native)),
                statements,
                "hazard_plain_unit",
                async () => {
                  evolved = await statusOf(
                    adopter.withEvolvedTransaction(native, plan, () =>
                      Promise.resolve("evolved"),
                    ),
                  );
                  throw new Error("the plain binding's unit fails");
                },
              ),
            ),
          );
          const observed = {
            evolved,
            version: await activeSchemaVersion(backend, graph.id),
          };
          expect([
            { evolved: "rejected", version: plan.result.version - 1 },
            { evolved: "fulfilled", version: plan.result.version },
          ]).toContainEqual(observed);
        },
      );
    });

    describe("a unit on a target without statement execution", () => {
      it("bulkHardDelete refuses before its first row write when only the transaction target lacks it", async () => {
        const graph = buildGraph();
        const gated = gatedBackend(context.getBackend(), {
          withoutTransactionStatements: true,
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
        ]);
        gated.calls.length = 0;
        const attempt = await store.transaction((tx) =>
          statusOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s1")])),
        );
        expect({
          attempt,
          rowWrites: gated.calls.filter((member) =>
            member.startsWith("hardDelete"),
          ),
          items: await ids(() => store.nodes.HzItem.find()),
        }).toEqual({ attempt: "rejected", rowWrites: [], items: ["s1"] });
      });

      knownFailingOn(context, ALL_DRIVERS)(
        "bulkHardDelete keeps nothing of a failure after its first write when the root lacks it",
        async () => {
          const graph = buildGraph();
          const backend = context.getBackend();
          const [setup] = await createStoreWithSchema(graph, backend);
          await setup.nodes.HzItem.bulkCreate([
            { props: { label: "s1" }, id: "s1" },
            { props: { label: "s2" }, id: "s2" },
          ]);
          const gated = gatedBackend(
            projectBackendWithout(backend, ["executeStatement"]),
            {
              withoutTransactionStatements: true,
              after: {
                hardDeleteNodesBatch: () => {
                  throw new Error("injected failure after the delete");
                },
              },
            },
          );
          const [store] = await createStoreWithSchema(graph, gated.backend);
          const attempt = await store.transaction((tx) =>
            statusOf(
              tx.nodes.HzItem.bulkHardDelete([asNodeId("s1"), asNodeId("s2")]),
            ),
          );
          expect({
            attempt,
            items: await ids(() => setup.nodes.HzItem.find()),
          }).toEqual({ attempt: "rejected", items: ["s1", "s2"] });
        },
      );

      it("merge apply refuses before any statement when the transaction target lacks it", async () => {
        const graph = buildGraph();
        const gated = gatedBackend(context.getBackend(), {
          withoutTransactionStatements: true,
        });
        const [target] = await createStoreWithSchema(graph, gated.backend, {
          revisionTracking: true,
        });
        const source = unwrap(
          await branch(target, () => context.createIsolatedBackend(), {
            id: asBranchId(`hazards-${graph.id}`),
          }),
        );
        await source.store.nodes.HzItem.create({ label: "m1" }, { id: "m1" });
        const artifact = unwrap(await planMerge(target, [source]));
        gated.calls.length = 0;
        const apply = await target.transaction((tx) =>
          statusOf(applyMergePlanInTransaction(target, tx, artifact)),
        );
        expect({
          apply,
          calls: gated.calls,
          items: await ids(() => target.nodes.HzItem.find()),
        }).toEqual({ apply: "rejected", calls: [], items: [] });
      });
    });

    describe("deferred execution", () => {
      knownFailingOn(context, ALL_DRIVERS)(
        "a stream advanced during a bulkHardDelete that rolls back yields what commits",
        async () => {
          const graph = buildGraph();
          const yielded: unknown[] = [];
          let iterator: AsyncIterator<unknown> | undefined;
          const gated = gatedBackend(context.getBackend(), {
            after: {
              hardDeleteNodesBatch: async () => {
                const stream = requireDefined(iterator);
                for (;;) {
                  const next = await stream.next();
                  if (next.done === true) break;
                  yielded.push(next.value);
                }
                throw new Error("injected failure after the delete");
              },
            },
          });
          const [store] = await createStoreWithSchema(graph, gated.backend);
          await store.nodes.HzItem.bulkCreate([
            { props: { label: "s1" }, id: "s1" },
            { props: { label: "s2" }, id: "s2" },
            { props: { label: "s3" }, id: "s3" },
          ]);
          const unit = await store.transaction(async (tx) => {
            iterator = tx
              .query()
              .from("HzItem", "item")
              .select((select) => select.item.id)
              .orderBy("item", "id")
              .stream({ batchSize: 1 })
              [Symbol.asyncIterator]();
            const first = await iterator.next();
            yielded.push(first.value);
            return statusOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s2")]));
          });
          expect({
            unit,
            yielded,
            items: await ids(() => store.nodes.HzItem.find()),
          }).toEqual({
            unit: "rejected",
            yielded: ["s1", "s2", "s3"],
            items: ["s1", "s2", "s3"],
          });
        },
      );

      knownFailingOn(context, ["better-sqlite3"])(
        "a prepared query and a stream kept past their callback never read a later transaction's writes",
        async () => {
          const graph = buildGraph();
          const [store] = await createStoreWithSchema(
            graph,
            context.getBackend(),
          );
          await store.nodes.HzItem.bulkCreate([
            { props: { label: "s1" }, id: "s1" },
            { props: { label: "s2" }, id: "s2" },
          ]);
          const { prepared, stream } = await store.transaction(async (tx) => {
            const query = () =>
              tx
                .query()
                .from("HzItem", "item")
                .select((select) => select.item.id)
                .orderBy("item", "id");
            const iterator = query()
              .stream({ batchSize: 1 })
              [Symbol.asyncIterator]();
            await iterator.next();
            return { prepared: query().prepare(), stream: iterator };
          });
          const seen: unknown[] = [];
          const abort = new Error("the later transaction rolls back");
          await expect(
            store.transaction(async (tx) => {
              await tx.nodes.HzItem.create({ label: "x1" }, { id: "x1" });
              await prepared.execute().then(
                (rows) => seen.push(...rows),
                () => 0,
              );
              for (;;) {
                // A refused advance ends the stream, as exhaustion does.
                const next = await stream.next().then(
                  (result) => result,
                  (): IteratorResult<unknown> => ({
                    done: true,
                    value: undefined,
                  }),
                );
                if (next.done === true) break;
                seen.push(next.value);
              }
              throw abort;
            }),
          ).rejects.toBe(abort);
          expect({ sawUncommittedRow: seen.includes("x1") }).toEqual({
            sawUncommittedRow: false,
          });
        },
      );
    });
  });
}

/** A Store over a caller's transaction, as these cases call it. */
type ItemCreatorWithTransaction = Readonly<{
  nodes: Readonly<{
    HzItem: Readonly<{
      create: (
        props: { label: string },
        options?: { id: string },
      ) => Promise<unknown>;
    }>;
  }>;
  transaction: (
    fn: (tx: ItemCreatorWithTransaction) => Promise<unknown>,
  ) => Promise<unknown>;
}>;
