/**
 * THE STATEMENT-ORDER ORACLE.
 *
 * Lock acquisition and statement order cannot be asserted from the public API
 * — two writes that take their locks in opposite orders return the same rows —
 * so this file asserts them from the emitted SQL, for EVERY managed-write
 * entry point, as they behave TODAY. It is written before any call site moves
 * onto the write pipeline and is never edited again: a batch that needs it
 * edited has changed behavior, which the migration forbids.
 *
 * What every managed write must show, in this order:
 *
 *  1. the schema-version fence (`SELECT … FOR SHARE` on the active schema row),
 *  2. the per-graph write lock (`pg_advisory_xact_lock('typegraph:
 *     recorded-graph-write', …)`) — present exactly for a CONSTRAINED write,
 *     absent for one that declares nothing,
 *  3. the per-graph identity lock (`… hashtext('typegraph:identity') …`),
 *     where identity participates,
 *  4. row work.
 *
 * The second clause is as load-bearing as the first: a fence taken for every
 * write would be a lock the design does not claim and a cost nobody asked for,
 * so "absent when unconstrained" is asserted per row rather than assumed.
 *
 * Named mutations:
 *  - (a, bites today) move `await lockSchemaVersionForStoreWrite(ctx, target)`
 *    (`write-transaction.ts`) below the `const lock = acquiresLock ? await
 *    lockRecordedGraphWrite(…)` acquisition → every constrained row fails on
 *    the schema-fence ordering;
 *  - (b, bites today through the executor's own frame) move the executor's
 *    `acquireIdentityLock(target)` call after `rowWork` → the executor case
 *    fails;
 *  - (c, bites today through the executor's own frame) drop
 *    `fencesConstraintProbe: plan.constraintProbe` from
 *    `planTransactionOptions` → the executor's constrained case loses its
 *    advisory lock.
 * (b) and (c) become mutations of the production path from B1 onward, when the
 * call sites above run through the executor; the executor case below is what
 * makes them bite at B0 as well.
 *
 * PGlite plus drizzle's `logger`, following `constraint-write-fence.test.ts`.
 * ONE instance and ONE store for the whole table: instance creation plus DDL
 * costs about a second and the table is 20 cases wide, so it is paid once and
 * the statement log is cleared per case.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  rebuildIdentityClosure,
  subClassOf,
} from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { type GraphBackend } from "../src/backend/types";
import { lockIdentityGraph } from "../src/identity/service-read";
import {
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../src/interchange";
import { createSqlSchema } from "../src/query/compiler/schema";
import { buildKindRegistry } from "../src/registry";
import { type Store } from "../src/store";
import { runWritePlan } from "../src/store/operations/write-executor";
import { nodeWritePlan } from "../src/store/operations/write-plan";

const GRAPH_WRITE_NAMESPACE = "typegraph:recorded-graph-write";
const IDENTITY_NAMESPACE = "typegraph:identity";

type LoggedStatement = Readonly<{ query: string; params: readonly unknown[] }>;

const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Plain = defineNode("Plain", {
  schema: z.object({ name: z.string() }),
});
const Team = defineNode("Team", {
  schema: z.object({ name: z.string() }),
});
/** No unique, no disjointness axiom: a create that decides nothing. */
const Loose = defineNode("Loose", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", { schema: z.object({ note: z.string() }) });
const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

/** A shared-scope unique: the probe spans sibling kinds no single key backs. */
const SHARED_SCOPE_UNIQUE = {
  name: "shared_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const graph = defineGraph({
  id: "write_plan_statement_order",
  nodes: {
    Employee: { type: Employee, unique: [SHARED_SCOPE_UNIQUE] },
    Worker: { type: Worker, unique: [SHARED_SCOPE_UNIQUE] },
    Plain: { type: Plain },
    Team: { type: Team },
    Loose: { type: Loose },
  },
  edges: {
    knows: { type: knows, from: [Plain], to: [Plain], cardinality: "many" },
    reportsTo: {
      type: reportsTo,
      from: [Plain],
      to: [Plain],
      cardinality: "one",
    },
  },
  ontology: [subClassOf(Employee, Worker), disjointWith(Plain, Team)],
  identity: { sameIdAcrossKinds: "fold" },
});

