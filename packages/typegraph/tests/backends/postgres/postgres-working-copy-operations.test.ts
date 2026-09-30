/**
 * Durable operations on the bundled PostgreSQL working-copy manager: every
 * clause of the `DurableOperationCapability` contract against a real database,
 * with the coordinate assertions repeated across the three base-version modes
 * (recorded-time capture, revision tracking only, content fingerprint).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import {
  ALLOCATION_LOCK_TRANSACTION_OPTIONS,
  lockAllocation,
  WORKING_COPY_ISOLATION_UNSUPPORTED,
} from "../../../src/backend/drizzle/postgres-working-copy-lock";
import { operationEvidenceTableName } from "../../../src/backend/drizzle/postgres-working-copy-operations";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import {
  createPostgresWorkingCopyManager,
  type PostgresWorkingCopyOperations,
} from "../../../src/backend/postgres/working-copy";
import type { GraphBackend } from "../../../src/backend/types";
import { ConfigurationError } from "../../../src/errors";
import {
  branchDurable,
  computeBaseVersion,
  destroyDurableBranch,
  type DurableBranchDescriptor,
  durableBranchHasUndeliveredEvidence,
  DurableEvidenceUndeliveredError,
  DurableOperationConflictError,
  DurableOperationError,
  DurableOperationRequestError,
  getDurableOperation,
  markDurableOperationDelivered,
  operateDurableBranch,
  scanDurableOperations,
} from "../../../src/graph-merge";
import { BranchError } from "../../../src/graph-merge/errors";
import { isErr, type Result, unwrap } from "../../../src/graph-merge/result";
import { asBaseVersion, asBranchId } from "../../../src/graph-merge/types";
import { renderPostgres } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { recordedGraphWriteAdvisoryLockSql } from "../../../src/store/recorded-capture/clock";
import { createStoreWithSchema, type Store } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
const LEDGER = "typegraph_working_copy_allocations";
const CONCURRENT_OPERATION_COUNT = 6;
const SETTLE_WINDOW_MS = 500;
const TEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 20;
const MAX_CAUSE_DEPTH = 12;
// A schema a connected session searches first, ahead of the allocation's own.
const SKEW_SCHEMA = "operations_evidence_skew";
const REPEATABLE_READ_SERVER_DEFAULT = String.raw`-c default_transaction_isolation=repeatable\ read`;

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "postgres-working-copy-operations",
  nodes: { Person: { type: Person } },
  edges: {},
});
type G = typeof graph;

const mutationSchema = z.object({
  kind: z.literal("createPerson"),
  name: z.string(),
  failAfterWrite: z.boolean().optional(),
  holdOn: z.string().optional(),
  delayMs: z.number().optional(),
});
type PersonMutation = Readonly<{
  kind: "createPerson";
  name: string;
  failAfterWrite?: boolean;
  holdOn?: string;
  delayMs?: number;
}>;

type StoreMode = Readonly<{ history?: boolean; revisionTracking?: boolean }>;
const STORE_MODES = [
  { label: "recorded-time capture", mode: { history: true } },
  { label: "revision tracking", mode: { revisionTracking: true } },
  { label: "content fingerprint", mode: {} },
] as const satisfies readonly Readonly<{ label: string; mode: StoreMode }>[];

const TRACKING_STORE_MODES = STORE_MODES.filter(
  ({ mode }) => "history" in mode || "revisionTracking" in mode,
);

function createLatch(): Readonly<{
  promise: Promise<void>;
  release: () => void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    release: () => {
      resolvePromise?.();
    },
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function personMutation(
  name: string,
  extra: Partial<PersonMutation> = {},
): PersonMutation {
  return { kind: "createPerson", name, ...extra };
}

function operation(
  key: string,
  mutation: PersonMutation = personMutation(key),
) {
  return { idempotencyKey: key, metadata: { actor: "host", key }, mutation };
}

/** The error of a refused result; fails the test when the call succeeded. */
function refusalOf(result: Result<unknown, Error>): Error {
  if (!isErr(result)) throw new Error("Expected the call to be refused.");
  return result.error;
}

function population(store: Store<G>): Promise<number> {
  return store.nodes.Person.count();
}

/** Whether a promise is still pending after the settle window. */
async function isStillPending(promise: Promise<unknown>): Promise<boolean> {
  const settled = Symbol("settled");
  const observed = await Promise.race([
    promise.then(
      () => settled,
      () => settled,
    ),
    sleep(SETTLE_WINDOW_MS).then(() => "pending" as const),
  ]);
  return observed === "pending";
}

/** Polls until `condition` holds, failing loudly instead of hanging the suite. */
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + TEST_TIMEOUT_MS / 4;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition never held.");
    await sleep(POLL_INTERVAL_MS);
  }
}

/** The error and every cause beneath it, outermost first. */
function causeChain(error: unknown): readonly unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && chain.length < MAX_CAUSE_DEPTH) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

/** The removed-allocation BranchError anywhere in an error's cause chain. */
function removedAllocationIn(error: unknown): BranchError | undefined {
  return causeChain(error).find(
    (candidate): candidate is BranchError =>
      candidate instanceof BranchError &&
      candidate.message.includes("was destroyed during the operation"),
  );
}

/** The typed isolation refusal anywhere in an error's cause chain. */
function isolationRefusalIn(error: unknown): ConfigurationError | undefined {
  return causeChain(error).find(
    (candidate): candidate is ConfigurationError =>
      candidate instanceof ConfigurationError &&
      candidate.details["code"] === WORKING_COPY_ISOLATION_UNSUPPORTED,
  );
}

/**
 * A wrapper that forgets the requested transaction isolation, as a layer that
 * does not forward `TransactionOptions.isolationLevel` ("if supported") would.
 */
function withoutIsolationOption(backend: GraphBackend): GraphBackend {
  return deriveBackend(backend, {
    transaction: (run, options) => {
      if (options === undefined) return backend.transaction(run);
      const { isolationLevel: _forgotten, ...forwarded } = options;
      return backend.transaction(run, forwarded);
    },
  });
}

/**
 * Runs `beforeRead` once, immediately before the first statement whose rendered
 * SQL satisfies `matches`: a deterministic stand-in for another session
 * committing in the window between two statements of one member.
 */
function beforeFirstStatementMatching(
  matches: (statement: string) => boolean,
  beforeRead: () => Promise<void>,
): (backend: GraphBackend) => GraphBackend {
  let fired = false;
  return (backend) =>
    deriveBackend(backend, {
      execute: async <Row>(query: Parameters<GraphBackend["execute"]>[0]) => {
        if (!fired && matches(renderPostgres(query).sql)) {
          fired = true;
          await beforeRead();
        }
        return backend.execute<Row>(query);
      },
    });
}

function beforeFirstReadOf(
  relation: string,
  beforeRead: () => Promise<void>,
): (backend: GraphBackend) => GraphBackend {
  return beforeFirstStatementMatching(
    (statement) => statement.includes(relation),
    beforeRead,
  );
}

/** Every schema holding a relation of the allocation, by its reserved prefix. */
async function allocationRelationSchemas(
  pool: Pool,
  physicalPrefix: string,
): Promise<readonly string[]> {
  const found = await pool.query<{ schema: string }>(
    "SELECT DISTINCT n.nspname AS schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE starts_with(c.relname::text, $1) ORDER BY 1",
    [physicalPrefix],
  );
  return found.rows.map((row) => row.schema);
}

