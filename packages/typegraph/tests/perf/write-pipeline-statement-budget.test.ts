/**
 * Statement-count budgets for the managed write pipeline: every operation in
 * {@link BUDGET_CASES} issues an exact, enumerated multiset of statement
 * classes (I-COUNT), and a batch's statement count does not grow with row
 * count inside one bind chunk (I-BATCH).
 *
 * The fixture graph deliberately mirrors `tests/write-plan-statement-order.
 * test.ts`'s `graph` — a shared-scope-unique hierarchy (`Employee`/`Worker`),
 * cardinality `many`/`one` edges, `identity: { sameIdAcrossKinds: "fold" }` —
 * because that shape is what makes the oracle's coverage list
 * (`scanOracleEntryPoints`) a meaningful thing to compare this fixture against
 * (test 4 below). It is declared independently rather than imported: the
 * oracle file is frozen ("never edited again", its own header), and this
 * fixture additionally needs an own-kind unique, a second shared-scope
 * hierarchy (for the 1-unique vs 2-unique differencing in
 * `claim-fence-overhead.test.ts`), and a disjointness pair the oracle's graph
 * does not carry under those exact names.
 *
 * Every case creates its OWN recorded store (`createRecordedPostgresStore` /
 * `createRecordedSqliteStore`), matching `tests/constraint-write-fence.
 * test.ts`'s convention: `tests/statement-recorder.ts`'s `afterEach` closes
 * whatever client a test opened, so a store shared across `it()` blocks would
 * be closed out from under the second one.
 *
 * `schema: "committed"` is used throughout (`createStoreWithSchema`): an
 * unmanaged store's `schemaVersion` is `undefined`, so
 * `lockSchemaVersionForStoreWrite` returns before issuing anything and every
 * budget below would silently omit the schema-version fence.
 *
 * Ids are passed explicitly on every create in these fixtures — measured, not
 * incidental: `identity.foldCreated`'s cross-kind fold probe
 * (`foldReferences` in `src/store/operations/node-operations.ts`) filters to
 * `prepared.idProvided`, so an auto-generated id skips the fold's OWN second
 * `lockIdentityGraph` + closure-membership SELECT entirely and would
 * undercount every identity-participating budget by two statements.
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
  type RecordedPostgresStore,
  type RecordedStore,
} from "../statement-recorder";
import { scanOracleEntryPoints } from "./inventory";
import {
  classifyStatement,
  payloadCount,
  type StatementClass,
  type StatementKey,
  type StatementTally,
  type StatementVerb,
  tallyStatements,
} from "./statement-classes";

// ============================================================
// Fixture graph
// ============================================================

const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
/** A second shared-scope hierarchy, with TWO uniques instead of one. */
const Staff = defineNode("Staff", {
  schema: z.object({ email: z.string(), alias: z.string(), name: z.string() }),
});
const StaffRoot = defineNode("StaffRoot", {
  schema: z.object({ email: z.string(), alias: z.string(), name: z.string() }),
});
/** `scope: "kind"` — its own primary key is the fence; no per-graph lock. */
const OwnUnique = defineNode("OwnUnique", {
  schema: z.object({ email: z.string() }),
});
/** Disjoint with `Team`; declares no unique of its own. */
const Plain = defineNode("Plain", { schema: z.object({ name: z.string() }) });
const Team = defineNode("Team", { schema: z.object({ name: z.string() }) });
/** Declares nothing: the unconstrained baseline. */
const Loose = defineNode("Loose", { schema: z.object({ name: z.string() }) });

