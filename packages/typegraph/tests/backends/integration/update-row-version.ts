/**
 * A node update's row write is bound to the row version it was planned from.
 *
 * Every update entry point reads the row, merges or replaces its props and
 * plans its uniqueness claim transition from what it read, then writes. Under
 * PostgreSQL READ COMMITTED another session can commit a write to the same row
 * in between. An UPDATE predicated on identity alone then writes the props it
 * computed from the superseded row back over the newer one, with claims
 * planned for neither: the row holds one unique value while its claim names
 * another, and a create of the stored value is admitted as if it were free.
 *
 * Each entry point here is run across such a write, and the case asserts what
 * survived: the stored row, the live claim rows (read straight from the claim
 * relation), that a create of the stored value is refused and that the value
 * the row no longer holds is free. The rule each entry point follows when the
 * version moved is stated by its case:
 *
 * - a patch (`update`, `upsertById`, `bulkUpsertById`) re-reads the row and
 *   re-applies the fields it names to it, so the concurrent write survives
 *   wherever the patch did not name a field;
 * - a whole-row replace (`bulkReplaceById`) states every field, so it re-reads
 *   only to plan its claims from the row it replaces and stores its own row;
 * - an `importGraph` overwrite (`onConflict: "update"`) refuses the row with
 *   its per-row `INTERCHANGE_NODE_UPDATE_TARGET_CHANGED` error and leaves the
 *   concurrent write in place: its window verdict was judged against the row
 *   it read, and import reports a row that moved rather than re-judging it.
 *
 * Two constructions of the concurrent write:
 *
 * - INJECTED, on every lane: the first read of the row after arming returns
 *   and then the same session commits a move of the row's unique value (with
 *   the version increment every store write makes) before the entry point's
 *   own write — the schedule READ COMMITTED allows.
 * - TWO CONNECTIONS, on the server PostgreSQL lanes: one connection moves the
 *   value inside a transaction it holds open; the entry point runs on another
 *   connection, reads the committed row and parks on the row lock; the holder
 *   commits only once that wait is observed.
 *
 * REVERT CHECK (SQLite and PGlite lanes, injected form): on main, every
 * `update`, `upsertById` and per-row `bulkUpsertById` case fails (the row
 * keeps the superseded value, its claim names the other one, and a duplicate
 * of the stored value is admitted), the import cases fail with the row
 * overwritten instead of refused, the provenance reopen revives the superseded
 * props, and the ignoring backend is not refused. With only the predicate
 * removed from `buildUpdateNode` the same cases fail. The resolved-batch
 * `bulkUpsertById` and `bulkReplaceById` cases pass on main: that statement
 * already gates on the version, and they guard it. The create-on-tombstone
 * case passes on main (the create writes only its own props) and fails when
 * the resurrection gets one attempt: it guards the convergence, as the reopen
 * case does.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import {
  type TransactionBackend,
  type UpdateNodeParams,
} from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import { createRetractionCapability } from "../../../src/provenance";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { createGate } from "../../concurrency-utils";
import { type IntegrationTestContext } from "./test-context";

const RvEvent = defineNode("RvEvent", {
  schema: z.object({ name: z.string(), at: z.date() }),
});

/** A date reached through a pipe: its input is text, its output a `Date`. */
const RvPipedEvent = defineNode("RvPipedEvent", {
  schema: z.object({ name: z.string(), at: z.string().pipe(z.coerce.date()) }),
});

const RvTag = defineNode("RvTag", {
  schema: z.object({ name: z.string(), code: z.string() }),
});

const RvSource = defineNode("RvSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const RvJustification = defineNode("RvJustification", {
  schema: z.object({ label: z.string() }),
});

