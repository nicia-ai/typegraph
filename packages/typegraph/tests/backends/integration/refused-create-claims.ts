/**
 * A create refused by one of its claims leaves nothing behind.
 *
 * A create that owes two or more claims issued BEFORE its row — a uniqueness
 * key at an axis spanning other kinds, a `disjointWith` pair — is refused as a
 * whole when any one of them is held by somebody else. A caller that catches
 * that refusal inside `store.transaction` and commits must find the database
 * exactly as it was: a claim that was free must still be free, because no node
 * exists to own it and nothing would ever release it. Left behind, it refuses
 * every later write of that key for good.
 *
 * The first two shapes are the ones a refused claim can strand a sibling in:
 * two disjoint partners of one kind, and two uniqueness constraints a subclass
 * claims at its hierarchy's axis. The third is a claim issued AFTER the row —
 * an own-kind unique key — whose refusal must not leave the row it refused.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  subClassOf,
  UniquenessError,
} from "../../../src";
import { type GraphBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import {
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
  uniquenessClaimAxis,
} from "../../../src/store/claims/axis";
import { type IntegrationTestContext } from "./test-context";

const REFUSAL_A_UNIQUE = {
  name: "refused_create_a",
  fields: ["a"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;
const REFUSAL_B_UNIQUE = {
  name: "refused_create_b",
  fields: ["b"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const REFUSAL_EMAIL_UNIQUE = {
  name: "refused_create_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

const RefusalItem = defineNode("RefusalItem", { schema: z.object({}) });
const RefusalOther = defineNode("RefusalOther", { schema: z.object({}) });
const RefusalPartner = defineNode("RefusalPartner", { schema: z.object({}) });

const RefusalParent = defineNode("RefusalParent", {
  schema: z.object({ a: z.string(), b: z.string() }),
});
const RefusalChild = defineNode("RefusalChild", {
  schema: z.object({ a: z.string(), b: z.string() }),
});

const RefusalAccount = defineNode("RefusalAccount", {
  schema: z.object({ email: z.string() }),
});

const refusedCreateGraph = defineGraph({
  id: "refused_create_claims",
  nodes: {
    RefusalItem: { type: RefusalItem },
    RefusalOther: { type: RefusalOther },
    RefusalPartner: { type: RefusalPartner },
    RefusalParent: {
      type: RefusalParent,
      unique: [REFUSAL_A_UNIQUE, REFUSAL_B_UNIQUE],
    },
    RefusalChild: {
      type: RefusalChild,
      unique: [REFUSAL_A_UNIQUE, REFUSAL_B_UNIQUE],
    },
    RefusalAccount: { type: RefusalAccount, unique: [REFUSAL_EMAIL_UNIQUE] },
  },
  edges: {},
  ontology: [
    disjointWith(RefusalItem, RefusalOther),
    disjointWith(RefusalItem, RefusalPartner),
    subClassOf(RefusalChild, RefusalParent),
  ],
});

const registry = buildKindRegistry(refusedCreateGraph);

async function readLiveClaimOwner(
  backend: GraphBackend,
  axis: string,
  constraintName: string,
  key: string,
): Promise<string | undefined> {
  const row = await backend.checkUnique({
    graphId: refusedCreateGraph.id,
    nodeKind: axis,
    constraintName,
    key,
    includeDeleted: false,
  });
  return row === undefined ? undefined : `${row.concrete_kind}:${row.node_id}`;
}

async function readStoredNode(
  backend: GraphBackend,
  kind: string,
  id: string,
): Promise<string | undefined> {
  const row = await backend.getNode(refusedCreateGraph.id, kind, id);
  return row === undefined ? undefined : `${row.kind}:${row.id}`;
}

export function registerRefusedCreateClaimIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a create refused by a claim leaves nothing behind", () => {
    it("keeps a free disjoint pair free when another pair refuses", async () => {
      const store = await context.createStore(refusedCreateGraph);
      const sharedId = "refused-disjoint-shared";
      await store.nodes.RefusalPartner.create({}, { id: sharedId });

      await store.transaction(async (tx) => {
        const refusal = await tx.nodes.RefusalItem.create(
          {},
          { id: sharedId },
        ).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(DisjointError);
      });

      expect(
        await readStoredNode(store.backend, "RefusalItem", sharedId),
      ).toBeUndefined();
      expect(
        await readLiveClaimOwner(
          store.backend,
          disjointnessClaimAxis("RefusalItem", "RefusalOther", registry),
          DISJOINT_CONSTRAINT_NAME,
          sharedId,
        ),
      ).toBeUndefined();
      const other = await store.nodes.RefusalOther.create({}, { id: sharedId });
      expect(other.id).toBe(sharedId);
    });

    it("keeps a free inherited unique key free when a sibling key refuses", async () => {
      const store = await context.createStore(refusedCreateGraph);
      const holder = await store.nodes.RefusalParent.create(
        { a: "seed-a", b: "held-b" },
        { id: "refused-unique-holder" },
      );

      await store.transaction(async (tx) => {
        const refusal = await tx.nodes.RefusalChild.create(
          { a: "free-a", b: "held-b" },
          { id: "refused-unique-candidate" },
        ).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(UniquenessError);
        expect((refusal as UniquenessError).details).toMatchObject({
          constraintName: REFUSAL_B_UNIQUE.name,
          existingId: holder.id,
        });
      });

      expect(
        await readStoredNode(
          store.backend,
          "RefusalChild",
          "refused-unique-candidate",
        ),
      ).toBeUndefined();
      expect(
        await readLiveClaimOwner(
          store.backend,
          uniquenessClaimAxis("RefusalChild", "kindWithSubClasses", registry),
          REFUSAL_A_UNIQUE.name,
          computeUniqueKey({ a: "free-a" }, ["a"], "binary"),
        ),
      ).toBeUndefined();
      const reuser = await store.nodes.RefusalParent.create({
        a: "free-a",
        b: "fresh-b",
      });
      expect(reuser.a).toBe("free-a");
    });

    it("leaves no node row behind when its own-kind unique key refuses", async () => {
      const store = await context.createStore(refusedCreateGraph);
      const email = "held@refused-create.example";
      const holder = await store.nodes.RefusalAccount.create(
        { email },
        { id: "refused-account-holder" },
      );

      await store.transaction(async (tx) => {
        const refusal = await tx.nodes.RefusalAccount.create(
          { email },
          { id: "refused-account-candidate" },
        ).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(UniquenessError);
        expect((refusal as UniquenessError).details).toMatchObject({
          constraintName: REFUSAL_EMAIL_UNIQUE.name,
          existingId: holder.id,
        });
      });

      expect(
        await readStoredNode(
          store.backend,
          "RefusalAccount",
          "refused-account-candidate",
        ),
      ).toBeUndefined();
      const accounts = await store.nodes.RefusalAccount.find();
      expect(accounts.map((account) => account.id)).toEqual([holder.id]);
    });
  });
}
