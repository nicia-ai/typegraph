/**
 * A set update refused inside `store.transaction()` leaves nothing behind.
 *
 * `updateWhere` and `compareAndSet` read and lock their rows in a dry-run,
 * validate every after-image it returns, and only then write exactly those
 * rows. A refusal — the schema, the normalization check, the uniqueness
 * verdict across the resolved set — is raised before the write. A caller that
 * catches it and lets its transaction commit must find the database — rows,
 * recorded history, the receipt, hooks and every sidecar — exactly as it was
 * before the call (#948). Each case checks the whole end state in one
 * assertion.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  embedding,
  type GraphBackend,
  searchable,
  UniquenessError,
  ValidationError,
} from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import {
  rowPropsToObject,
  type TransactionBackend,
} from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { DatabaseOperationError } from "../../../src/errors";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../../src/query/sql-intent";
import { buildKindRegistry } from "../../../src/registry";
import { uniquenessClaimAxis } from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const SET_UPDATE_VERBS = ["updateWhere", "compareAndSet"] as const;

/** An enterprise account needs an owner: a cross-field refinement. */
function enterpriseNeedsOwner(
  account: Readonly<{
    plan: "free" | "enterprise";
    ownerId?: string | undefined;
  }>,
): boolean {
  return account.plan !== "enterprise" || account.ownerId !== undefined;
}

const OWNER_REFINEMENT = {
  path: ["ownerId"],
  message: "enterprise accounts need an owner",
};

const REFUSAL_NAME_UNIQUE = {
  name: "set_update_refusal_name",
  fields: ["name"],
  scope: "kind",
  collation: "binary",
} as const;

const RefusalAccount = defineNode("RefusalAccount", {
  schema: z
    .object({
      name: z.string(),
      plan: z.enum(["free", "enterprise"]),
      ownerId: z.string().optional(),
    })
    .refine((account) => enterpriseNeedsOwner(account), OWNER_REFINEMENT),
});

const refusalGraph = defineGraph({
  id: "set_update_refusal",
  nodes: {
    RefusalAccount: { type: RefusalAccount, unique: [REFUSAL_NAME_UNIQUE] },
  },
  edges: {},
});

const refusalRegistry = buildKindRegistry(refusalGraph);

const SearchAccount = defineNode("SearchAccount", {
  schema: z
    .object({
      plan: z.enum(["free", "enterprise"]),
      ownerId: z.string().optional(),
      bio: searchable({ language: "english" }),
    })
    .refine((account) => enterpriseNeedsOwner(account), OWNER_REFINEMENT),
});

const searchRefusalGraph = defineGraph({
  id: "set_update_refusal_fulltext",
  nodes: { SearchAccount: { type: SearchAccount } },
  edges: {},
});

const VectorAccount = defineNode("VectorAccount", {
  schema: z
    .object({
      plan: z.enum(["free", "enterprise"]),
      ownerId: z.string().optional(),
      vector: embedding(4),
    })
    .refine((account) => enterpriseNeedsOwner(account), OWNER_REFINEMENT),
});

const vectorRefusalGraph = defineGraph({
  id: "set_update_refusal_vector",
  nodes: { VectorAccount: { type: VectorAccount } },
  edges: {},
});

const TieredAccount = defineNode("TieredAccount", {
  schema: z.object({
    name: z.string(),
    tier: z.string().default("basic"),
  }),
});

const normalizationGraph = defineGraph({
  id: "set_update_refusal_normalization",
  nodes: { TieredAccount: { type: TieredAccount } },
  edges: {},
});

const RecreatedAccount = defineNode("RecreatedAccount", {
  schema: z.object({
    name: z.string(),
    plan: z.enum(["free", "enterprise"]),
  }),
});

const recreationGraph = defineGraph({
  id: "set_update_refusal_recreation",
  nodes: { RecreatedAccount: { type: RecreatedAccount } },
  edges: {},
});

/** How a row is re-created between a set update's dry-run and its write. */
type Replacement = Readonly<{
  label: string;
  props: Readonly<{ name: string; plan: "free" | "enterprise" }>;
  validFrom?: string;
}>;