const statements: LoggedStatement[] = [];

/**
 * The relation names the claim-placement matchers below look for, read from the
 * same schema builder the store uses rather than spelled as literals: a
 * configured table prefix would silently make a substring matcher match nothing,
 * and a matcher that matches nothing passes every "before" comparison it is not
 * guarded against.
 */
const SCHEMA_TABLES = {
  nodes: "typegraph_nodes",
  nodeUniques: "typegraph_node_uniques",
} as const;

let store: Store<typeof graph>;
let backend: GraphBackend;
let closeClient: () => Promise<void>;

/** Ids seeded once and reused; each case writes its own rows where it must. */
const SEEDED = {
  employee: "employee-seed",
  plainA: "plain-a",
  plainB: "plain-b",
  plainC: "plain-c",
  edge: "edge-seed",
  looseA: "loose-a",
  teamA: "team-a",
} as const;

const SEEDED_EDGE = asEdgeId<typeof knows>(SEEDED.edge);
const BULK_EDGE = asEdgeId<typeof knows>("edge-bulk");

beforeAll(async () => {
  const client = await PGlite.create();
  closeClient = () => client.close();
  await client.exec(generatePostgresDDL().join("\n\n"));
  backend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(query: string, params: unknown[]): void {
          statements.push({ query, params });
        },
      },
    }),
    { vector: false },
  );
  [store] = await createStoreWithSchema(graph, backend);

  await store.nodes.Employee.create(
    { email: "seed@example.com", name: "Seed" },
    { id: SEEDED.employee },
  );
  for (const id of [SEEDED.plainA, SEEDED.plainB, SEEDED.plainC]) {
    await store.nodes.Plain.create({ name: id }, { id });
  }
  await store.nodes.Loose.create({ name: "loose-a" }, { id: SEEDED.looseA });
  await store.nodes.Team.create({ name: "team-a" }, { id: SEEDED.teamA });
  await store.edges.knows.create(
    { kind: "Plain", id: SEEDED.plainA },
    { kind: "Plain", id: SEEDED.plainB },
    { note: "seed" },
    { id: SEEDED.edge },
  );
});

afterAll(async () => {
  await closeClient();
});

beforeEach(() => {
  statements.splice(0);
});

function indexOfAdvisoryLock(namespace: string): number {
  return statements.findIndex(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      (statement.params[0] === namespace ||
        statement.query.includes(`'${namespace}'`)),
  );
}

function countAdvisoryLocks(namespace: string): number {
  return statements.filter(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      (statement.params[0] === namespace ||
        statement.query.includes(`'${namespace}'`)),
  ).length;
}

function indexOfSchemaFence(): number {
  return statements.findIndex((statement) =>
    /for share/i.test(statement.query),
  );
}

/**
 * The first statement that WRITES a row — the work every lock above exists to
 * protect. Lock statements are `SELECT`s, so they cannot be mistaken for one.
 */
function indexOfFirstRowStatement(): number {
  return statements.findIndex((statement) =>
    /^\s*(insert|update|delete)/i.test(statement.query),
  );
}

type OrderCase = Readonly<{
  /** The managed-write entry point this drives. */
  entryPoint: string;
  run: () => Promise<unknown>;
  /** Per-graph write locks the write is expected to take. */
  graphWriteLocks: number;
  /** Whether identity participates in this write. */
  identityLock: boolean;
}>;