const knows = defineEdge("knows", { schema: z.object({ note: z.string() }) });
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
const OWN_EMAIL = {
  name: "own_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

export const perfWriteBudgetGraph = defineGraph({
  id: "perf_write_pipeline_statement_budget",
  nodes: {
    Employee: { type: Employee, unique: [SHARED_EMAIL] },
    Worker: { type: Worker, unique: [SHARED_EMAIL] },
    Staff: { type: Staff, unique: [SHARED_EMAIL2, SHARED_ALIAS2] },
    StaffRoot: { type: StaffRoot, unique: [SHARED_EMAIL2, SHARED_ALIAS2] },
    OwnUnique: { type: OwnUnique, unique: [OWN_EMAIL] },
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

export type PerfWriteBudgetGraph = typeof perfWriteBudgetGraph;

export type Dialect = "postgres" | "sqlite";
export const DIALECTS: readonly Dialect[] = ["postgres", "sqlite"];

export async function createRecordedStore(
  dialect: Dialect,
): Promise<RecordedStore<PerfWriteBudgetGraph>> {
  if (dialect === "postgres") {
    // `RecordedPostgresStore` is `RecordedStore`'s original name, kept as an
    // alias for existing callers — named explicitly here rather than left an
    // always-inferred type, so this is a real reader of it, not just a
    // signature nobody exercises.
    const recorded: RecordedPostgresStore<PerfWriteBudgetGraph> =
      await createRecordedPostgresStore(perfWriteBudgetGraph, {
        schema: "committed",
      });
    return recorded;
  }
  return createRecordedSqliteStore(perfWriteBudgetGraph, {
    schema: "committed",
  });
}

export function tablesFor(backend: GraphBackend) {
  return createSqlSchema(backend.tableNames).tables;
}

// ============================================================
// Pinned budgets (§5 of the batch spec) — one entry per (operation, dialect),
// each tally re-measured against this exact fixture (see the commit body for
// the measurement script). Every class present is enumerated; a class this
// tree drops or gains shows up as a missing/extra key against `toEqual`, not
// as a silently passing inequality.
// ============================================================

export type BudgetedOperation =
  | "node create, no constraints"
  | "node create, 1 shared-scope unique"
  | "node create, 2 shared-scope uniques"
  | "node create, disjointness axiom only"
  | "node create, own-kind unique"
  | "node bulkCreate N=50, 2 uniques"
  | "node bulkCreate N=200, no constraints"
  | "node update, non-claimed field"
  | "node update, moves a claimed value"
  | "node delete, no claims"
  | "node delete, 2 claims"
  | "edge create, cardinality many"
  | "edge create, cardinality one"
  | "edge update"
  | "edge delete";

export const BUDGETS: Readonly<
  Record<BudgetedOperation, Readonly<Record<Dialect, StatementTally>>>
> = {
  // schemaFence(1) + identity lock ×2 (executor + foldCreated, per the
  // module doc's "double advisory lock" note) + nodes:select ×2 (existence
  // probe + fold's closure-membership read) + nodes:insert(1).
  "node create, no constraints": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 2,
      "nodes:select": 2,
      "nodes:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "nodes:insert": 1,
    },
  },
  // No-constraints tally, PLUS the graph-write fence(1, PostgreSQL only) and
  // the shared-scope claim: 2 scope-member probes (Employee + Worker) + 1
  // post-insert-fused... no — a SINGLE-row create issues claims individually
  // (`issueClaimsIndividually`), so ONE claim is ONE probe pair + ONE insert.
  "node create, 1 shared-scope unique": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 3,
      "nodes:select": 2,
      "nodeUniques:select": 2,
      "nodeUniques:insert": 1,
      "nodes:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "nodeUniques:select": 2,
      "nodeUniques:insert": 1,
      "nodes:insert": 1,
    },
  },
  // Two declared uniques, same 2-kind scope: 4 probes (2 per claim) and TWO
  // separate inserts — the single-row path issues one INSERT per claim, so
  // this is the 1-unique tally plus exactly one more (2 probes + 1 insert),
  // pinning PER_CLAIM_SINGLE_STATEMENTS = 3 (see `claim-fence-overhead.
  // test.ts`).
  "node create, 2 shared-scope uniques": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 3,
      "nodes:select": 2,
      "nodeUniques:select": 4,
      "nodeUniques:insert": 2,
      "nodes:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "nodeUniques:select": 4,
      "nodeUniques:insert": 2,
      "nodes:insert": 1,
    },
  },
  // Disjointness reserves in the SAME `uniques` relation as uniqueness (see
  // `CONSTRAINT_FENCE_BACKING.nodeDisjointness` in `src/store/claims/
  // backing.ts`): one extra `nodes:select` (the cross-kind existence probe
  // against the disjoint partner kind) and one `nodeUniques:insert`
  // (the disjointness claim), no `nodeUniques:select` (the probe is a node
  // read, not a uniques-table read).
  "node create, disjointness axiom only": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 3,
      "nodes:select": 3,
      "nodeUniques:insert": 1,
      "nodes:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 3,
      "nodeUniques:insert": 1,
      "nodes:insert": 1,
    },
  },
  // `scope: "kind"` — the uniques primary key IS the fence, so no per-graph
  // lock: one probe (its own kind only, not a 2-kind scope) and one
  // post-insert claim insert.
  "node create, own-kind unique": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 2,
      "nodes:select": 2,
      "nodeUniques:select": 1,
      "nodes:insert": 1,
      "nodeUniques:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "nodeUniques:select": 1,
      "nodes:insert": 1,
      "nodeUniques:insert": 1,
    },
  },
  // A batch FUSES every row's claims of one placement group into ONE
  // statement — the 2-uniques single-row tally's `nodeUniques:insert: 2`
  // collapses to `1` here, at any N (see the row-count-independence test).
  "node bulkCreate N=50, 2 uniques": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 3,
      "nodes:select": 2,
      "nodeUniques:select": 4,
      "nodeUniques:insert": 1,
      "nodes:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "nodeUniques:select": 4,
      "nodeUniques:insert": 1,
      "nodes:insert": 1,
    },
  },
  "node bulkCreate N=200, no constraints": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 2,
      "nodes:select": 2,
      "nodes:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "nodes:insert": 1,
    },
  },
  // A shared-scope kind still takes the graph-write fence on update even
  // when no claimed key changes (the fence is kind-scoped, not value-scoped
  // — see `nodeWriteNeedsConstraintFence`'s doc). No identity lock: an
  // in-place update cannot change a node's kind, so nothing folds.
  "node update, non-claimed field": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 1,
      "nodes:select": 1,
      "nodes:update": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 1,
      "nodes:update": 1,
    },
  },
  // The non-claimed-field tally, plus the transition: probe the new key (2
  // scope-member probes), claim it (1 insert), then release the old one (1
  // update) once the row write lands.
  "node update, moves a claimed value": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 1,
      "nodes:select": 1,
      "nodeUniques:select": 2,
      "nodeUniques:insert": 1,
      "nodes:update": 1,
      "nodeUniques:update": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 1,
      "nodeUniques:select": 2,
      "nodeUniques:insert": 1,
      "nodes:update": 1,
      "nodeUniques:update": 1,
    },
  },
  // A soft delete: read the row, probe outgoing/incoming edges for the
  // restrict/cascade/disconnect decision (one UNION ALL statement,
  // classified `edges:select`), soft-delete the row, then identity's detach
  // path (its OWN `lockIdentityGraph` + the two identity-relation reads) —
  // the delete-side twin of create's `foldCreated` double lock. SQLite
  // issues one MORE `nodes:select` than PostgreSQL here (the characterized
  // quirk `AGENTS.md`/the batch spec's §8 leaves unfixed); pinned as
  // measured.
  "node delete, no claims": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 2,
      "nodes:select": 1,
      "edges:select": 1,
      "nodes:update": 1,
      "identityAssertions:select": 1,
      "identityClosure:select": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "edges:select": 1,
      "nodes:update": 1,
      "identityAssertions:select": 1,
      "identityClosure:select": 1,
    },
  },
  // The no-claims delete tally, plus one release (`nodeUniques:update`) per
  // held claim — two, for Staff's two shared-scope uniques.
  "node delete, 2 claims": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 2,
      "nodes:select": 1,
      "edges:select": 1,
      "nodes:update": 1,
      "nodeUniques:update": 2,
      "identityAssertions:select": 1,
      "identityClosure:select": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "edges:select": 1,
      "nodes:update": 1,
      "nodeUniques:update": 2,
      "identityAssertions:select": 1,
      "identityClosure:select": 1,
    },
  },
  // `many` declares no constraint: no lock, no claim, just the two endpoint
  // existence probes and the row insert.
  "edge create, cardinality many": {
    postgres: {
      "schemaFence:select": 1,
      "nodes:select": 2,
      "edges:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "edges:insert": 1,
    },
  },
  // `one` is constrained: the graph-write fence, the two endpoint probes,
  // the cardinality COUNT probe (`edges:select`), the claim
  // (`edgeClaims:insert`), then the row.
  "edge create, cardinality one": {
    postgres: {
      "schemaFence:select": 1,
      "advisoryLock:select": 1,
      "nodes:select": 2,
      "edges:select": 1,
      "edgeClaims:insert": 1,
      "edges:insert": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "nodes:select": 2,
      "edges:select": 1,
      "edgeClaims:insert": 1,
      "edges:insert": 1,
    },
  },
  // Edges carry no identity and `knows` declares no constraint, so an update
  // is just schema fence, read, write. SQLite issues one more `edges:select`
  // than PostgreSQL (characterized, not fixed here — see the no-claims
  // delete note above for the sibling quirk on the node side).
  "edge update": {
    postgres: {
      "schemaFence:select": 1,
      "edges:select": 1,
      "edges:update": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "edges:select": 2,
      "edges:update": 1,
    },
  },
  // A soft delete on an unconstrained edge: no read-back on PostgreSQL, one
  // `edges:select` on SQLite before the `UPDATE ... SET deleted_at`
  // (classified `edges:update`, not `edges:delete` — soft delete is an
  // UPDATE statement on every dialect).
  "edge delete": {
    postgres: {
      "schemaFence:select": 1,
      "edges:update": 1,
    },
    sqlite: {
      "transactionControl:other": 2,
      "schemaFence:select": 1,
      "edges:select": 1,
      "edges:update": 1,
    },
  },
};