const rvPremiseOf = defineEdge("rvPremiseOf");
const rvDerives = defineEdge("rvDerives");

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      RvEvent: {
        type: RvEvent,
        unique: [
          {
            name: "RvEvent_at",
            fields: ["at"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      RvPipedEvent: {
        type: RvPipedEvent,
        unique: [
          {
            name: "RvPipedEvent_at",
            fields: ["at"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      RvTag: {
        type: RvTag,
        unique: [
          {
            name: "RvTag_code",
            fields: ["code"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      RvSource: { type: RvSource },
      RvJustification: { type: RvJustification },
    },
    edges: {
      rvPremiseOf: {
        type: rvPremiseOf,
        from: [RvSource],
        to: [RvJustification],
      },
      rvDerives: { type: rvDerives, from: [RvJustification], to: [RvTag] },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `update_row_version_${graphIdCounter}`;
}

type RvGraph = ReturnType<typeof buildGraph>;
type RvStore = Awaited<ReturnType<typeof createStoreWithSchema<RvGraph>>>[0];
type RvKind = "RvEvent" | "RvPipedEvent" | "RvTag";

/**
 * One unique field and the two values a case moves it between: `before` is
 * what the row is created with, `after` what the concurrent write moves it to.
 */
type UniqueShape = Readonly<{
  name: string;
  kind: RvKind;
  constraintName: string;
  field: "at" | "code";
  before: unknown;
  after: unknown;
  /** The value as an interchange document or a stored row spells it. */
  asJson: (value: unknown) => string;
  /** The value the kind's schema produces from `value`, which claims are keyed from. */
  validated: (value: unknown) => unknown;
  /**
   * Whether an interchange document can state the value. A `z.date()` field
   * cannot: the document carries text, which the schema refuses before the
   * import reads the row.
   */
  importable: boolean;
}>;

const SHAPES: readonly UniqueShape[] = [
  {
    name: "a unique z.date() field",
    kind: "RvEvent",
    constraintName: "RvEvent_at",
    field: "at",
    before: new Date("2024-01-01T00:00:00.000Z"),
    after: new Date("2024-01-02T00:00:00.000Z"),
    asJson: (value) => new Date(String(value)).toISOString(),
    validated: (value) => value,
    importable: false,
  },
  {
    name: "a unique text-to-date piped field",
    kind: "RvPipedEvent",
    constraintName: "RvPipedEvent_at",
    field: "at",
    before: "2024-01-01T00:00:00.000Z",
    after: "2024-01-02T00:00:00.000Z",
    asJson: (value) => new Date(String(value)).toISOString(),
    validated: (value) => new Date(String(value)),
    importable: true,
  },
  {
    name: "a unique z.string() field",
    kind: "RvTag",
    constraintName: "RvTag_code",
    field: "code",
    before: "code-1",
    after: "code-2",
    asJson: String,
    validated: (value) => value,
    importable: true,
  },
];

const ROW_ID = "row";

/** The collection surface every case drives; both kinds share it. */
type RvCollection = Readonly<{
  create: (props: never, options?: { id?: string }) => Promise<unknown>;
  getById: (id: never) => Promise<Record<string, unknown> | undefined>;
  update: (id: never, props: never) => Promise<unknown>;
  upsertById: (id: string, props: never) => Promise<unknown>;
  bulkUpsertById: (
    items: readonly Readonly<{ id: string; props: never; validTo?: string }>[],
  ) => Promise<unknown>;
  bulkReplaceById: (
    items: readonly Readonly<{ id: string; props: never }>[],
  ) => Promise<unknown>;
}>;

function collection(store: RvStore, kind: RvKind): RvCollection {
  return store.nodes[kind];
}

function rowProps(
  shape: UniqueShape,
  name: string,
  value: unknown,
): Record<string, unknown> {
  return { name, [shape.field]: value };
}

/**
 * What an entry point is expected to leave: whose value of the unique field
 * the row stores, the name it stores, and what the call itself returned.
 */
type EntryExpectation = Readonly<{
  value: "before" | "after";
  name: string;
  outcome: string;
}>;

type EntryPoint = Readonly<{
  name: string;
  /** The rule this entry point follows when the version moved. */
  rule: string;
  appliesTo: (shape: UniqueShape) => boolean;
  /**
   * How many of the entry point's in-transaction reads of the row precede the
   * one its write is planned from.
   */
  plannedFromRead: number;
  run: (store: RvStore, shape: UniqueShape) => Promise<string>;
  expected: EntryExpectation;
}>;

/** Whether a write was refused, by error name, or completed. */
async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "written";
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

const RENAMED = "renamed";

const ENTRY_POINTS: readonly EntryPoint[] = [
  {
    name: "update",
    rule: "re-applies its patch to the current row",
    appliesTo: () => true,
    plannedFromRead: 0,
    run: (store, shape) =>
      outcome(() =>
        collection(store, shape.kind).update(
          ROW_ID as never,
          { name: RENAMED } as never,
        ),
      ),
    expected: { value: "after", name: RENAMED, outcome: "written" },
  },
  {
    name: "upsertById",
    rule: "re-applies its patch to the current row",
    appliesTo: () => true,
    plannedFromRead: 0,
    run: (store, shape) =>
      outcome(() =>
        collection(store, shape.kind).upsertById(ROW_ID, {
          name: RENAMED,
        } as never),
      ),
    expected: { value: "after", name: RENAMED, outcome: "written" },
  },
  {
    name: "bulkUpsertById",
    rule: "re-applies its patch to the current row",
    appliesTo: () => true,
    plannedFromRead: 1,
    run: (store, shape) =>
      outcome(() =>
        collection(store, shape.kind).bulkUpsertById([
          { id: ROW_ID, props: { name: RENAMED } as never },
        ]),
      ),
    expected: { value: "after", name: RENAMED, outcome: "written" },
  },
  {
    // A stated window end takes the batch off its version-gated resolved
    // statement and onto one row write per entry.
    name: "bulkUpsertById with a stated validTo",
    rule: "re-applies its patch to the current row",
    appliesTo: () => true,
    plannedFromRead: 1,
    run: (store, shape) =>
      outcome(() =>
        collection(store, shape.kind).bulkUpsertById([
          {
            id: ROW_ID,
            props: { name: RENAMED } as never,
            validTo: "2999-01-01T00:00:00.000Z",
          },
        ]),
      ),
    expected: { value: "after", name: RENAMED, outcome: "written" },
  },
  {
    name: "bulkReplaceById",
    rule: "stores its whole row, with claims planned from the current row",
    appliesTo: () => true,
    plannedFromRead: 1,
    run: (store, shape) =>
      outcome(() =>
        collection(store, shape.kind).bulkReplaceById([
          {
            id: ROW_ID,
            props: rowProps(shape, RENAMED, shape.before) as never,
          },
        ]),
      ),
    expected: { value: "before", name: RENAMED, outcome: "written" },
  },
  {
    name: "importGraph onConflict update",
    rule: "refuses the row and leaves the concurrent write in place",
    appliesTo: (shape) => shape.importable,
    plannedFromRead: 0,
    run: async (store, shape) => {
      const result = await importGraph(
        store,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          source: { type: "external", description: "update row version" },
          nodes: [
            {
              kind: shape.kind,
              id: ROW_ID,
              properties: {
                name: RENAMED,
                [shape.field]: shape.asJson(shape.before),
              },
            },
          ],
          edges: [],
        },
        { onConflict: "update", onUnknownProperty: "error" },
      );
      return result.errors.length === 0 ?
          "written"
        : result.errors
            .map((entry) => entry.error.split(":")[0] ?? entry.error)
            .join(", ");
    },
    expected: {
      value: "after",
      name: "row",
      outcome: "INTERCHANGE_NODE_UPDATE_TARGET_CHANGED",
    },
  },
];

type LiveClaim = Readonly<{
  constraint_name: string;
  key: string;
  node_id: string;
}>;

function keyOf(shape: UniqueShape, value: unknown): string {
  return computeUniqueKey(
    { [shape.field]: shape.validated(value) },
    [shape.field],
    "binary",
  );
}

function claimOf(shape: UniqueShape, value: unknown): LiveClaim {
  return {
    constraint_name: shape.constraintName,
    key: keyOf(shape, value),
    node_id: ROW_ID,
  };
}

/** Every live claim of one constraint, read straight from the claim relation. */
async function liveClaims(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  constraintName: string,
): Promise<readonly LiveClaim[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<LiveClaim>(
    asCompiledRowsSql(sql`
      SELECT constraint_name, key, node_id
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${graphId}
        AND constraint_name = ${constraintName}
        AND deleted_at IS NULL
      ORDER BY node_id
    `),
  );
  return rows.map((row) => ({
    constraint_name: row.constraint_name,
    key: row.key,
    node_id: row.node_id,
  }));
}

/**
 * What survived a case: the stored row, the live claims, and whether a create
 * of the stored value is refused while a create of the value the row does not
 * hold is admitted.
 */
async function survivingState(
  store: RvStore,
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  shape: UniqueShape,
) {
  const nodes = collection(store, shape.kind);
  const stored = requireDefined(await nodes.getById(ROW_ID as never));
  const storedValue = shape.asJson(stored[shape.field]);
  const holdsBefore = storedValue === shape.asJson(shape.before);
  const heldValue = holdsBefore ? shape.before : shape.after;
  const otherValue = holdsBefore ? shape.after : shape.before;
  return {
    name: stored["name"],
    value: storedValue,
    claims: await liveClaims(backend, store.graphId, shape.constraintName),
    duplicate: await outcome(() =>
      nodes.create(rowProps(shape, "duplicate", heldValue) as never),
    ),
    vacated: await outcome(() =>
      nodes.create(rowProps(shape, "vacated", otherValue) as never),
    ),
  };
}

function expectedState(shape: UniqueShape, expected: EntryExpectation) {
  const value = expected.value === "before" ? shape.before : shape.after;
  return {
    name: expected.name,
    value: shape.asJson(value),
    claims: [claimOf(shape, value)],
    duplicate: "UniquenessError",
    vacated: "written",
  };
}

/**
 * A backend whose next read of the row inside a write transaction, once armed,
 * returns and then commits a move of the row's unique value on the same target
 * — a store update's row write and claim transition, version increment
 * included — before the reader acts on what it read. Only a read through a
 * transaction counts: an entry point's autocommit probe before its write
 * transaction (`upsertById`'s) is not the read its write is planned from.
 */
function createReadInterleaver(
  backend: GraphBackend,
  intervene: (target: GraphBackend | TransactionBackend) => Promise<void>,
) {
  const state = { armed: false, skip: 0 };
  async function afterRead(
    target: GraphBackend | TransactionBackend,
    ids: readonly string[],
  ): Promise<void> {
    if (!state.armed || !ids.includes(ROW_ID)) return;
    if (state.skip > 0) {
      state.skip -= 1;
      return;
    }
    state.armed = false;
    await intervene(target);
  }
  function interleaved<B extends GraphBackend | TransactionBackend>(target: B) {
    const getNodes = target.getNodes;
    return deriveBackend(target, {
      getNode: async (graphId: string, kind: string, id: string) => {
        const row = await target.getNode(graphId, kind, id);
        await afterRead(target, [id]);
        return row;
      },
      ...(getNodes === undefined ?
        {}
      : {
          getNodes: async (graphId: string, kind: string, ids: string[]) => {
            const rows = await getNodes(graphId, kind, ids);
            await afterRead(target, ids);
            return rows;
          },
        }),
    } as never);
  }
  return {
    backend: deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction((tx) => fn(interleaved(tx)), options),
    }),
    /** Interleaves after the read that follows `skip` earlier reads of the row. */
    arm: (skip: number) => {
      state.armed = true;
      state.skip = skip;
    },
    fired: () => !state.armed,
  };
}

/**
 * Rewrites the row's stored props while it stays deleted, with the version
 * increment every write makes: what a revive, an update and a delete by
 * another session leave behind. A tombstone holds no live claim, so there is
 * no claim to move.
 */
function tombstoneRewrite(graphId: string, props: Record<string, unknown>) {
  return async (target: GraphBackend | TransactionBackend): Promise<void> => {
    const nodes = createSqlSchema(target.tableNames).nodesTable;
    await requireDefined(target.executeStatement)(
      asCompiledStatementSql(sql`
        UPDATE ${nodes}
        SET props = ${JSON.stringify(props)}, version = version + 1
        WHERE graph_id = ${graphId} AND kind = 'RvTag' AND id = ${ROW_ID}
      `),
    );
  };
}

function moveIntervention(graphId: string, shape: UniqueShape) {
  const claimRow = (value: unknown) => ({
    graphId,
    nodeKind: shape.kind,
    constraintName: shape.constraintName,
    key: keyOf(shape, value),
    concreteKind: shape.kind,
    nodeId: ROW_ID,
  });
  return async (target: GraphBackend | TransactionBackend): Promise<void> => {
    await target.updateNode({
      graphId,
      kind: shape.kind,
      id: ROW_ID,
      props: { name: "row", [shape.field]: shape.asJson(shape.after) },
      incrementVersion: true,
    });
    await target.insertUnique(claimRow(shape.after));
    await target.deleteUnique(claimRow(shape.before));
  };
}

type CountRow = Readonly<{ count: string | number }>;

/**
 * Runs `operation` on one connection while another holds, uncommitted, a move
 * of the row's unique value to `after`, and lets that writer commit only once
 * the operation is observed waiting on a lock. The operation therefore read
 * the row as it was before the move, and its write lands after the move.
 */
async function raceAgainstHeldMove(
  context: IntegrationTestContext,
  store: RvStore,
  shape: UniqueShape,
  operation: () => Promise<string>,
): Promise<Readonly<{ holder: string; contender: string }>> {
  const reached = createGate();
  const release = createGate();
  const holding = outcome(() =>
    store.transaction(async (tx) => {
      const nodes = tx.nodes[shape.kind] as unknown as RvCollection;
      await nodes.update(
        ROW_ID as never,
        { [shape.field]: shape.after } as never,
      );
      reached.open();
      await release.opened;
    }),
  );
  await reached.opened;
  const operating = operation();
  try {
    await vi.waitFor(
      async () => {
        const rows = await context.getBackend().execute<CountRow>(
          asCompiledRowsSql(sql`
            SELECT count(*) AS count FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
          `),
        );
        expect(Number(requireDefined(rows[0]).count)).toBe(1);
      },
      { timeout: 5000 },
    );
  } finally {
    release.open();
  }
  return { holder: await holding, contender: await operating };
}

/**
 * A port whose `updateNode` drops `expectedVersion` before the statement: a
 * custom backend written before the predicate existed.
 */
function ignoringExpectedVersion(backend: GraphBackend): GraphBackend {
  function stripped<B extends GraphBackend | TransactionBackend>(target: B) {
    return deriveBackend(target, {
      updateNode: (params: UpdateNodeParams) => {
        const { expectedVersion: _ignored, ...unfenced } = params;
        return target.updateNode(unfenced);
      },
    } as never);
  }
  return deriveBackend(stripped(backend), {
    transaction: (fn, options) =>
      backend.transaction((tx) => fn(stripped(tx)), options),
  });
}

export function registerUpdateRowVersionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a node update is bound to the row version it was planned from", () => {
    it("a backend whose updateNode ignores expectedVersion is refused and nothing it wrote survives", async () => {
      const shape = requireDefined(SHAPES[0]);
      const graphId = nextGraphId();
      const interleaver = createReadInterleaver(
        ignoringExpectedVersion(context.getBackend()),
        moveIntervention(graphId, shape),
      );
      const [store] = await createStoreWithSchema(
        buildGraph(graphId),
        interleaver.backend,
      );
      await collection(store, shape.kind).create(
        rowProps(shape, "row", shape.before) as never,
        { id: ROW_ID },
      );

      interleaver.arm(0);
      const refused = await collection(store, shape.kind)
        .update(ROW_ID as never, { name: RENAMED } as never)
        .then(
          () => "written",
          (error: unknown) =>
            error instanceof Error ?
              `${error.name}: ${String((error as { details?: { operation?: unknown } }).details?.operation)}`
            : String(error),
        );

      // The refusal aborted the write's transaction, which held the
      // interleaved move too: the row and its claims are as created.
      expect({
        outcome: refused,
        ...(await survivingState(store, interleaver.backend, shape)),
      }).toEqual({
        outcome: "ConfigurationError: updateNode",
        ...expectedState(shape, {
          value: "before",
          name: "row",
          outcome: "",
        }),
      });
    });

    it("a provenance reopen across a concurrent write to the tombstone revives the props the row holds now", async () => {
      const graphId = nextGraphId();
      const interleaver = createReadInterleaver(
        context.getBackend(),
        tombstoneRewrite(graphId, { name: "rewritten", code: "code-2" }),
      );
      const [store] = await createStoreWithSchema(
        buildGraph(graphId),
        interleaver.backend,
        { history: true },
      );
      const source = await store.nodes.RvSource.create(
        { label: "source", retracted: false },
        { id: "source" },
      );
      const fact = await store.nodes.RvTag.create(
        { name: "row", code: "code-1" },
        { id: ROW_ID },
      );
      const justification = await store.nodes.RvJustification.create(
        { label: "justification" },
        { id: "justification" },
      );
      await store.edges.rvPremiseOf.create(source, justification, {});
      await store.edges.rvDerives.create(justification, fact, {});
      const provenance = createRetractionCapability(store, {
        source: { kind: "RvSource" },
        justification: { kind: "RvJustification" },
        fact: { kinds: ["RvTag"] },
        premiseOf: { kind: "rvPremiseOf" },
        derives: { kind: "rvDerives" },
      });
      await provenance.retract(source);

      interleaver.arm(1);
      await provenance.unRetract(source);

      expect(interleaver.fired()).toBe(true);
      const stored = await store.nodes.RvTag.getById(fact.id);
      expect({
        stored: { name: stored?.name, code: stored?.code },
        claims: await liveClaims(interleaver.backend, graphId, "RvTag_code"),
        duplicate: await outcome(() =>
          store.nodes.RvTag.create({ name: "duplicate", code: "code-2" }),
        ),
        vacated: await outcome(() =>
          store.nodes.RvTag.create({ name: "vacated", code: "code-1" }),
        ),
      }).toEqual({
        stored: { name: "rewritten", code: "code-2" },
        claims: [
          {
            constraint_name: "RvTag_code",
            key: computeUniqueKey({ code: "code-2" }, ["code"], "binary"),
            node_id: ROW_ID,
          },
        ],
        duplicate: "UniquenessError",
        vacated: "written",
      });
    });

    it("a create landing on a tombstone across a concurrent write to it resurrects with its own props", async () => {
      const graphId = nextGraphId();
      const interleaver = createReadInterleaver(
        context.getBackend(),
        tombstoneRewrite(graphId, { name: "rewritten", code: "code-2" }),
      );
      const [store] = await createStoreWithSchema(
        buildGraph(graphId),
        interleaver.backend,
      );
      const created = await store.nodes.RvTag.create(
        { name: "row", code: "code-1" },
        { id: ROW_ID },
      );
      await store.nodes.RvTag.delete(created.id);

      interleaver.arm(1);
      const resurrected = await outcome(() =>
        store.nodes.RvTag.create(
          { name: "created", code: "code-3" },
          { id: ROW_ID },
        ),
      );

      expect(interleaver.fired()).toBe(true);
      const stored = await store.nodes.RvTag.getById(created.id);
      expect({
        resurrected,
        stored: { name: stored?.name, code: stored?.code },
        claims: await liveClaims(interleaver.backend, graphId, "RvTag_code"),
        duplicate: await outcome(() =>
          store.nodes.RvTag.create({ name: "duplicate", code: "code-3" }),
        ),
        vacated: await outcome(() =>
          store.nodes.RvTag.create({ name: "vacated", code: "code-2" }),
        ),
      }).toEqual({
        resurrected: "written",
        stored: { name: "created", code: "code-3" },
        claims: [
          {
            constraint_name: "RvTag_code",
            key: computeUniqueKey({ code: "code-3" }, ["code"], "binary"),
            node_id: ROW_ID,
          },
        ],
        duplicate: "UniquenessError",
        vacated: "written",
      });
    });

    for (const shape of SHAPES) {
      for (const entry of ENTRY_POINTS.filter((candidate) =>
        candidate.appliesTo(shape),
      )) {
        it(`${entry.name} across a concurrent move of ${shape.name} ${entry.rule} (same session, injected)`, async () => {
          const graphId = nextGraphId();
          const interleaver = createReadInterleaver(
            context.getBackend(),
            moveIntervention(graphId, shape),
          );
          const [store] = await createStoreWithSchema(
            buildGraph(graphId),
            interleaver.backend,
          );
          await collection(store, shape.kind).create(
            rowProps(shape, "row", shape.before) as never,
            { id: ROW_ID },
          );

          interleaver.arm(entry.plannedFromRead);
          const result = await entry.run(store, shape);

          expect(interleaver.fired()).toBe(true);
          expect({
            outcome: result,
            ...(await survivingState(store, interleaver.backend, shape)),
          }).toEqual({
            outcome: entry.expected.outcome,
            ...expectedState(shape, entry.expected),
          });
          expect(await store.verifyConstraintFences()).toEqual([]);
        });

        it.runIf(context.serverLaneConcurrency)(
          `${entry.name} across a concurrent move of ${shape.name} ${entry.rule} (two connections)`,
          async () => {
            const store = await context.createStore(buildGraph(nextGraphId()));
            await collection(store, shape.kind).create(
              rowProps(shape, "row", shape.before) as never,
              { id: ROW_ID },
            );

            const race = await raceAgainstHeldMove(context, store, shape, () =>
              entry.run(store, shape),
            );

            expect({
              holder: race.holder,
              contender: race.contender,
              ...(await survivingState(store, context.getBackend(), shape)),
            }).toEqual({
              holder: "written",
              contender: entry.expected.outcome,
              ...expectedState(shape, entry.expected),
            });
            expect(await store.verifyConstraintFences()).toEqual([]);
          },
        );
      }
    }
  });
}
