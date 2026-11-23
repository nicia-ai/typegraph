/**
 * THE RATCHET for the transitional shim `legacyTransactionOperation`
 * (`src/store/operation-scope.ts`).
 *
 * Store code no longer holds a transaction's statement surface: where a
 * transaction is opened or joined it receives `StoreTransactionBackend`, and a
 * statement inside a transaction goes through an operation handle. Code not
 * yet converted to mint one operation per public call obtains its handle from
 * the shim, which hands out ONE handle for the whole native transaction —
 * exactly how every statement in a transaction ran before handles existed,
 * now visible and counted.
 *
 * Every reference to the shim is found by symbol, and every call by the
 * signature the checker resolves (`legacyShimSites`), so a renamed import, a
 * namespace member, a string-literal element access, a re-export, a
 * destructured alias and a call through a stored value are all found. Only a
 * direct call by name (renamed or not) is allowed, and each is pinned to the
 * inventory below by file and enclosing function. Adding a call fails.
 * Each entry names the family whose conversion removes it;
 * `FAMILY_BASELINE` is the table those conversions count down. A conversion
 * that removes calls lowers its entries and its family here in the same
 * change.
 */
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createScanProgram,
  errorDiagnostics,
  legacyShimSites,
  PACKAGE_ROOT,
  type ScanProgram,
} from "./helpers/operation-scope-scan";

/** The family whose conversion removes a shim call. */
type Family =
  | "node writes"
  | "edge writes"
  | "query terminals and tx.backend"
  | "identity and search facades"
  | "capture and flush"
  | "schema and evolution"
  | "merge and durable operations"
  | "provenance and interchange"
  | "working copies";

/** The table each family's conversion counts down. */
const FAMILY_BASELINE = {
  "node writes": 4,
  "edge writes": 1,
  "query terminals and tx.backend": 11,
  "identity and search facades": 40,
  "capture and flush": 10,
  "schema and evolution": 12,
  "merge and durable operations": 31,
  "provenance and interchange": 7,
  "working copies": 3,
} as const satisfies Record<Family, number>;

type InventoryEntry = Readonly<{ count: number; family: Family }>;

/**
 * Every shim call in `src`, by `file#enclosing function`. Session-level work
 * (capture, flush, the schema and identity commit channel, the places a
 * transaction is opened or joined) routes through the shim for now; its end
 * state is a session, not an operation, and it is grouped with the family
 * that owns that session.
 */