// ============================================================
// Cases: each does its own (unmeasured) setup, resets, then issues the ONE
// write `BUDGETS[operation]` pins.
// ============================================================

type BudgetCaseContext = Readonly<{
  store: RecordedStore<PerfWriteBudgetGraph>["store"];
  reset: () => void;
}>;

type BudgetCase = Readonly<{
  operation: BudgetedOperation;
  run: (ctx: BudgetCaseContext) => Promise<void>;
}>;

const BUDGET_CASES: readonly BudgetCase[] = [
  {
    operation: "node create, no constraints",
    run: async ({ store, reset }) => {
      reset();
      await store.nodes.Loose.create(
        { name: "budget" },
        { id: "budget-loose-create" },
      );
    },
  },
  {
    operation: "node create, 1 shared-scope unique",
    run: async ({ store, reset }) => {
      reset();
      await store.nodes.Employee.create(
        { email: "budget-employee@example.com", name: "Budget Employee" },
        { id: "budget-employee-create" },
      );
    },
  },
  {
    operation: "node create, 2 shared-scope uniques",
    run: async ({ store, reset }) => {
      reset();
      await store.nodes.Staff.create(
        {
          email: "budget-staff@example.com",
          alias: "budget-staff-alias",
          name: "Budget Staff",
        },
        { id: "budget-staff-create" },
      );
    },
  },
  {
    operation: "node create, disjointness axiom only",
    run: async ({ store, reset }) => {
      reset();
      await store.nodes.Plain.create(
        { name: "budget-plain" },
        { id: "budget-plain-create" },
      );
    },
  },
  {
    operation: "node create, own-kind unique",
    run: async ({ store, reset }) => {
      reset();
      await store.nodes.OwnUnique.create(
        { email: "budget-own@example.com" },
        { id: "budget-own-create" },
      );
    },
  },
  {
    operation: "node bulkCreate N=50, 2 uniques",
    run: async ({ store, reset }) => {
      reset();
      await store.nodes.Staff.bulkCreate(
        Array.from({ length: 50 }, (unused, index) => ({
          id: `budget-staff-bulk-${index}`,
          props: {
            email: `budget-staff-bulk-${index}@example.com`,
            alias: `budget-staff-bulk-alias-${index}`,
            name: "Bulk",
          },
        })),
      );
    },
  },
  {
    operation: "node bulkCreate N=200, no constraints",
    run: async ({ store, reset }) => {
      reset();
      await store.nodes.Loose.bulkCreate(
        Array.from({ length: 200 }, (unused, index) => ({
          id: `budget-loose-bulk-${index}`,
          props: { name: "Bulk" },
        })),
      );
    },
  },
  {
    operation: "node update, non-claimed field",
    run: async ({ store, reset }) => {
      const employee = await store.nodes.Employee.create(
        { email: "budget-employee-update@example.com", name: "Before" },
        { id: "budget-employee-update" },
      );
      reset();
      await store.nodes.Employee.update(employee.id, { name: "After" });
    },
  },
  {
    operation: "node update, moves a claimed value",
    run: async ({ store, reset }) => {
      const employee = await store.nodes.Employee.create(
        { email: "budget-employee-move@example.com", name: "Mover" },
        { id: "budget-employee-move" },
      );
      reset();
      await store.nodes.Employee.update(employee.id, {
        email: "budget-employee-moved@example.com",
      });
    },
  },
  {
    operation: "node delete, no claims",
    run: async ({ store, reset }) => {
      const loose = await store.nodes.Loose.create(
        { name: "budget-loose-delete" },
        { id: "budget-loose-delete" },
      );
      reset();
      await store.nodes.Loose.delete(loose.id);
    },
  },
  {
    operation: "node delete, 2 claims",
    run: async ({ store, reset }) => {
      const staff = await store.nodes.Staff.create(
        {
          email: "budget-staff-delete@example.com",
          alias: "budget-staff-delete-alias",
          name: "Deleted",
        },
        { id: "budget-staff-delete" },
      );
      reset();
      await store.nodes.Staff.delete(staff.id);
    },
  },
  {
    operation: "edge create, cardinality many",
    run: async ({ store, reset }) => {
      const from = await store.nodes.Plain.create(
        { name: "budget-plain-many-from" },
        { id: "budget-plain-many-from" },
      );
      const to = await store.nodes.Plain.create(
        { name: "budget-plain-many-to" },
        { id: "budget-plain-many-to" },
      );
      reset();
      await store.edges.knows.create(
        from,
        to,
        { note: "budget" },
        {
          id: "budget-knows-create",
        },
      );
    },
  },
  {
    operation: "edge create, cardinality one",
    run: async ({ store, reset }) => {
      const from = await store.nodes.Plain.create(
        { name: "budget-plain-one-from" },
        { id: "budget-plain-one-from" },
      );
      const to = await store.nodes.Plain.create(
        { name: "budget-plain-one-to" },
        { id: "budget-plain-one-to" },
      );
      reset();
      await store.edges.reportsTo.create(
        from,
        to,
        {},
        {
          id: "budget-reports-to-create",
        },
      );
    },
  },
  {
    operation: "edge update",
    run: async ({ store, reset }) => {
      const from = await store.nodes.Plain.create(
        { name: "budget-plain-update-from" },
        { id: "budget-plain-update-from" },
      );
      const to = await store.nodes.Plain.create(
        { name: "budget-plain-update-to" },
        { id: "budget-plain-update-to" },
      );
      const edge = await store.edges.knows.create(
        from,
        to,
        { note: "before" },
        {
          id: "budget-knows-update",
        },
      );
      reset();
      await store.edges.knows.update(edge.id, { note: "after" });
    },
  },
  {
    operation: "edge delete",
    run: async ({ store, reset }) => {
      const from = await store.nodes.Plain.create(
        { name: "budget-plain-delete-from" },
        { id: "budget-plain-delete-from" },
      );
      const to = await store.nodes.Plain.create(
        { name: "budget-plain-delete-to" },
        { id: "budget-plain-delete-to" },
      );
      const edge = await store.edges.knows.create(
        from,
        to,
        { note: "gone" },
        {
          id: "budget-knows-delete",
        },
      );
      reset();
      await store.edges.knows.delete(edge.id);
    },
  },
];