/**
 * The replacements, each at version 1 like the original, created at the same
 * instant, and each still matching the selection: one with other properties
 * under the same validity window, and one identical in every property but
 * stored under another validity window. Each differs from the original in
 * exactly one part of the row token, so each case fails if the token stops
 * naming that part.
 */
const REPLACEMENTS: readonly Replacement[] = [
  {
    label: "with other properties",
    props: { name: "Recreated", plan: "free" },
  },
  {
    label: "with the same properties under another validity window",
    props: { name: "Original", plan: "free" },
    validFrom: "2001-01-01T00:00:00.000Z",
  },
];

/**
 * `backend`, whose transactions delete the row `id` and re-create it under the
 * same id as `replacement` describes, immediately before their set update's
 * keyed write — after its dry-run has read and validated the original. The
 * replacement keeps the original's creation time, and its validity window
 * unless `replacement` states another.
 */
function backendRecreatingBeforeSetWrite(
  backend: GraphBackend,
  id: string,
  replacement: Replacement,
): GraphBackend {
  function recreating(target: TransactionBackend): TransactionBackend {
    const updateNodeSet = requireDefined(target.updateNodeSet);
    return deriveBackend(target, {
      updateNodeSet: async (params) => {
        const original = requireDefined(
          await target.getNode(params.graphId, params.kind, id),
        );
        await target.hardDeleteNode({
          graphId: params.graphId,
          kind: params.kind,
          id,
        });
        await target.insertNode({
          graphId: params.graphId,
          kind: params.kind,
          id,
          props: replacement.props,
          validFrom: replacement.validFrom ?? requireDefined(original.valid_from),
        });
        const nodesTable = createSqlSchema(target.tableNames).nodesTable;
        await requireDefined(target.executeStatement)(
          asCompiledStatementSql(sql`
            UPDATE ${nodesTable} SET created_at = ${original.created_at}
            WHERE graph_id = ${params.graphId} AND kind = ${params.kind}
              AND id = ${id}
          `),
        );
        const replaced = requireDefined(
          await target.getNode(params.graphId, params.kind, id),
        );
        // The replacement differs from the original only where the case says.
        expect([replaced.version, replaced.created_at]).toEqual([
          original.version,
          original.created_at,
        ]);
        expect(replaced.valid_from === original.valid_from).toBe(
          replacement.validFrom === undefined,
        );
        return updateNodeSet(params);
      },
    });
  }
  // Over a projection: the store's own backend object is frozen.
  return deriveBackend(projectGraphBackend(backend), {
    transaction: (run, options) =>
      backend.transaction((target) => run(recreating(target)), options),
  });
}

/** What a call threw, or `"resolved"` when it did not throw. */
async function settle(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => "resolved",
    (error: unknown) => error,
  );
}

/** What a refused call threw, reduced to whether it was the schema refusal. */
function refusalClass(thrown: unknown): string {
  return thrown instanceof ValidationError ? "ValidationError" : String(thrown);
}

/**
 * Asserts a case's whole end state in one observation: the state with the
 * refused call undone.
 */
function expectRefusal<TValue>(
  observed: TValue,
  correct: NoInfer<TValue>,
): void {
  expect(observed).toEqual(correct);
}

