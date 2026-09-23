/**
 * The RELEASE half of the resolved-write-set uniqueness decision
 * (`findResolvedNodeClaimConflicts`, src/store/claims/resolved-node-claims.ts):
 * a claim the set itself gives back is available to the set. A merge that
 * deletes the row holding a unique key and creates a new row under that key
 * must commit, leaving only the new row — the persisted holder is among the
 * set's releases, so its claim is not a foreign one.
 *
 * Runs on every backend in the merge matrix: the probe is the store's own
 * batched claim read, which is backend-specific code.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Account = defineNode("Account", {
  schema: z.object({ email: z.string() }),
});
const graph = defineGraph({
  id: "uniqueness_handoff",
  nodes: {
    Account: {
      type: Account,
      unique: [
        {
          name: "account_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

const BRANCH_A = asBranchId("branch-a");
const EMAIL = "ada@example.test";

describe.each(backendMatrix())(
  "resolved write set — a released unique key hands off to a new row [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups.toReversed()) {
        await cleanup();
      }
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    it("commits a merge that deletes the key's holder and creates a new row under the same key", async () => {
      const [base] = await createStoreWithSchema(graph, await makeBackend(), {
        history: true,
      });
      await base.nodes.Account.create({ email: EMAIL }, { id: "old" });

      const source = unwrap(
        await branch(base, () => makeBackend(), { id: BRANCH_A }),
      );
      await source.store.nodes.Account.delete("old" as never);
      await source.store.nodes.Account.create({ email: EMAIL }, { id: "new" });

      const result = await merge(base, [source], { branchOrder: [BRANCH_A] });
      if (isErr(result)) throw result.error;
      console.info(`[${entry.name}] handoff merged:`, result.data.merged);

      const remaining = await base.nodes.Account.find();
      expect(remaining.map((row) => `${row.id}:${row.email}`)).toEqual([
        `new:${EMAIL}`,
      ]);
      expect(await base.verifyConstraintFences()).toEqual([]);
    });
    // MUTATION CHECK: drop `...releases` from `affectedOwnerKeys`
    // (src/store/claims/resolved-node-claims.ts) — the persisted `old` row's
    // claim then reads as a foreign holder of the key `new` claims, the
    // resolved-set validation refuses the merge with a uniqueness violation,
    // and `throw result.error` fails this test.
  },
);