const CASES: readonly OrderCase[] = [
  {
    entryPoint: "node create (constrained: shared-scope unique)",
    run: () =>
      store.nodes.Employee.create({
        email: "create@example.com",
        name: "Created",
      }),
    graphWriteLocks: 1,
    identityLock: true,
  },
  {
    entryPoint: "node create (unconstrained)",
    run: () => store.nodes.Loose.create({ name: "loose" }),
    graphWriteLocks: 0,
    identityLock: true,
  },
  {
    entryPoint: "node create, no-return batch",
    run: () =>
      store.nodes.Plain.bulkInsert([
        { props: { name: "batch-1" }, id: "batch-1" },
      ]),
    graphWriteLocks: 1,
    identityLock: true,
  },
  {
    entryPoint: "node create batch",
    run: () =>
      store.nodes.Plain.bulkCreate([
        { props: { name: "batch-2" }, id: "batch-2" },
      ]),
    graphWriteLocks: 1,
    identityLock: true,
  },
  {
    entryPoint: "node update (constrained: shared-scope unique)",
    run: () =>
      store.nodes.Employee.update(asNodeId<typeof Employee>(SEEDED.employee), {
        name: "Renamed",
      }),
    graphWriteLocks: 1,
    // Identity participates in an update only when it RESURRECTS a tombstone:
    // a live-row update cannot change a node's kind, so nothing folds.
    identityLock: false,
  },
  {
    entryPoint: "node update (unconstrained)",
    run: () =>
      store.nodes.Plain.update(asNodeId<typeof Plain>(SEEDED.plainA), {
        name: "renamed",
      }),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "node updateWhere (set update)",
    run: () =>
      store.nodes.Plain.updateWhere({
        all: true,
        patch: { name: "set-updated" },
      }),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "node upsert update",
    run: () =>
      store.nodes.Plain.bulkUpsertById([
        { id: SEEDED.plainB, props: { name: "upserted" } },
      ]),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "node delete",
    run: () => store.nodes.Plain.delete(asNodeId<typeof Plain>("batch-1")),
    graphWriteLocks: 0,
    identityLock: true,
  },
  {
    entryPoint: "node delete batch",
    run: () =>
      store.nodes.Plain.bulkDelete([asNodeId<typeof Plain>("batch-2")]),
    graphWriteLocks: 0,
    identityLock: true,
  },
  {
    entryPoint: "node hard delete",
    run: () =>
      store.nodes.Plain.hardDelete(asNodeId<typeof Plain>(SEEDED.plainC)),
    graphWriteLocks: 0,
    identityLock: true,
  },
  {
    entryPoint: "edge create (constrained: cardinality one)",
    run: () =>
      store.edges.reportsTo.create(
        { kind: "Plain", id: SEEDED.plainA },
        { kind: "Plain", id: SEEDED.plainB },
        {},
      ),
    graphWriteLocks: 1,
    identityLock: false,
  },
  {
    entryPoint: "edge create (unconstrained: cardinality many)",
    run: () =>
      store.edges.knows.create(
        { kind: "Plain", id: SEEDED.plainA },
        { kind: "Plain", id: SEEDED.plainB },
        { note: "second" },
      ),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge create, no-return batch",
    run: () =>
      store.edges.knows.bulkInsert([
        {
          from: { kind: "Plain", id: SEEDED.plainA },
          to: { kind: "Plain", id: SEEDED.plainB },
          props: { note: "bulk-insert" },
        },
      ]),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge create batch",
    run: () =>
      store.edges.knows.bulkCreate([
        {
          from: { kind: "Plain", id: SEEDED.plainA },
          to: { kind: "Plain", id: SEEDED.plainB },
          props: { note: "bulk-create" },
          id: "edge-bulk",
        },
      ]),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge update",
    run: () => store.edges.knows.update(SEEDED_EDGE, { note: "updated" }),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge upsert update",
    run: () =>
      store.edges.knows.bulkUpsertById([
        {
          id: SEEDED_EDGE,
          from: { kind: "Plain", id: SEEDED.plainA },
          to: { kind: "Plain", id: SEEDED.plainB },
          props: { note: "upserted" },
        },
      ]),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge delete",
    run: () => store.edges.knows.delete(BULK_EDGE),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge delete batch",
    run: () => store.edges.knows.bulkDelete([SEEDED_EDGE]),
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge hard delete",
    run: async () => {
      const created = await store.edges.knows.create(
        { kind: "Plain", id: SEEDED.plainA },
        { kind: "Plain", id: SEEDED.plainB },
        { note: "to hard delete" },
        { id: "edge-hard" },
      );
      statements.splice(0);
      await store.edges.knows.hardDelete(created.id);
    },
    graphWriteLocks: 0,
    identityLock: false,
  },
  {
    entryPoint: "edge bulk getOrCreateByEndpoints",
    run: () =>
      store.edges.knows.bulkGetOrCreateByEndpoints([
        {
          from: { kind: "Plain", id: SEEDED.plainB },
          to: { kind: "Plain", id: SEEDED.plainA },
          props: { note: "converged" },
        },
      ]),
    graphWriteLocks: 1,
    identityLock: false,
  },
  {
    entryPoint: "interchange import",
    run: () =>
      importGraph(
        store,
        importDocument(),
        ImportOptionsSchema.parse({ onConflict: "skip" }),
      ),
    // Import declares NO constraint probe today, so it takes no per-graph
    // write lock even for a shared-scope-unique kind that the store's own
    // create path fences. Characterized, not endorsed: the batch that moves
    // import onto the executor must reproduce this exactly, and changing it
    // is a separate, deliberate decision.
    graphWriteLocks: 0,
    identityLock: true,
  },
  {
    entryPoint: "identity assertion (permanently allowlisted entry point)",
    run: () =>
      store.identity.assertSame(
        { kind: "Loose", id: SEEDED.looseA },
        { kind: "Team", id: SEEDED.teamA },
      ),
    graphWriteLocks: 0,
    identityLock: true,
  },
  {
    entryPoint:
      "identity closure rebuild (permanently allowlisted entry point)",
    run: () => rebuildIdentityClosure(store),
    graphWriteLocks: 0,
    identityLock: true,
  },
];

