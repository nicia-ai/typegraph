/**
 * Claim/fence overhead: an unconstrained write pays neither (I-ABSENT), and a
 * constrained write's per-claim cost is CONSTANT — isolated by differencing
 * so it never depends on the base statement cost or the lock count (I-CLAIM).
 *
 * The fixture graph mirrors `tests/perf/write-pipeline-statement-budget.
 * test.ts`'s (independently declared — see that file's module doc for why
 * this batch does not import between `*.test.ts` files): a shared-scope
 * hierarchy with one declared unique (`Employee`/`Worker`) and a second with
 * two (`Staff`/`StaffRoot`), a disjoint pair (`Plain`/`Team`), cardinality
 * `many`/`one` edges, and `identity: { sameIdAcrossKinds: "fold" }`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  type GraphBackend,
  subClassOf,
} from "../../src";
import { createSqlSchema } from "../../src/query/compiler/schema";
import {
  createRecordedPostgresStore,
  createRecordedSqliteStore,
  type LoggedStatement,
  type RecordedStore,
} from "../statement-recorder";
import { payloadCount, tallyStatements } from "./statement-classes";

// ============================================================
// Fixture graph
// ============================================================

const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Staff = defineNode("Staff", {
  schema: z.object({ email: z.string(), alias: z.string(), name: z.string() }),
});
const StaffRoot = defineNode("StaffRoot", {
  schema: z.object({ email: z.string(), alias: z.string(), name: z.string() }),
});
const Plain = defineNode("Plain", { schema: z.object({ name: z.string() }) });
const Team = defineNode("Team", { schema: z.object({ name: z.string() }) });
const Loose = defineNode("Loose", { schema: z.object({ name: z.string() }) });

const knows = defineEdge("knows", { schema: z.object({}) });
const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

const SHARED_EMAIL = {
  name: "shared_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;
const SHARED_EMAIL2 = {
  name: "shared_email2",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;
const SHARED_ALIAS2 = {
  name: "shared_alias2",
  fields: ["alias"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const fenceGraph = defineGraph({
  id: "perf_claim_fence_overhead",
  nodes: {
    Employee: { type: Employee, unique: [SHARED_EMAIL] },
    Worker: { type: Worker, unique: [SHARED_EMAIL] },
    Staff: { type: Staff, unique: [SHARED_EMAIL2, SHARED_ALIAS2] },
    StaffRoot: { type: StaffRoot, unique: [SHARED_EMAIL2, SHARED_ALIAS2] },
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
  ontology: [
    subClassOf(Employee, Worker),
    subClassOf(Staff, StaffRoot),
    disjointWith(Plain, Team),
  ],
  identity: { sameIdAcrossKinds: "fold" },
});

type FenceGraph = typeof fenceGraph;
type Dialect = "postgres" | "sqlite";
const DIALECTS: readonly Dialect[] = ["postgres", "sqlite"];

async function createRecordedStore(
  dialect: Dialect,
): Promise<RecordedStore<FenceGraph>> {
  return dialect === "postgres" ?
      createRecordedPostgresStore(fenceGraph, { schema: "committed" })
    : createRecordedSqliteStore(fenceGraph, { schema: "committed" });
}

function tablesFor(backend: GraphBackend) {
  return createSqlSchema(backend.tableNames).tables;
}

/** The single measured write's payload statement count (excludes SQLite's `transactionControl`). */
async function measurePayload(
  dialect: Dialect,
  run: (recorded: RecordedStore<FenceGraph>) => Promise<unknown>,
): Promise<number> {
  const recorded = await createRecordedStore(dialect);
  recorded.reset();
  await run(recorded);
  return payloadCount(
    tallyStatements(recorded.statements, tablesFor(recorded.backend)),
  );
}

// ============================================================
// Per-claim cost constants, justified by the differencing tests below.
// ============================================================

/** 2 scope-member probes + 1 claim insert — the single-row path issues one claim's statements individually. */
const PER_CLAIM_SINGLE_STATEMENTS = 3;

/**
 * PostgreSQL-only: `pg_advisory_xact_lock` calls whose namespace parameter is
 * the recorded graph-write key, as opposed to the identity lock (whose
 * namespace is inlined as literal SQL text, never a bound parameter — see
 * `lockIdentityGraph` in `src/identity/service-read.ts`). Mirrors
 * `graphWriteLockCount` in `tests/constraint-write-fence.test.ts`, the
 * existing owner of this exact distinction.
 */
const GRAPH_WRITE_NAMESPACE = "typegraph:recorded-graph-write";

function graphWriteLockCount(statements: readonly LoggedStatement[]): number {
  return statements.filter(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params[0] === GRAPH_WRITE_NAMESPACE,
  ).length;
}

let uniqueSuffix = 0;
function nextId(prefix: string): string {
  uniqueSuffix += 1;
  return `${prefix}-${uniqueSuffix}`;
}

/** A batch create's claim-only cost: constrained payload minus unconstrained, at one row count. */
async function batchClaimDelta(
  dialect: Dialect,
  rowCount: number,
): Promise<number> {
  const constrained = await measurePayload(dialect, (recorded) =>
    recorded.store.nodes.Staff.bulkCreate(
      Array.from({ length: rowCount }, (unused, index) => ({
        id: nextId(`batch-delta-staff-${rowCount}-${index}`),
        props: {
          email: `${nextId(`batch-delta-staff-email-${rowCount}-${index}`)}@example.com`,
          alias: nextId(`batch-delta-staff-alias-${rowCount}-${index}`),
          name: "Batch",
        },
      })),
    ),
  );
  const unconstrained = await measurePayload(dialect, (recorded) =>
    recorded.store.nodes.Loose.bulkCreate(
      Array.from({ length: rowCount }, (unused, index) => ({
        id: nextId(`batch-delta-loose-${rowCount}-${index}`),
        props: { name: "Batch" },
      })),
    ),
  );
  return constrained - unconstrained;
}

