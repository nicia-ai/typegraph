/**
 * Serialized-resource provenance, run on every backend lane.
 *
 * Three claims live here, and they are cross-backend for the same reason the
 * query-feature suites are: the answer differs per engine, so a per-dialect
 * test would happily certify a divergence.
 *
 * 1. A backend one of this package's factories built carries a connection
 *    verdict, and every backend the store derives from it carries the SAME
 *    verdict. Which verdict is lane-dependent — `serialized` on better-sqlite3,
 *    a local libsql file and PGlite, `independent` on the two pooled PostgreSQL
 *    lanes — so nothing here asserts a fixed `kind`. What is asserted is
 *    EQUALITY between a base and the object derived from it, which is the
 *    property a lost carry breaks on every lane at once.
 * 2. The backend the store's QUERIES execute through is one of those
 *    derivations. It is a transient local inside query construction that is
 *    stored nowhere, so `storeQueryBackend` is the only handle on it.
 * 3. A snapshot export and a streaming import over one serialized connection
 *    are refused with the documented code — which needs a genuinely serialized
 *    fixture, and on the pooled PostgreSQL lanes the suite's own backend is
 *    deliberately not one. That is what `context.createSerializedBackend()` is
 *    for, and one test here asserts each lane's implementation really is
 *    serialized so the refusal test cannot degrade into a no-op.
 *
 * RULE for anything added below: **a test that calls `storeQueryBackend` and
 * does not configure a query hook is asserting an object against itself.**
 * `#createHookedQueryBackend` returns its input unchanged when all three query
 * hooks are absent, so on a hookless store the accessor answers with the very
 * object it was handed, every comparison against that object holds by
 * construction, and no defect in the code past that early return is observable.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { projectGraphBackend } from "../../../src/backend/derive-backend";
import {
  resolveBackendAudit,
  sharesSerializedTransactionResource,
  snapshotExportContention,
} from "../../../src/backend/transaction-resource";
// The Store runtime port's sanctioned internal surface: `storeBackend` and
// `storeQueryBackend` are re-exported side by side there precisely so a
// consumer outside `src/store` reads both through one door.
import {
  storeBackend,
  storeQueryBackend,
} from "../../../src/graph-merge/typegraph-internal";
import { exportGraphStream, importGraphStream } from "../../../src/interchange";
import { ImportOptionsSchema } from "../../../src/interchange/types";
import { expectAuditedBackend } from "../../test-utils";
import { type IntegrationTestContext } from "./test-context";

const ProvenancePerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const provenanceGraph = defineGraph({
  id: "backend_provenance",
  nodes: { Person: { type: ProvenancePerson } },
  edges: {},
});

const provenanceSourceGraph = defineGraph({
  id: "backend_provenance_source",
  nodes: { Person: { type: ProvenancePerson } },
  edges: {},
});

const provenanceTargetGraph = defineGraph({
  id: "backend_provenance_target",
  nodes: { Person: { type: ProvenancePerson } },
  edges: {},
});

/** The minimal store options that make a hooked query backend exist. */
const QUERY_HOOKS = {
  hooks: {
    onQueryStart: () => {
      // Deliberately empty, and load-bearing anyway: what the hook DOES is
      // irrelevant, its presence is what makes the store build a hooked query
      // backend at all rather than return its input (see the RULE above).
    },
  },
} as const;

const IMPORT_OPTIONS = ImportOptionsSchema.parse({ onConflict: "error" });

