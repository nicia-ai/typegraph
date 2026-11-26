/**
 * Hazards of one transaction session shared by several TypeGraph calls,
 * reproduced on main.
 *
 * A static design review listed ways a call on a transaction session can
 * outlive, overlap or escape the boundary that is supposed to govern it. Each
 * case here drives one of them on every lane. Its setup and its interception
 * run as ordinary assertions; its end state is ONE observation, checked with
 * `expectObservation` (`tests/helpers/known-defect.ts`) against the CORRECT
 * value: a call reports success only for writes that commit, a receipt or
 * recorded capture agrees with the rows, and nothing lands outside the
 * transaction that issued it. Where more than one end state is correct (a late
 * call may be refused, or may finish and be counted), the observation is
 * `ACCEPTED` for exactly those and the raw end state otherwise.
 *
 * Where main violates a case on a driver, the case names the hazard as a known
 * defect on exactly those drivers, with the exact end state main produces
 * there today. A repair flips the observation to the correct value and fails
 * the case with "defect fixed, flip this marker"; any other change fails it
 * as a changed defect. A hazard that reproduces nowhere is an ordinary case
 * pinning the safe behaviour.
 *
 * Interleavings are forced, never timed: `gatedBackend` runs a test step right
 * after a chosen transaction-scoped backend member resolves, so a late call is
 * always cut between the same two statements. A late call is held until the
 * callback that started it has returned, never until its transaction settles,
 * so a repair that waits for in-flight calls before committing can still
 * finish. Cases that need a savepoint which fails on demand, around a call no
 * public unit can contain, open it through `runRecordedTransactionSavepoint`,
 * the one helper every TypeGraph unit (hard-delete batches, import rounds,
 * merge apply) runs through.
 */
import { isDeepStrictEqual } from "node:util";

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
  InsertEdgeParams,
  InsertNodeParams,
  TransactionBackend,
  TrustedImportSession,
} from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { defineGraphExtension } from "../../../src/graph-extension";
import { branch } from "../../../src/graph-merge/branch";
import {
  applyMergePlanInTransaction,
  planMerge,
} from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import {
  enterOperation,
  openTransactionSession,
} from "../../../src/store/operation-scope";
import { runRecordedTransactionSavepoint } from "../../../src/store/recorded-capture";
import { transactionBackend } from "../../../src/store/runtime-port";
import type { StoreHooks } from "../../../src/store/types";
import { requireDefined } from "../../../src/utils/presence";
import { unwrap } from "../../../src/utils/result";
import { createGate, type Gate } from "../../concurrency-utils";
import {
  type DefectScope,
  expectObservation,
  type KnownDefect,
} from "../../helpers/known-defect";
import {
  prefixedTableNames,
  type TracedStatement,
} from "../../helpers/traced-connection";
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

/** The scope of a known defect every driver shows today. */
/** The lanes whose backend offers `trustedImport`: a synchronous SQLite driver, or PostgreSQL. */
const TRUSTED_IMPORT_DRIVERS: ReadonlySet<IntegrationLaneDriver> = new Set([
  "better-sqlite3",
  "pglite",
  "node-postgres",
  "postgres-js",
]);
/** The lanes whose serialized backend carries a vector strategy. */
const VECTOR_DRIVERS: ReadonlySet<IntegrationLaneDriver> = new Set(ALL_DRIVERS);
const ON_EVERY_DRIVER: DefectScope = { driver: ALL_DRIVERS };
/** The scope of a known defect every PostgreSQL driver shows today. */
const ON_POSTGRES_DRIVERS: DefectScope = { driver: POSTGRES_DRIVERS };

/**
 * Asserts a case's one observation on this lane: the correct value, or the
 * exact value a known defect produces on the drivers it names.
 */
function expectOnLane<TValue>(
  context: IntegrationTestContext,
  observed: TValue,
  correct: NoInfer<TValue>,
  defects: readonly KnownDefect<NoInfer<TValue>>[] = [],
): void {
  expectObservation({
    lane: { driver: context.driver },
    observed,
    correct,
    defects,
  });
}

/** The observation of an end state that is one of a case's correct ones. */
const ACCEPTED = "an accepted end state";

/** `ACCEPTED` when `observed` is one of `accepted`, else `observed` itself. */
function acceptedOr<TValue>(
  observed: TValue,
  accepted: readonly NoInfer<TValue>[],
): TValue | typeof ACCEPTED {
  return accepted.some((state) => isDeepStrictEqual(state, observed)) ? ACCEPTED
    : observed;
}

type Status = "fulfilled" | "rejected";

function statusOf(pending: Promise<unknown>): Promise<Status> {
  return pending.then(
    () => "fulfilled" as const,
    () => "rejected" as const,
  );
}

/** A typed error as its name, code, identifying details and typed cause. */
type TypedError = Readonly<{
  error: string;
  code: string;
  details: Readonly<Record<string, unknown>>;
  cause?: TypedError | string;
}>;

/** A refusal as a {@link TypedError}, or what else `pending` did. */
type Refusal = TypedError | Readonly<{ fulfilled: true }> | string;

/** The details that name what a capability refusal is about. */
const IDENTIFYING_DETAILS = new Set(["bundle", "member", "code", "capability"]);

function typedErrorOf(error: unknown): TypedError | string {
  if (!(error instanceof TypeGraphError)) return String(error);
  const details = Object.fromEntries(
    Object.entries(error.details).filter(([key]) =>
      IDENTIFYING_DETAILS.has(key),
    ),
  );
  return {
    error: error.name,
    code: error.code,
    details,
    ...(error.cause === undefined ? {} : { cause: typedErrorOf(error.cause) }),
  };
}

function refusalOf(pending: Promise<unknown>): Promise<Refusal> {
  return pending.then(
    (): Refusal => ({ fulfilled: true }),
    (error: unknown): Refusal => typedErrorOf(error),
  );
}

/** The refusal of a statement issued after its transaction's view closed. */
const TRANSACTION_CLOSED: TypedError = {
  error: "TransactionClosedError",
  code: "TRANSACTION_CLOSED",
  details: {},
};

/**
 * The refusal of contribution administration (here `createVectorIndex`)
 * through a transaction-scoped backend.
 */
const VECTOR_INDEX_ADMINISTRATION_REFUSAL: TypedError = {
  error: "ConfigurationError",
  code: "CONFIGURATION_ERROR",
  details: {
    capability: "contributionAdministration",
    member: "createVectorIndex",
  },
};

/**
 * The refusal of a unit whose transaction target lacks `executeStatement`:
 * the statement-execution bundle the root resolved cannot bind to it.
 */