function importDocument(): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: "2024-01-01T00:00:00.000Z",
    source: { type: "external" },
    nodes: [
      {
        kind: "Employee",
        id: "imported-employee",
        properties: { email: "imported@example.com", name: "Imported" },
      },
    ],
    edges: [],
  };
}

describe("every managed write locks before it writes", () => {
  for (const orderCase of CASES) {
    it(`${orderCase.entryPoint} takes its locks in the canonical order`, async () => {
      await orderCase.run();

      // The per-graph write lock is taken for a CONSTRAINED write and for no
      // other: "absent when nothing was declared" is half the invariant.
      expect(countAdvisoryLocks(GRAPH_WRITE_NAMESPACE)).toBe(
        orderCase.graphWriteLocks,
      );
      // Identity participates exactly where the write folds or detaches.
      expect(indexOfAdvisoryLock(IDENTITY_NAMESPACE) >= 0).toBe(
        orderCase.identityLock,
      );

      // …and the statements this write DID emit appear in the canonical
      // order, ending with row work. Asserted as one sequence rather than as
      // per-position comparisons so a missing statement reads as a missing
      // step instead of as a passing comparison against -1.
      const acquired: readonly (readonly [string, number])[] = [
        ["schema fence", indexOfSchemaFence()],
        ...(orderCase.graphWriteLocks > 0 ?
          ([
            [
              "per-graph write lock",
              indexOfAdvisoryLock(GRAPH_WRITE_NAMESPACE),
            ],
          ] as const)
        : []),
        ...(orderCase.identityLock ?
          ([
            ["identity lock", indexOfAdvisoryLock(IDENTITY_NAMESPACE)],
          ] as const)
        : []),
        ["first row statement", indexOfFirstRowStatement()],
      ];

      expect(
        acquired.filter(([, index]) => index < 0).map(([label]) => label),
      ).toEqual([]);
      expect(acquired.map(([label]) => label)).toEqual(
        [...acquired]
          .toSorted(([, left], [, right]) => left - right)
          .map(([label]) => label),
      );
    });
  }
});

/**
 * The first statement that writes the CLAIM relation a node's declared
 * constraints reserve in. Both claim families live in `uniques`, so one matcher
 * covers uniqueness and disjointness alike.
 */
function indexOfClaimStatement(): number {
  return statements.findIndex(
    (statement) =>
      /^\s*insert/i.test(statement.query) &&
      statement.query.includes(SCHEMA_TABLES.nodeUniques),
  );
}

