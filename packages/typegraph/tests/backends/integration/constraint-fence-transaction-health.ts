/**
 * A refused constraint leaves the enclosing transaction USABLE (I4).
 *
 * The fence a claim provides is an upsert whose `RETURNING` reports the key's
 * owner, and the refusal is a decision made in application code from that
 * answer. That is not an implementation detail: the alternative shape — letting
 * the engine's own unique violation be the refusal — poisons the transaction on
 * PostgreSQL, where every subsequent statement fails with `25P02` ("current
 * transaction is aborted") until a rollback. A caller who catches a
 * `UniquenessError` inside `store.transaction(...)` and carries on writing
 * something unrelated is doing a reasonable thing, and it has to keep working.
 *
 * So each case provokes a refusal inside one transaction, catches it, writes
 * something unrelated, and commits — then asserts the unrelated write is
 * durable. A claim implemented as a bare `INSERT` would fail the follow-up
 * write on PostgreSQL and fail these cases with it.
 *
 * Both legs are covered, because they refuse from different places: the probe
 * (which reads before the write) and the claim (reached by blinding the probe,
 * so the upsert's verdict is what the caller sees).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  subClassOf,
  UniquenessError,
} from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
import { type IntegrationTestContext } from "./test-context";

const HEALTH_EMAIL_UNIQUE = {
  name: "fence_health_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const HealthWorker = defineNode("HealthWorker", {
  schema: z.object({ email: z.string() }),
});
const HealthEmployee = defineNode("HealthEmployee", {
  schema: z.object({ email: z.string() }),
});
const HealthContractor = defineNode("HealthContractor", {
  schema: z.object({ email: z.string() }),
});
/** Unconstrained, so the follow-up write asserts transaction health only. */
const HealthNote = defineNode("HealthNote", {
  schema: z.object({ body: z.string() }),
});

const healthGraph = defineGraph({
  id: "constraint_fence_transaction_health",
  nodes: {
    HealthWorker: { type: HealthWorker, unique: [HEALTH_EMAIL_UNIQUE] },
    HealthEmployee: { type: HealthEmployee, unique: [HEALTH_EMAIL_UNIQUE] },
    HealthContractor: { type: HealthContractor, unique: [HEALTH_EMAIL_UNIQUE] },
    HealthNote: { type: HealthNote },
  },
  edges: {},
  ontology: [
    subClassOf(HealthEmployee, HealthWorker),
    subClassOf(HealthContractor, HealthWorker),
  ],
});

/** The same backend with the uniqueness PROBE blinded, so the claim refuses. */
function backendWithoutUniquenessProbe(backend: GraphBackend): GraphBackend {
  // Over a PROJECTION, not over the store's own backend object: that one is
  // frozen, and a decoration Proxy cannot shadow a non-configurable member.
  // `projectGraphBackend` is the audited way to get an unfrozen copy.
  return deriveBackend(projectGraphBackend(backend), {
    checkUnique: () => Promise.resolve(undefined),
    checkUniqueBatch: () => Promise.resolve([]),
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              checkUnique: () => Promise.resolve(undefined),
              checkUniqueBatch: () => Promise.resolve([]),
            }),
          ),
        options,
      ),
  });
}

export function registerConstraintFenceTransactionHealthTests(
  context: IntegrationTestContext,
): void {
  describe("a refused constraint leaves its transaction usable", () => {
    it("keeps writing after the probe refuses a duplicate scoped key", async () => {
      const store = await context.createStore(healthGraph);
      await store.nodes.HealthEmployee.create(
        { email: "probe@health.example" },
        { id: "health-probe-incumbent" },
      );

      await store.transaction(async (tx) => {
        await expect(
          tx.nodes.HealthContractor.create(
            { email: "probe@health.example" },
            { id: "health-probe-challenger" },
          ),
        ).rejects.toThrow(UniquenessError);

        await tx.nodes.HealthNote.create(
          { body: "after the probe refusal" },
          { id: "health-probe-note" },
        );
      });

      expect(
        await store.nodes.HealthNote.getById("health-probe-note" as never),
      ).toMatchObject({ body: "after the probe refusal" });
      expect(
        await store.nodes.HealthContractor.getById(
          "health-probe-challenger" as never,
        ),
      ).toBeUndefined();
    });

    it("keeps writing after the CLAIM itself refuses one", async () => {
      // The leg that would break under a bare `INSERT` claim: the refusal now
      // comes from the upsert's reported owner rather than from a probe, and
      // it must still be a plain application decision inside a healthy
      // transaction.
      const store = await context.createStore(healthGraph);
      await store.nodes.HealthEmployee.create(
        { email: "claim@health.example" },
        { id: "health-claim-incumbent" },
      );

      const blindStore = createStore(
        healthGraph,
        backendWithoutUniquenessProbe(store.backend),
      );

      await blindStore.transaction(async (tx) => {
        await expect(
          tx.nodes.HealthContractor.create(
            { email: "claim@health.example" },
            { id: "health-claim-challenger" },
          ),
        ).rejects.toThrow(UniquenessError);

        await tx.nodes.HealthNote.create(
          { body: "after the claim refusal" },
          { id: "health-claim-note" },
        );
      });

      expect(
        await store.nodes.HealthNote.getById("health-claim-note" as never),
      ).toMatchObject({ body: "after the claim refusal" });
      expect(
        await store.nodes.HealthContractor.getById(
          "health-claim-challenger" as never,
        ),
      ).toBeUndefined();
      // The refused create's own claim is not left behind either: its
      // pre-insert reservation is compensated away, so the incumbent is still
      // the only live claimant of that key.
      const employees = await store.nodes.HealthEmployee.find();
      expect(employees.map((node) => node.id)).toEqual([
        "health-claim-incumbent",
      ]);
    });
  });
}