const STATEMENT_EXECUTION_REFUSAL: TypedError = {
  error: "ConfigurationError",
  code: "CONFIGURATION_ERROR",
  details: {
    bundle: "statementExecution",
    member: "executeStatement",
    code: "BUNDLE_PORT_SURFACE_MISMATCH",
  },
};

/** How a transaction settled, with its receipt's write total when it committed. */
type TransactionSettlement =
  | Readonly<{ status: "fulfilled"; receiptTotal: number }>
  | Readonly<{ status: "rejected" }>;

function settlementOf(
  pending: Promise<
    Readonly<{ receipt: Readonly<{ writes: Readonly<{ total: number }> }> }>
  >,
): Promise<TransactionSettlement> {
  return pending.then(
    (outcome): TransactionSettlement => ({
      status: "fulfilled",
      receiptTotal: outcome.receipt.writes.total,
    }),
    (): TransactionSettlement => ({ status: "rejected" }),
  );
}

/** `callback`, opening `returned` the moment its promise settles. */
function openingOnReturn<TArgument, TResult>(
  returned: Gate,
  callback: (argument: TArgument) => Promise<TResult>,
): (argument: TArgument) => Promise<TResult> {
  return (argument) =>
    callback(argument).finally(() => {
      returned.open();
    });
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

/**
 * The live uniqueness claims each of `nodeIds` owns: 1 for a live `HzItem`,
 * 0 for a deleted one. A surviving node that lost its claim, or a deleted
 * node whose claim stayed behind, shows here when its row does not.
 */
async function liveClaims(
  backend: GraphBackend,
  graphId: string,
  nodeIds: readonly string[],
): Promise<Readonly<Record<string, number>>> {
  const tables = requireDefined(backend.tableNames);
  const claims: Record<string, number> = {};
  for (const nodeId of nodeIds) {
    const rows = await backend.execute<{ count: number | string }>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS count
        FROM ${sql.identifier(requireDefined(tables.uniques))}
        WHERE graph_id = ${graphId} AND node_id = ${nodeId}
          AND deleted_at IS NULL
      `),
    );
    claims[nodeId] = Number(requireDefined(rows[0]).count);
  }
  return claims;
}

async function countRows(
  backend: GraphBackend,
  table: "nodes" | "edges" | "recordedNodes",
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

/** One node row as trusted import writes it. */
function importedNode(graphId: string, id: string): InsertNodeParams {
  return { graphId, kind: "HzItem", id, props: { label: id } };
}

/** One edge row as trusted import writes it. */
function importedEdge(graphId: string, id: string): InsertEdgeParams {
  return {
    graphId,
    id,
    kind: "hzLink",
    fromKind: "HzItem",
    fromId: "a",
    toKind: "HzItem",
    toId: "b",
    props: {},
  };
}

/**
 * The lanes where a second session can hold a statement of the import open on
 * the wire: the server PostgreSQL drivers. better-sqlite3 runs every
 * statement synchronously, so none is ever in flight at the boundary, and
 * PGlite is one session, so no other session can hold the lock. The SQLite
 * manual frame's drain is pinned against an async driver in
 * `tests/transaction-view.test.ts`.
 */
const HELD_STATEMENT_DRIVERS: ReadonlySet<IntegrationLaneDriver> = new Set([
  "node-postgres",
  "postgres-js",
]);

/** The advisory lock the held-insert trigger waits for. */
const HELD_INSERT_LOCK_KEY = 954_998;

/** The node id whose insert waits for {@link HELD_INSERT_LOCK_KEY}. */
const HELD_INSERT_ID = "held";

/**
 * Installs a PostgreSQL trigger under which inserting node `HELD_INSERT_ID`
 * into `graphId` waits until no other session holds
 * {@link HELD_INSERT_LOCK_KEY}. Returns the teardown.
 */
async function installHeldInsertTrigger(
  backend: Pick<GraphBackend, "executeDdl" | "tableNames">,
  graphId: string,
): Promise<() => Promise<void>> {
  const executeDdl = requireDefined(backend.executeDdl);
  const nodesTable = `"${requireDefined(backend.tableNames).nodes}"`;
  const trigger = `tg_held_insert_${graphCounter}`;
  await executeDdl(
    `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN PERFORM pg_advisory_xact_lock_shared(${HELD_INSERT_LOCK_KEY}); RETURN NEW; END $$`,
  );
  await executeDdl(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${nodesTable}
     FOR EACH ROW WHEN (NEW.graph_id = '${graphId.replaceAll("'", "''")}' AND NEW.id = '${HELD_INSERT_ID}')
     EXECUTE FUNCTION ${trigger}()`,
  );
  return async () => {
    await executeDdl(`DROP TRIGGER ${trigger} ON ${nodesTable}`);
    await executeDdl(`DROP FUNCTION ${trigger}()`);
  };
}

/**
 * The import batches into `graphId` (as `insert <node id>`) and the
 * transaction-control statements among `statements`, in the order they
 * reached the client.
 */
function importStatementsOf(
  statements: readonly TracedStatement[],
  graphId: string,
): readonly string[] {
  return statements.flatMap((statement) => {
    const text = statement.text.trim();
    if (/^(?:COMMIT|ROLLBACK)\b/i.test(text)) return [text.toUpperCase()];
    // A batch binds its columns as arrays (`UNNEST`), which a driver may
    // record as array literals: match the serialized parameters.
    const params = statement.params
      .map((parameter) =>
        typeof parameter === "string" ? parameter : JSON.stringify(parameter),
      )
      .join(" ");
    if (!/^INSERT\b/i.test(text) || !params.includes(graphId)) return [];
    return [HELD_INSERT_ID, "queued"]
      .filter((id) => params.includes(`"${id}"`))
      .map((id) => `insert ${id}`);
  });
}

/** Resolves once `condition` holds, checking every few milliseconds. */
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Whether `pending` has settled once every queued microtask has run. */
async function hasSettled(pending: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    pending.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => {
        resolve(false);
      }, 0);
    }),
  ]);
}

/** The node id whose insert the engine-rollback trigger answers. */
const ENGINE_ROLLBACK_ID = "engine-rollback";

/**
 * Installs a trigger under which inserting node `ENGINE_ROLLBACK_ID` into
 * `graphId` fails in the engine, ending (SQLite's `RAISE(ROLLBACK)`) or
 * aborting (PostgreSQL) the transaction it runs in. Returns the teardown.
 */
