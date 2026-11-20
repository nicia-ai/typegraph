/**
 * Claim ownership has ONE definition and three renderers (I11).
 *
 * A claim row records who holds it as the pair `(concrete_kind, node_id)`,
 * because ids are unique only per kind: `Employee "X"` and `Contractor "X"` are
 * two nodes, and a scope spanning both makes them contend for one claim row.
 * Three layers answer "is this row mine?" — the TypeScript predicate, the SQL
 * arms of the two upsert builders, and the batch-validation cache that answers
 * from memory for rows not yet flushed — and a disagreement between any two of
 * them is a silently accepted double claim.
 *
 * The table below is the whole contract: four incumbent/proposer shapes, and
 * for each one the ownership verdict every renderer must produce plus whether
 * the claim is accepted. Liveness is deliberately separate from ownership: a
 * TOMBSTONED incumbent is a released reservation, so a different owner takes it
 * over even though the owners differ — that arm belongs to the builders, and
 * pinning it here is what stops the ownership fix from being "read" as a
 * liveness fix.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  subClassOf,
  UniquenessError,
} from "../../../src";
import { projectGraphBackend } from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import {
  type ClaimOwner,
  isSameClaimOwner,
  uniquenessClaimAxis,
} from "../../../src/store/claims/axis";
import { createNodeBatchValidationSeams } from "../../../src/store/operations/node-operations";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const STAFF_EMAIL_CONSTRAINT = "claim_owner_staff_email";

const STAFF_EMAIL_UNIQUE = {
  name: STAFF_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string() }),
});
const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string() }),
});
const Contractor = defineNode("Contractor", {
  schema: z.object({ email: z.string() }),
});

const ownerGraph = defineGraph({
  id: "claim_owner_identity",
  nodes: {
    Worker: { type: Worker, unique: [STAFF_EMAIL_UNIQUE] },
    Employee: { type: Employee, unique: [STAFF_EMAIL_UNIQUE] },
    Contractor: { type: Contractor, unique: [STAFF_EMAIL_UNIQUE] },
  },
  edges: {},
  ontology: [subClassOf(Employee, Worker), subClassOf(Contractor, Worker)],
});

const registry = buildKindRegistry(ownerGraph);
/** Every kind in the hierarchy folds here, which is what makes them collide. */
const AXIS = uniquenessClaimAxis("Employee", "kindWithSubClasses", registry);

function emailKey(email: string): string {
  return computeUniqueKey({ email }, ["email"], "binary");
}

type OwnerCell = Readonly<{
  name: string;
  incumbent: ClaimOwner;
  proposed: ClaimOwner;
  /** Whether the incumbent's claim is released before the proposal. */
  incumbentReleased: boolean;
  /** What every renderer must say about the two owners. */
  sameOwner: boolean;
  /** Whether the proposal is admitted once liveness is taken into account. */
  accepted: boolean;
}>;

const CELLS: readonly OwnerCell[] = [
  {
    name: "the same node re-claiming its own key",
    incumbent: { concreteKind: "Employee", nodeId: "owner-same" },
    proposed: { concreteKind: "Employee", nodeId: "owner-same" },
    incumbentReleased: false,
    sameOwner: true,
    accepted: true,
  },
  {
    name: "the same id under a different kind",
    incumbent: { concreteKind: "Employee", nodeId: "owner-shared-id" },
    proposed: { concreteKind: "Contractor", nodeId: "owner-shared-id" },
    incumbentReleased: false,
    sameOwner: false,
    accepted: false,
  },
  {
    name: "a different id under the same kind",
    incumbent: { concreteKind: "Employee", nodeId: "owner-first" },
    proposed: { concreteKind: "Employee", nodeId: "owner-second" },
    incumbentReleased: false,
    sameOwner: false,
    accepted: false,
  },
  {
    name: "a tombstoned incumbent under a different kind",
    incumbent: { concreteKind: "Employee", nodeId: "owner-tombstoned" },
    proposed: { concreteKind: "Contractor", nodeId: "owner-tombstoned" },
    incumbentReleased: true,
    sameOwner: false,
    accepted: true,
  },
];

/** Seeds the incumbent's claim at the axis, releasing it when the cell says so. */
async function seedIncumbentClaim(
  backend: GraphBackend,
  graphId: string,
  cell: OwnerCell,
  key: string,
): Promise<void> {
  await backend.insertUnique({
    graphId,
    nodeKind: AXIS,
    constraintName: STAFF_EMAIL_CONSTRAINT,
    key,
    nodeId: cell.incumbent.nodeId,
    concreteKind: cell.incumbent.concreteKind,
  });
  if (!cell.incumbentReleased) return;
  await backend.deleteUnique({
    graphId,
    constraintName: STAFF_EMAIL_CONSTRAINT,
    key,
    concreteKind: cell.incumbent.concreteKind,
    nodeId: cell.incumbent.nodeId,
  });
}

/** Ownership as the layer under test reported it, for one uniform assertion. */
function claimOwnerOfRow(
  row: Readonly<{ node_id: string; concrete_kind: string }>,
): ClaimOwner {
  return { concreteKind: row.concrete_kind, nodeId: row.node_id };
}

/**
 * A claim attempt's verdict as data, so every cell asserts the SAME shape
 * unconditionally: a branch per cell would let an arm silently assert nothing.
 */
type ClaimVerdict = Readonly<{
  accepted: boolean;
  refusedBy?: Readonly<{ kind: string; existingId: string }>;
}>;