/** The first statement that writes the node row itself. */
function indexOfNodeRowStatement(): number {
  return statements.findIndex(
    (statement) =>
      /^\s*insert/i.test(statement.query) &&
      statement.query.includes(SCHEMA_TABLES.nodes),
  );
}

/**
 * THE PINNED COORDINATION ORDER where the write pipeline meets the claim
 * architecture: pre-insert claims, the row, post-insert claims, the sync fans.
 *
 * The lock table above cannot see this — it stops at "the first row statement" —
 * and neither design's own suites pin it either, because each was written
 * against a tree where the other half did not exist: the claim suites drive the
 * public API and assert OUTCOMES (who owns the axis, what error a loser gets),
 * and the pipeline suites assert which MEMBERS a fused unit reaches. The
 * placement is the one property that is neither, and it is the property the two
 * designs had to agree on: a claim issued after the row it fences is not a
 * fence, and a sync fan issued before the row can write derived data for a row
 * that never landed.
 *
 * Named mutation, verified to bite: invert the placement partition in
 * `withNodeCreateClaimsIssuedBy` (`claims/node-claims.ts`) so the post-insert
 * group is issued first → this case fails, because the claim then follows the
 * row it is supposed to gate.
 *
 * The other half of the pinned order — the sync fans FOLLOW the row — is pinned
 * in `session-sidecar-completeness.test.ts`, whose fixture actually declares a
 * searchable and an embedded field; this fixture's kinds declare neither, so a
 * case here would assert against a statement that is never emitted.
 */
describe("claims and row work keep their pinned order", () => {
  it("issues a pre-insert claim BEFORE the row it gates", async () => {
    // A `kindWithSubClasses` scope: the axis spans sibling kinds no single
    // primary key backs, which is exactly the claim that must precede its row.
    await store.nodes.Employee.create({
      email: "placement@example.com",
      name: "Placement",
    });

    const claim = indexOfClaimStatement();
    const row = indexOfNodeRowStatement();
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(row);
  });
});

describe("the executor's own frame keeps that order", () => {
  it("threads the plan's constraint probe and takes identity at position three", async () => {
    const identityLocks: number[] = [];

    await runWritePlan(
      {
        graphId: graph.id,
        registry: buildKindRegistry(graph),
        schemaVersion: store.introspect().schemaVersion,
        historyEnabled: false,
        revisionTrackingEnabled: false,
        revisionSchema: createSqlSchema(),
        // The real acquirer the node/edge contexts hand the executor.
        identityLock: async (target) => {
          identityLocks.push(statements.length);
          await lockIdentityGraph(target, graph.id);
        },
      },
      // A constrained plan with identity participation: the executor owns
      // BOTH decisions, so both are visible in one frame.
      nodeWritePlan("nodeUniquenessScope", true),
      backend,
      (session) =>
        session.createNode({
          params: {
            graphId: graph.id,
            kind: "Plain",
            id: "executor-node",
            props: { name: "executor" },
          },
          claim: {
            kind: "Plain",
            id: "executor-node",
            props: { name: "executor" },
            constraints: [],
          },
          sideEffects: {
            kind: "Plain",
            id: "executor-node",
            schema: Plain.schema,
            props: { name: "executor" },
            uniqueConstraints: [],
          },
        }),
    );

    const schemaFence = indexOfSchemaFence();
    const graphWriteLock = indexOfAdvisoryLock(GRAPH_WRITE_NAMESPACE);
    const identityLock = indexOfAdvisoryLock(IDENTITY_NAMESPACE);
    const firstRow = indexOfFirstRowStatement();

    // The probe came from the plan and nowhere else: dropping it from the
    // executor's options leaves this write unfenced.
    expect(countAdvisoryLocks(GRAPH_WRITE_NAMESPACE)).toBe(1);
    expect(schemaFence).toBeGreaterThanOrEqual(0);
    expect(graphWriteLock).toBeGreaterThan(schemaFence);
    // Identity is acquired BEFORE row work, not after it.
    expect(identityLock).toBeGreaterThan(graphWriteLock);
    expect(firstRow).toBeGreaterThan(identityLock);
    expect(identityLocks).toEqual([identityLock]);
  });
});