async function installEngineRollbackTrigger(
  backend: Pick<GraphBackend, "dialect" | "executeDdl" | "tableNames">,
  graphId: string,
): Promise<() => Promise<void>> {
  const executeDdl = requireDefined(backend.executeDdl);
  const nodesTable = `"${requireDefined(backend.tableNames).nodes}"`;
  const trigger = `tg_engine_rollback_${graphCounter}`;
  const when = `graph_id = '${graphId.replaceAll("'", "''")}' AND NEW.id = '${ENGINE_ROLLBACK_ID}'`;
  if (backend.dialect === "postgres") {
    await executeDdl(
      `CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE EXCEPTION 'engine ended the transaction'; END $$`,
    );
    await executeDdl(
      `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${nodesTable}
       FOR EACH ROW WHEN (NEW.${when}) EXECUTE FUNCTION ${trigger}()`,
    );
    return async () => {
      await executeDdl(`DROP TRIGGER ${trigger} ON ${nodesTable}`);
      await executeDdl(`DROP FUNCTION ${trigger}()`);
    };
  }
  await executeDdl(
    `CREATE TRIGGER ${trigger} BEFORE INSERT ON ${nodesTable}
     WHEN NEW.${when}
     BEGIN SELECT RAISE(ROLLBACK, 'engine ended the transaction'); END`,
  );
  return async () => {
    await executeDdl(`DROP TRIGGER ${trigger}`);
  };
}

/**
 * How a write the callback issues after the engine ended (SQLite) or aborted
 * (PostgreSQL) its transaction is refused.
 */
const ENGINE_ROLLBACK_LATER_REFUSAL: Readonly<
  Record<IntegrationLaneDriver, string>
> = {
  "better-sqlite3": "TransactionRolledBackError",
  libsql: "TransactionRolledBackError",
  // The server refuses every statement of an aborted transaction itself
  // (`25P02`); the refusal reaches the caller as the driver raised it.
  pglite: "untyped driver error",
  "node-postgres": "untyped driver error",
  "postgres-js": "untyped driver error",
};

/** Whether `refusal` records a call that succeeded. */
function isFulfilled(refusal: Refusal): boolean {
  return typeof refusal === "object" && "fulfilled" in refusal;
}

/** A refusal as its error class, `"fulfilled"`, or `"untyped driver error"`. */
function typedOutcome(refusal: Refusal | undefined): string {
  if (refusal === undefined) return "never issued";
  if (typeof refusal === "string") return "untyped driver error";
  return "fulfilled" in refusal ? "fulfilled" : refusal.error;
}

