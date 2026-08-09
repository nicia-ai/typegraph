/**
 * Cross-backend owner-scoped release of uniqueness claims (I7).
 *
 * A claim row records BOTH the axis it fences on (`node_kind`) and the node
 * that owns it (`concrete_kind`, `node_id`). Those two are equal for every row
 * the current code writes, so a release keyed on the axis and a release keyed
 * on the owner are indistinguishable on data this version produced — and a row
 * where they DIFFER is exactly what a claim written by a different version, or
 * at a pair axis, looks like. Every case here therefore seeds
 * `node_kind !== concrete_kind` directly through the backend, which is the only
 * way to tell the two predicates apart.
 *
 * The shapes, each with its own owner:
 *  - lifecycle release — every claim THIS node holds for a constraint and key,
 *    whatever axis it sits on;
 *  - the same release must NOT reach another node's claim for the same
 *    constraint and key;
 *  - compensating release — only the row a refused write itself claimed, at the
 *    axis it claimed on, leaving the same node's claim at another axis alone;
 *  - kind reaping — every claim the removed kind's nodes own, and nothing a
 *    surviving sibling owns.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GraphBackend } from "../../../src";
import {
  createStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
} from "../../../src";
import { computeUniqueKey } from "../../../src/constraints";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const EMPLOYEE_EMAIL_CONSTRAINT = "employee_email";

const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string() }),
});

const employeeGraph = defineGraph({
  id: "legacy_claim_axis",
  nodes: {
    Employee: {
      type: Employee,
      unique: [
        {
          name: EMPLOYEE_EMAIL_CONSTRAINT,
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

/**
 * A second kind that can hold the SAME id as an Employee: the nodes primary key
 * is (graph, kind, id), so `Employee "X"` and `Contractor "X"` are two nodes,
 * and their claims are two rows one release must tell apart.
 */
const Contractor = defineNode("Contractor", {
  schema: z.object({ email: z.string() }),
});

const NAMESAKE_EMAIL_UNIQUE = {
  name: EMPLOYEE_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

const namesakeGraph = defineGraph({
  id: "legacy_claim_axis_namesake",
  nodes: {
    Employee: { type: Employee, unique: [NAMESAKE_EMAIL_UNIQUE] },
    Contractor: { type: Contractor, unique: [NAMESAKE_EMAIL_UNIQUE] },
  },
  edges: {},
});

function emailKey(email: string): string {
  return computeUniqueKey({ email }, ["email"], "binary");
}

/**
 * Reads a claim row including tombstones, so a case can distinguish "released"
 * from "never there" — `checkUnique` without the flag hides both.
 */
async function readClaim(
  backend: GraphBackend,
  graphId: string,
  axis: string,
  constraintName: string,
  key: string,
): Promise<Readonly<{ nodeId: string; released: boolean }> | undefined> {
  const row = await backend.checkUnique({
    graphId,
    nodeKind: axis,
    constraintName,
    key,
    includeDeleted: true,
  });
  if (row === undefined) return undefined;
  return { nodeId: row.node_id, released: row.deleted_at !== undefined };
}

/**
 * A lower bound no stored row carries, so an UPDATE fenced on it matches zero
 * rows — the shape a concurrent hard delete and recreate leaves behind.
 */
const VANISHED_LOWER_BOUND = "1970-01-01T00:00:00.000Z";

/** A one-node document that moves an existing node onto a new email. */
function movingDocument(nodeId: string, email: string): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "compensating claim release" },
    nodes: [{ kind: "Employee", id: nodeId, properties: { email } }],
    edges: [],
  };
}

/**
 * The same backend, with ONE node's gated row write forced to match zero rows:
 * its UPDATE is re-issued carrying an `expectedValidFrom` the stored row does
 * not have, so the backend raises its own `no_row_returned` refusal on either
 * dialect rather than a synthetic error. That is how the gate legitimately
 * refuses — a peer moved the row's lower bound between the probe and the write —
 * and it is the failure the claim compensation exists for.
 *
 * Wrapped at `transaction` because the gated write runs against the transaction
 * backend rather than the outer one. Armed once per transaction and only for the
 * named node, so every other write the caller makes is untouched.
 */
function backendRefusingGatedRowWrite(
  backend: GraphBackend,
  nodeId: string,
): GraphBackend {
  const runTransaction = backend.transaction;
  return {
    ...backend,
    transaction: (run, options) =>
      runTransaction(async (target) => {
        const updateNode = target.updateNode;
        let armed = true;
        return run({
          ...target,
          updateNode: async (params) => {
            if (armed && params.id === nodeId) {
              armed = false;
              return updateNode({
                ...params,
                expectedValidFrom: VANISHED_LOWER_BOUND,
              });
            }
            return updateNode(params);
          },
        });
      }, options),
  };
}