async function relationNamesIn(
  pool: Pool,
  schema: string,
  prefix: string,
): Promise<readonly string[]> {
  const found = await pool.query<{ name: string }>(
    "SELECT c.relname::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND starts_with(c.relname::text, $2) ORDER BY 1",
    [schema, prefix],
  );
  return found.rows.map((row) => row.name);
}

async function dropRelations(
  pool: Pool,
  schema: string,
  names: readonly string[],
): Promise<void> {
  await pool.query(
    `DROP TABLE ${names.map((name) => `"${schema}"."${name}"`).join(", ")}`,
  );
}

async function ledgerRowCount(
  pool: Pool,
  allocationId: string,
): Promise<number> {
  const found = await pool.query(
    `SELECT 1 FROM ${LEDGER} WHERE allocation_id = $1`,
    [allocationId],
  );
  return found.rowCount ?? 0;
}

async function countRowsIn(
  pool: Pool,
  schema: string,
  table: string,
  where = "true",
): Promise<number> {
  const found = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "${schema}"."${table}" WHERE ${where}`,
  );
  return Number(found.rows[0]?.count);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working-copy durable operations",
  () => {
    let pool: Pool;
    let repeatableReadPool: Pool;
    let skewedPool: Pool;
    const gates = new Map<string, ReturnType<typeof createLatch>>();
    let applyCalls = 0;
    let allocationCounter = 0;
    const SERVER_ISOLATION_DEFAULTS = [
      { label: "default isolation", poolOf: () => pool },
      { label: "repeatable read", poolOf: () => repeatableReadPool },
    ] as const;

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 24 });
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SKEW_SCHEMA}`);
      skewedPool = new Pool({
        connectionString: TEST_DATABASE_URL,
        max: 24,
        options: `-c search_path=${SKEW_SCHEMA},public`,
      });
      repeatableReadPool = new Pool({
        connectionString: TEST_DATABASE_URL,
        max: 24,
        options: REPEATABLE_READ_SERVER_DEFAULT,
      });
    });
    afterAll(async () => {
      await Promise.all([
        pool.end(),
        repeatableReadPool.end(),
        skewedPool.end(),
      ]);
    });

    const hostOperations: PostgresWorkingCopyOperations<G> = {
      graph,
      apply: async (transaction, rawMutation) => {
        applyCalls += 1;
        const mutation = mutationSchema.parse(rawMutation);
        if (mutation.holdOn !== undefined) {
          await gates.get(mutation.holdOn)?.promise;
        }
        if (mutation.delayMs !== undefined) {
          await sleep(mutation.delayMs);
        }
        await transaction.nodes.Person.create({ name: mutation.name });
        if (mutation.failAfterWrite === true) {
          throw new Error("host apply failed");
        }
      },
    };

    /** Counts `connect` calls: a refusal that precedes the connection opens none. */
    const connections = { opened: 0 };

    function createManager(
      withOperations = true,
      connectionPool = pool,
      shape: (backend: GraphBackend) => GraphBackend = (backend) => backend,
      operations: PostgresWorkingCopyOperations<G> = hostOperations,
      connectPool = connectionPool,
    ) {
      const control = shape(createPostgresBackend(drizzle(connectionPool)));
      const manager = createPostgresWorkingCopyManager<G>({
        control,
        cleanupLockTimeoutMs: 30_000,
        connect: (names, allocation) => {
          connections.opened += 1;
          return Promise.resolve(
            shape(
              createPostgresBackend(drizzle(connectPool), {
                tables: createPostgresTables(names),
                ...(allocation === undefined ?
                  {}
                : { vector: allocation.vectorStrategy }),
              }),
            ),
          );
        },
        ...(withOperations ? { operations } : {}),
      });
      return { control, manager };
    }

    async function createBranch(
      mode: StoreMode = {},
      withOperations = true,
      connectionPool = pool,
      connectPool = connectionPool,
    ) {
      const { control, manager } = createManager(
        withOperations,
        connectionPool,
        undefined,
        undefined,
        connectPool,
      );
      const [source] = await createStoreWithSchema(graph, control, {
        ...(mode.history === true ? { history: true } : {}),
        ...(mode.revisionTracking === true ? { revisionTracking: true } : {}),
      });
      allocationCounter += 1;
      const allocationId = `operations-allocation-${allocationCounter}`;
      const branch = unwrap(
        await branchDurable(source, manager.durable, {
          id: asBranchId(`operations-branch-${allocationCounter}`),
          allocationId,
        }),
      );
      return {
        strategy: manager.durable,
        manager,
        source,
        descriptor: branch.descriptor,
        store: branch.branch.store,
        allocationId,
        close: () => branch.branch.close(),
      };
    }

    type EvidenceLocation = Readonly<{
      schema: string;
      physical_prefix: string;
    }>;

    async function evidenceLocationOf(
      allocationId: string,
    ): Promise<EvidenceLocation> {
      const found = await pool.query<EvidenceLocation>(
        `SELECT schema_name AS schema, physical_prefix FROM ${LEDGER} WHERE allocation_id = $1`,
        [allocationId],
      );
      const location = found.rows[0];
      if (location === undefined) throw new Error("Allocation has no row.");
      return location;
    }

    async function evidenceTableOf(allocationId: string): Promise<string> {
      const found = await pool.query<{ physical_prefix: string }>(
        `SELECT physical_prefix FROM ${LEDGER} WHERE allocation_id = $1`,
        [allocationId],
      );
      return `${found.rows[0]?.physical_prefix}op_evidence`;
    }

    async function evidenceRowCount(allocationId: string): Promise<number> {
      const found = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${await evidenceTableOf(allocationId)}"`,
      );
      return Number(found.rows[0]?.count);
    }

    async function relationExists(name: string): Promise<boolean> {
      const found = await pool.query<{ present: string | null }>(
        "SELECT to_regclass($1)::text AS present",
        [`"${name}"`],
      );
      return found.rows[0]?.present !== null;
    }

    describe.each(STORE_MODES)("$label", ({ mode }) => {
      it(
        "applies once, returns undelivered evidence, and mints coordinates equal to the branch's",
        async () => {
          const branch = await createBranch(mode);
          try {
            const before = await computeBaseVersion(branch.store);
            const outcome = unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1", personMutation("Alice")),
              ),
            );
            expect(outcome.outcome).toBe("applied");
            if (outcome.outcome !== "applied") return;
            expect(outcome.evidence.delivered).toBe(false);
            expect(outcome.evidence.metadata).toEqual({
              actor: "host",
              key: "op-1",
            });
            expect(outcome.evidence.before.base).toBe(before);
            expect(outcome.evidence.after.base).not.toBe(before);
            expect(await computeBaseVersion(branch.store)).toBe(
              outcome.evidence.after.base,
            );
            expect(await population(branch.store)).toBe(1);
            expect(await evidenceRowCount(branch.allocationId)).toBe(1);
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "chains coordinates in commit order across concurrent operates",
        async () => {
          const branch = await createBranch(mode);
          try {
            const keys = Array.from(
              { length: CONCURRENT_OPERATION_COUNT },
              (_, index) => `concurrent-${index}`,
            );
            const results = await Promise.all(
              keys.map((key) =>
                operateDurableBranch(
                  branch.descriptor,
                  branch.strategy,
                  operation(key, personMutation(key, { delayMs: 60 })),
                ),
              ),
            );
            for (const result of results) {
              expect(unwrap(result).outcome).toBe("applied");
            }
            const scanned = unwrap(
              await scanDurableOperations(branch.descriptor, branch.strategy),
            );
            expect(scanned.operations).toHaveLength(CONCURRENT_OPERATION_COUNT);
            const afters = scanned.operations
              .slice(0, -1)
              .map((evidence) => evidence.after.base);
            const nextBefores = scanned.operations
              .slice(1)
              .map((evidence) => evidence.before.base);
            expect(afters).toEqual(nextBefores);
            expect(
              new Set(scanned.operations.map((entry) => entry.idempotencyKey)),
            ).toEqual(new Set(keys));
            expect(await population(branch.store)).toBe(
              CONCURRENT_OPERATION_COUNT,
            );
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    it(
      "replays exact evidence without applying again",
      async () => {
        const branch = await createBranch({ revisionTracking: true });
        try {
          const first = unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          const callsAfterFirst = applyCalls;
          const second = unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          expect(second.outcome).toBe("replayed");
          if (
            first.outcome === "unsupported" ||
            second.outcome === "unsupported"
          ) {
            throw new Error("expected evidence outcomes");
          }
          expect(second.evidence).toEqual(first.evidence);
          expect(applyCalls).toBe(callsAfterFirst);
          expect(await population(branch.store)).toBe(1);
          expect(await evidenceRowCount(branch.allocationId)).toBe(1);
        } finally {
          await branch.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "refuses a reused key with a different digest and mutates nothing",
      async () => {
        const branch = await createBranch({ revisionTracking: true });
        try {
          unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1", personMutation("Alice")),
            ),
          );
          const callsAfterFirst = applyCalls;
          const conflicting = await operateDurableBranch(
            branch.descriptor,
            branch.strategy,
            operation("op-1", personMutation("Mallory")),
          );
          const conflictingError = refusalOf(conflicting);
          expect(conflictingError).toBeInstanceOf(
            DurableOperationConflictError,
          );
          expect(applyCalls).toBe(callsAfterFirst);
          expect(await population(branch.store)).toBe(1);
          expect(await evidenceRowCount(branch.allocationId)).toBe(1);
          const stored = unwrap(
            await getDurableOperation(
              branch.descriptor,
              branch.strategy,
              "op-1",
            ),
          );
          expect(stored?.mutation).toEqual(personMutation("Alice"));
        } finally {
          await branch.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "commits neither evidence nor mutation when apply throws",
      async () => {
        const branch = await createBranch({ history: true });
        try {
          const failed = await operateDurableBranch(
            branch.descriptor,
            branch.strategy,
            operation(
              "op-1",
              personMutation("Alice", { failAfterWrite: true }),
            ),
          );
          const failedError = refusalOf(failed);
          expect(failedError).toBeInstanceOf(DurableOperationError);
          expect(failedError.message).toContain("host apply failed");
          expect(await population(branch.store)).toBe(0);
          expect(await evidenceRowCount(branch.allocationId)).toBe(0);
          expect(
            unwrap(
              await getDurableOperation(
                branch.descriptor,
                branch.strategy,
                "op-1",
              ),
            ),
          ).toBeUndefined();
          const retried = unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          expect(retried.outcome).toBe("applied");
        } finally {
          await branch.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "refuses every member for a descriptor whose origin does not match, executing nothing",
      async () => {
        const branch = await createBranch({ revisionTracking: true });
        try {
          unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          const callsBefore = applyCalls;
          const tampered: DurableBranchDescriptor<
            typeof branch.descriptor.store
          > = {
            ...branch.descriptor,
            base: asBaseVersion("wrong-base"),
          };
          const refusals = [
            isErr(
              await operateDurableBranch(
                tampered,
                branch.strategy,
                operation("op-2"),
              ),
            ),
            isErr(await getDurableOperation(tampered, branch.strategy, "op-1")),
            isErr(await scanDurableOperations(tampered, branch.strategy)),
            isErr(
              await markDurableOperationDelivered(
                tampered,
                branch.strategy,
                "op-1",
              ),
            ),
            isErr(
              await durableBranchHasUndeliveredEvidence(
                tampered,
                branch.strategy,
              ),
            ),
          ];
          expect(refusals).toEqual([true, true, true, true, true]);
          expect(applyCalls).toBe(callsBefore);
          expect(await evidenceRowCount(branch.allocationId)).toBe(1);
          const stored = unwrap(
            await getDurableOperation(
              branch.descriptor,
              branch.strategy,
              "op-1",
            ),
          );
          expect(stored?.delivered).toBe(false);
        } finally {
          await branch.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "pages the scan with opaque cursors, echoing the cursor on an empty page",
      async () => {
        const branch = await createBranch({ revisionTracking: true });
        try {
          const initial = unwrap(
            await scanDurableOperations(branch.descriptor, branch.strategy),
          );
          expect(initial).toEqual({ operations: [], hasMore: false });
          for (const key of ["a", "b", "c", "d", "e"]) {
            unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation(key),
              ),
            );
          }
          const first = unwrap(
            await scanDurableOperations(branch.descriptor, branch.strategy, {
              limit: 2,
            }),
          );
          expect(first.operations.map((entry) => entry.idempotencyKey)).toEqual(
            ["a", "b"],
          );
          expect(first.hasMore).toBe(true);
          const second = unwrap(
            await scanDurableOperations(branch.descriptor, branch.strategy, {
              limit: 2,
              after: first.cursor,
            }),
          );
          expect(
            second.operations.map((entry) => entry.idempotencyKey),
          ).toEqual(["c", "d"]);
          expect(second.hasMore).toBe(true);
          const third = unwrap(
            await scanDurableOperations(branch.descriptor, branch.strategy, {
              limit: 2,
              after: second.cursor,
            }),
          );
          expect(third.operations.map((entry) => entry.idempotencyKey)).toEqual(
            ["e"],
          );
          expect(third.hasMore).toBe(false);
          const drained = unwrap(
            await scanDurableOperations(branch.descriptor, branch.strategy, {
              after: third.cursor,
            }),
          );
          expect(drained).toEqual({
            operations: [],
            cursor: third.cursor,
            hasMore: false,
          });
          unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("f"),
            ),
          );
          const resumed = unwrap(
            await scanDurableOperations(branch.descriptor, branch.strategy, {
              after: drained.cursor,
            }),
          );
          expect(
            resumed.operations.map((entry) => entry.idempotencyKey),
          ).toEqual(["f"]);
          const malformed = await scanDurableOperations(
            branch.descriptor,
            branch.strategy,
            {
              after: "not-a-cursor",
            },
          );
          expect(refusalOf(malformed)).toBeInstanceOf(
            DurableOperationRequestError,
          );
        } finally {
          await branch.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "marks delivery idempotently and answers undefined for an unknown key",
      async () => {
        const branch = await createBranch({ revisionTracking: true });
        try {
          unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          expect(
            unwrap(
              await durableBranchHasUndeliveredEvidence(
                branch.descriptor,
                branch.strategy,
              ),
            ),
          ).toBe(true);
          const marked = unwrap(
            await markDurableOperationDelivered(
              branch.descriptor,
              branch.strategy,
              "op-1",
            ),
          );
          expect(marked?.delivered).toBe(true);
          const again = unwrap(
            await markDurableOperationDelivered(
              branch.descriptor,
              branch.strategy,
              "op-1",
            ),
          );
          expect(again).toEqual(marked);
          expect(
            unwrap(
              await markDurableOperationDelivered(
                branch.descriptor,
                branch.strategy,
                "missing",
              ),
            ),
          ).toBeUndefined();
          expect(
            unwrap(
              await durableBranchHasUndeliveredEvidence(
                branch.descriptor,
                branch.strategy,
              ),
            ),
          ).toBe(false);
          const replay = unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          expect(
            replay.outcome === "replayed" && replay.evidence.delivered,
          ).toBe(true);
        } finally {
          await branch.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "refuses destroy while evidence is undelivered, then destroys and drops the evidence relation once delivered",
      async () => {
        const branch = await createBranch({ revisionTracking: true });
        const evidenceTable = await evidenceTableOf(branch.allocationId);
        try {
          unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          const refused = await destroyDurableBranch(
            branch.descriptor,
            branch.strategy,
          );
          expect(refusalOf(refused)).toBeInstanceOf(
            DurableEvidenceUndeliveredError,
          );
          expect(await relationExists(evidenceTable)).toBe(true);
          expect(await evidenceRowCount(branch.allocationId)).toBe(1);

          unwrap(
            await markDurableOperationDelivered(
              branch.descriptor,
              branch.strategy,
              "op-1",
            ),
          );
          await branch.close();
          unwrap(
            await destroyDurableBranch(branch.descriptor, branch.strategy),
          );
          expect(await relationExists(evidenceTable)).toBe(false);
          const ledger = await pool.query(
            `SELECT 1 FROM ${LEDGER} WHERE allocation_id = $1`,
            [branch.allocationId],
          );
          expect(ledger.rowCount).toBe(0);
        } finally {
          await Promise.allSettled([branch.close()]);
        }
      },
      TEST_TIMEOUT_MS,
    );

    describe("when the allocation's relations are removed out of band", () => {
      it(
        "removes an allocation whose relations exist nowhere, evidence relation included",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("gone-op"),
              ),
            );
            const { schema, physical_prefix: prefix } =
              await evidenceLocationOf(branch.allocationId);
            await branch.close();
            await dropRelations(
              pool,
              schema,
              await relationNamesIn(pool, schema, prefix),
            );
            expect(await allocationRelationSchemas(pool, prefix)).toEqual([]);

            unwrap(
              await destroyDurableBranch(branch.descriptor, branch.strategy),
            );
            expect(await ledgerRowCount(pool, branch.allocationId)).toBe(0);
          } finally {
            await Promise.allSettled([branch.close()]);
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "removes the allocation and its remaining relations when only the evidence relation is missing",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            const { schema, physical_prefix: prefix } =
              await evidenceLocationOf(branch.allocationId);
            const evidenceTable = `${prefix}op_evidence`;
            await branch.close();
            await dropRelations(pool, schema, [evidenceTable]);
            expect(
              await relationNamesIn(pool, schema, prefix),
            ).not.toHaveLength(0);

            unwrap(
              await destroyDurableBranch(branch.descriptor, branch.strategy),
            );
            expect(await ledgerRowCount(pool, branch.allocationId)).toBe(0);
            expect(await relationNamesIn(pool, schema, prefix)).toEqual([]);
          } finally {
            await Promise.allSettled([branch.close()]);
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("when connect's pool leads with another schema", () => {
      it.each(TRACKING_STORE_MODES)(
        "provisions, addresses and removes the evidence relation in the allocation schema in $label mode",
        async ({ mode }) => {
          const branch = await createBranch(mode, true, pool, skewedPool);
          const { schema, physical_prefix: prefix } = await evidenceLocationOf(
            branch.allocationId,
          );
          const evidenceTable = `${prefix}op_evidence`;
          // The shadow is what an unqualified statement on the skewed
          // connection would resolve to instead of the allocation's relation.
          await pool.query(
            `CREATE TABLE "${SKEW_SCHEMA}"."${evidenceTable}" (LIKE "${schema}"."${evidenceTable}" INCLUDING ALL)`,
          );
          try {
            expect(schema).not.toBe(SKEW_SCHEMA);
            expect(await allocationRelationSchemas(pool, prefix)).toEqual(
              [schema, SKEW_SCHEMA].toSorted(),
            );

            const outcome = unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("skewed-op"),
              ),
            );
            expect(outcome.outcome).toBe("applied");
            expect(await countRowsIn(pool, schema, evidenceTable)).toBe(1);
            expect(await countRowsIn(pool, SKEW_SCHEMA, evidenceTable)).toBe(0);

            const fetched = unwrap(
              await getDurableOperation(
                branch.descriptor,
                branch.strategy,
                "skewed-op",
              ),
            );
            expect(fetched?.idempotencyKey).toBe("skewed-op");
            expect(
              unwrap(
                await scanDurableOperations(branch.descriptor, branch.strategy),
              ).operations,
            ).toHaveLength(1);
            expect(
              unwrap(
                await durableBranchHasUndeliveredEvidence(
                  branch.descriptor,
                  branch.strategy,
                ),
              ),
            ).toBe(true);

            const delivered = unwrap(
              await markDurableOperationDelivered(
                branch.descriptor,
                branch.strategy,
                "skewed-op",
              ),
            );
            expect(delivered?.delivered).toBe(true);
            expect(
              await countRowsIn(pool, schema, evidenceTable, "delivered"),
            ).toBe(1);

            await branch.close();
            // Allocation-prefixed relations in another schema are the only
            // pointer to data the row's schema does not hold: removal refuses
            // and keeps the row, whatever the skewed connection's path leads with.
            const refused = refusalOf(
              await destroyDurableBranch(branch.descriptor, branch.strategy),
            );
            expect(
              causeChain(refused).some(
                (link) =>
                  link instanceof BranchError &&
                  link.message.includes(`"${SKEW_SCHEMA}"`),
              ),
            ).toBe(true);
            expect(await allocationRelationSchemas(pool, prefix)).toEqual(
              [schema, SKEW_SCHEMA].toSorted(),
            );
            expect(await countRowsIn(pool, schema, evidenceTable)).toBe(1);
            expect(await ledgerRowCount(pool, branch.allocationId)).toBe(1);

            await pool.query(`DROP TABLE "${SKEW_SCHEMA}"."${evidenceTable}"`);
            unwrap(
              await destroyDurableBranch(branch.descriptor, branch.strategy),
            );
            expect(await allocationRelationSchemas(pool, prefix)).toEqual([]);
          } finally {
            await Promise.allSettled([branch.close()]);
            await pool.query(
              `DROP TABLE IF EXISTS "${SKEW_SCHEMA}"."${evidenceTable}"`,
            );
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "refuses an evidence allocation whose row records no schema to resolve it in",
        async () => {
          const branch = await createBranch(
            { revisionTracking: true },
            true,
            pool,
            skewedPool,
          );
          try {
            await pool.query(
              `UPDATE ${LEDGER} SET schema_name = NULL WHERE allocation_id = $1`,
              [branch.allocationId],
            );
            const refusal = refusalOf(
              await getDurableOperation(
                branch.descriptor,
                branch.strategy,
                "any-key",
              ),
            );
            expect(
              causeChain(refusal).some(
                (link) =>
                  link instanceof BranchError &&
                  link.message.includes(
                    "records operation evidence but no schema",
                  ),
              ),
            ).toBe(true);
          } finally {
            await branch.close();
            unwrap(
              await destroyDurableBranch(branch.descriptor, branch.strategy),
            );
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe.each(SERVER_ISOLATION_DEFAULTS)(
      "under a $label server default",
      ({ poolOf }) => {
        it(
          "serializes a concurrent destroy behind an in-flight operate on the allocation lock",
          async () => {
            const branch = await createBranch(
              { revisionTracking: true },
              true,
              poolOf(),
            );
            const gate = createLatch();
            gates.set("gate-destroy", gate);
            try {
              const operating = operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation(
                  "op-1",
                  personMutation("Alice", { holdOn: "gate-destroy" }),
                ),
              );
              await sleep(SETTLE_WINDOW_MS);
              const destroying = destroyDurableBranch(
                branch.descriptor,
                branch.strategy,
              );
              expect(await isStillPending(destroying)).toBe(true);

              gate.release();
              expect(unwrap(await operating).outcome).toBe("applied");
              const settled = await destroying;
              expect(refusalOf(settled)).toBeInstanceOf(
                DurableEvidenceUndeliveredError,
              );
              expect(await population(branch.store)).toBe(1);
              expect(await evidenceRowCount(branch.allocationId)).toBe(1);
            } finally {
              gate.release();
              await branch.close();
            }
          },
          TEST_TIMEOUT_MS,
        );

        it(
          "marks evidence delivered that a concurrent operate commits while the mark waits on the allocation lock",
          async () => {
            const branch = await createBranch(
              { revisionTracking: true },
              true,
              poolOf(),
            );
            const gate = createLatch();
            gates.set("gate-mark", gate);
            try {
              const operating = operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation(
                  "op-1",
                  personMutation("Alice", { holdOn: "gate-mark" }),
                ),
              );
              await sleep(SETTLE_WINDOW_MS);
              const marking = markDurableOperationDelivered(
                branch.descriptor,
                branch.strategy,
                "op-1",
              );
              expect(await isStillPending(marking)).toBe(true);

              gate.release();
              expect(unwrap(await operating).outcome).toBe("applied");
              expect(unwrap(await marking)?.delivered).toBe(true);
            } finally {
              gate.release();
              await branch.close();
            }
          },
          TEST_TIMEOUT_MS,
        );

        it(
          "answers a concurrent operate with the same key as a replay of one application",
          async () => {
            const branch = await createBranch(
              { revisionTracking: true },
              true,
              poolOf(),
            );
            try {
              const callsBefore = applyCalls;
              const outcomes = await Promise.all(
                [0, 1].map(() =>
                  operateDurableBranch(
                    branch.descriptor,
                    branch.strategy,
                    operation(
                      "same-key",
                      personMutation("Alice", { delayMs: 200 }),
                    ),
                  ),
                ),
              );
              expect(
                outcomes.map((outcome) => unwrap(outcome).outcome).toSorted(),
              ).toEqual(["applied", "replayed"]);
              expect(applyCalls - callsBefore).toBe(1);
              expect(await population(branch.store)).toBe(1);
              expect(await evidenceRowCount(branch.allocationId)).toBe(1);
            } finally {
              await branch.close();
            }
          },
          TEST_TIMEOUT_MS,
        );
      },
    );

    it("runs the repeatable-read pool under a repeatable read server default", async () => {
      const shown = await repeatableReadPool.query<{
        default_transaction_isolation: string;
      }>("SHOW default_transaction_isolation");
      expect(shown.rows[0]?.default_transaction_isolation).toBe(
        "repeatable read",
      );
    });

    describe.each(TRACKING_STORE_MODES)(
      "fences the before coordinate in $label mode",
      ({ mode }) => {
        it(
          "holds a direct write to the allocation until the operation commits",
          async () => {
            const branch = await createBranch(mode);
            const gate = createLatch();
            gates.set("gate-direct-write", gate);
            try {
              const operating = operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation(
                  "op-1",
                  personMutation("Alice", { holdOn: "gate-direct-write" }),
                ),
              );
              await sleep(SETTLE_WINDOW_MS);
              const directWrite = branch.store.nodes.Person.create({
                name: "Direct",
              });
              expect(await isStillPending(directWrite)).toBe(true);

              gate.release();
              const outcome = unwrap(await operating);
              await directWrite;
              if (outcome.outcome !== "applied") {
                throw new Error("expected an applied operation");
              }
              expect(await population(branch.store)).toBe(2);
              expect(await computeBaseVersion(branch.store)).not.toBe(
                outcome.evidence.after.base,
              );
            } finally {
              gate.release();
              await branch.close();
            }
          },
          TEST_TIMEOUT_MS,
        );
      },
    );

    it(
      "leaves durable.operations undefined without the option, yet still fences destroy",
      async () => {
        const branch = await createBranch({ revisionTracking: true }, false);
        try {
          expect(branch.strategy.operations).toBeUndefined();
          const evidenceTable = await evidenceTableOf(branch.allocationId);
          await pool.query(
            `INSERT INTO "${evidenceTable}" (idempotency_key, operation_digest, metadata, mutation, before_base, after_base) VALUES ('op-1', 'digest', '{}', '{}', 'a', 'b')`,
          );
          const refused = await destroyDurableBranch(
            branch.descriptor,
            branch.strategy,
          );
          expect(refusalOf(refused)).toBeInstanceOf(
            DurableEvidenceUndeliveredError,
          );
          const unsupported = await operateDurableBranch(
            branch.descriptor,
            branch.strategy,
            operation("op-2"),
          );
          expect(unwrap(unsupported)).toEqual({
            outcome: "unsupported",
            dimensions: ["atomicMutation"],
          });
          expect(
            isErr(
              await getDurableOperation(
                branch.descriptor,
                branch.strategy,
                "op-1",
              ),
            ),
          ).toBe(true);
        } finally {
          await branch.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    describe("a fresh allocation reports the capability", () => {
      it(
        "provisions a durable allocation with an evidence relation and an ephemeral one without",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            const ledger = await pool.query<{
              operation_evidence: boolean;
              state: string;
            }>(
              `SELECT operation_evidence, state FROM ${LEDGER} WHERE allocation_id = $1`,
              [branch.allocationId],
            );
            expect(ledger.rows).toEqual([
              { operation_evidence: true, state: "sealed" },
            ]);
            expect(
              await relationExists(await evidenceTableOf(branch.allocationId)),
            ).toBe(true);
            const outcome = unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            expect(outcome.outcome).toBe("applied");

            const ephemeralBefore = await pool.query<{ allocation_id: string }>(
              `SELECT allocation_id FROM ${LEDGER} WHERE state = 'ephemeral'`,
            );
            const clone = await branch.manager.ephemeral.create(
              branch.source,
              await computeBaseVersion(branch.source),
            );
            try {
              const ephemeral = await pool.query<{
                physical_prefix: string;
                operation_evidence: boolean;
              }>(
                `SELECT physical_prefix, operation_evidence FROM ${LEDGER} WHERE state = 'ephemeral' AND allocation_id <> ALL ($1::text[])`,
                [ephemeralBefore.rows.map((row) => row.allocation_id)],
              );
              expect(ephemeral.rows).toHaveLength(1);
              expect(ephemeral.rows[0]?.operation_evidence).toBe(false);
              expect(
                await relationExists(
                  operationEvidenceTableName(
                    ephemeral.rows[0]?.physical_prefix ?? "",
                  ),
                ),
              ).toBe(false);
            } finally {
              await clone.close();
            }
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("isolation is observed on the session that relies on it", () => {
      it(
        "refuses operate on a session that ignored the requested isolation, applying and writing nothing",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            const { manager: hostile } = createManager(
              true,
              repeatableReadPool,
              withoutIsolationOption,
            );
            const callsBefore = applyCalls;
            const refused = await operateDurableBranch(
              branch.descriptor,
              hostile.durable,
              operation("op-1"),
            );
            const refusal = isolationRefusalIn(refusalOf(refused));
            expect(refusal?.details["observedIsolation"]).toBe(
              "repeatable_read",
            );
            expect(applyCalls).toBe(callsBefore);
            expect(await population(branch.store)).toBe(0);
            expect(await evidenceRowCount(branch.allocationId)).toBe(0);

            const honest = unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            expect(honest.outcome).toBe("applied");
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "refuses markDelivered on such a session instead of answering from a stale snapshot",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            const { manager: hostile } = createManager(
              true,
              repeatableReadPool,
              withoutIsolationOption,
            );
            const refused = await markDurableOperationDelivered(
              branch.descriptor,
              hostile.durable,
              "op-1",
            );
            expect(isolationRefusalIn(refusalOf(refused))).toBeDefined();
            expect(
              unwrap(
                await getDurableOperation(
                  branch.descriptor,
                  branch.strategy,
                  "op-1",
                ),
              )?.delivered,
            ).toBe(false);
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "keeps committed undelivered evidence when a destroy on such a session waits out an in-flight operate",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          const evidenceTable = await evidenceTableOf(branch.allocationId);
          const gate = createLatch();
          gates.set("gate-hostile-destroy", gate);
          try {
            const operating = operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation(
                "op-1",
                personMutation("Alice", { holdOn: "gate-hostile-destroy" }),
              ),
            );
            await sleep(SETTLE_WINDOW_MS);
            const { manager: hostile } = createManager(
              true,
              repeatableReadPool,
              withoutIsolationOption,
            );
            const destroying = destroyDurableBranch(
              branch.descriptor,
              hostile.durable,
            );
            expect(await isStillPending(destroying)).toBe(true);

            gate.release();
            expect(unwrap(await operating).outcome).toBe("applied");
            expect(
              isolationRefusalIn(refusalOf(await destroying)),
            ).toBeDefined();
            expect(await relationExists(evidenceTable)).toBe(true);
            expect(await evidenceRowCount(branch.allocationId)).toBe(1);
            expect(await population(branch.store)).toBe(1);
            const ledger = await pool.query(
              `SELECT 1 FROM ${LEDGER} WHERE allocation_id = $1`,
              [branch.allocationId],
            );
            expect(ledger.rowCount).toBe(1);
          } finally {
            gate.release();
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("an allocation whose drop a wrapper refused", () => {
      /**
       * Every site that drops an allocation on the way out. Each one runs
       * `dropAllocation`, which takes the allocation lock and so refuses a
       * session that is not READ COMMITTED; `discard` and the durable branch's
       * abort after a failed seal swallow the refusal.
       */
      const DROP_SITES = [
        {
          label: "closing an ephemeral working-copy store",
          leave: async (
            hostile: ReturnType<typeof createManager>,
            source: Store<G>,
          ) => {
            const store = await hostile.manager.ephemeral.create(
              source,
              await computeBaseVersion(source),
            );
            await expect(store.close()).rejects.toSatisfy(
              (error) => isolationRefusalIn(error) !== undefined,
            );
          },
        },
        {
          label: "closing a makeBackend backend",
          leave: async (hostile: ReturnType<typeof createManager>) => {
            const backend = await hostile.manager.makeBackend();
            await expect(backend.close()).rejects.toSatisfy(
              (error) => isolationRefusalIn(error) !== undefined,
            );
          },
        },
        {
          label: "discarding an allocation whose setup failed",
          leave: async (
            hostile: ReturnType<typeof createManager>,
            source: Store<G>,
          ) => {
            const setupFailure = new Error("connect failed after provisioning");
            const failing = createPostgresWorkingCopyManager<G>({
              control: hostile.control,
              connect: () => Promise.reject(setupFailure),
            });
            // discardAllocation swallows the refusal: the setup failure wins.
            await expect(
              failing.ephemeral.create(
                source,
                await computeBaseVersion(source),
              ),
            ).rejects.toBe(setupFailure);
          },
        },
        {
          label: "aborting a durable branch whose seal failed",
          leave: async (
            hostile: ReturnType<typeof createManager>,
            source: Store<G>,
          ) => {
            const sealFailure = new Error("seal failed after provisioning");
            allocationCounter += 1;
            const refused = refusalOf(
              await branchDurable(
                source,
                {
                  ...hostile.manager.durable,
                  seal: () => Promise.reject(sealFailure),
                },
                {
                  id: asBranchId(`operations-branch-${allocationCounter}`),
                  allocationId: `operations-allocation-${allocationCounter}`,
                },
              ),
            );
            // abandonAllocation swallows the refusal: the seal failure wins.
            expect(refused.cause).toBe(sealFailure);
            expect(refused).toBeInstanceOf(BranchError);
            expect((refused as BranchError).details["allocationAborted"]).toBe(
              false,
            );
          },
        },
      ] as const;

      it.each(DROP_SITES)(
        "leaves an orphan after $label that listUnsealedAllocations finds and abortAllocation removes",
        async ({ leave }) => {
          const hostile = createManager(
            true,
            repeatableReadPool,
            withoutIsolationOption,
          );
          const honest = createManager();
          for (const orphan of await honest.manager.listUnsealedAllocations()) {
            await honest.manager.abortAllocation(orphan.allocationId);
          }

          const [source] = await createStoreWithSchema(graph, honest.control, {
            revisionTracking: true,
          });

          await leave(hostile, source);

          const orphans = await honest.manager.listUnsealedAllocations();
          expect(orphans).toHaveLength(1);
          const [orphan] = orphans;
          if (orphan === undefined) throw new Error("Missing orphan.");
          const owned = await pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE (SELECT physical_prefix FROM ${LEDGER} WHERE allocation_id = $1) || '%'`,
            [orphan.allocationId],
          );
          expect(Number(owned.rows[0]?.count)).toBeGreaterThan(0);

          await honest.manager.abortAllocation(orphan.allocationId);

          expect(await honest.manager.listUnsealedAllocations()).toEqual([]);
          const remaining = await pool.query(
            `SELECT 1 FROM ${LEDGER} WHERE allocation_id = $1`,
            [orphan.allocationId],
          );
          expect(remaining.rowCount).toBe(0);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("a destroy committing between the sealed-row read and an unlocked evidence read", () => {
      type Branch = Awaited<ReturnType<typeof createBranch>>;
      type Descriptor = Branch["descriptor"];
      type Strategy = Branch["strategy"];
      const UNLOCKED_MEMBERS = [
        {
          label: "get",
          read: (descriptor: Descriptor, strategy: Strategy) =>
            getDurableOperation(descriptor, strategy, "op-1"),
        },
        {
          label: "scan",
          read: (descriptor: Descriptor, strategy: Strategy) =>
            scanDurableOperations(descriptor, strategy),
        },
        {
          label: "hasUndelivered",
          read: (descriptor: Descriptor, strategy: Strategy) =>
            durableBranchHasUndeliveredEvidence(descriptor, strategy),
        },
      ] as const;

      it.each(UNLOCKED_MEMBERS)(
        "fails $label with the removed-allocation BranchError, not a missing-relation error",
        async ({ read }) => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            unwrap(
              await markDurableOperationDelivered(
                branch.descriptor,
                branch.strategy,
                "op-1",
              ),
            );
            await branch.close();
            const evidenceTable = await evidenceTableOf(branch.allocationId);
            const racing = createManager(
              true,
              pool,
              beforeFirstReadOf(evidenceTable, async () => {
                unwrap(
                  await destroyDurableBranch(
                    branch.descriptor,
                    branch.strategy,
                  ),
                );
              }),
            );

            const refused = refusalOf(
              await read(branch.descriptor, racing.manager.durable),
            );

            expect(removedAllocationIn(refused)).toBeDefined();
            expect(await relationExists(evidenceTable)).toBe(false);
          } finally {
            await Promise.allSettled([branch.close()]);
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("a destroy committing before the member holds the allocation", () => {
      type Branch = Awaited<ReturnType<typeof createBranch>>;

      /** An idle, fully delivered branch, so a destroy is permitted. */
      async function createDestroyableBranch(): Promise<Branch> {
        const branch = await createBranch({ revisionTracking: true });
        unwrap(
          await operateDurableBranch(
            branch.descriptor,
            branch.strategy,
            operation("op-1"),
          ),
        );
        unwrap(
          await markDurableOperationDelivered(
            branch.descriptor,
            branch.strategy,
            "op-1",
          ),
        );
        await branch.close();
        return branch;
      }

      it(
        "fails operate with the removed-allocation BranchError when the destroy lands before the revision origin is minted",
        async () => {
          const branch = await createDestroyableBranch();
          try {
            const evidenceTable = await evidenceTableOf(branch.allocationId);
            const originsTable = evidenceTable.replace(
              /op_evidence$/u,
              "revisionOrigins",
            );
            const racing = createManager(
              true,
              pool,
              beforeFirstReadOf(originsTable, async () => {
                unwrap(
                  await destroyDurableBranch(
                    branch.descriptor,
                    branch.strategy,
                  ),
                );
              }),
            );
            const callsBefore = applyCalls;

            const refused = refusalOf(
              await operateDurableBranch(
                branch.descriptor,
                racing.manager.durable,
                operation("op-2"),
              ),
            );

            expect(removedAllocationIn(refused)).toBeDefined();
            expect(applyCalls).toBe(callsBefore);
            expect(await relationExists(evidenceTable)).toBe(false);
          } finally {
            await Promise.allSettled([branch.close()]);
          }
        },
        TEST_TIMEOUT_MS,
      );

      it.each([
        {
          label: "get",
          read: (
            descriptor: Branch["descriptor"],
            strategy: Branch["strategy"],
          ) => getDurableOperation(descriptor, strategy, "op-1"),
        },
        {
          label: "scan",
          read: (
            descriptor: Branch["descriptor"],
            strategy: Branch["strategy"],
          ) => scanDurableOperations(descriptor, strategy),
        },
        {
          label: "hasUndelivered",
          read: (
            descriptor: Branch["descriptor"],
            strategy: Branch["strategy"],
          ) => durableBranchHasUndeliveredEvidence(descriptor, strategy),
        },
        {
          label: "markDelivered",
          read: (
            descriptor: Branch["descriptor"],
            strategy: Branch["strategy"],
          ) => markDurableOperationDelivered(descriptor, strategy, "op-1"),
        },
      ] as const)(
        "fails $label with the removed-allocation BranchError when the destroy lands before the connection is attested",
        async ({ read }) => {
          const branch = await createDestroyableBranch();
          try {
            const evidenceTable = await evidenceTableOf(branch.allocationId);
            const racing = createManager(
              true,
              pool,
              beforeFirstStatementMatching(
                (statement) =>
                  statement.includes(LEDGER) &&
                  statement.includes("SELECT ownership_token FROM"),
                async () => {
                  unwrap(
                    await destroyDurableBranch(
                      branch.descriptor,
                      branch.strategy,
                    ),
                  );
                },
              ),
            );

            const refused = refusalOf(
              await read(branch.descriptor, racing.manager.durable),
            );

            const removed = removedAllocationIn(refused);
            expect(removed).toBeDefined();
            expect(removed?.message).not.toContain("not bound");
            expect(await relationExists(evidenceTable)).toBe(false);
          } finally {
            await Promise.allSettled([branch.close()]);
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("the allocation lock's key space", () => {
      it(
        "excludes a second holder of the same allocation and is disjoint from a graph write lock with the same key",
        async () => {
          const { control } = createManager();
          const key = "lock-namespace-key";
          const releaseFirst = createLatch();
          const first = control.transaction(async (transaction) => {
            await lockAllocation(transaction, key);
            await releaseFirst.promise;
          }, ALLOCATION_LOCK_TRANSACTION_OPTIONS);
          await sleep(SETTLE_WINDOW_MS);
          const second = control.transaction(
            (transaction) => lockAllocation(transaction, key),
            ALLOCATION_LOCK_TRANSACTION_OPTIONS,
          );
          expect(await isStillPending(second)).toBe(true);
          releaseFirst.release();
          await Promise.all([first, second]);

          const releaseGraphLock = createLatch();
          const graphLock = control.transaction(async (transaction) => {
            await transaction.execute(
              asCompiledRowsSql(recordedGraphWriteAdvisoryLockSql(key)),
            );
            await releaseGraphLock.promise;
          }, ALLOCATION_LOCK_TRANSACTION_OPTIONS);
          try {
            await sleep(SETTLE_WINDOW_MS);
            const allocationLock = control.transaction(
              (transaction) => lockAllocation(transaction, key),
              ALLOCATION_LOCK_TRANSACTION_OPTIONS,
            );
            expect(await isStillPending(allocationLock)).toBe(false);
            await allocationLock;
          } finally {
            releaseGraphLock.release();
            await graphLock;
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe.each(TRACKING_STORE_MODES)(
      "reads the before coordinate after the write fence in $label mode",
      ({ mode }) => {
        it(
          "chains the evidence to the state a fence-holding writer committed while the operation waited",
          async () => {
            const branch = await createBranch(mode);
            const directGate = createLatch();
            const applyGate = createLatch();
            gates.set("gate-ordering-apply", applyGate);
            try {
              const forkBase = await computeBaseVersion(branch.store);
              const directWrite = branch.store.transaction(
                async (transaction) => {
                  await transaction.nodes.Person.create({ name: "Direct" });
                  await directGate.promise;
                },
              );
              await sleep(SETTLE_WINDOW_MS);
              const callsBefore = applyCalls;
              const operating = operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation(
                  "op-1",
                  personMutation("Alice", { holdOn: "gate-ordering-apply" }),
                ),
              );
              expect(await isStillPending(operating)).toBe(true);

              directGate.release();
              await directWrite;
              await waitUntil(() => applyCalls > callsBefore);
              const committedByWriter = await computeBaseVersion(branch.store);
              expect(committedByWriter).not.toBe(forkBase);

              applyGate.release();
              const outcome = unwrap(await operating);
              if (outcome.outcome !== "applied") {
                throw new Error("expected an applied operation");
              }
              expect(outcome.evidence.before.base).toBe(committedByWriter);
              expect(await population(branch.store)).toBe(2);
            } finally {
              directGate.release();
              applyGate.release();
              await branch.close();
            }
          },
          TEST_TIMEOUT_MS,
        );
      },
    );

    describe("engine revision coordinates", () => {
      it.each(TRACKING_STORE_MODES)(
        "reports before and after revisions in $label mode",
        async ({ mode }) => {
          const branch = await createBranch(mode);
          try {
            const outcome = unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            if (outcome.outcome !== "applied") {
              throw new Error("expected an applied operation");
            }
            const { before, after } = outcome.evidence;
            expect(before.revision).toBeDefined();
            expect(after.revision).toBeDefined();
            expect(after.revision).not.toBe(before.revision);
            expect(after.revision).toBe(
              await branch.store.lineageRevisionNow(),
            );
            const stored = unwrap(
              await getDurableOperation(
                branch.descriptor,
                branch.strategy,
                "op-1",
              ),
            );
            expect(stored?.before).toEqual(before);
            expect(stored?.after).toEqual(after);
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "reports no revision when the working copy resolves no lineage",
        async () => {
          const branch = await createBranch({});
          try {
            expect(await branch.store.lineageRevisionNow()).toBeUndefined();
            const outcome = unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            if (outcome.outcome !== "applied") {
              throw new Error("expected an applied operation");
            }
            expect("revision" in outcome.evidence.before).toBe(false);
            expect("revision" in outcome.evidence.after).toBe(false);
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("attestation before any connection", () => {
      const Company = defineNode("Company", {
        schema: z.object({ title: z.string() }),
      });
      const otherIdGraph = defineGraph({
        id: "postgres-working-copy-operations-other",
        nodes: { Person: { type: Person } },
        edges: {},
      });
      const divergentGraph = defineGraph({
        id: graph.id,
        nodes: { Person: { type: Person }, Company: { type: Company } },
        edges: {},
      });

      it.each([
        { label: "a different graph id", candidate: otherIdGraph },
        { label: "a divergent definition", candidate: divergentGraph },
      ])(
        "refuses $label before opening a connection or a transaction",
        async ({ candidate }) => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            let opened = 0;
            let applied = 0;
            const manager = createPostgresWorkingCopyManager<typeof candidate>({
              control: createPostgresBackend(drizzle(pool)),
              connect: (names) => {
                opened += 1;
                return Promise.resolve(
                  createPostgresBackend(drizzle(pool), {
                    tables: createPostgresTables(names),
                  }),
                );
              },
              operations: {
                graph: candidate,
                apply: () => {
                  applied += 1;
                  return Promise.resolve();
                },
              },
            });
            const refused = await operateDurableBranch(
              branch.descriptor,
              manager.durable,
              operation("op-1"),
            );
            expect(
              causeChain(refusalOf(refused)).some(
                (error) =>
                  error instanceof BranchError &&
                  error.message.includes("supplied graph"),
              ),
            ).toBe(true);
            expect(opened).toBe(0);
            expect(applied).toBe(0);
            expect(await evidenceRowCount(branch.allocationId)).toBe(0);
          } finally {
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("mixed-version ledgers", () => {
      it(
        "answers an allocation from an older ledger as unsupported without DDL, a lock or a connection",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          try {
            await pool.query(
              `ALTER TABLE ${LEDGER} DROP COLUMN operation_evidence`,
            );
            connections.opened = 0;
            const outcome = unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            expect(outcome).toEqual({
              outcome: "unsupported",
              dimensions: ["evidenceStore"],
            });
            expect(
              unwrap(
                await getDurableOperation(
                  branch.descriptor,
                  branch.strategy,
                  "op-1",
                ),
              ),
            ).toBeUndefined();
            expect(
              unwrap(
                await scanDurableOperations(branch.descriptor, branch.strategy),
              ),
            ).toEqual({ operations: [], hasMore: false });
            expect(
              unwrap(
                await markDurableOperationDelivered(
                  branch.descriptor,
                  branch.strategy,
                  "op-1",
                ),
              ),
            ).toBeUndefined();
            expect(
              unwrap(
                await durableBranchHasUndeliveredEvidence(
                  branch.descriptor,
                  branch.strategy,
                ),
              ),
            ).toBe(false);
            expect(connections.opened).toBe(0);
            const column = await pool.query(
              `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'operation_evidence'`,
              [LEDGER],
            );
            expect(column.rowCount).toBe(0);
          } finally {
            await pool.query(
              `ALTER TABLE ${LEDGER} ADD COLUMN IF NOT EXISTS operation_evidence boolean NOT NULL DEFAULT false`,
            );
            await pool.query(
              `UPDATE ${LEDGER} SET operation_evidence = true WHERE allocation_id = $1`,
              [branch.allocationId],
            );
            await branch.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "names an orphaned evidence relation when an older manager destroyed the allocation without the fence",
        async () => {
          const branch = await createBranch({ revisionTracking: true });
          const evidenceTable = await evidenceTableOf(branch.allocationId);
          try {
            unwrap(
              await operateDurableBranch(
                branch.descriptor,
                branch.strategy,
                operation("op-1"),
              ),
            );
            await branch.close();
            // What a manager from before durable operations leaves behind: every
            // relation it knew about is dropped, the evidence relation is not.
            const prefix = evidenceTable.slice(0, -"op_evidence".length);
            const relations = await pool.query<{ tablename: string }>(
              "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND left(tablename, length($1)) = $1 AND tablename <> $2",
              [prefix, evidenceTable],
            );
            for (const { tablename } of relations.rows) {
              await pool.query(`DROP TABLE "${tablename}" CASCADE`);
            }
            await pool.query(`DELETE FROM ${LEDGER} WHERE allocation_id = $1`, [
              branch.allocationId,
            ]);

            const retried = await branchDurable(
              branch.source,
              branch.strategy,
              {
                id: asBranchId("orphan-retry"),
                allocationId: branch.allocationId,
              },
            );
            const refusal = causeChain(refusalOf(retried)).find(
              (error): error is BranchError =>
                error instanceof BranchError &&
                error.details["evidenceTable"] === evidenceTable,
            );
            expect(refusal?.message).toContain("without a ledger row");
            expect(refusal?.suggestion).toContain("deliver");
            expect(await relationExists(evidenceTable)).toBe(true);
            const undelivered = await pool.query(
              `SELECT 1 FROM "${evidenceTable}" WHERE NOT delivered`,
            );
            expect(undelivered.rowCount).toBe(1);
            const ledger = await pool.query(
              `SELECT 1 FROM ${LEDGER} WHERE allocation_id = $1`,
              [branch.allocationId],
            );
            expect(ledger.rowCount).toBe(0);
          } finally {
            await pool.query(`DROP TABLE IF EXISTS "${evidenceTable}"`);
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    it(
      "treats an allocation provisioned before evidence existed as unsupported and evidence-free",
      async () => {
        const branch = await createBranch({ revisionTracking: true });
        try {
          await pool.query(
            `UPDATE ${LEDGER} SET operation_evidence = false WHERE allocation_id = $1`,
            [branch.allocationId],
          );
          const callsBefore = applyCalls;
          const outcome = unwrap(
            await operateDurableBranch(
              branch.descriptor,
              branch.strategy,
              operation("op-1"),
            ),
          );
          expect(outcome).toEqual({
            outcome: "unsupported",
            dimensions: ["evidenceStore"],
          });
          expect(applyCalls).toBe(callsBefore);
          expect(await population(branch.store)).toBe(0);
          expect(
            unwrap(
              await getDurableOperation(
                branch.descriptor,
                branch.strategy,
                "op-1",
              ),
            ),
          ).toBeUndefined();
          expect(
            unwrap(
              await scanDurableOperations(branch.descriptor, branch.strategy),
            ),
          ).toEqual({ operations: [], hasMore: false });
          const echoed = unwrap(
            await scanDurableOperations(branch.descriptor, branch.strategy, {
              after: "pgop1.7",
            }),
          );
          expect(echoed).toEqual({
            operations: [],
            cursor: "pgop1.7",
            hasMore: false,
          });
          expect(
            unwrap(
              await markDurableOperationDelivered(
                branch.descriptor,
                branch.strategy,
                "op-1",
              ),
            ),
          ).toBeUndefined();
          expect(
            unwrap(
              await durableBranchHasUndeliveredEvidence(
                branch.descriptor,
                branch.strategy,
              ),
            ),
          ).toBe(false);
          await branch.close();
          unwrap(
            await destroyDurableBranch(branch.descriptor, branch.strategy),
          );
        } finally {
          await Promise.allSettled([branch.close()]);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