// ============================================================
// scanOracleEntryPoints() coverage — every entry the oracle names is either
// budgeted here or exempted, with a stated reason.
// ============================================================

/**
 * Oracle entry points this batch's budgets cover. Literal strings from
 * `tests/write-plan-statement-order.test.ts`'s own `entryPoint:` values —
 * `tests/perf/perf-fixture-inventory.test.ts` checks this set against a live
 * scan of that file, so a rename there is a failure here, not a silent gap.
 */
export const BUDGETED_ENTRY_POINTS: readonly string[] = [
  "node create (constrained: shared-scope unique)",
  "node create (unconstrained)",
  "node create batch",
  "node update (constrained: shared-scope unique)",
  "node delete",
  "edge create (constrained: cardinality one)",
  "edge create (unconstrained: cardinality many)",
  "edge update",
  "edge delete",
];

/**
 * Every oracle entry point NOT in {@link BUDGETED_ENTRY_POINTS}, each with the
 * reason this batch does not pin it — the applied-or-refused rule for the
 * inventory invariant (I-INVENTORY): a gap is named, never silent.
 */
export const ORACLE_COVERAGE_EXEMPTIONS: Readonly<Record<string, string>> = {
  "node create, no-return batch":
    "bulkInsert omits RETURNING but issues the identical statement sequence as the budgeted `node create batch` case; no separate class to pin.",
  "node update (unconstrained)":
    "the budgeted constrained update's tally minus the graph-write fence, the claim probe and the claim insert — no statement class this fixture does not already pin elsewhere.",
  "node updateWhere (set update)":
    "a distinct bulk code path (set-update, no per-row claim diff) this fixture does not exercise.",
  "node upsert update":
    "the resurrect/upsert path has its own statement shape (tombstone revival), not exercised by this batch's create/update/delete cases.",
  "node delete batch":
    "this batch's row-count-independence claim (I-BATCH) is scoped to CREATE batching; delete batching is not separately pinned.",
  "node hard delete":
    "hard delete purges claim rows through a distinct statement (`hardDeleteClaimsByNodeIds`) this batch's soft-delete-focused cases do not exercise.",
  "edge create, no-return batch":
    "bulkInsert omits RETURNING but issues the identical statement sequence as an edge batch create; no separate class to pin.",
  "edge create batch":
    "an edge batch create's claim-fusion shape mirrors the node batch case already budgeted; not separately pinned here.",
  "edge upsert update":
    "the resurrect/upsert path has its own statement shape, not exercised by this batch's create/update/delete cases.",
  "edge delete batch":
    "this batch's row-count-independence claim (I-BATCH) is scoped to CREATE batching; delete batching is not separately pinned.",
  "edge hard delete":
    "hard delete purges the edge claim row through a distinct statement this batch's soft-delete-focused cases do not exercise.",
  "edge bulk getOrCreateByEndpoints":
    "a convergence-probe path with its own fence semantics (`edgeMatchKeyConvergence`), out of this batch's create/update/delete scope.",
  "interchange import":
    "import's claim statement shape is already asserted by `tests/constraint-claim-inventory.test.ts`; out of this batch's scope.",
  "identity assertion (permanently allowlisted entry point)":
    "an explicit identity-service entry point, not a node/edge write-pipeline operation this batch's budgets model.",
  "identity closure rebuild (permanently allowlisted entry point)":
    "an explicit identity-service entry point, not a node/edge write-pipeline operation this batch's budgets model.",
};