describe("claim-fence overhead", () => {
  for (const dialect of DIALECTS) {
    it(`${dialect}: an unconstrained create pays no fence and no claim`, async () => {
      const recorded = await createRecordedStore(dialect);
      recorded.reset();
      await recorded.store.nodes.Loose.create(
        { name: "fence-baseline" },
        { id: nextId("fence-baseline") },
      );

      const tally = tallyStatements(
        recorded.statements,
        tablesFor(recorded.backend),
      );
      expect(tally["nodeUniques:select"]).toBeUndefined();
      expect(tally["nodeUniques:insert"]).toBeUndefined();
      expect(tally["edgeClaims:insert"]).toBeUndefined();
      // `graphWriteLockCount` matches `pg_advisory_xact_lock` text that never
      // appears in a SQLite statement, so this holds unconditionally rather
      // than only under an `if (dialect === "postgres")` guard.
      expect(graphWriteLockCount(recorded.statements)).toBe(0);
    });
  }

  for (const dialect of DIALECTS) {
    it(`${dialect}: each declared unique adds a constant per-claim cost`, async () => {
      const baseline = await measurePayload(dialect, (recorded) =>
        recorded.store.nodes.Loose.create(
          { name: "delta-baseline" },
          { id: nextId("delta-baseline") },
        ),
      );
      const oneUnique = await measurePayload(dialect, (recorded) =>
        recorded.store.nodes.Employee.create(
          { email: `${nextId("delta-one")}@example.com`, name: "One" },
          { id: nextId("delta-one-node") },
        ),
      );
      const twoUniques = await measurePayload(dialect, (recorded) =>
        recorded.store.nodes.Staff.create(
          {
            email: `${nextId("delta-two")}@example.com`,
            alias: nextId("delta-two-alias"),
            name: "Two",
          },
          { id: nextId("delta-two-node") },
        ),
      );

      const deltaOne = oneUnique - baseline;
      const deltaTwo = twoUniques - baseline;
      expect(deltaTwo - deltaOne).toBe(PER_CLAIM_SINGLE_STATEMENTS);
    });
  }

  for (const dialect of DIALECTS) {
    it(`${dialect}: a batch pays per claim, not per row`, async () => {
      const deltaAt1 = await batchClaimDelta(dialect, 1);
      const deltaAt50 = await batchClaimDelta(dialect, 50);
      expect(deltaAt50).toBe(deltaAt1);
    }, 30_000);
  }

  for (const dialect of DIALECTS) {
    it(`${dialect}: a disjointness axiom costs exactly its declared claim`, async () => {
      const recorded = await createRecordedStore(dialect);
      recorded.reset();
      await recorded.store.nodes.Plain.create(
        { name: "disjoint-only" },
        { id: nextId("disjoint-only") },
      );

      const tally = tallyStatements(
        recorded.statements,
        tablesFor(recorded.backend),
      );
      expect(tally["nodeUniques:insert"]).toBe(1);
      expect(tally["nodeUniques:select"]).toBeUndefined();
      expect(tally["nodeUniques:update"]).toBeUndefined();
    });
  }

  for (const dialect of DIALECTS) {
    it(`${dialect}: an update that leaves the claimed field alone rewrites no claim`, async () => {
      const recorded = await createRecordedStore(dialect);
      const employee = await recorded.store.nodes.Employee.create(
        { email: `${nextId("untouched")}@example.com`, name: "Before" },
        { id: nextId("untouched-node") },
      );

      recorded.reset();
      await recorded.store.nodes.Employee.update(employee.id, {
        name: "After",
      });

      const tally = tallyStatements(
        recorded.statements,
        tablesFor(recorded.backend),
      );
      expect(tally["nodeUniques:select"]).toBeUndefined();
      expect(tally["nodeUniques:insert"]).toBeUndefined();
      expect(tally["nodeUniques:update"]).toBeUndefined();
    });

    it(`${dialect}: an update that moves a claimed value releases and reserves once`, async () => {
      const recorded = await createRecordedStore(dialect);
      const employee = await recorded.store.nodes.Employee.create(
        { email: `${nextId("moved")}@example.com`, name: "Mover" },
        { id: nextId("moved-node") },
      );

      recorded.reset();
      await recorded.store.nodes.Employee.update(employee.id, {
        email: `${nextId("moved-target")}@example.com`,
      });

      const tally = tallyStatements(
        recorded.statements,
        tablesFor(recorded.backend),
      );
      expect(tally["nodeUniques:insert"]).toBe(1);
      expect(tally["nodeUniques:update"]).toBe(1);
    });
  }

  it("postgres: only a constrained write takes the per-graph write fence", async () => {
    const unconstrained = await createRecordedStore("postgres");
    unconstrained.reset();
    await unconstrained.store.nodes.Loose.create(
      { name: "lock-baseline" },
      { id: nextId("lock-baseline") },
    );
    expect(graphWriteLockCount(unconstrained.statements)).toBe(0);

    const constrained = await createRecordedStore("postgres");
    constrained.reset();
    await constrained.store.nodes.Employee.create(
      { email: `${nextId("lock-constrained")}@example.com`, name: "Locked" },
      { id: nextId("lock-constrained-node") },
    );
    expect(graphWriteLockCount(constrained.statements)).toBe(1);
  });
});
