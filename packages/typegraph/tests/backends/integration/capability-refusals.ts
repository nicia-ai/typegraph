/**
 * Cross-backend coverage for the `recursiveTraversal` capability: a backend
 * that declares `{ supported: false }` refuses variable-length traversals
 * with the sanctioned refusal, and the bundled declaration on the unmodified
 * lane backend keeps running them (T1-A, T4).
 */
import { describe, expect, it } from "vitest";

import { createStore } from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { ConfigurationError } from "../../../src/errors";
import { integrationTestGraph } from "./fixtures";
import { seedKnowsChain } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

export function registerCapabilityRefusalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("recursiveTraversal capability", () => {
    it("refuses a variable-length traversal when the backend declares no recursive traversal", async () => {
      const store = context.getStore();
      await seedKnowsChain(store);

      // Over a PROJECTION, not over the store's own backend object: that one
      // is frozen, and a decoration Proxy cannot shadow a non-configurable
      // member. `projectGraphBackend` is the audited way to get an unfrozen
      // copy (mirrors `constraint-fence-transaction-health.ts`).
      const refusingBackend = deriveBackend(
        projectGraphBackend(store.backend),
        {
          capabilities: {
            ...store.backend.capabilities,
            recursiveTraversal: {
              supported: false,
              reason: "test engine has no recursive CTE",
            },
          },
        },
      );
      const refusingStore = createStore(integrationTestGraph, refusingBackend);

      const caught = await refusingStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive()
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute()
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConfigurationError);
      const error = caught as ConfigurationError;
      expect(error.details["code"]).toBe("RECURSIVE_TRAVERSAL_UNSUPPORTED");
      expect(error.details["operation"]).toBe("variable-length traversal");
      expect(error.details["reason"]).toBe("test engine has no recursive CTE");
    });

    it("runs variable-length traversals on the bundled declaration", async () => {
      const store = context.getStore();
      await seedKnowsChain(store);

      const results = await store
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("knows", "e")
        .recursive()
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute();

      const uniqueResults = [...new Set(results)];
      expect(uniqueResults.toSorted()).toEqual([
        "Bob",
        "Charlie",
        "Diana",
        "Eve",
      ]);
    });
  });
}