async function claimVerdict(claim: () => Promise<void>): Promise<ClaimVerdict> {
  try {
    await claim();
    return { accepted: true };
  } catch (error) {
    if (!(error instanceof UniquenessError)) throw error;
    return {
      accepted: false,
      refusedBy: {
        kind: error.details.kind,
        existingId: error.details.existingId,
      },
    };
  }
}

/** What every SQL renderer must answer for a cell, refusal payload included. */
function expectedVerdict(cell: OwnerCell): ClaimVerdict {
  if (cell.accepted) return { accepted: true };
  return {
    accepted: false,
    // The refusal names the HOLDER's kind, not the axis the row sits at.
    refusedBy: {
      kind: cell.incumbent.concreteKind,
      existingId: cell.incumbent.nodeId,
    },
  };
}

export function registerClaimOwnerIdentityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("claim owner identity", () => {
    for (const cell of CELLS) {
      it(`agrees on ${cell.name}`, async () => {
        const store = await context.createStore(ownerGraph);
        const backend = store.backend;
        // Every renderer gets its own key, so three seeded incumbents never
        // read as one another on the suite's shared backend.
        const email = `${cell.proposed.nodeId}@example.com`;
        const key = emailKey(email);

        // Renderer 1 — the TypeScript predicate.
        expect(isSameClaimOwner(cell.incumbent, cell.proposed)).toBe(
          cell.sameOwner,
        );

        // Renderer 2a — the single-row upsert's CASE arms and RETURNING.
        await seedIncumbentClaim(backend, ownerGraph.id, cell, key);
        const singleVerdict = await claimVerdict(() =>
          backend.insertUnique({
            graphId: ownerGraph.id,
            nodeKind: AXIS,
            constraintName: STAFF_EMAIL_CONSTRAINT,
            key,
            nodeId: cell.proposed.nodeId,
            concreteKind: cell.proposed.concreteKind,
          }),
        );
        expect(singleVerdict).toEqual(expectedVerdict(cell));

        // Renderer 2b — the batch upsert, against `excluded`, in a statement
        // that also carries an unrelated row so the multi-row form is real.
        const batchKey = emailKey(`batch-${email}`);
        await seedIncumbentClaim(backend, ownerGraph.id, cell, batchKey);
        const insertUniqueBatch = requireDefined(
          backend.insertUniqueBatch,
          "insertUniqueBatch",
        );
        const batchVerdict = await claimVerdict(() =>
          insertUniqueBatch([
            {
              graphId: ownerGraph.id,
              nodeKind: AXIS,
              constraintName: STAFF_EMAIL_CONSTRAINT,
              key: batchKey,
              nodeId: cell.proposed.nodeId,
              concreteKind: cell.proposed.concreteKind,
            },
            {
              graphId: ownerGraph.id,
              nodeKind: AXIS,
              constraintName: STAFF_EMAIL_CONSTRAINT,
              key: emailKey(`fresh-${email}`),
              nodeId: "owner-fresh",
              concreteKind: "Employee",
            },
          ]),
        );
        expect(batchVerdict).toEqual(expectedVerdict(cell));

        // Renderer 3 — the batch-validation cache, answering for a claim no
        // statement has written yet. A pending claim is live by construction,
        // so this renderer answers the OWNERSHIP half of the cell.
        const pendingEmail = `pending-${email}`;
        const seams = createNodeBatchValidationSeams(
          ownerGraph.id,
          registry,
          // A fresh projection, not the store's own backend object: that one is
          // frozen, and an overlay Proxy cannot shadow a non-configurable
          // member. `projectGraphBackend` is the audited way to get an unfrozen
          // copy — a spread would build a backend the serialized-resource audit
          // does not follow (#435).
          projectGraphBackend(backend),
        );
        seams.registerPendingUniqueEntries(
          cell.incumbent.concreteKind,
          cell.incumbent.nodeId,
          { email: pendingEmail },
          [STAFF_EMAIL_UNIQUE],
        );
        const pendingRow = requireDefined(
          await seams.reader.checkUnique({
            graphId: ownerGraph.id,
            nodeKind: AXIS,
            constraintName: STAFF_EMAIL_CONSTRAINT,
            key: emailKey(pendingEmail),
          }),
          "pending claim row",
        );
        expect(
          isSameClaimOwner(claimOwnerOfRow(pendingRow), cell.proposed),
        ).toBe(cell.sameOwner);
      });
    }

    it("refuses two owners of one target inside a single batch statement", async () => {
      // A multi-row upsert cannot affect one row twice, so the batch collapses
      // entries that share a conflict target before issuing. Collapsing on the
      // id alone would fold a namesake under another kind into the first
      // entry's claim and accept both — the same hole the row-level arms
      // refuse, one statement earlier.
      const store = await context.createStore(ownerGraph);
      const insertUniqueBatch = requireDefined(
        store.backend.insertUniqueBatch,
        "insertUniqueBatch",
      );
      const key = emailKey("in-statement@example.com");

      const verdict = await claimVerdict(() =>
        insertUniqueBatch([
          {
            graphId: ownerGraph.id,
            nodeKind: AXIS,
            constraintName: STAFF_EMAIL_CONSTRAINT,
            key,
            nodeId: "owner-in-statement",
            concreteKind: "Employee",
          },
          {
            graphId: ownerGraph.id,
            nodeKind: AXIS,
            constraintName: STAFF_EMAIL_CONSTRAINT,
            key,
            nodeId: "owner-in-statement",
            concreteKind: "Contractor",
          },
        ]),
      );

      expect(verdict).toEqual({
        accepted: false,
        refusedBy: { kind: "Employee", existingId: "owner-in-statement" },
      });
    });
  });
}