export function registerSetUpdateRefusalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a set update refused by validation leaves nothing behind", () => {
    describe.for(SET_UPDATE_VERBS)("%s", (verb) => {
      it("does not commit the refused row, and reports the refusal through onError only", async () => {
        const events: string[] = [];
        const store = await context.createStore(refusalGraph, {
          hooks: {
            onBulkOperationStart: (hook) => {
              events.push(`start:${hook.operation}`);
            },
            onBulkOperationEnd: (hook, result) => {
              events.push(`end:${hook.operation}:${result.affectedCount}`);
            },
            onError: () => {
              events.push("error");
            },
          },
        });
        const account = await store.nodes.RefusalAccount.create({
          name: "Plain",
          plan: "free",
        });

        const thrown = await store.transaction(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.RefusalAccount.updateWhere({
                patch: {
                  plan: "enterprise",
                },
                where: (candidate) => candidate.id.eq(account.id),
              })
            : tx.nodes.RefusalAccount.compareAndSet(account.id, {
                expected: { plan: "free" },
                patch: {
                  plan: "enterprise",
                },
              }),
          ),
        );

        const stored = requireDefined(
          await store.nodes.RefusalAccount.getById(account.id),
        );
        expectRefusal(
          {
            thrown: refusalClass(thrown),
            plan: stored.plan,
            version: stored.meta.version,
            events,
          },
          {
            thrown: "ValidationError",
            plan: "free",
            version: account.meta.version,
            events: [`start:${verb}`, "error"],
          },
        );
      });

      it("leaves the recorded history of a history store unchanged", async () => {
        const store = await context.createHistoryStore(refusalGraph);
        const account = await store.nodes.RefusalAccount.create({
          name: "Recorded",
          plan: "free",
        });
        const beforeRefusal = requireDefined(await store.recordedNow());

        const thrown = await store.transaction(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.RefusalAccount.updateWhere({
                patch: {
                  plan: "enterprise",
                },
                where: (candidate) => candidate.id.eq(account.id),
              })
            : tx.nodes.RefusalAccount.compareAndSet(account.id, {
                expected: { plan: "free" },
                patch: {
                  plan: "enterprise",
                },
              }),
          ),
        );

        const afterCommit = requireDefined(await store.recordedNow());
        const live = requireDefined(
          await store.nodes.RefusalAccount.getById(account.id),
        );
        const recorded = requireDefined(
          await store
            .asOfRecorded(afterCommit)
            .nodes.RefusalAccount.getById(account.id),
        );
        expectRefusal(
          {
            thrown: refusalClass(thrown),
            recordedAdvanced: afterCommit !== beforeRefusal,
            livePlan: live.plan,
            recordedPlan: recorded.plan,
            recordedVersion: recorded.meta.version,
          },
          {
            thrown: "ValidationError",
            recordedAdvanced: false,
            livePlan: "free",
            recordedPlan: "free",
            recordedVersion: account.meta.version,
          },
        );
      });

      it("counts nothing in the receipt and commits nothing it did not count", async () => {
        const store = await context.createStore(refusalGraph);
        const account = await store.nodes.RefusalAccount.create({
          name: "Receipted",
          plan: "free",
        });

        const outcome = await store.transactionWithReceipt(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.RefusalAccount.updateWhere({
                patch: {
                  plan: "enterprise",
                },
                where: (candidate) => candidate.id.eq(account.id),
              })
            : tx.nodes.RefusalAccount.compareAndSet(account.id, {
                expected: { plan: "free" },
                patch: {
                  plan: "enterprise",
                },
              }),
          ),
        );

        const stored = requireDefined(
          await store.nodes.RefusalAccount.getById(account.id),
        );
        expectRefusal(
          {
            thrown: refusalClass(outcome.result),
            receiptNodes: outcome.receipt.writes.nodes,
            receiptTotal: outcome.receipt.writes.total,
            plan: stored.plan,
          },
          {
            thrown: "ValidationError",
            receiptNodes: {},
            receiptTotal: 0,
            plan: "free",
          },
        );
      });

      it("keeps the refused row's uniqueness claim on its old key", async () => {
        const store = await context.createStore(refusalGraph);
        const account = await store.nodes.RefusalAccount.create({
          name: "Before",
          plan: "free",
        });

        const thrown = await store.transaction(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.RefusalAccount.updateWhere({
                patch: {
                  plan: "enterprise",
                  name: "After",
                },
                where: (candidate) => candidate.id.eq(account.id),
              })
            : tx.nodes.RefusalAccount.compareAndSet(account.id, {
                expected: { plan: "free" },
                patch: {
                  plan: "enterprise",
                  name: "After",
                },
              }),
          ),
        );

        const axis = uniquenessClaimAxis(
          "RefusalAccount",
          REFUSAL_NAME_UNIQUE.scope,
          refusalRegistry,
        );
        async function claimOwner(name: string): Promise<string | undefined> {
          const row = await store.backend.checkUnique({
            graphId: refusalGraph.id,
            nodeKind: axis,
            constraintName: REFUSAL_NAME_UNIQUE.name,
            key: computeUniqueKey(
              { name },
              REFUSAL_NAME_UNIQUE.fields,
              REFUSAL_NAME_UNIQUE.collation,
            ),
            includeDeleted: false,
          });
          return row?.node_id;
        }
        const stored = requireDefined(
          await store.nodes.RefusalAccount.getById(account.id),
        );
        const oldKeyOwner = await claimOwner("Before");
        const newKeyOwner = await claimOwner("After");
        // A later writer takes the name the refused call wrote: with the row
        // unchanged that name is free, so exactly one row may carry it.
        await store.nodes.RefusalAccount.create({
          name: "After",
          plan: "free",
        });
        const carryingNewName = await store.nodes.RefusalAccount.find({
          where: (candidate) => candidate.name.eq("After"),
        });
        expectRefusal(
          {
            thrown: refusalClass(thrown),
            name: stored.name,
            plan: stored.plan,
            oldKeyOwner,
            newKeyOwner,
            rowsCarryingNewName: carryingNewName.length,
          },
          {
            thrown: "ValidationError",
            name: "Before",
            plan: "free",
            oldKeyOwner: account.id,
            newKeyOwner: undefined,
            rowsCarryingNewName: 1,
          },
        );
      });

      it("keeps the refused row's fulltext entry and row in agreement", async (ctx) => {
        const store = await context.createStore(searchRefusalGraph);
        if (store.backend.capabilities.fulltext?.supported !== true) {
          ctx.skip();
        }
        const account = await store.nodes.SearchAccount.create({
          plan: "free",
          bio: "giraffe",
        });

        const thrown = await store.transaction(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.SearchAccount.updateWhere({
                patch: {
                  plan: "enterprise",
                  bio: "zebra",
                },
                where: (candidate) => candidate.id.eq(account.id),
              })
            : tx.nodes.SearchAccount.compareAndSet(account.id, {
                expected: { plan: "free" },
                patch: {
                  plan: "enterprise",
                  bio: "zebra",
                },
              }),
          ),
        );

        async function hits(query: string): Promise<readonly string[]> {
          const results = await store.search.fulltext("SearchAccount", {
            query,
            limit: 10,
          });
          return results.map((hit) => `${hit.node.id}:${hit.node.bio}`);
        }
        const stored = requireDefined(
          await store.nodes.SearchAccount.getById(account.id),
        );
        expectRefusal(
          {
            thrown: refusalClass(thrown),
            bio: stored.bio,
            plan: stored.plan,
            oldTermHits: await hits("giraffe"),
            newTermHits: await hits("zebra"),
          },
          {
            thrown: "ValidationError",
            bio: "giraffe",
            plan: "free",
            oldTermHits: [`${account.id}:giraffe`],
            newTermHits: [],
          },
        );
      });

      it("keeps the refused row's embedding and row in agreement", async (ctx) => {
        const store = await context.createStore(vectorRefusalGraph);
        if (store.backend.capabilities.vector?.supported !== true) {
          ctx.skip();
        }
        const account = await store.nodes.VectorAccount.create({
          plan: "free",
          vector: [1, 0, 0, 0],
        });

        const thrown = await store.transaction(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.VectorAccount.updateWhere({
                patch: {
                  plan: "enterprise",
                  vector: [0, 1, 0, 0],
                },
                where: (candidate) => candidate.id.eq(account.id),
              })
            : tx.nodes.VectorAccount.compareAndSet(account.id, {
                expected: { plan: "free" },
                patch: {
                  plan: "enterprise",
                  vector: [0, 1, 0, 0],
                },
              }),
          ),
        );

        const vectorHits = await store.search.vector("VectorAccount", {
          fieldPath: "vector",
          queryEmbedding: [1, 0, 0, 0],
          limit: 1,
        });
        const nearest = requireDefined(vectorHits[0]);
        const stored = requireDefined(
          await store.nodes.VectorAccount.getById(account.id),
        );
        expectRefusal(
          {
            thrown: refusalClass(thrown),
            vector: [...stored.vector],
            plan: stored.plan,
            nearestId: nearest.node.id,
            nearestScore: Math.round(nearest.score * 1000) / 1000,
          },
          {
            thrown: "ValidationError",
            vector: [1, 0, 0, 0],
            plan: "free",
            nearestId: account.id,
            nearestScore: 1,
          },
        );
      });
    });

    it("updateWhere: leaves every candidate unchanged when exactly one violates the schema", async () => {
      const store = await context.createStore(refusalGraph);
      const ownedA = await store.nodes.RefusalAccount.create({
        name: "OwnedA",
        plan: "free",
        ownerId: "rep-1",
      });
      const unowned = await store.nodes.RefusalAccount.create({
        name: "Unowned",
        plan: "free",
      });
      const ownedB = await store.nodes.RefusalAccount.create({
        name: "OwnedB",
        plan: "free",
        ownerId: "rep-2",
      });

      const thrown = await store.transaction(async (tx) =>
        settle(
          tx.nodes.RefusalAccount.updateWhere({
            patch: { plan: "enterprise" },
            where: (account) => account.plan.eq("free"),
          }),
        ),
      );

      const plans: Record<string, string> = {};
      for (const [label, id] of [
        ["ownedA", ownedA.id],
        ["unowned", unowned.id],
        ["ownedB", ownedB.id],
      ] as const) {
        plans[label] = requireDefined(
          await store.nodes.RefusalAccount.getById(id),
        ).plan;
      }
      expectRefusal(
        { thrown: refusalClass(thrown), plans },
        {
          thrown: "ValidationError",
          plans: { ownedA: "free", unowned: "free", ownedB: "free" },
        },
      );
    });
    describe.for(SET_UPDATE_VERBS)("%s", (verb) => {
      it("refuses a rename onto another row's unique key and leaves both rows and their claims as they were", async () => {
        const store = await context.createStore(refusalGraph);
        const renamed = await store.nodes.RefusalAccount.create({
          name: "Alpha",
          plan: "free",
        });
        const holder = await store.nodes.RefusalAccount.create({
          name: "Beta",
          plan: "free",
        });

        const outcome = await store.transactionWithReceipt(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.RefusalAccount.updateWhere({
                patch: { name: "Beta" },
                where: (candidate) => candidate.id.eq(renamed.id),
              })
            : tx.nodes.RefusalAccount.compareAndSet(renamed.id, {
                expected: { name: "Alpha" },
                patch: { name: "Beta" },
              }),
          ),
        );

        const axis = uniquenessClaimAxis(
          "RefusalAccount",
          REFUSAL_NAME_UNIQUE.scope,
          refusalRegistry,
        );
        async function claimOwner(name: string): Promise<string | undefined> {
          const row = await store.backend.checkUnique({
            graphId: refusalGraph.id,
            nodeKind: axis,
            constraintName: REFUSAL_NAME_UNIQUE.name,
            key: computeUniqueKey(
              { name },
              REFUSAL_NAME_UNIQUE.fields,
              REFUSAL_NAME_UNIQUE.collation,
            ),
            includeDeleted: false,
          });
          return row?.node_id;
        }
        const stored = requireDefined(
          await store.nodes.RefusalAccount.getById(renamed.id),
        );
        const carryingBeta = await store.nodes.RefusalAccount.find({
          where: (candidate) => candidate.name.eq("Beta"),
        });
        expectRefusal(
          {
            thrown:
              outcome.result instanceof UniquenessError ?
                "UniquenessError"
              : String(outcome.result),
            receiptTotal: outcome.receipt.writes.total,
            name: stored.name,
            version: stored.meta.version,
            alphaOwner: await claimOwner("Alpha"),
            betaOwner: await claimOwner("Beta"),
            rowsCarryingBeta: carryingBeta.map((row) => row.id),
          },
          {
            thrown: "UniquenessError",
            receiptTotal: 0,
            name: "Alpha",
            version: renamed.meta.version,
            alphaOwner: renamed.id,
            betaOwner: holder.id,
            rowsCarryingBeta: [holder.id],
          },
        );
      });

      it("refuses an after-image that needs schema normalization and leaves the row as it was", async () => {
        const store = await context.createStore(normalizationGraph);
        // Stored before the kind declared its default: the row lacks `tier`,
        // so every after-image of it needs the default filled in.
        await store.backend.insertNode({
          graphId: normalizationGraph.id,
          kind: "TieredAccount",
          id: "tiered-legacy",
          props: { name: "Legacy" },
        });

        const thrown = await store.transaction(async (tx) =>
          settle(
            verb === "updateWhere" ?
              tx.nodes.TieredAccount.updateWhere({
                patch: { name: "Renamed" },
                where: (candidate) => candidate.name.eq("Legacy"),
              })
            : tx.nodes.TieredAccount.compareAndSet(
                "tiered-legacy" as Parameters<
                  typeof tx.nodes.TieredAccount.compareAndSet
                >[0],
                { expected: { name: "Legacy" }, patch: { name: "Renamed" } },
              ),
          ),
        );

        const stored = requireDefined(
          await store.backend.getNode(
            normalizationGraph.id,
            "TieredAccount",
            "tiered-legacy",
          ),
        );
        expectRefusal(
          {
            thrown: refusalClass(thrown),
            props: rowPropsToObject(stored.props),
            version: stored.version,
          },
          {
            thrown: "ValidationError",
            props: { name: "Legacy" },
            version: 1,
          },
        );
      });

      it.for(REPLACEMENTS)(
        "writes nothing and reports the conflict when the row is re-created under its id $label between the dry-run and the write",
        async (replacement) => {
          const store = await context.createStore(recreationGraph);
          const original = await store.nodes.RecreatedAccount.create({
            name: "Original",
            plan: "free",
          });
          // Untouched between the two statements: it still carries its token,
          // and the write must leave it alone too, since the set it belongs to
          // is refused as a whole.
          const bystander = await store.nodes.RecreatedAccount.create({
            name: "Bystander",
            plan: "free",
          });
          // Between the dry-run and the keyed write, this transaction deletes the
          // row and re-creates it under the same id at the same version (1),
          // still matching the selection. Only the stored row the dry-run read
          // can tell the two apart.
          const recreating = createStore(
            recreationGraph,
            backendRecreatingBeforeSetWrite(
              store.backend,
              original.id,
              replacement,
            ),
          );

          const thrown = await recreating.transaction(async (tx) =>
            settle(
              verb === "updateWhere" ?
                tx.nodes.RecreatedAccount.updateWhere({
                  patch: { plan: "enterprise" },
                  where: (candidate) => candidate.plan.eq("free"),
                })
              : tx.nodes.RecreatedAccount.compareAndSet(original.id, {
                  expected: { plan: "free" },
                  patch: { plan: "enterprise" },
                }),
            ),
          );

          const stored = requireDefined(
            await store.nodes.RecreatedAccount.getById(original.id),
          );
          const storedBystander = requireDefined(
            await store.nodes.RecreatedAccount.getById(bystander.id),
          );
          expectRefusal(
            {
              thrown:
                (
                  thrown instanceof DatabaseOperationError &&
                  thrown.details.reason === "no_row_returned"
                ) ?
                  "no_row_returned"
                : String(thrown),
              name: stored.name,
              plan: stored.plan,
              version: stored.meta.version,
              bystander: [storedBystander.plan, storedBystander.meta.version],
            },
            {
              thrown: "no_row_returned",
              name: replacement.props.name,
              plan: "free",
              version: 1,
              bystander: ["free", 1],
            },
          );
        },
      );
    });
  });
}