describe("write-pipeline statement budgets", () => {
  for (const dialect of DIALECTS) {
    for (const budgetCase of BUDGET_CASES) {
      it(`${dialect}: ${budgetCase.operation} issues exactly its pinned statements`, async () => {
        const recorded = await createRecordedStore(dialect);
        await budgetCase.run({ store: recorded.store, reset: recorded.reset });

        const tally = tallyStatements(
          recorded.statements,
          tablesFor(recorded.backend),
        );
        const unclassified = Object.keys(tally).filter((key) =>
          key.startsWith("other:"),
        );
        expect(unclassified).toEqual([]);
        expect(tally).toEqual(BUDGETS[budgetCase.operation][dialect]);
      });
    }
  }

  const ROW_COUNTS = [1, 25, 200] as const;

  for (const dialect of DIALECTS) {
    it(`${dialect}: a batch's statement count does not grow with row count`, async () => {
      const constrainedPayloads: number[] = [];
      const unconstrainedPayloads: number[] = [];

      for (const rowCount of ROW_COUNTS) {
        const constrained = await createRecordedStore(dialect);
        constrained.reset();
        await constrained.store.nodes.Staff.bulkCreate(
          Array.from({ length: rowCount }, (unused, index) => ({
            id: `scale-staff-${rowCount}-${index}`,
            props: {
              email: `scale-staff-${rowCount}-${index}@example.com`,
              alias: `scale-staff-alias-${rowCount}-${index}`,
              name: "Scale",
            },
          })),
        );
        constrainedPayloads.push(
          payloadCount(
            tallyStatements(
              constrained.statements,
              tablesFor(constrained.backend),
            ),
          ),
        );

        const unconstrained = await createRecordedStore(dialect);
        unconstrained.reset();
        await unconstrained.store.nodes.Loose.bulkCreate(
          Array.from({ length: rowCount }, (unused, index) => ({
            id: `scale-loose-${rowCount}-${index}`,
            props: { name: "Scale" },
          })),
        );
        unconstrainedPayloads.push(
          payloadCount(
            tallyStatements(
              unconstrained.statements,
              tablesFor(unconstrained.backend),
            ),
          ),
        );
      }

      const [firstConstrained] = constrainedPayloads;
      const [firstUnconstrained] = unconstrainedPayloads;
      expect(constrainedPayloads).toEqual(
        constrainedPayloads.map(() => firstConstrained),
      );
      expect(unconstrainedPayloads).toEqual(
        unconstrainedPayloads.map(() => firstUnconstrained),
      );
    }, 30_000);
  }

  for (const dialect of DIALECTS) {
    it(`${dialect}: an own-kind unique still writes its post-insert claim`, async () => {
      const recorded = await createRecordedStore(dialect);
      recorded.reset();
      await recorded.store.nodes.OwnUnique.create(
        { email: `own-kind-claim-${dialect}@example.com` },
        { id: `own-kind-claim-${dialect}` },
      );

      const tally = tallyStatements(
        recorded.statements,
        tablesFor(recorded.backend),
      );
      expect(tally["nodeUniques:insert"]).toBe(1);
      expect(tally).toEqual(BUDGETS["node create, own-kind unique"][dialect]);
    });
  }

  it("budgets or exempts every managed-write entry point the statement-order oracle names", () => {
    const oracleEntryPoints = scanOracleEntryPoints();

    // A scan that matches nothing must fail loudly, not read as "nothing to
    // cover" — the oracle names 24 entry points today.
    expect(oracleEntryPoints.length).toBeGreaterThanOrEqual(20);

    const covered = new Set([
      ...BUDGETED_ENTRY_POINTS,
      ...Object.keys(ORACLE_COVERAGE_EXEMPTIONS),
    ]);
    expect(new Set(oracleEntryPoints)).toEqual(covered);
  });
});

