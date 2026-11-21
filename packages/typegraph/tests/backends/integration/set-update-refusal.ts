/**
 * A set update refused by schema validation inside `store.transaction()`
 * leaves nothing behind.
 *
 * `updateWhere` and `compareAndSet` run their UPDATE first and validate the
 * after-images it returns. When a returned row violates the schema the call
 * throws `ValidationError`. A caller that catches that refusal and lets its
 * transaction commit must find the database — rows, recorded history, the
 * receipt, hooks and every sidecar — exactly as it was before the call.
 *
 * Every case here is a known defect (#948): the UPDATE is not undone when
 * validation refuses, so the caught refusal commits the schema-invalid row
 * while the sidecars the call never rebuilt keep describing the old one. The
 * cases are `it.fails` until the repair lands; each asserts the whole correct
 * end state in one comparison, so a failure diff shows everything the defect
 * left behind.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  searchable,
  ValidationError,
} from "../../../src";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import { uniquenessClaimAxis } from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

/** The issue tracking the defect every case in this file pins. */
const KNOWN_DEFECT = "known defect #948";

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

export function registerSetUpdateRefusalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe(`a set update refused by validation leaves nothing behind (${KNOWN_DEFECT})`, () => {
    describe.for(SET_UPDATE_VERBS)("%s", (verb) => {
      it.fails(
        "does not commit the refused row, and reports the refusal through onError only",
        async () => {
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
          expect({
            thrown: refusalClass(thrown),
            plan: stored.plan,
            version: stored.meta.version,
            events,
          }).toEqual({
            thrown: "ValidationError",
            plan: "free",
            version: account.meta.version,
            events: [`start:${verb}`, "error"],
          });
        },
      );

      it.fails(
        "leaves the recorded history of a history store unchanged",
        async () => {
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
          expect({
            thrown: refusalClass(thrown),
            recordedAdvanced: afterCommit !== beforeRefusal,
            livePlan: live.plan,
            recordedPlan: recorded.plan,
            recordedVersion: recorded.meta.version,
          }).toEqual({
            thrown: "ValidationError",
            recordedAdvanced: false,
            livePlan: "free",
            recordedPlan: "free",
            recordedVersion: account.meta.version,
          });
        },
      );

      it.fails(
        "counts nothing in the receipt and commits nothing it did not count",
        async () => {
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
          expect({
            thrown: refusalClass(outcome.result),
            receiptNodes: outcome.receipt.writes.nodes,
            receiptTotal: outcome.receipt.writes.total,
            plan: stored.plan,
          }).toEqual({
            thrown: "ValidationError",
            receiptNodes: {},
            receiptTotal: 0,
            plan: "free",
          });
        },
      );

      it.fails(
        "keeps the refused row's uniqueness claim on its old key",
        async () => {
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
          expect({
            thrown: refusalClass(thrown),
            name: stored.name,
            plan: stored.plan,
            oldKeyOwner,
            newKeyOwner,
            rowsCarryingNewName: carryingNewName.length,
          }).toEqual({
            thrown: "ValidationError",
            name: "Before",
            plan: "free",
            oldKeyOwner: account.id,
            newKeyOwner: undefined,
            rowsCarryingNewName: 1,
          });
        },
      );

      it.fails(
        "keeps the refused row's fulltext entry and row in agreement",
        async (ctx) => {
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
          expect({
            thrown: refusalClass(thrown),
            bio: stored.bio,
            plan: stored.plan,
            oldTermHits: await hits("giraffe"),
            newTermHits: await hits("zebra"),
          }).toEqual({
            thrown: "ValidationError",
            bio: "giraffe",
            plan: "free",
            oldTermHits: [`${account.id}:giraffe`],
            newTermHits: [],
          });
        },
      );

      it.fails(
        "keeps the refused row's embedding and row in agreement",
        async (ctx) => {
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
          expect({
            thrown: refusalClass(thrown),
            vector: stored.vector,
            plan: stored.plan,
            nearestId: nearest.node.id,
            nearestScore: Math.round(nearest.score * 1000) / 1000,
          }).toEqual({
            thrown: "ValidationError",
            vector: [1, 0, 0, 0],
            plan: "free",
            nearestId: account.id,
            nearestScore: 1,
          });
        },
      );
    });

    it.fails(
      "updateWhere: leaves every candidate unchanged when exactly one violates the schema",
      async () => {
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
        expect({ thrown: refusalClass(thrown), plans }).toEqual({
          thrown: "ValidationError",
          plans: { ownedA: "free", unowned: "free", ownedB: "free" },
        });
      },
    );
  });
}
