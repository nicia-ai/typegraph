/**
 * A claim issued BEFORE the row it gates leaves zero net effect when that row
 * never lands (I6).
 *
 * Inverting the pre-insert group is what makes the claim a fence at all — a
 * reservation written after the row it is supposed to refuse cannot refuse
 * anything — but it also creates the failure mode the inversion has to pay for:
 * the reservation is taken, and then the write it was taken for does not
 * happen. Whoever catches that failure and carries on (interchange import, a
 * caller-managed transaction) must not be left with a key reserved for a row
 * that does not exist. Nothing else would ever release it: the lifecycle
 * release is driven by a node, and there is no node.
 *
 * The failure is injected rather than provoked, because every NATURAL failure
 * of this insert also rolls the transaction back, which would hide a missing
 * compensation. Here the caller catches inside a live transaction and keeps
 * writing, so the only thing that can free the key is the give-back itself.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode, subClassOf } from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
import { type IntegrationTestContext } from "./test-context";

const COMPENSATION_EMAIL_UNIQUE = {
  name: "compensation_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const CompWorker = defineNode("CompWorker", {
  schema: z.object({ email: z.string() }),
});
const CompEmployee = defineNode("CompEmployee", {
  schema: z.object({ email: z.string() }),
});
const CompContractor = defineNode("CompContractor", {
  schema: z.object({ email: z.string() }),
});

const compensationGraph = defineGraph({
  id: "constraint_claim_compensation",
  nodes: {
    CompWorker: { type: CompWorker, unique: [COMPENSATION_EMAIL_UNIQUE] },
    CompEmployee: { type: CompEmployee, unique: [COMPENSATION_EMAIL_UNIQUE] },
    CompContractor: {
      type: CompContractor,
      unique: [COMPENSATION_EMAIL_UNIQUE],
    },
  },
  edges: {},
  ontology: [
    subClassOf(CompEmployee, CompWorker),
    subClassOf(CompContractor, CompWorker),
  ],
});

const DOOMED_ID = "compensation-victim";
const INSERT_FAILURE = "injected node insert failure";

/**
 * The same backend whose node insert fails for ONE id — the gated write of the
 * claim seam, refusing after the reservation was taken and before the row
 * exists.
 */
function failingInsertNode(
  insert: GraphBackend["insertNode"],
): GraphBackend["insertNode"] {
  return async (params) => {
    if (params.id === DOOMED_ID) throw new Error(INSERT_FAILURE);
    return insert(params);
  };
}

function backendFailingOneInsert(backend: GraphBackend): GraphBackend {
  // Over a PROJECTION, not over the store's own backend object: that one is
  // frozen, and a decoration Proxy cannot shadow a non-configurable member.
  // `projectGraphBackend` is the audited way to get an unfrozen copy.
  return deriveBackend(projectGraphBackend(backend), {
    insertNode: failingInsertNode((params) => backend.insertNode(params)),
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              insertNode: failingInsertNode((params) =>
                target.insertNode(params),
              ),
            }),
          ),
        options,
      ),
  });
}

export function registerClaimCompensationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a pre-insert claim is given back when its row does not land", () => {
    it("frees the key for a sibling kind inside the same transaction", async () => {
      const store = await context.createStore(compensationGraph);
      const doomedStore = createStore(
        compensationGraph,
        backendFailingOneInsert(store.backend),
      );

      await doomedStore.transaction(async (tx) => {
        await expect(
          tx.nodes.CompEmployee.create(
            { email: "shared@compensation.example" },
            { id: DOOMED_ID },
          ),
        ).rejects.toThrow(INSERT_FAILURE);

        // The reservation the failed create took is gone, so the key is free
        // for a sibling kind on the same axis. Without the give-back this is
        // refused — permanently, since no node exists to release it.
        const survivor = await tx.nodes.CompContractor.create(
          { email: "shared@compensation.example" },
          { id: "compensation-survivor" },
        );
        expect(survivor.id).toBe("compensation-survivor");
      });

      const contractors = await store.nodes.CompContractor.find();
      expect(contractors.map((node) => node.email)).toEqual([
        "shared@compensation.example",
      ]);
      expect(await store.nodes.CompEmployee.find()).toEqual([]);
    });
  });
}
