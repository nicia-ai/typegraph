/**
 * Cross-backend importGraph uniqueness parity.
 *
 * Batch import primes a shared uniqueness pre-check cache ONCE per slice and
 * then routes each record (create vs onConflict:"update") against it. An
 * in-slice update mutates the real backend's uniqueness rows directly, so the
 * batched path must reconcile the cache with that mutation or it diverges from
 * the one-record-per-slice (sequential-equivalent) path:
 *
 *  - an update that FREES a unique value must let a later create claim it, and
 *  - an update that CLAIMS a free value must turn a later create of that value
 *    into a per-row error — never a flush-time constraint violation that
 *    throws and rolls back the whole import.
 *
 * These live in the shared suite so both SQLite and PostgreSQL certify the
 * same observable outcome (the batching path was previously SQLite-only).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  type NodeId,
  subClassOf,
} from "../../../src";
import { type GraphBackend } from "../../../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import {
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
} from "../../../src/store/claims/axis";
import { type IntegrationTestContext } from "./test-context";

const ImportPerson = defineNode("ImportPerson", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

// Each run gets its own graph id so the sequential (batchSize 1) and batched
// runs within one test are fully isolated on the shared backend — node rows
// are namespaced by graph_id, so distinct ids never see each other's writes.
function buildImportUniquenessGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: {
      ImportPerson: {
        type: ImportPerson,
        unique: [
          {
            name: "import_person_email",
            fields: ["email"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {},
  });
}

const ImportEmployee = defineNode("ImportEmployee", {
  schema: z.object({ email: z.string() }),
});
const ImportContractor = defineNode("ImportContractor", {
  schema: z.object({ email: z.string() }),
});
const ImportWorker = defineNode("ImportWorker", {
  schema: z.object({ email: z.string() }),
});

const SHARED_EMAIL_UNIQUE = {
  name: "import_staff_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

/**
 * A hierarchy, so one claim axis covers all three kinds — which is what makes
 * two rows sharing an id under DIFFERENT kinds contend for one claim row.
 */
function buildImportHierarchyGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: {
      ImportWorker: { type: ImportWorker, unique: [SHARED_EMAIL_UNIQUE] },
      ImportEmployee: { type: ImportEmployee, unique: [SHARED_EMAIL_UNIQUE] },
      ImportContractor: {
        type: ImportContractor,
        unique: [SHARED_EMAIL_UNIQUE],
      },
    },
    edges: {},
    ontology: [
      subClassOf(ImportEmployee, ImportWorker),
      subClassOf(ImportContractor, ImportWorker),
    ],
  });
}

const ImportHuman = defineNode("ImportHuman", {
  schema: z.object({ name: z.string() }),
});
const ImportOrg = defineNode("ImportOrg", {
  schema: z.object({ name: z.string() }),
});

/**
 * A disjoint pair and nothing else: no unique constraint anywhere, so the only
 * thing that can refuse a row here is the disjointness family.
 */
function buildImportDisjointGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: {
      ImportHuman: { type: ImportHuman },
      ImportOrg: { type: ImportOrg },
    },
    edges: {},
    ontology: [disjointWith(ImportHuman, ImportOrg)],
  });
}

const ImportAlpha = defineNode("ImportAlpha", {
  schema: z.object({ name: z.string() }),
});
const ImportBeta = defineNode("ImportBeta", {
  schema: z.object({ name: z.string() }),
});

/**
 * TWO unrelated disjoint pairs, so a single batch/slice can carry disjointness
 * entries for both. `ImportAlpha`/`ImportBeta`'s claim axis is the
 * alphabetically SMALLER of the two pair labels
 * (`disjointnessClaimAxis`/`disjointPairLabel` sort the pair's own kind
 * names), so its entry sorts BEFORE `ImportHuman`/`ImportOrg`'s in
 * `compareClaimTargets` order — load-bearing for the regression below, which
 * needs a matcher keyed on anything other than axis to name the WRONG pair.
 */
function buildImportTwoDisjointPairsGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: {
      ImportHuman: { type: ImportHuman },
      ImportOrg: { type: ImportOrg },
      ImportAlpha: { type: ImportAlpha },
      ImportBeta: { type: ImportBeta },
    },
    edges: {},
    ontology: [
      disjointWith(ImportHuman, ImportOrg),
      disjointWith(ImportAlpha, ImportBeta),
    ],
  });
}

/**
 * The same backend with the disjointness probe blinded for ONE kind:
 * `getNode` reports that kind's rows as absent, so a create whose partner is
 * that kind reaches its CLAIM instead of being refused by the app-level probe
 * — deterministically reproducing the window a genuine concurrent writer
 * would open between the probe and the claim.
 */