export function registerBackendProvenanceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Serialized-resource provenance", () => {
    it("carries one verdict from the store's backend into the backend it exposes", async () => {
      // Four store shapes, because each reaches `store.backend` by a different
      // derivation: the frozen portable projection for the three live shapes,
      // and the history projection for `history: true`.
      const plain = await context.createStore(provenanceGraph);
      const history = await context.createHistoryStore(provenanceGraph);
      const tracked = await context.createStore(provenanceGraph, {
        revisionTracking: true,
      });
      const hooked = await context.createStore(provenanceGraph, QUERY_HOOKS);
      const shapes = [
        { name: "plain", root: storeBackend(plain), exposed: plain.backend },
        {
          name: "history: true",
          root: storeBackend(history),
          exposed: history.backend,
        },
        {
          name: "revisionTracking: true",
          root: storeBackend(tracked),
          exposed: tracked.backend,
        },
        {
          name: "hooked query",
          root: storeBackend(hooked),
          exposed: hooked.backend,
        },
      ];

      for (const shape of shapes) {
        // The verdict itself is lane-dependent; that a factory looked is not.
        expectAuditedBackend(shape.root);
        expect(
          resolveBackendAudit(shape.exposed),
          `${shape.name}: the backend this store exposes lost its base's verdict`,
        ).toEqual(resolveBackendAudit(shape.root));
      }
    });

    it("carries the verdict into the backend the store's queries execute through", async () => {
      // The object the derived-backend defect actually corrupts: it exists only
      // inside query construction, so nothing but this accessor can see it.
      const store = await context.createStore(provenanceGraph, QUERY_HOOKS);
      const root = storeBackend(store);
      const queried = storeQueryBackend(store);

      expect(queried).not.toBe(root);
      expect(resolveBackendAudit(root)).toBeDefined();
      expect(resolveBackendAudit(queried)).toEqual(resolveBackendAudit(root));
    });

    it("keeps the query backend on the store's serialized connection", async () => {
      const serialized = await context.createSerializedBackend();
      try {
        const [store] = await createStoreWithSchema(
          provenanceGraph,
          serialized.backend,
          QUERY_HOOKS,
        );

        expect(
          sharesSerializedTransactionResource(
            storeQueryBackend(store),
            storeBackend(store),
          ),
        ).toBe(true);
      } finally {
        await serialized.close();
      }
    });

    it("refuses a snapshot export streamed into a second wrapper on one connection", async () => {
      const serialized = await context.createSerializedBackend();
      try {
        const [source] = await createStoreWithSchema(
          provenanceSourceGraph,
          serialized.backend,
        );
        // A projection is a second wrapper over the SAME connection — one of
        // the shapes `transaction-resource.ts` enumerates — so the refusal is
        // decided by the shared-resource arm on every lane rather than by the
        // SQLite-only object-identity arm, and the code is one code everywhere.
        const [target] = await createStoreWithSchema(
          provenanceTargetGraph,
          projectGraphBackend(serialized.backend),
        );
        await source.nodes.Person.create({ name: "Ada" });
        const openSnapshot = vi.spyOn(storeBackend(source), "transaction");

        await expect(
          importGraphStream(target, exportGraphStream(source), IMPORT_OPTIONS),
        ).rejects.toMatchObject({
          name: "ConfigurationError",
          details: {
            code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
            graphId: provenanceTargetGraph.id,
            requested: "import-stream",
            heldBy: "export-snapshot",
          },
        });

        // Load-bearing, and not decoration: the refusal CODE alone cannot see
        // the pre-flight being lost. With `snapshotExportContention` neutered
        // the import proceeds, pulls the first chunk, finds the export holding
        // the stream lease and is refused with that identical code — one step
        // later, after the export has already opened its snapshot transaction
        // on the one connection. That the snapshot never opened is what says
        // the pre-flight answered.
        expect(openSnapshot).not.toHaveBeenCalled();
        expect(await target.nodes.Person.count()).toBe(0);
      } finally {
        vi.restoreAllMocks();
        await serialized.close();
      }
    });

    it("is handed a genuinely serialized backend by this lane", async () => {
      // Without this, the refusal test above silently becomes a no-op on any
      // lane whose implementation drifts back to the suite's pooled backend.
      const serialized = await context.createSerializedBackend();
      try {
        expect(expectAuditedBackend(serialized.backend)).toBe("serialized");
        expect(
          snapshotExportContention(serialized.backend, serialized.backend),
        ).toBeDefined();
      } finally {
        await serialized.close();
      }
    });
  });
}