describe("classifyStatement", () => {
  const tables = createSqlSchema().tables;

  function classOf(query: string): StatementClass {
    const key: StatementKey = classifyStatement({ query, params: [] }, tables);
    const [statementClass] = key.split(":") as [StatementClass, StatementVerb];
    return statementClass;
  }

  function verbOf(query: string): StatementVerb {
    const key = classifyStatement({ query, params: [] }, tables);
    const [, verb] = key.split(":") as [StatementClass, StatementVerb];
    return verb;
  }

  it("classifies transaction control ahead of every relation match", () => {
    expect(classOf("BEGIN IMMEDIATE")).toBe("transactionControl");
    expect(classOf("  commit")).toBe("transactionControl");
    expect(verbOf("BEGIN IMMEDIATE")).toBe("other");
  });

  it("classifies an advisory lock call regardless of which relation it names", () => {
    expect(
      classOf(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`),
    ).toBe("advisoryLock");
  });

  it("classifies the schema-versions fence read", () => {
    expect(classOf(`SELECT * FROM "typegraph_schema_versions" WHERE ...`)).toBe(
      "schemaFence",
    );
  });

  it("classifies every relation this batch's classes name, by the live table names", () => {
    expect(classOf(`SELECT * FROM "${tables.nodes}" WHERE ...`)).toBe("nodes");
    expect(classOf(`SELECT * FROM "${tables.edges}" WHERE ...`)).toBe("edges");
    expect(classOf(`SELECT * FROM "${tables.uniques}" WHERE ...`)).toBe(
      "nodeUniques",
    );
    expect(classOf(`SELECT * FROM "${tables.edgeClaims}" WHERE ...`)).toBe(
      "edgeClaims",
    );
    expect(
      classOf(`SELECT * FROM "${tables.identityAssertions}" WHERE ...`),
    ).toBe("identityAssertions");
    expect(classOf(`SELECT * FROM "${tables.identityClosure}" WHERE ...`)).toBe(
      "identityClosure",
    );
  });

  it("classifies an unmatched statement as other, never silently as one of the named classes", () => {
    expect(classOf("SELECT 1")).toBe("other");
  });

  it("reads each SQL verb off the statement text", () => {
    expect(verbOf(`INSERT INTO "${tables.nodes}" ...`)).toBe("insert");
    expect(verbOf(`UPDATE "${tables.nodes}" ...`)).toBe("update");
    expect(verbOf(`DELETE FROM "${tables.nodes}" ...`)).toBe("delete");
    expect(verbOf("VACUUM")).toBe("other");
  });
});
