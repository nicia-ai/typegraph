/**
 * Cross-backend coverage for the `recursiveTraversal` capability: a backend
 * that declares `{ supported: false }` refuses variable-length traversals
 * with the sanctioned refusal, and the bundled declaration on the unmodified
 * lane backend keeps running them (T1-A, T4).
 *
 * The four rows below extend the same coverage to sites B (`subgraph`), C
 * (a historical identity class read), D (a non-recursive, identity-expanded
 * historical query — so site A's assert cannot pre-empt site D), and F (the
 * identity window-ledger read). T4's positive half gets no new rows for
 * these four sites, deliberately: their success paths already run
 * cross-backend in `subgraph.ts`, `identity.ts` and
 * `identity-historical-traversal.ts`; those suites staying green is the
 * positive evidence, and duplicating them here would cost PostgreSQL-lane
 * time for no new signal.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import {
  type BackendCapabilities,
  type GraphBackend,
} from "../../../src/backend/types";
import { ConfigurationError } from "../../../src/errors";
import { integrationTestGraph } from "./fixtures";
import { seedKnowsChain } from "./seed-helpers";
import { type IntegrationTestContext } from "./test-context";

/**
 * Projects `base`, overlays a refusing `recursiveTraversal` declaration, and
 * ALSO overlays `transaction` so the transaction target it hands callers
 * refuses too.
 *
 * Measured, not assumed: with only the outer overlay,
 * `refusing.capabilities.recursiveTraversal` reads
 * `{ supported: false, ... }` while INSIDE `refusing.transaction(...)` the
 * transaction target reports `{ supported: true }` — the bundled factories
 * build every `TransactionBackend` from the `capabilities` object they closed
 * over at construction (`sqlite.ts:1664,1696,1719,1741`). Identity WRITES run
 * inside `runInWriteTransaction`, so the window-ledger row (T1 row 4) would
 * silently exercise the base declaration without this wrapper.
 */
function refuseRecursiveTraversal(
  base: GraphBackend,
  reason: string,
): GraphBackend {
  const capabilities: BackendCapabilities = {
    ...base.capabilities,
    recursiveTraversal: { supported: false, reason },
  };
  const projected = projectGraphBackend(base);
  const wrappedTransaction: GraphBackend["transaction"] = (fn, options) =>
    projected.transaction(
      (tx) => fn(deriveBackend(tx, { capabilities })),
      options,
    );
  return deriveBackend(projected, {
    capabilities,
    transaction: wrappedTransaction,
  });
}

const REASON = "test engine has no recursive CTE";

const RefusalPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const RefusalCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const refusalLink = defineEdge("link", { schema: z.object({}) });

/**
 * Identity-enabled graph for the C/D/F rows below: `Person`/`Company`, one
 * `link` edge accepting both kinds on both ends, `sameIdAcrossKinds: "fold"`.
 */