/** Whether a relation named `name` exists in the backend's catalog. */
async function relationExists(
  backend: GraphBackend,
  name: string,
): Promise<boolean> {
  const rows = await backend.execute<{ count: number | string }>(
    asCompiledRowsSql(
      backend.dialect === "sqlite" ?
        sql`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ${name}`
      : sql`SELECT COUNT(*) AS count FROM pg_catalog.pg_class WHERE relname = ${name}`,
    ),
  );
  return Number(requireDefined(rows[0]).count) > 0;
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

export function registerTransactionSessionHazardTests(
  context: IntegrationTestContext,
): void {
  describe("transaction session hazards", () => {
    describe("a re-adopted binding of a read-only transaction", () => {
      it("cannot write through store.withTransaction(tx.sql)", async () => {
        const graph = buildGraph();
        const [store] = await createAdapterStoreWithSchema(
          graph,
          context.getBackend(),
        );
        let aliasWrite: Status | undefined;
        // PostgreSQL refuses the alias's statement itself, and postgres-js
        // then rejects the transaction too: its outcome is not the question.
        await statusOf(
          store.transaction(
            async (tx) => {
              const alias = store.withTransaction(
                requireDefined((tx as Readonly<{ sql?: unknown }>).sql),
              );
              aliasWrite = await statusOf(
                alias.nodes.HzNote.create(
                  { body: "through the alias" },
                  { id: "alias" },
                ),
              );
            },
            { accessMode: "read_only" },
          ),
        );
        expectOnLane(
          context,
          { aliasWrite, notes: await ids(() => store.nodes.HzNote.find()) },
          { aliasWrite: "rejected", notes: [] },
          [
            {
              label: "hazard 1",
              on: { driver: ["better-sqlite3", "libsql"] },
              today: { aliasWrite: "fulfilled", notes: ["alias"] },
            },
          ],
        );
      });
    });

    describe("a call that outlives its callback", () => {
      it("commits all of a create cut between its node and claim statements, counted, or none of it", async () => {
        const graph = buildGraph();
        const nodesWritten = createGate();
        const callbackReturned = createGate();
        const gated = gatedBackend(context.getBackend(), {
          after: {
            insertNodesBatchReturning: async () => {
              nodesWritten.open();
              await callbackReturned.opened;
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        let late: Promise<Status> = Promise.resolve("rejected");
        let transaction: TransactionSettlement | undefined;
        const unhandled = await unhandledRejectionsDuring(async () => {
          transaction = await settlementOf(
            store.transactionWithReceipt(
              openingOnReturn(callbackReturned, async (tx) => {
                late = statusOf(
                  tx.nodes.HzItem.bulkCreate([
                    { props: { label: "n1" }, id: "n1" },
                    { props: { label: "n2" }, id: "n2" },
                  ]),
                );
                await nodesWritten.opened;
              }),
            ),
          );
          await late;
        });
        expectOnLane(
          context,
          acceptedOr(
            {
              transaction,
              late: await late,
              items: await ids(() => store.nodes.HzItem.find()),
              n1Free: await labelIsFree(store, "n1"),
              unhandled,
            },
            [
              {
                transaction: { status: "fulfilled", receiptTotal: 2 },
                late: "fulfilled",
                items: ["n1", "n2"],
                n1Free: false,
                unhandled: [],
              },
              {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "rejected",
                items: [],
                n1Free: true,
                unhandled: [],
              },
              {
                transaction: { status: "rejected" },
                late: "rejected",
                items: [],
                n1Free: true,
                unhandled: [],
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 2a",
              on: { driver: ["better-sqlite3", "libsql"] },
              today: {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "fulfilled",
                items: ["n1", "n2"],
                n1Free: false,
                unhandled: [],
              },
            },
          ],
        );
      });

      it("commits nothing of a create orphaned by a Promise.all whose sibling rejected", async () => {
        const graph = buildGraph();
        const nodesWritten = createGate();
        const callbackReturned = createGate();
        const gated = gatedBackend(context.getBackend(), {
          after: {
            insertNodesBatchReturning: async () => {
              nodesWritten.open();
              await callbackReturned.opened;
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        let late: Promise<Status> = Promise.resolve("rejected");
        let transaction: Status | undefined;
        const unhandled = await unhandledRejectionsDuring(async () => {
          transaction = await statusOf(
            store.transaction(
              openingOnReturn(callbackReturned, async (tx) => {
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
              }),
            ),
          );
          await late;
        });
        expectOnLane(
          context,
          {
            transaction,
            late: await late,
            items: await ids(() => store.nodes.HzItem.find()),
            n1Free: await labelIsFree(store, "n1"),
            unhandled,
          },
          {
            transaction: "rejected",
            late: "rejected",
            items: [],
            n1Free: true,
            unhandled: [],
          },
          [
            {
              label: "hazard 2b",
              on: ON_EVERY_DRIVER,
              today: {
                transaction: "rejected",
                late: "fulfilled",
                items: [],
                n1Free: true,
                unhandled: [],
              },
            },
          ],
        );
      });

      it("commits all of a bulkHardDelete cut inside its savepoint, counted, or none of it", async () => {
        const graph = buildGraph();
        const rowsDeleted = createGate();
        const callbackReturned = createGate();
        const gated = gatedBackend(context.getBackend(), {
          after: {
            hardDeleteNodesBatch: async () => {
              rowsDeleted.open();
              await callbackReturned.opened;
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
        let transaction: TransactionSettlement | undefined;
        const unhandled = await unhandledRejectionsDuring(async () => {
          transaction = await settlementOf(
            store.transactionWithReceipt(
              openingOnReturn(callbackReturned, async (tx) => {
                late = statusOf(
                  tx.nodes.HzItem.bulkHardDelete([
                    asNodeId("s1"),
                    asNodeId("s2"),
                  ]),
                );
                await rowsDeleted.opened;
              }),
            ),
          );
          await late;
        });
        const untouched = {
          items: ["s1", "s2", "s3"],
          claims: { s1: 1, s2: 1 },
          unhandled: [],
        };
        expectOnLane(
          context,
          acceptedOr(
            {
              transaction,
              late: await late,
              items: await ids(() => store.nodes.HzItem.find()),
              claims: await liveClaims(context.getBackend(), graph.id, [
                "s1",
                "s2",
              ]),
              unhandled,
            },
            [
              {
                transaction: { status: "fulfilled", receiptTotal: 2 },
                late: "fulfilled",
                items: ["s3"],
                claims: { s1: 0, s2: 0 },
                unhandled: [],
              },
              {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "rejected",
                ...untouched,
              },
              {
                transaction: { status: "rejected" },
                late: "rejected",
                ...untouched,
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 2c",
              on: { driver: ["postgres-js"] },
              today: {
                transaction: { status: "fulfilled", receiptTotal: 0 },
                late: "rejected",
                items: ["s3"],
                claims: { s1: 0, s2: 0 },
                unhandled: [],
              },
            },
          ],
        );
      });

      it("never lands in the next transaction on the connection", async () => {
        const graph = buildGraph();
        const firstReturned = createGate();
        const secondSubmitted = createGate();
        let armed = true;
        const gated = gatedBackend(context.getBackend(), {
          after: {
            lockSchemaVersionForWrite: async () => {
              if (!armed) return;
              armed = false;
              await secondSubmitted.opened;
            },
          },
        });
        const [store] = await createStoreWithSchema(graph, gated.backend);
        let late: Promise<Status> = Promise.resolve("rejected");
        const first = statusOf(
          store.transaction(
            openingOnReturn(firstReturned, (tx) => {
              late = statusOf(
                tx.nodes.HzItem.bulkCreate([
                  { props: { label: "n1" }, id: "n1" },
                  { props: { label: "n2" }, id: "n2" },
                ]),
              );
              return Promise.resolve();
            }),
          ),
        );
        // The second transaction is asked for as soon as the first callback
        // returns, whether or not the first transaction has settled; the late
        // call resumes only once it has been asked for.
        await firstReturned.opened;
        const abort = new Error("the second transaction rolls back");
        let seenInSecond: readonly string[] | undefined;
        const second = store.transaction(async (tx) => {
          await late;
          seenInSecond = await ids(() => tx.nodes.HzItem.find());
          throw abort;
        });
        secondSubmitted.open();
        await expect(second).rejects.toBe(abort);
        // Where the late call's rows landed: seen by the second transaction
        // and gone after its rollback means they were written inside it.
        expectOnLane(
          context,
          acceptedOr(
            {
              first: await first,
              late: await late,
              seenInSecond,
              items: await ids(() => store.nodes.HzItem.find()),
            },
            [
              {
                first: "fulfilled",
                late: "rejected",
                seenInSecond: [],
                items: [],
              },
              {
                first: "fulfilled",
                late: "fulfilled",
                seenInSecond: ["n1", "n2"],
                items: ["n1", "n2"],
              },
              {
                first: "rejected",
                late: "rejected",
                seenInSecond: [],
                items: [],
              },
            ],
          ),
          ACCEPTED,
        );
      });
    });

    describe("a call re-entered from a hook", () => {
      it("never reports a write that merge apply's rollback removed", async () => {
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
        expectOnLane(
          context,
          acceptedOr(
            {
              apply,
              child: await child,
              notes: await countOf(() => target.nodes.HzNote.find()),
              items: await ids(() => target.nodes.HzItem.find()),
            },
            [
              { apply: "rejected", child: "rejected", notes: 0, items: [] },
              { apply: "rejected", child: "fulfilled", notes: 1, items: [] },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 3a",
              on: ON_EVERY_DRIVER,
              today: {
                apply: "rejected",
                child: "fulfilled",
                notes: 0,
                items: [],
              },
            },
          ],
        );
      });

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

      it("applies both of two bulkHardDelete units one hook starts at once", async () => {
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
        expectOnLane(
          context,
          {
            ...result,
            receiptTotal: receipt.writes.total,
            items: await ids(() => store.nodes.HzItem.find()),
            claims: await liveClaims(context.getBackend(), graph.id, [
              "s1",
              "s2",
            ]),
            notes: await countOf(() => store.nodes.HzNote.find()),
          },
          {
            note: "fulfilled",
            children: ["fulfilled", "fulfilled"],
            receiptTotal: 3,
            items: [],
            claims: { s1: 0, s2: 0 },
            notes: 1,
          },
          [
            {
              label: "hazard 3c",
              on: { driver: ["postgres-js"] },
              today: {
                note: "fulfilled",
                children: ["rejected", "rejected"],
                receiptTotal: 1,
                items: ["s1", "s2"],
                claims: { s1: 1, s2: 1 },
                notes: 0,
              },
            },
          ],
        );
      });

      it("never reports a sibling write that a failing bulkHardDelete's rollback removed", async () => {
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
        expectOnLane(
          context,
          acceptedOr(
            {
              ...result,
              notes: await ids(() => store.nodes.HzNote.find()),
              items: await ids(() => store.nodes.HzItem.find()),
            },
            [
              {
                unit: "rejected",
                sibling: "fulfilled",
                notes: ["sibling"],
                items: ["s1"],
              },
              {
                unit: "rejected",
                sibling: "rejected",
                notes: [],
                items: ["s1"],
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 3d",
              on: ON_EVERY_DRIVER,
              today: {
                unit: "rejected",
                sibling: "fulfilled",
                notes: [],
                items: ["s1"],
              },
            },
          ],
        );
      });
    });

    describe("two bindings of one native transaction", () => {
      it("leaves no recorded row or receipt for a history write a plain binding's savepoint rolled back", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [plain] = await createAdapterStoreWithSchema(graph, backend);
        const [history] = await createAdapterStoreWithSchema(graph, backend, {
          history: true,
        });
        const statements = savepointStatements(backend);
        const outcome = await backend.transactionWithNative((_target, native) =>
          history.withRecordedTransaction(native, async (tx) =>
            statusOf(
              runRecordedTransactionSavepoint(
                enterOperation(
                  openTransactionSession(
                    transactionBackend(plain.withTransaction(native)),
                  ),
                ).backend,
                statements,
                "hazard_plain_unit",
                async () => {
                  await tx.nodes.HzItem.create({ label: "h1" }, { id: "h1" });
                  throw new Error("the plain binding's unit fails");
                },
              ),
            ),
          ),
        );
        expectOnLane(
          context,
          {
            unit: outcome.result,
            receiptTotal: outcome.receipt.writes.total,
            receiptRecorded: outcome.receipt.recorded !== undefined,
            live: await countRows(backend, "nodes", graph.id),
            recorded: await countRows(backend, "recordedNodes", graph.id),
          },
          {
            unit: "rejected",
            receiptTotal: 0,
            receiptRecorded: false,
            live: 0,
            recorded: 0,
          },
          [
            {
              label: "hazard 4a",
              on: ON_EVERY_DRIVER,
              today: {
                unit: "rejected",
                receiptTotal: 1,
                receiptRecorded: true,
                live: 0,
                recorded: 1,
              },
            },
          ],
        );
      });

      it("never reports a plain binding's write that a history binding's savepoint rolled back", async () => {
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
                enterOperation(openTransactionSession(transactionBackend(tx)))
                  .backend,
                statements,
                "hazard_history_unit",
                async () => {
                  plainWrite = await statusOf(
                    plainTx.nodes.HzItem.create({ label: "p1" }, { id: "p1" }),
                  );
                  throw new Error("the history binding's unit fails");
                },
              ),
            ),
          );
        });
        expectOnLane(
          context,
          acceptedOr(
            { plainWrite, items: await ids(() => plain.nodes.HzItem.find()) },
            [
              { plainWrite: "fulfilled", items: ["p1"] },
              { plainWrite: "rejected", items: [] },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 4a",
              on: ON_EVERY_DRIVER,
              today: { plainWrite: "fulfilled", items: [] },
            },
          ],
        );
      });

      async function withTransactionStore(
        run: (store: ItemCreatorWithTransaction) => Promise<void>,
      ): Promise<readonly string[]> {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [setup] = await createAdapterStoreWithSchema(graph, backend);
        await setup.nodes.HzItem.create({ label: "taken" }, { id: "taken" });
        await backend.transactionWithNative(async (_target, native) => {
          const [store] = await createAdapterStoreWithSchema(
            graph,
            createPostgresBackend(native as never) as AdapterBackend<unknown>,
          );
          await run(store as unknown as ItemCreatorWithTransaction);
        });
        return ids(() => setup.nodes.HzItem.find());
      }

      // SQLite has no factory for a backend over a caller's transaction.
      describe.runIf(POSTGRES_DRIVERS.includes(context.driver))(
        "a Store over createPostgresTransactionBackend",
        () => {
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

          it("commits a create that succeeded beside an overlapping create that failed", async () => {
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
            expectOnLane(
              context,
              { creates, items },
              { creates: ["fulfilled", "rejected"], items: ["c", "taken"] },
              [
                {
                  label: "hazard 4b",
                  on: ON_POSTGRES_DRIVERS,
                  today: {
                    creates: ["fulfilled", "rejected"],
                    items: ["taken"],
                  },
                },
              ],
            );
          });

          it("commits a create that overlapped a nested store.transaction() that rolled back", async () => {
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
            expectOnLane(
              context,
              { outcomes, items },
              { outcomes: ["rejected", "fulfilled"], items: ["f", "taken"] },
              [
                {
                  label: "hazard 4c",
                  on: ON_POSTGRES_DRIVERS,
                  today: {
                    outcomes: ["rejected", "fulfilled"],
                    items: ["taken"],
                  },
                },
              ],
            );
          });
        },
      );
    });

    describe("an adopted callback inside another binding's savepoint", () => {
      it("withRecordedTransaction never returns a receipt for writes the savepoint rolled back", async () => {
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
              enterOperation(
                openTransactionSession(
                  transactionBackend(plain.withTransaction(native)),
                ),
              ).backend,
              statements,
              "hazard_plain_unit",
              async () => {
                adopted = await history
                  .withRecordedTransaction(native, async (tx) => {
                    await tx.nodes.HzItem.create({ label: "r1" }, { id: "r1" });
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
        expectOnLane(
          context,
          acceptedOr(
            {
              adopted,
              live: await countRows(backend, "nodes", graph.id),
              recorded: await countRows(backend, "recordedNodes", graph.id),
            },
            [
              { adopted: { status: "rejected" }, live: 0, recorded: 0 },
              {
                adopted: { status: "fulfilled", receiptTotal: 1 },
                live: 1,
                recorded: 1,
              },
            ],
          ),
          ACCEPTED,
          [
            {
              label: "hazard 5",
              on: ON_EVERY_DRIVER,
              today: {
                adopted: { status: "fulfilled", receiptTotal: 1 },
                live: 0,
                recorded: 0,
              },
            },
          ],
        );
      });

      // The evolved receipt is provisional until the caller commits
      // (graph-extensions.md, `EvolvedTransactionOutcome`), and this caller
      // rolls the containing savepoint back: success followed by the original
      // version is the documented contract, not a defect. What the contract
      // does promise is that nothing of the rolled-back version survives and
      // `refreshSchema` refuses to treat the provisional version as committed.
      // libSQL has no adopted schema write transaction and refuses the call.
      it("withEvolvedTransaction's provisional schema version does not survive the savepoint's rollback", async () => {
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
        let evolved:
          | Readonly<{ receiptVersion: number; result: string }>
          | Refusal
          | undefined;
        await backend.transactionWithNative((_target, native) =>
          statusOf(
            runRecordedTransactionSavepoint(
              enterOperation(
                openTransactionSession(
                  transactionBackend(plain.withTransaction(native)),
                ),
              ).backend,
              statements,
              "hazard_plain_unit",
              async () => {
                evolved = await adopter
                  .withEvolvedTransaction(native, plan, () =>
                    Promise.resolve("evolved"),
                  )
                  .then(
                    (outcome) => ({
                      receiptVersion: outcome.receipt.schema.version,
                      result: outcome.result,
                    }),
                    (error: unknown) => typedErrorOf(error),
                  );
                throw new Error("the plain binding's unit fails");
              },
            ),
          ),
        );
        expect({
          evolved,
          version: await activeSchemaVersion(backend, graph.id),
          refresh: await refusalOf(
            plain.refreshSchema({ minVersion: plan.result.version }),
          ),
        }).toEqual({
          evolved:
            context.driver === "libsql" ?
              {
                error: "UnsupportedBackendCapabilityError",
                code: "UNSUPPORTED_BACKEND_CAPABILITY",
                details: { capability: "adoptSchemaWriteTransaction" },
              }
            : { receiptVersion: plan.result.version, result: "evolved" },
          version: plan.result.version - 1,
          refresh: {
            error: "ConfigurationError",
            code: "CONFIGURATION_ERROR",
            details: { code: "SCHEMA_REFRESH_VERSION_UNAVAILABLE" },
          },
        });
      });
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
          refusalOf(tx.nodes.HzItem.bulkHardDelete([asNodeId("s1")])),
        );
        expect({
          attempt,
          rowWrites: gated.calls.filter((member) =>
            member.startsWith("hardDelete"),
          ),
          items: await ids(() => store.nodes.HzItem.find()),
        }).toEqual({
          attempt: STATEMENT_EXECUTION_REFUSAL,
          rowWrites: [],
          items: ["s1"],
        });
      });

      it("bulkHardDelete keeps nothing of a failure after its first write when the root lacks it", async () => {
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
        expectOnLane(
          context,
          {
            attempt,
            items: await ids(() => setup.nodes.HzItem.find()),
            claims: await liveClaims(backend, graph.id, ["s1", "s2"]),
          },
          {
            attempt: "rejected",
            items: ["s1", "s2"],
            claims: { s1: 1, s2: 1 },
          },
          [
            {
              label: "hazard 6b",
              on: ON_EVERY_DRIVER,
              today: {
                attempt: "rejected",
                items: [],
                claims: { s1: 0, s2: 0 },
              },
            },
          ],
        );
      });

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
          refusalOf(applyMergePlanInTransaction(target, tx, artifact)),
        );
        expect({
          apply,
          calls: gated.calls,
          items: await ids(() => target.nodes.HzItem.find()),
        }).toEqual({
          apply: {
            error: "MergeError",
            code: "GRAPH_MERGE_ERROR",
            details: {},
            cause: STATEMENT_EXECUTION_REFUSAL,
          },
          calls: [],
          items: [],
        });
      });
    });

    describe("deferred execution", () => {
      // Each stream page is a fresh query on the transaction (cursor
      // pagination, queries/execute.md "Batch Size"), so a page read after
      // the transaction's own delete sees that delete, and a later rollback
      // cannot change pages already delivered. The stream promises no
      // snapshot: this pins the read-your-writes page it does promise.
      it("a stream advanced during a bulkHardDelete reads the transaction's own delete, which then rolls back", async () => {
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
          claims: await liveClaims(context.getBackend(), graph.id, ["s2"]),
        }).toEqual({
          unit: "rejected",
          yielded: ["s1", "s3"],
          items: ["s1", "s2", "s3"],
          claims: { s2: 1 },
        });
      });

      it("a prepared query and a stream kept past their callback never read a later transaction's writes", async () => {
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
        expectOnLane(
          context,
          { sawUncommittedRow: seen.includes("x1") },
          { sawUncommittedRow: false },
        );
      });
    });

    describe("a transaction's view once the transaction ends", () => {
      // The Store seals its own collections when the callback returns, so a
      // kept collection is refused before it reaches the backend; a kept
      // transaction backend, prepared query or stream reaches the view.
      it("refuses a kept transaction backend, prepared query and stream with TransactionClosedError", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [store] = await createStoreWithSchema(graph, backend);
        await store.nodes.HzItem.bulkCreate([
          { props: { label: "s1" }, id: "s1" },
          { props: { label: "s2" }, id: "s2" },
        ]);
        const kept = await store.transaction(async (tx) => {
          const query = () =>
            tx
              .query()
              .from("HzItem", "item")
              .select((select) => select.item.id)
              .orderBy("item", "id");
          const stream = query()
            .stream({ batchSize: 1 })
            [Symbol.asyncIterator]();
          await stream.next();
          return { prepared: query().prepare(), stream };
        });
        let escaped: TransactionBackend | undefined;
        await backend.transaction((tx) => {
          escaped = tx;
          return Promise.resolve();
        });
        expect({
          backend: await refusalOf(
            requireDefined(escaped).getNode(graph.id, "HzItem", "s1"),
          ),
          prepared: await refusalOf(kept.prepared.execute()),
          stream: await refusalOf(kept.stream.next()),
        }).toEqual({
          backend: TRANSACTION_CLOSED,
          prepared: TRANSACTION_CLOSED,
          stream: TRANSACTION_CLOSED,
        });
      });

      it("refuses a kept trusted-import session's batches once its import committed or rolled back", async () => {
        const backend = context.getBackend();
        const trustedImport = backend.trustedImport;
        expect({
          driver: context.driver,
          trustedImport: trustedImport !== undefined,
        }).toEqual({
          driver: context.driver,
          trustedImport: TRUSTED_IMPORT_DRIVERS.has(context.driver),
        });
        if (trustedImport === undefined) return;
        const graphId = buildGraph().id;

        const committed = await trustedImport((session) =>
          Promise.resolve(session),
        );
        const abort = new Error("abort the import");
        let rolledBack: TrustedImportSession | undefined;
        await expect(
          trustedImport((session) => {
            rolledBack = session;
            return Promise.reject(abort);
          }),
        ).rejects.toBe(abort);
        const kept = requireDefined(rolledBack);

        const afterCommit = await refusalOf(
          committed.insertNodes([importedNode(graphId, "after-commit")]),
        );
        const edgeAfterCommit = await refusalOf(
          committed.insertEdges([importedEdge(graphId, "after-commit")]),
        );
        const afterRollback = await refusalOf(
          kept.insertNodes([importedNode(graphId, "after-rollback")]),
        );
        // An empty batch issues no statement, and is refused all the same.
        const emptyAfterCommit = await refusalOf(committed.insertNodes([]));
        const emptyEdgesAfterRollback = await refusalOf(kept.insertEdges([]));
        // Issued while the next transaction on the connection is open, a late
        // batch must not join that transaction either.
        let insideNext: Refusal | undefined;
        await backend.transaction(async () => {
          insideNext = await refusalOf(
            kept.insertEdges([importedEdge(graphId, "inside-next")]),
          );
        });
        expect({
          afterCommit,
          edgeAfterCommit,
          afterRollback,
          emptyAfterCommit,
          emptyEdgesAfterRollback,
          insideNext,
          nodes: await countRows(backend, "nodes", graphId),
          edges: await countRows(backend, "edges", graphId),
        }).toEqual({
          afterCommit: TRANSACTION_CLOSED,
          edgeAfterCommit: TRANSACTION_CLOSED,
          afterRollback: TRANSACTION_CLOSED,
          emptyAfterCommit: TRANSACTION_CLOSED,
          emptyEdgesAfterRollback: TRANSACTION_CLOSED,
          insideNext: TRANSACTION_CLOSED,
          nodes: 0,
          edges: 0,
        });
      });

      // A callback that keeps its backend and then fails, whichever way it
      // fails: a synchronous throw from the call itself, or a rejection. The
      // runner rolls back either way, and the kept backend's next write must
      // be refused rather than reach the connection after that ROLLBACK, in
      // autocommit.
      it.each([
        ["throws synchronously", "sync"],
        ["rejects", "async"],
      ] as const)(
        "refuses a kept backend's write once a callback that %s rolled its transaction back, on every runner",
        async (_failure, mode) => {
          const backend = context.getBackend();
          const graphId = buildGraph().id;
          const abort = new Error("the callback fails");
          /** Keeps its argument, then fails the way this case says. */
          function failingCallback<TKept>(
            keep: (kept: TKept) => void,
          ): (kept: TKept) => Promise<never> {
            return (kept) => {
              keep(kept);
              if (mode === "sync") throw abort;
              return Promise.reject(abort);
            };
          }
          const outcomes: Record<string, Refusal> = {};
          const lateWrites: Record<string, Refusal> = {};

          // First: trusted import refuses a database that already holds a row.
          const trustedImport = backend.trustedImport;
          if (trustedImport !== undefined) {
            let session: TrustedImportSession | undefined;
            outcomes["trustedImport"] = await refusalOf(
              trustedImport(
                failingCallback<TrustedImportSession>((kept) => {
                  session = kept;
                }),
              ),
            );
            lateWrites["trustedImport"] = await refusalOf(
              requireDefined(session).insertNodes([
                importedNode(graphId, "after-import"),
              ]),
            );
          }

          let transactionBackend: TransactionBackend | undefined;
          outcomes["transaction"] = await refusalOf(
            backend.transaction(
              failingCallback<TransactionBackend>((kept) => {
                transactionBackend = kept;
              }),
            ),
          );
          lateWrites["transaction"] = await refusalOf(
            requireDefined(transactionBackend).insertNode(
              importedNode(graphId, "after-transaction"),
            ),
          );

          const schemaWriteTransaction = backend.schemaWriteTransaction;
          if (schemaWriteTransaction !== undefined) {
            let schemaWriteBackend: TransactionBackend | undefined;
            outcomes["schemaWriteTransaction"] = await refusalOf(
              schemaWriteTransaction(
                graphId,
                failingCallback<TransactionBackend>((kept) => {
                  schemaWriteBackend = kept;
                }),
              ),
            );
            lateWrites["schemaWriteTransaction"] = await refusalOf(
              requireDefined(schemaWriteBackend).insertNode(
                importedNode(graphId, "after-schema-write"),
              ),
            );
          }

          const runners = Object.keys(outcomes);
          expect({
            outcomes,
            lateWrites,
            nodes: await countRows(backend, "nodes", graphId),
          }).toEqual({
            outcomes: Object.fromEntries(
              runners.map((runner) => [runner, String(abort)]),
            ),
            lateWrites: Object.fromEntries(
              runners.map((runner) => [runner, TRANSACTION_CLOSED]),
            ),
            nodes: 0,
          });
        },
      );

      it("commits a trusted-import batch still in flight when its callback returns", async () => {
        const backend = context.getBackend();
        const trustedImport = backend.trustedImport;
        if (trustedImport === undefined) return;
        const graphId = buildGraph().id;
        let inFlight: Promise<Status> = Promise.resolve("rejected");
        await trustedImport((session) => {
          inFlight = statusOf(
            session.insertNodes([importedNode(graphId, "in-flight")]),
          );
          return Promise.resolve();
        });
        expect({
          inFlight: await inFlight,
          nodes: await countRows(backend, "nodes", graphId),
        }).toEqual({ inFlight: "fulfilled", nodes: 1 });
      });

      // The import runs on a traced connection of its own, so the order in
      // which its statements reach the pinned client is observable. On
      // node-postgres the trace records each statement as it is handed to the
      // client, so a batch that skipped the transaction's queue would show
      // before the release; postgres-js records a statement as it is written
      // to the wire, and holds each until the previous one completed, so
      // there only the order is observable.
      it.each([
        ["ROLLBACK, so none lands", "ROLLBACK"],
        ["COMMIT, so both land", "COMMIT"],
      ] as const)(
        "settles every trusted-import batch the callback left running before its %s",
        async (_outcome, frameEnd) => {
          const backend = context.getBackend();
          if (!HELD_STATEMENT_DRIVERS.has(context.driver)) return;
          const graphId = buildGraph().id;
          const traced = await context.openTracedConnection([
            prefixedTableNames(`hz_held_import_${graphCounter}`),
          ]);
          const importBackend = requireDefined(traced.backends[0]);
          const trustedImport = requireDefined(importBackend.trustedImport);
          const removeTrigger = await installHeldInsertTrigger(
            importBackend,
            graphId,
          );
          const holding = createGate();
          const release = createGate();
          // Another session holds the lock the trigger waits for, so the first
          // batch stays on the wire until the test releases it.
          const holder = backend.transaction(async (tx) => {
            await tx.execute(
              asCompiledRowsSql(
                sql`SELECT pg_advisory_xact_lock(${HELD_INSERT_LOCK_KEY})`,
              ),
            );
            holding.open();
            await release.opened;
          });
          try {
            await holding.opened;
            traced.reset();
            const abort = new Error("abort the import");
            let held: Promise<Status> = Promise.resolve("rejected");
            let queued: Promise<Status> = Promise.resolve("rejected");
            let callbackReturned = false;
            const imported = statusOf(
              trustedImport((session) => {
                held = statusOf(
                  session.insertNodes([importedNode(graphId, HELD_INSERT_ID)]),
                );
                // Queued behind the held batch on the transaction's statement
                // queue: without the queue it would reach the client while the
                // held batch is on the wire, and without the drain after the
                // ROLLBACK, in autocommit.
                queued = statusOf(
                  session.insertNodes([importedNode(graphId, "queued")]),
                );
                callbackReturned = true;
                return frameEnd === "ROLLBACK" ?
                    Promise.reject(abort)
                  : Promise.resolve();
              }),
            );
            // Wait until the callback has rejected and the held batch has
            // reached the client: the import cannot settle while it is held.
            await waitUntil(
              () =>
                callbackReturned &&
                importStatementsOf(traced.statements(), graphId).length > 0,
            );
            const settledWhileHeld = await hasSettled(imported);
            const reachedBeforeRelease = importStatementsOf(
              traced.statements(),
              graphId,
            );
            release.open();
            await holder;
            const importOutcome = await imported;
            expect({
              settledWhileHeld,
              reachedBeforeRelease,
              reached: importStatementsOf(traced.statements(), graphId),
              imported: importOutcome,
              held: await held,
              queued: await queued,
              nodes: await countRows(importBackend, "nodes", graphId),
            }).toEqual({
              settledWhileHeld: false,
              reachedBeforeRelease: [`insert ${HELD_INSERT_ID}`],
              reached: [`insert ${HELD_INSERT_ID}`, "insert queued", frameEnd],
              imported: frameEnd === "ROLLBACK" ? "rejected" : "fulfilled",
              held: "fulfilled",
              queued: "fulfilled",
              nodes: frameEnd === "ROLLBACK" ? 0 : 2,
            });
          } finally {
            release.open();
            await holder;
            await removeTrigger();
            await traced.close();
          }
        },
      );

      it("refuses a write the callback issues after the engine ended its transaction, and saves nothing", async () => {
        const graph = buildGraph();
        const backend = context.getBackend();
        const [store] = await createStoreWithSchema(graph, backend);
        const removeTrigger = await installEngineRollbackTrigger(
          backend,
          graph.id,
        );
        try {
          let failed: Refusal | undefined;
          let later: Refusal | undefined;
          const transaction = await refusalOf(
            store.transaction(async (tx) => {
              await tx.nodes.HzItem.create({ label: "first" }, { id: "first" });
              // The callback catches the statement's failure and carries on.
              failed = await refusalOf(
                tx.nodes.HzItem.create(
                  { label: ENGINE_ROLLBACK_ID },
                  { id: ENGINE_ROLLBACK_ID },
                ),
              );
              later = await refusalOf(
                tx.nodes.HzItem.create({ label: "later" }, { id: "later" }),
              );
            }),
          );
          expect({
            failed: failed !== undefined && !isFulfilled(failed),
            later: typedOutcome(later),
            transaction: typedOutcome(transaction),
            nodes: await countRows(backend, "nodes", graph.id),
          }).toEqual({
            failed: true,
            later: ENGINE_ROLLBACK_LATER_REFUSAL[context.driver],
            transaction: "TransactionRolledBackError",
            nodes: 0,
          });
        } finally {
          await removeTrigger();
        }
      });

      it("refuses a sibling write submitted in the same turn as the failure that ended its transaction, and saves nothing", async () => {
        const graphId = buildGraph().id;
        const backend = context.getBackend();
        const removeTrigger = await installEngineRollbackTrigger(
          backend,
          graphId,
        );
        try {
          const statements: Record<string, Promise<Refusal>> = {};
          const transaction = await refusalOf(
            backend.transaction(async (tx) => {
              await tx.insertNode(importedNode(graphId, "first"));
              // Both submitted before either settles.
              statements["failing"] = refusalOf(
                tx.insertNode(importedNode(graphId, ENGINE_ROLLBACK_ID)),
              );
              statements["sibling"] = refusalOf(
                tx.insertNode(importedNode(graphId, "sibling")),
              );
              await Promise.all(Object.values(statements));
            }),
          );
          const sibling = await requireDefined(statements["sibling"]);
          expect({
            failed: !isFulfilled(await requireDefined(statements["failing"])),
            sibling: typedOutcome(sibling),
            transaction: isFulfilled(transaction) ? "fulfilled" : "rejected",
            nodes: await countRows(backend, "nodes", graphId),
          }).toEqual({
            failed: true,
            sibling: ENGINE_ROLLBACK_LATER_REFUSAL[context.driver],
            transaction: "rejected",
            nodes: 0,
          });
        } finally {
          await removeTrigger();
        }
      });

      it("refuses vector index creation through a transaction backend, open or ended, and creates no storage", async () => {
        const handle = await context.createSerializedBackend();
        try {
          const backend = handle.backend;
          const strategy = backend.vectorStrategy;
          expect({
            driver: context.driver,
            vector: strategy !== undefined,
          }).toEqual({
            driver: context.driver,
            vector: VECTOR_DRIVERS.has(context.driver),
          });
          if (strategy === undefined) return;
          const graph = buildGraph();
          await createStoreWithSchema(graph, backend);
          // A slot no schema declares, so nothing has materialized it.
          const params = {
            graphId: graph.id,
            nodeKind: "HzUndeclared",
            fieldPath: "embedding",
            dimensions: 3,
            metric: "cosine",
            indexType:
              requireDefined(backend.capabilities.vector).indexTypes[0] ??
              "none",
          } as const;
          let escaped: TransactionBackend | undefined;
          const whileOpen = await backend.transaction((tx) => {
            escaped = tx;
            return refusalOf(requireDefined(tx.createVectorIndex)(params));
          });
          const afterEnd = await refusalOf(
            requireDefined(requireDefined(escaped).createVectorIndex)(params),
          );
          expect({
            whileOpen,
            afterEnd,
            storage: await relationExists(
              backend,
              strategy.tableName(graph.id, params.nodeKind, params.fieldPath),
            ),
          }).toEqual({
            whileOpen: VECTOR_INDEX_ADMINISTRATION_REFUSAL,
            afterEnd: VECTOR_INDEX_ADMINISTRATION_REFUSAL,
            storage: false,
          });
        } finally {
          await handle.close();
        }
      });
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