function backendWithHiddenKind(
  backend: GraphBackend,
  hiddenKind: string,
): GraphBackend {
  const getNode: GraphBackend["getNode"] = (graphId, kind, id) =>
    kind === hiddenKind ?
      Promise.resolve(undefined)
    : backend.getNode(graphId, kind, id);
  return {
    ...backend,
    getNode,
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run({
            ...target,
            getNode: (graphId, kind, id) =>
              kind === hiddenKind ?
                Promise.resolve(undefined)
              : target.getNode(graphId, kind, id),
          }),
        options,
      ),
  };
}

let graphIdCounter = 0;

function personId(id: string): NodeId<typeof ImportPerson> {
  return id as NodeId<typeof ImportPerson>;
}

function payload(nodes: GraphData["nodes"]): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "import uniqueness parity" },
    nodes,
    edges: [],
  };
}

function personNode(
  id: string,
  name: string,
  email: string,
): GraphData["nodes"][number] {
  return { kind: "ImportPerson", id, properties: { name, email } };
}

function options(batchSize: number): ImportOptions {
  return {
    onConflict: "update",
    onUnknownProperty: "error",
    validateReferences: true,
    batchSize,
    refreshStatistics: false,
  };
}

export function registerImportUniquenessIntegrationTests(
  context: IntegrationTestContext,
): void {
  // Hoisted to this scope (not inside `describe`) because it closes over
  // `context`; each call gets its own graph id so a test's sequential
  // (batchSize 1) and batched runs stay isolated on the shared backend.
  async function createGraphStore() {
    graphIdCounter += 1;
    const [store] = await createStoreWithSchema(
      buildImportUniquenessGraph(`import_uniqueness_parity_${graphIdCounter}`),
      context.getStore().backend,
    );
    return store;
  }

  describe("importGraph uniqueness parity", () => {
    it("in-slice update that frees a unique key lets a later create claim it", async () => {
      const outcomes = new Map<number, unknown>();
      for (const batchSize of [1, 100]) {
        const store = await createGraphStore();
        await importGraph(
          store,
          payload([personNode("free-a", "a", "shared@example.com")]),
          options(1),
        );
        const result = await importGraph(
          store,
          payload([
            personNode("free-a", "a2", "moved@example.com"),
            personNode("free-b", "b", "shared@example.com"),
          ]),
          options(batchSize),
        );
        const personA = await store.nodes.ImportPerson.getById(
          personId("free-a"),
        );
        const personB = await store.nodes.ImportPerson.getById(
          personId("free-b"),
        );
        outcomes.set(batchSize, {
          created: result.nodes.created,
          updated: result.nodes.updated,
          errorIds: result.errors.map((entry) => entry.id),
          emailA: personA?.email,
          emailB: personB?.email,
        });
      }

      const sequential = outcomes.get(1);
      const batched = outcomes.get(100);

      expect(sequential).toEqual({
        created: 1,
        updated: 1,
        errorIds: [],
        emailA: "moved@example.com",
        emailB: "shared@example.com",
      });
      expect(batched).toEqual(sequential);
    });

    it("in-slice update that claims a free unique key makes a later create a per-row error, not an import abort", async () => {
      const outcomes = new Map<number, unknown>();
      for (const batchSize of [1, 100]) {
        const store = await createGraphStore();
        await importGraph(
          store,
          payload([personNode("claim-a", "a", "a-orig@example.com")]),
          options(1),
        );
        const result = await importGraph(
          store,
          payload([
            personNode("claim-a", "a2", "target@example.com"),
            personNode("claim-c", "c", "target@example.com"),
          ]),
          options(batchSize),
        );
        const personA = await store.nodes.ImportPerson.getById(
          personId("claim-a"),
        );
        const personC = await store.nodes.ImportPerson.getById(
          personId("claim-c"),
        );
        outcomes.set(batchSize, {
          created: result.nodes.created,
          updated: result.nodes.updated,
          errors: result.errors.map((entry) => ({
            id: entry.id,
            matchesConstraint: entry.error.includes("import_person_email"),
          })),
          emailA: personA?.email,
          personCExists: personC !== undefined,
        });
      }

      const sequential = outcomes.get(1);
      const batched = outcomes.get(100);

      expect(sequential).toEqual({
        created: 0,
        updated: 1,
        errors: [{ id: "claim-c", matchesConstraint: true }],
        emailA: "target@example.com",
        personCExists: false,
      });
      expect(batched).toEqual(sequential);
    });

    it("in-slice create reserving a unique value makes a later update to it a per-row error, not an import abort", async () => {
      const outcomes = new Map<number, unknown>();
      for (const batchSize of [1, 100]) {
        const store = await createGraphStore();
        await importGraph(
          store,
          payload([personNode("inv-a", "a", "a-orig@example.com")]),
          options(1),
        );
        const result = await importGraph(
          store,
          payload([
            personNode("inv-b", "b", "target@example.com"),
            personNode("inv-a", "a2", "target@example.com"),
          ]),
          options(batchSize),
        );
        const personA = await store.nodes.ImportPerson.getById(
          personId("inv-a"),
        );
        const personB = await store.nodes.ImportPerson.getById(
          personId("inv-b"),
        );
        outcomes.set(batchSize, {
          created: result.nodes.created,
          updated: result.nodes.updated,
          errors: result.errors.map((entry) => ({
            id: entry.id,
            matchesConstraint: entry.error.includes("import_person_email"),
          })),
          emailA: personA?.email,
          emailB: personB?.email,
        });
      }

      const sequential = outcomes.get(1);
      const batched = outcomes.get(100);

      // Sequential creates B owning "target", then A's update to "target" is a
      // per-row uniqueness error (A keeps its original value). Batched must
      // match: the update's pre-check has to see B's still-unflushed
      // reservation instead of claiming the key and colliding at flush.
      expect(sequential).toEqual({
        created: 1,
        updated: 0,
        errors: [{ id: "inv-a", matchesConstraint: true }],
        emailA: "a-orig@example.com",
        emailB: "target@example.com",
      });
      expect(batched).toEqual(sequential);
    });
    it("refuses only the second of two same-id rows under different kinds in one slice", async () => {
      // Both rows carry the id "shared-x" and one shared-scope key. They are
      // two DIFFERENT nodes — the nodes primary key is (graph, kind, id) — so
      // the second must be a per-row refusal with the first committed, which is
      // only decidable if the in-batch owner is the PAIR and not the id.
      graphIdCounter += 1;
      const [store] = await createStoreWithSchema(
        buildImportHierarchyGraph(`import_same_id_kinds_${graphIdCounter}`),
        context.getStore().backend,
      );

      const result = await importGraph(
        store,
        payload([
          {
            kind: "ImportEmployee",
            id: "shared-x",
            properties: { email: "shared@example.com" },
          },
          {
            kind: "ImportContractor",
            id: "shared-x",
            properties: { email: "shared@example.com" },
          },
        ]),
        options(100),
      );

      expect(result.nodes.created).toBe(1);
      expect(
        result.errors.map((entry) => ({
          id: entry.id,
          matchesConstraint: entry.error.includes("import_staff_email"),
        })),
      ).toEqual([{ id: "shared-x", matchesConstraint: true }]);

      const employees = await store.nodes.ImportEmployee.find();
      const contractors = await store.nodes.ImportContractor.find();
      expect(employees).toHaveLength(1);
      expect(contractors).toHaveLength(0);
    });

    it("refuses only the second of two disjoint same-id rows in one slice", async () => {
      // Newly enforced: at HEAD an import ran no disjointness probe at all, so
      // BOTH rows committed and the graph carried a violation of an axiom it
      // declares. The refusal has to be per ROW — the first row committed, the
      // second reported — which is only true because the probe runs against the
      // pending-aware overlay inside the widened per-row guard. The claim behind
      // it is the fence for the concurrent case, and that one aborts the import.
      graphIdCounter += 1;
      const graph = buildImportDisjointGraph(
        `import_disjoint_slice_${graphIdCounter}`,
      );
      const [store] = await createStoreWithSchema(
        graph,
        context.getStore().backend,
      );

      const result = await importGraph(
        store,
        payload([
          {
            kind: "ImportHuman",
            id: "disjoint-x",
            properties: { name: "H" },
          },
          { kind: "ImportOrg", id: "disjoint-x", properties: { name: "O" } },
        ]),
        options(100),
      );

      expect(result.nodes.created).toBe(1);
      expect(
        result.errors.map((entry) => ({
          id: entry.id,
          isDisjointRefusal: entry.error.includes("Disjoint constraint"),
        })),
      ).toEqual([{ id: "disjoint-x", isDisjointRefusal: true }]);

      expect(await store.nodes.ImportHuman.find()).toHaveLength(1);
      expect(await store.nodes.ImportOrg.find()).toHaveLength(0);

      // The claim table holds exactly the accepted row's live claim: one
      // reservation on the PAIR axis, owned by the row that committed. Read
      // through the backend so nothing about it is inferred from the store.
      const claim = await context.getStore().backend.checkUnique({
        graphId: graph.id,
        nodeKind: disjointnessClaimAxis(
          "ImportHuman",
          "ImportOrg",
          store.registry,
        ),
        constraintName: DISJOINT_CONSTRAINT_NAME,
        key: "disjoint-x",
      });
      expect(claim).toMatchObject({
        concrete_kind: "ImportHuman",
        node_id: "disjoint-x",
      });
    });

    it("names the row that actually lost when two unrelated disjoint pairs share an id in one slice", async () => {
      // `mapClaimRefusal` (`store/claims/node-claims.ts`) locates the entry a
      // backend refusal belongs to. Every `disjointWith` pair shares the SAME
      // reserved `DISJOINT_CONSTRAINT_NAME`, so a matcher keyed on
      // `(constraintName, key)` alone cannot tell `ImportHuman`/`ImportOrg`'s
      // entry apart from `ImportAlpha`/`ImportBeta`'s when both claim the same
      // literal id in one batch — it would report whichever entry happens to
      // sort first, not the one the backend actually refused.
      //
      // `ImportOrg` "two-pairs-shared" is a live incumbent created BEFORE this
      // import, so `ImportHuman`'s row is the one that must lose; the probe is
      // blinded to `ImportOrg` so the CLAIM is what refuses it (the window a
      // genuine concurrent writer opens) rather than the app-level probe.
      // `ImportAlpha` shares nothing with either kind except the id and the
      // reserved constraint name, and its axis sorts BEFORE the colliding
      // pair's — the exact ordering that made the un-fixed matcher name it.
      graphIdCounter += 1;
      const graph = buildImportTwoDisjointPairsGraph(
        `import_disjoint_two_pairs_${graphIdCounter}`,
      );
      const [store] = await createStoreWithSchema(
        graph,
        context.getStore().backend,
      );
      await store.nodes.ImportOrg.create(
        { name: "O" },
        { id: "two-pairs-shared" },
      );

      const blindStore = createStore(
        graph,
        backendWithHiddenKind(context.getStore().backend, "ImportOrg"),
      );

      let caught: unknown;
      try {
        await importGraph(
          blindStore,
          payload([
            {
              kind: "ImportAlpha",
              id: "two-pairs-shared",
              properties: { name: "A" },
            },
            {
              kind: "ImportHuman",
              id: "two-pairs-shared",
              properties: { name: "H" },
            },
          ]),
          options(100),
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DisjointError);
      expect((caught as DisjointError).details).toEqual({
        nodeId: "two-pairs-shared",
        // The row that actually collided with the live `ImportOrg` — never
        // `ImportAlpha`, which the graph never even declared disjoint with
        // `ImportOrg`.
        attemptedKind: "ImportHuman",
        conflictingKind: "ImportOrg",
      });

      // The whole slice's claim statement rolled back with the refusal: no
      // half-committed row from either pair, and the incumbent untouched.
      expect(await store.nodes.ImportHuman.find()).toHaveLength(0);
      expect(await store.nodes.ImportAlpha.find()).toHaveLength(0);
      expect(await store.nodes.ImportOrg.find()).toHaveLength(1);
    });

    it("refuses a disjoint row on the per-row path after the slice flush", async () => {
      // The second `ImportOrg` repeats an id already seen in the slice, so it is
      // deferred to the per-row path, which probes against the REAL backend
      // rather than the overlay. Both rows must be refused, and neither may
      // leave the graph carrying a violation.
      graphIdCounter += 1;
      const graph = buildImportDisjointGraph(
        `import_disjoint_per_row_${graphIdCounter}`,
      );
      const [store] = await createStoreWithSchema(
        graph,
        context.getStore().backend,
      );

      await importGraph(
        store,
        payload([
          { kind: "ImportHuman", id: "deferred-y", properties: { name: "H" } },
        ]),
        options(100),
      );

      const result = await importGraph(
        store,
        payload([
          { kind: "ImportOrg", id: "deferred-y", properties: { name: "O1" } },
          { kind: "ImportOrg", id: "deferred-y", properties: { name: "O2" } },
        ]),
        options(100),
      );

      expect(result.nodes.created).toBe(0);
      expect(
        result.errors.map((entry) =>
          entry.error.includes("Disjoint constraint"),
        ),
      ).toEqual([true, true]);
      expect(await store.nodes.ImportOrg.find()).toHaveLength(0);
      expect(await store.nodes.ImportHuman.find()).toHaveLength(1);
    });
  });
}