/** Owner-scoped claim release and kind reaping, on every backend. */
export function registerLegacyClaimAxisIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("owner-scoped claim release", () => {
    it("releases a claim of this node whose axis is not this node's kind", async () => {
      const store = await context.createStore(employeeGraph);
      const backend = store.backend;
      const employee = await store.nodes.Employee.create({
        email: "ada@example.com",
      });
      const key = emailKey("ada@example.com");

      // A claim this node owns, fenced at an axis no current write produces.
      await backend.insertUnique({
        graphId: employeeGraph.id,
        nodeKind: "Root",
        constraintName: EMPLOYEE_EMAIL_CONSTRAINT,
        key,
        nodeId: employee.id,
        concreteKind: "Employee",
      });

      await store.nodes.Employee.delete(employee.id);

      const legacyClaim = requireDefined(
        await readClaim(
          backend,
          employeeGraph.id,
          "Root",
          EMPLOYEE_EMAIL_CONSTRAINT,
          key,
        ),
        "legacy-axis claim row",
      );
      expect(legacyClaim.released).toBe(true);
      const ownAxisClaim = requireDefined(
        await readClaim(
          backend,
          employeeGraph.id,
          "Employee",
          EMPLOYEE_EMAIL_CONSTRAINT,
          key,
        ),
        "own-axis claim row",
      );
      expect(ownAxisClaim.released).toBe(true);
    });

    it("leaves another node's claim for the same constraint and key alone", async () => {
      const store = await context.createStore(employeeGraph);
      const backend = store.backend;
      const key = emailKey("shared@example.com");

      // The incumbent's claim sits at an axis the probe does not visit, so the
      // second node can take the same key at its own axis. That is what makes
      // one node's release able to reach the other's row at all.
      const incumbent = await store.nodes.Employee.create({
        email: "ada@example.com",
      });
      await backend.insertUnique({
        graphId: employeeGraph.id,
        nodeKind: "Root",
        constraintName: EMPLOYEE_EMAIL_CONSTRAINT,
        key,
        nodeId: incumbent.id,
        concreteKind: "Employee",
      });

      const other = await store.nodes.Employee.create({
        email: "shared@example.com",
      });
      await store.nodes.Employee.delete(other.id);

      const incumbentClaim = requireDefined(
        await readClaim(
          backend,
          employeeGraph.id,
          "Root",
          EMPLOYEE_EMAIL_CONSTRAINT,
          key,
        ),
        "incumbent claim row",
      );
      expect(incumbentClaim.nodeId).toBe(incumbent.id);
      expect(incumbentClaim.released).toBe(false);
      const releasedClaim = requireDefined(
        await readClaim(
          backend,
          employeeGraph.id,
          "Employee",
          EMPLOYEE_EMAIL_CONSTRAINT,
          key,
        ),
        "releasing node's claim row",
      );
      expect(releasedClaim.nodeId).toBe(other.id);
      expect(releasedClaim.released).toBe(true);
    });

    it("leaves a namesake's claim under another kind alone", async () => {
      const store = await context.createStore(namesakeGraph);
      const backend = store.backend;
      const key = emailKey("namesake@example.com");

      // Same id, different kind: an owner-blind release matches this row on
      // (constraint, key) alone, and an id-keyed one matches it too. Only the
      // owner PAIR tells the two claims apart.
      const employee = await store.nodes.Employee.create(
        { email: "namesake@example.com" },
        { id: "namesake-x" },
      );
      await backend.insertUnique({
        graphId: namesakeGraph.id,
        nodeKind: "Root",
        constraintName: EMPLOYEE_EMAIL_CONSTRAINT,
        key,
        nodeId: employee.id,
        concreteKind: "Contractor",
      });

      await store.nodes.Employee.delete(employee.id);

      const namesakeClaim = requireDefined(
        await readClaim(
          backend,
          namesakeGraph.id,
          "Root",
          EMPLOYEE_EMAIL_CONSTRAINT,
          key,
        ),
        "namesake claim row",
      );
      expect(namesakeClaim.released).toBe(false);
      const ownClaim = requireDefined(
        await readClaim(
          backend,
          namesakeGraph.id,
          "Employee",
          EMPLOYEE_EMAIL_CONSTRAINT,
          key,
        ),
        "releasing node claim row",
      );
      expect(ownClaim.released).toBe(true);
    });

    it("gives back only the claim a refused write took, not this node's claim at another axis", async () => {
      const backend = context.getBackend();
      const employeeId = "employee-whose-update-is-refused";
      // The store writes through a backend that refuses this node's gated row
      // write; the claim rows are seeded and read through the real one.
      const [store] = await createStoreWithSchema(
        employeeGraph,
        backendRefusingGatedRowWrite(backend, employeeId),
      );
      const employee = await store.nodes.Employee.create(
        { email: "ada@example.com" },
        { id: employeeId },
      );
      const movedKey = emailKey("moved@example.com");

      // A live claim THIS node already owns for the key the refused write is
      // about to take, at an axis no current write produces. The probe does not
      // visit that axis, so the write claims the key at the node's own kind and
      // the rollback has two rows of one owner to tell apart — which is the only
      // thing separating "undo the row I took" from "give up every claim I hold
      // for this constraint and key".
      await backend.insertUnique({
        graphId: employeeGraph.id,
        nodeKind: "Root",
        constraintName: EMPLOYEE_EMAIL_CONSTRAINT,
        key: movedKey,
        nodeId: employee.id,
        concreteKind: "Employee",
      });

      const result = await importGraph(
        store,
        movingDocument(employee.id, "moved@example.com"),
        { onConflict: "update", batchSize: 1 },
      );

      // The gate refused, so the claim it gated was compensated — and the
      // refusal was per row, so everything else in the import committed.
      expect(result.nodes.updated).toBe(0);
      expect(result.errors.map((entry) => entry.id)).toEqual([employee.id]);

      // The pre-existing claim is not this write's to give back.
      const priorClaim = requireDefined(
        await readClaim(
          backend,
          employeeGraph.id,
          "Root",
          EMPLOYEE_EMAIL_CONSTRAINT,
          movedKey,
        ),
        "prior claim row at another axis",
      );
      expect(priorClaim.nodeId).toBe(employee.id);
      expect(priorClaim.released).toBe(false);

      // The row this write did take is given back.
      const compensatedClaim = requireDefined(
        await readClaim(
          backend,
          employeeGraph.id,
          "Employee",
          EMPLOYEE_EMAIL_CONSTRAINT,
          movedKey,
        ),
        "compensated claim row",
      );
      expect(compensatedClaim.nodeId).toBe(employee.id);
      expect(compensatedClaim.released).toBe(true);
    });
  });

  describe("kind removal reaps the claims that kind owns", () => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const baseGraph = defineGraph({
      id: "legacy_claim_axis_removal",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const partsExtension = defineGraphExtension({
      nodes: {
        Widget: { properties: { label: { type: "string" } } },
        Gadget: { properties: { label: { type: "string" } } },
      },
    });
    const LABEL_CONSTRAINT = "part_label";
    // A disjointness claim's axis is the unordered pair, not a kind — the shape
    // a `node_kind`-keyed reap can never match.
    const PAIR_AXIS = "disjoint(Gadget|Widget)";

    it("removes every claim the kind owns and no sibling's", async () => {
      const backend = context.getBackend();
      const [store] = await createStoreWithSchema(baseGraph, backend);
      const evolved = await store.evolve(partsExtension);
      const widget = await evolved
        .getNodeCollectionOrThrow("Widget")
        .create({ label: "doomed" });
      const gadget = await evolved
        .getNodeCollectionOrThrow("Gadget")
        .create({ label: "survivor" });

      // Owned by the removed kind, at its own axis.
      await backend.insertUnique({
        graphId: baseGraph.id,
        nodeKind: "Widget",
        constraintName: LABEL_CONSTRAINT,
        key: "doomed",
        nodeId: widget.id,
        concreteKind: "Widget",
      });
      // Owned by the removed kind, at an axis that is not a kind at all.
      await backend.insertUnique({
        graphId: baseGraph.id,
        nodeKind: PAIR_AXIS,
        constraintName: "typegraph_disjoint",
        key: widget.id,
        nodeId: widget.id,
        concreteKind: "Widget",
      });
      // Owned by a SURVIVING sibling, at the removed kind's axis.
      await backend.insertUnique({
        graphId: baseGraph.id,
        nodeKind: "Widget",
        constraintName: LABEL_CONSTRAINT,
        key: "survivor",
        nodeId: gadget.id,
        concreteKind: "Gadget",
      });

      const removed = await evolved.removeKinds(["Widget"]);
      const result = await removed.materializeRemovals();
      expect(result.results).toContainEqual({
        entity: "node",
        kind: "Widget",
        status: "removed",
      });

      await expect(
        readClaim(backend, baseGraph.id, "Widget", LABEL_CONSTRAINT, "doomed"),
      ).resolves.toBeUndefined();
      await expect(
        readClaim(
          backend,
          baseGraph.id,
          PAIR_AXIS,
          "typegraph_disjoint",
          widget.id,
        ),
      ).resolves.toBeUndefined();
      const siblingClaim = requireDefined(
        await readClaim(
          backend,
          baseGraph.id,
          "Widget",
          LABEL_CONSTRAINT,
          "survivor",
        ),
        "surviving sibling's claim row",
      );
      expect(siblingClaim.nodeId).toBe(gadget.id);
      expect(siblingClaim.released).toBe(false);
    });
  });
}