const SHIM_INVENTORY: Readonly<Record<string, InventoryEntry>> = {
  // --- node writes: the write executor's spine opens the transaction every
  // managed write runs in; it becomes the real mint where the native
  // transaction is opened or joined.
  "src/store/operations/write-transaction.ts#runInWriteTransactionAttempt": {
    count: 1,
    family: "node writes",
  },
  "src/store/operations/write-transaction.ts#runOwnedMutationSetTransaction": {
    count: 1,
    family: "node writes",
  },
  "src/store/operations/node-operations.ts#executeNodeCreateInternal": {
    count: 1,
    family: "node writes",
  },
  "src/store/collections/node-collection.ts#upsertByIdFromRecord": {
    count: 1,
    family: "node writes",
  },

  // --- edge writes
  "src/store/operations/edge-operations.ts#findCandidatesInTransaction": {
    count: 1,
    family: "edge writes",
  },

  // --- query terminals: `executeOn` and `store.batch()` receive an outside
  // target through the public signature.
  "src/query/builder/executable-query.ts#ExecutableQuery.executeOn": {
    count: 1,
    family: "query terminals and tx.backend",
  },
  "src/query/builder/executable-projection-query.ts#ExecutableProjectionQuery.executeOn":
    { count: 1, family: "query terminals and tx.backend" },
  "src/query/builder/relation.ts#ExecutableRelationQuery.executeOn": {
    count: 1,
    family: "query terminals and tx.backend",
  },
  "src/query/builder/unionable-query.ts#UnionableQuery.executeOn": {
    count: 1,
    family: "query terminals and tx.backend",
  },
  // Raised from none: the implementation behind the public signature now
  // receives the Store-facing transaction, so the value it hands the
  // relation's public `executeOn` is the counted handle, not the raw type.
  "src/query/builder/executable-aggregate-query.ts#ExecutableAggregateQuery.executeOn":
    { count: 1, family: "query terminals and tx.backend" },
  "src/store/collections/edge-collection.ts#batchFindFrom": {
    count: 1,
    family: "query terminals and tx.backend",
  },
  "src/store/collections/edge-collection.ts#batchFindTo": {
    count: 1,
    family: "query terminals and tx.backend",
  },
  "src/store/collections/edge-collection.ts#batchFindByEndpoints": {
    count: 1,
    family: "query terminals and tx.backend",
  },
  "src/store/store.ts#StoreImplementation.batch": {
    count: 1,
    family: "query terminals and tx.backend",
  },
  "src/store/algorithms/iterative-graph-operation.ts#withInlineIterativeGraphOperation":
    { count: 1, family: "query terminals and tx.backend" },
  "src/store/algorithms/iterative-graph-operation.ts#runIterativeGraphOperation":
    { count: 1, family: "query terminals and tx.backend" },

  // --- identity and search facades
  "src/identity/replay.ts#currentClassMembers": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/replay.ts#everConnectedReferences": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/replay.ts#uncapturedClassMembers": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/replay.ts#unattributedRestoredTransitions": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/replay.ts#walkClassLineage": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/replay.ts#reconstructAt": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/replay.ts#walkedTransitionsFor": {
    count: 3,
    family: "identity and search facades",
  },
  "src/identity/service-facade.ts#runIdentityMutation": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/service-facade.ts#loadCurrentIdentityClassPage": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/service-facade.ts#classes": {
    count: 2,
    family: "identity and search facades",
  },
  "src/identity/service-facade.ts#areDifferent": {
    count: 6,
    family: "identity and search facades",
  },
  "src/identity/service-facade.ts#assertionsOf": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/service-facade.ts#explainSame": {
    count: 3,
    family: "identity and search facades",
  },
  "src/identity/service-maintenance.ts#runOnTransactionIfSupported": {
    count: 1,
    family: "identity and search facades",
  },
  "src/identity/service-maintenance.ts#rebuildIdentityClosureForContext": {
    count: 2,
    family: "identity and search facades",
  },
  "src/identity/service-maintenance.ts#validateIdentityForContext": {
    count: 2,
    family: "identity and search facades",
  },
  "src/identity/service-read.ts#visibleMembersAtCoordinate": {
    count: 2,
    family: "identity and search facades",
  },
  "src/store/store.ts#StoreImplementation.identityAssertionsAtTarget": {
    count: 1,
    family: "identity and search facades",
  },
  "src/store/store.ts#StoreImplementation.identityAssertionsTouchingAtTarget": {
    count: 1,
    family: "identity and search facades",
  },
  "src/store/store.ts#StoreImplementation.readIdentityAssertionPageAtTarget": {
    count: 1,
    family: "identity and search facades",
  },
  "src/store/store.ts#StoreImplementation.readIdentityTransitionPageAtTarget": {
    count: 1,
    family: "identity and search facades",
  },
  "src/store/store.ts#StoreImplementation.identityTransitionRetentionAtTarget":
    { count: 1, family: "identity and search facades" },
  "src/store/store.ts#StoreImplementation.assertIdentityClassesConsistentAtTarget":
    { count: 1, family: "identity and search facades" },
  "src/store/store.ts#StoreImplementation.applyIdentityMergeAtTarget": {
    count: 1,
    family: "identity and search facades",
  },
  "src/store/store.ts#rebuildIdentityClosureWithSchemaFence": {
    count: 1,
    family: "identity and search facades",
  },
  "src/store/fulltext-rebuild.ts#rebuildFulltextIndex": {
    count: 1,
    family: "identity and search facades",
  },
  "src/store/store.ts#StoreImplementation.rebuildContribution": {
    count: 1,
    family: "identity and search facades",
  },

  // --- capture and flush: session-level work, and the places the three
  // transaction kinds open or join the native transaction. The end state
  // hands these a session, never an operation.
  "src/store/recorded-capture.ts#runCapturedAutocommit": {
    count: 1,
    family: "capture and flush",
  },
  "src/store/recorded-capture.ts#transaction": {
    count: 1,
    family: "capture and flush",
  },
  "src/store/recorded-read-service.ts#createRecordedReadBackend": {
    count: 1,
    family: "capture and flush",
  },
  "src/store/recorded-anchor-log.ts#pruneRecordedAnchors": {
    count: 1,
    family: "capture and flush",
  },
  "src/store/allocation-owner.ts#rotateGraphAllocationOwner": {
    count: 1,
    family: "capture and flush",
  },
  "src/store/store.ts#StoreImplementation.clear": {
    count: 1,
    family: "capture and flush",
  },
  "src/store/store.ts#StoreImplementation.#runTransaction": {
    count: 2,
    family: "capture and flush",
  },
  "src/store/store.ts#StoreImplementation.withTransaction": {
    count: 1,
    family: "capture and flush",
  },
  "src/store/store.ts#StoreImplementation.withRecordedTransaction": {
    count: 1,
    family: "capture and flush",
  },

  // --- schema and evolution: the schema-write and commit-preflight channel,
  // session-level work.
  "src/schema/manager.ts#initializeSchemaImpl": {
    count: 2,
    family: "schema and evolution",
  },
  "src/schema/manager.ts#commitNewSchemaVersionWithPreflight": {
    count: 1,
    family: "schema and evolution",
  },
  "src/schema/manager.ts#rollbackSchema": {
    count: 1,
    family: "schema and evolution",
  },
  "src/identity/schema-transition.ts#provisionDerivedRelations": {
    count: 1,
    family: "schema and evolution",
  },
  "src/store/materialize-removals.ts#materializeOne": {
    count: 1,
    family: "schema and evolution",
  },
  "src/store/materialize-removals.ts#reclaimRemovedVectorFieldTables": {
    count: 1,
    family: "schema and evolution",
  },
  "src/store/store.ts#StoreImplementation.identitySchemaPreflight": {
    count: 1,
    family: "schema and evolution",
  },
  "src/store/store.ts#StoreImplementation.removeIdentityKindsInSchemaPreflight":
    { count: 1, family: "schema and evolution" },
  "src/store/store.ts#StoreImplementation.#applyEvolvedTransaction": {
    count: 3,
    family: "schema and evolution",
  },

  // --- merge and durable operations, including the Store runtime port the
  // merge drives (its members' types are spelled by the public API report).
  "src/graph-merge/merge.ts#commitPlan": {
    count: 4,
    family: "merge and durable operations",
  },
  "src/graph-merge/merge.ts#loadPlannedIdentityHistory": {
    count: 1,
    family: "merge and durable operations",
  },
  "src/graph-merge/merge.ts#applyValidatedMergePlanInTransaction": {
    count: 1,
    family: "merge and durable operations",
  },
  "src/graph-merge/merge.ts#applyMergePlanInTransaction": {
    count: 1,
    family: "merge and durable operations",
  },
  "src/graph-merge/merge.ts#commitIncrementalPlan": {
    count: 5,
    family: "merge and durable operations",
  },
  "src/graph-merge/adopted-transaction.ts#withAdoptedMergeApplySavepoint": {
    count: 1,
    family: "merge and durable operations",
  },
  "src/graph-merge/identity-separation.ts#captureIdentitySeparationFacts": {
    count: 4,
    family: "merge and durable operations",
  },
  "src/graph-merge/store-operation.ts#operateStore": {
    count: 1,
    family: "merge and durable operations",
  },
  // Two native transactions at once (source and target): one handle each.
  "src/graph-merge/namespace-fork.ts#forkGraphNamespace": {
    count: 4,
    family: "merge and durable operations",
  },
  "src/graph-merge/namespace-fork.ts#namespaceForkResult": {
    count: 1,
    family: "merge and durable operations",
  },
  "src/graph-merge/namespace-fork.ts#assertIndependentDatabase": {
    count: 1,
    family: "merge and durable operations",
  },
  "src/store/store.ts#StoreImplementation.constructor": {
    count: 7,
    family: "merge and durable operations",
  },

  // --- provenance and interchange
  "src/graph-merge/provenance-store.ts#claimSidecarOwnership": {
    count: 1,
    family: "provenance and interchange",
  },
  "src/provenance/holds.ts#readBelievedFacts": {
    count: 1,
    family: "provenance and interchange",
  },
  "src/provenance/holds.ts#assertFactsHold": {
    count: 1,
    family: "provenance and interchange",
  },
  "src/provenance/locks.ts#acquireCapabilityReadLock": {
    count: 1,
    family: "provenance and interchange",
  },
  "src/provenance/transition.ts#runTransition": {
    count: 1,
    family: "provenance and interchange",
  },
  "src/interchange/export.ts#exportGraphStreamFromBackend": {
    count: 1,
    family: "provenance and interchange",
  },
  "src/identity/interchange-read.ts#readIdentityAssertionsForInterchange": {
    count: 1,
    family: "provenance and interchange",
  },

  // --- working copies: engine-layer code that consumes the Store's
  // transaction port and Store functions.
  "src/backend/drizzle/postgres-working-copy-operations.ts#coordinatesAt": {
    count: 1,
    family: "working copies",
  },
  "src/backend/drizzle/postgres-working-copy-operations.ts#operateInAllocation":
    { count: 1, family: "working copies" },
  "src/backend/drizzle/postgres-working-copy.ts#allocate": {
    count: 1,
    family: "working copies",
  },
};