const capabilityRefusalIdentityGraph = defineGraph({
  id: "capability_refusal_identity",
  nodes: {
    Person: { type: RefusalPerson },
    Company: { type: RefusalCompany },
  },
  edges: {
    link: {
      type: refusalLink,
      from: [RefusalPerson, RefusalCompany],
      to: [RefusalPerson, RefusalCompany],
    },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

export function registerCapabilityRefusalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("recursiveTraversal capability", () => {
    it("refuses a variable-length traversal when the backend declares no recursive traversal", async () => {
      const store = context.getStore();
      await seedKnowsChain(store);

      const refusingBackend = refuseRecursiveTraversal(store.backend, REASON);
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
      expect(error.details["reason"]).toBe(REASON);
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

    it("refuses store.subgraph when the backend declares no recursive traversal", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create({ name: "Solo" });

      const refusingBackend = refuseRecursiveTraversal(store.backend, REASON);
      const refusingStore = createStore(integrationTestGraph, refusingBackend);

      const caught = await refusingStore
        .subgraph(person.id, { edges: ["knows"], maxDepth: 2 })
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConfigurationError);
      const error = caught as ConfigurationError;
      expect(error.details["code"]).toBe("RECURSIVE_TRAVERSAL_UNSUPPORTED");
      expect(error.details["operation"]).toBe("subgraph");
      expect(error.details["reason"]).toBe(REASON);
    });

    it("refuses a historical identity class read when the backend declares no recursive traversal", async () => {
      const baseBackend = context.getStore().backend;
      const [identityStore] = await createStoreWithSchema(
        capabilityRefusalIdentityGraph,
        baseBackend,
        {},
      );
      const person = await identityStore.nodes.Person.create({
        name: "Historical",
      });
      const pastIso = new Date(Date.now() - 60_000).toISOString();

      const refusingBackend = refuseRecursiveTraversal(baseBackend, REASON);
      const refusingIdentityStore = createStore(
        capabilityRefusalIdentityGraph,
        refusingBackend,
      );

      const caught = await refusingIdentityStore
        .asOf(pastIso)
        .identity.membersOf(person)
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConfigurationError);
      const error = caught as ConfigurationError;
      expect(error.details["code"]).toBe("RECURSIVE_TRAVERSAL_UNSUPPORTED");
      expect(error.details["operation"]).toBe("historical identity class read");
      expect(error.details["reason"]).toBe(REASON);
    });

    it("refuses an identity-expanded historical query when the backend declares no recursive traversal", async () => {
      const baseBackend = context.getStore().backend;
      const [identityStore] = await createStoreWithSchema(
        capabilityRefusalIdentityGraph,
        baseBackend,
        {},
      );
      const validFrom = new Date(Date.now() - 120_000).toISOString();
      const pastIso = new Date(Date.now() - 60_000).toISOString();
      const person = await identityStore.nodes.Person.create(
        { name: "Frontier" },
        { validFrom },
      );
      const friend = await identityStore.nodes.Person.create(
        { name: "Friend" },
        { validFrom },
      );
      await identityStore.edges.link.create(person, friend, {}, { validFrom });

      const refusingBackend = refuseRecursiveTraversal(baseBackend, REASON);
      const refusingIdentityStore = createStore(
        capabilityRefusalIdentityGraph,
        refusingBackend,
      );

      // Non-recursive traverse on purpose, so site A's assert cannot
      // pre-empt site D.
      const caught = await refusingIdentityStore
        .asOf(pastIso)
        .query()
        .from("Person", "p")
        .traverse("link", "e", { expand: "none", includeIdentityMembers: true })
        .to("Person", "friend")
        .select((ctx) => ctx.friend.name)
        .execute()
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConfigurationError);
      const error = caught as ConfigurationError;
      expect(error.details["code"]).toBe("RECURSIVE_TRAVERSAL_UNSUPPORTED");
      expect(error.details["operation"]).toBe("historical identity expansion");
      expect(error.details["reason"]).toBe(REASON);
    });

    it("refuses the identity window-ledger read when the backend declares no recursive traversal", async () => {
      const baseBackend = context.getStore().backend;
      const [identityStore] = await createStoreWithSchema(
        capabilityRefusalIdentityGraph,
        baseBackend,
        {},
      );
      const validFrom = new Date(Date.now() - 60_000).toISOString();
      const a = await identityStore.nodes.Person.create(
        { name: "Ledger A" },
        { validFrom },
      );
      const b = await identityStore.nodes.Person.create(
        { name: "Ledger B" },
        { validFrom },
      );

      const refusingBackend = refuseRecursiveTraversal(baseBackend, REASON);
      const refusingIdentityStore = createStore(
        capabilityRefusalIdentityGraph,
        refusingBackend,
      );

      // An explicit window is what routes `assertSame` through the
      // window-ledger read: a plain `assertSame(a, b)` validates against the
      // current-closure relation instead and never reaches site F.
      const caught = await refusingIdentityStore.identity
        .assertSame(a, b, { validFrom })
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(ConfigurationError);
      const error = caught as ConfigurationError;
      expect(error.details["code"]).toBe("RECURSIVE_TRAVERSAL_UNSUPPORTED");
      expect(error.details["operation"]).toBe("identity window ledger read");
      expect(error.details["reason"]).toBe(REASON);
    });
  });
}
