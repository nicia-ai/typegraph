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
 *
 * THE RATCHET is `FAMILY_BASELINE`: per family, the number of shim calls
 * that family's conversion removes. A baseline may only go DOWN. A change
 * that removes calls lowers its inventory entries and its family's baseline
 * in the same commit. A change that raises a baseline must state why in the
 * pull request that does it (and in a comment on the inventory entry); no
 * mechanism here compares against the base branch, so the raised number in
 * the diff is what a reviewer sees. The family-total test below is a
 * consistency check between the inventory and the table, not the ratchet: it
 * passes whenever both are raised together.
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
  "node writes": 0,
  "edge writes": 0,
  "query terminals and tx.backend": 0,
  "identity and search facades": 0,
  "capture and flush": 10,
  "schema and evolution": 12,
  "merge and durable operations": 0,
  "provenance and interchange": 0,
  "working copies": 0,
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
  // --- node writes and edge writes: none. Where the write executor or a
  // node or edge write opens a transaction it opens a session for it
  // (`openTransactionSession`), and every public node or edge write inside a
  // transaction enters its own operation of the session the transaction
  // context carries; see LEGACY_WRITE_ENTRY_INVENTORY for the callers outside
  // those families that still hold no session.

  // --- query terminals and tx.backend: none. A query built inside a
  // transaction carries its session (`query-operation.ts`) and enters one
  // operation of it per execution, as does each `tx.backend` read member; a
  // target arriving through `executeOn` (and so `store.batch()` and the edge
  // batch finders) enters through `enterTargetOperation`, and an iterative
  // algorithm opens the session of the read transaction it opens.

  // --- identity and search facades: none. Each call of an identity facade
  // enters one operation of the facade's scope (the root, or the session of
  // the transaction context that offers it) after its refusals, and runs under
  // a context built over that operation's handle; a Store identity port call
  // whose target arrives through a signature the public API spells enters
  // through `enterTargetOperation`; and identity maintenance, the fulltext
  // rebuild and the contribution rebuild open a session where they open their
  // transaction.

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

  // --- merge and durable operations: none. Merge apply and a durable Store
  // operation enter one operation of the session the transaction context's
  // runtime carries (`enterTransactionOperation`); the namespace fork opens a
  // session where it opens each of its native transactions; the identity
  // separation and planned-history reads run on the root. The Store runtime
  // port's members that take a statement target have a statement port
  // (`storeStatementPort`) a handle passes through unminted; their public
  // forms, whose types the API reports spell, enter a transaction target as a
  // binding of its own (`enterTargetOperation`).

  // --- provenance and interchange: none. Provenance enters an operation of
  // the session its transaction context carries (`enterTransactionOperation`);
  // the sidecar claim and the export open the session of the transaction they
  // open; the interchange identity read is handed its caller's target.

  // --- working copies: none. A durable operation enters an operation of the
  // session its transaction context carries, and the clone opens the session
  // of the source transaction it opens.
};

/**
 * The transitional `legacyWriteEntry` (`write-transaction.ts`): a write entry
 * for code that holds a bare handle and no session, which joins as a binding
 * of its own. Same counting rules as the shim. Every call wraps a shim call in
 * the same function, and is assigned the family that shim call is: that
 * family's conversion hands the call a session and removes both.
 * `LEGACY_WRITE_ENTRY_FAMILY_BASELINE` is its ratchet, and may only go down.
 */
const LEGACY_WRITE_ENTRY = {
  module: "src/store/operations/write-transaction.ts",
  name: "legacyWriteEntry",
} as const;

const LEGACY_WRITE_ENTRY_INVENTORY: Readonly<Record<string, InventoryEntry>> = {
  // RAISED from 0 by the identity and search facades conversion, which
  // moved these two here from `runIdentityMutation` and
  // `rebuildIdentityClosureWithSchemaFence`: an identity mutation and the
  // closure recompute now take their write entry from their caller, and these
  // two callers hold a bare handle and no session (the kind-removal cascade
  // the schema-commit preflight runs, and the derived-relation fence that
  // hands the recompute port its transaction). That family's conversion
  // opens a session where those transactions open and removes both.
  "src/store/store.ts#StoreImplementation.removeIdentityKindsInSchemaPreflight":
    { count: 1, family: "schema and evolution" },
  "src/identity/schema-transition.ts#provisionDerivedRelations": {
    count: 1,
    family: "schema and evolution",
  },
};

/** The legacy write entries each family's conversion removes. May only go down. */
const LEGACY_WRITE_ENTRY_FAMILY_BASELINE = {
  "node writes": 0,
  "edge writes": 0,
  "query terminals and tx.backend": 0,
  "identity and search facades": 0,
  "capture and flush": 0,
  "schema and evolution": 2,
  "merge and durable operations": 0,
  "provenance and interchange": 0,
  "working copies": 0,
} as const satisfies Record<Family, number>;

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

  it(
    "every legacy write entry in src is inventoried by file, function and count",
    { timeout: 180_000 },
    () => {
      const sites = legacyShimSites(scan, scan.sourceFiles, LEGACY_WRITE_ENTRY);
      expect(sites.filter((site) => site.form !== "call")).toEqual([]);
      expect(countBy(sites, (site) => `${site.file}#${site.function}`)).toEqual(
        Object.fromEntries(
          Object.entries(LEGACY_WRITE_ENTRY_INVENTORY).map(([label, entry]) => [
            label,
            entry.count,
          ]),
        ),
      );
    },
  );

  // A consistency check, not the ratchet: see the header.
  it("the family table is the inventory's per-family sum", () => {
    const totals = Object.fromEntries(
      Object.keys(FAMILY_BASELINE).map((family) => [family, 0]),
    ) as Record<Family, number>;
    for (const entry of Object.values(SHIM_INVENTORY)) {
      totals[entry.family] += entry.count;
    }
    expect(totals).toEqual(FAMILY_BASELINE);
  });

  // Consistency checks, not the ratchet: the legacy write entry's family table
  // is its inventory's per-family sum, and each of its sites belongs to the
  // family of the shim call in the same function, so the conversion that
  // removes that shim call is the one that removes the entry.
  it("the legacy write entry family table is its inventory's per-family sum", () => {
    const totals = Object.fromEntries(
      Object.keys(LEGACY_WRITE_ENTRY_FAMILY_BASELINE).map((family) => [
        family,
        0,
      ]),
    ) as Record<Family, number>;
    for (const entry of Object.values(LEGACY_WRITE_ENTRY_INVENTORY)) {
      totals[entry.family] += entry.count;
    }
    expect(totals).toEqual(LEGACY_WRITE_ENTRY_FAMILY_BASELINE);
  });

  it("each legacy write entry belongs to the family of the shim call beside it", () => {
    const families = Object.fromEntries(
      Object.entries(LEGACY_WRITE_ENTRY_INVENTORY).map(([label, entry]) => [
        label,
        entry.family,
      ]),
    );
    const shimFamilies = Object.fromEntries(
      Object.keys(LEGACY_WRITE_ENTRY_INVENTORY).map((label) => [
        label,
        SHIM_INVENTORY[label]?.family,
      ]),
    );
    expect(shimFamilies).toEqual(families);
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