/** A module inside `src/store`, so it resolves the shim like a store module. */
const SHIM_FIXTURE = "src/store/legacy-shim-reference.fixture.ts";

/** A second store module, re-exporting the shim, which the fixture imports. */
const SHIM_REEXPORT_FIXTURE = "src/store/legacy-shim-reexport.fixture.ts";

const SHIM_REEXPORT_SOURCE = `
export { legacyTransactionOperation as reexported } from "./operation-scope";
export * from "./operation-scope";
`;

const SHIM_FIXTURE_SOURCE = `
import type { TransactionBackend } from "../backend/types";
import {
  legacyTransactionOperation,
  legacyTransactionOperation as renamed,
} from "./operation-scope";
import * as scope from "./operation-scope";
import { reexported } from "./legacy-shim-reexport.fixture";

declare const raw: TransactionBackend;
declare const key: "legacyTransactionOperation";
declare function spread(value: object): void;

export function direct() { return legacyTransactionOperation(raw); }
export function throughRename() { return renamed(raw); }
export function throughNamespace() { return scope.legacyTransactionOperation(raw); }
export function throughElementAccess() { return scope["legacyTransactionOperation"](raw); }
export function throughComputedKey() { return scope[key](raw); }
export function throughNamespaceValue() { spread(scope); }
export function stored() { const shim = legacyTransactionOperation; return shim(raw); }
export function destructured() { const { legacyTransactionOperation: shim } = scope; return shim(raw); }
export function throughCall() { return legacyTransactionOperation.call(undefined, raw); }
export function throughReexport() { return reexported(raw); }
export { legacyTransactionOperation as forwarded };
`;

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const label = key(value);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

describe("legacyTransactionOperation ratchet", () => {
  let scan: ScanProgram;

  beforeAll(() => {
    scan = createScanProgram({
      [SHIM_FIXTURE]: SHIM_FIXTURE_SOURCE,
      [SHIM_REEXPORT_FIXTURE]: SHIM_REEXPORT_SOURCE,
    });
  }, 180_000);

  it(
    "every shim call in src is inventoried by file, function and count",
    { timeout: 180_000 },
    () => {
      const sites = legacyShimSites(scan, scan.sourceFiles);
      expect(sites.filter((site) => site.form !== "call")).toEqual([]);
      expect(countBy(sites, (site) => `${site.file}#${site.function}`)).toEqual(
        Object.fromEntries(
          Object.entries(SHIM_INVENTORY).map(([label, entry]) => [
            label,
            entry.count,
          ]),
        ),
      );
    },
  );

  it("the family table is the inventory's sum, and only decreases", () => {
    const totals = Object.fromEntries(
      Object.keys(FAMILY_BASELINE).map((family) => [family, 0]),
    ) as Record<Family, number>;
    for (const entry of Object.values(SHIM_INVENTORY)) {
      totals[entry.family] += entry.count;
    }
    expect(totals).toEqual(FAMILY_BASELINE);
  });

  it("finds every way of naming the shim, and allows only a direct call", () => {
    expect(errorDiagnostics(scan, SHIM_FIXTURE)).toEqual([]);
    const sites = legacyShimSites(scan, [
      path.join(PACKAGE_ROOT, SHIM_FIXTURE),
      path.join(PACKAGE_ROOT, SHIM_REEXPORT_FIXTURE),
    ]);
    expect(
      sites.map((site) => ({
        file: path.basename(site.file),
        function: site.function,
        form: site.form,
      })),
    ).toEqual([
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "direct",
        form: "call",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughRename",
        form: "call",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughNamespace",
        form: "namespace",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughElementAccess",
        form: "element-access",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughComputedKey",
        form: "indirect-call",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughComputedKey",
        form: "namespace-value",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughNamespaceValue",
        form: "namespace-value",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "stored",
        form: "value",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "stored",
        form: "indirect-call",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "destructured",
        form: "alias",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "destructured",
        form: "namespace-value",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "destructured",
        form: "indirect-call",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughCall",
        form: "value",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "throughReexport",
        form: "call",
      },
      {
        file: "legacy-shim-reference.fixture.ts",
        function: "<module>",
        form: "re-export",
      },
      {
        file: "legacy-shim-reexport.fixture.ts",
        function: "<module>",
        form: "re-export",
      },
      {
        file: "legacy-shim-reexport.fixture.ts",
        function: "<module>",
        form: "re-export",
      },
    ]);
  });
});
