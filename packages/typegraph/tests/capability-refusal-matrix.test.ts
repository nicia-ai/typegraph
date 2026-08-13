/**
 * T10 (skeleton) — every `refuse` operation row in the pilot registry names
 * a non-empty code; every GRADUATED bundle's refuse row carries a non-empty
 * `requires` (that is how a graduated bundle still refuses where the tree
 * refuses today); and the enumerated `(bundle, operation, code)` set equals
 * a pinned table, in BOTH directions, so neither a row silently disappearing
 * nor an unpinned row silently appearing goes unnoticed.
 *
 * Behavioral rows (actually exercising the refusal against a backend) land
 * in B7/B8 — this file enumerates the registry's OWN data.
 */
import { describe, expect, it } from "vitest";

import { CAPABILITY_BUNDLES } from "../src/backend/capabilities/bundle-registry";

type RefusalRow = Readonly<{
  bundle: string;
  operation: string;
  code: string;
  graduated: boolean;
  requires: readonly string[] | undefined;
}>;

function enumerateRefusalRows(): readonly RefusalRow[] {
  const rows: RefusalRow[] = [];
  for (const bundle of CAPABILITY_BUNDLES) {
    for (const operation of bundle.operations) {
      if (operation.disposition.kind !== "refuse") continue;
      rows.push({
        bundle: bundle.id,
        operation: operation.operation,
        code: operation.disposition.code,
        graduated: bundle.kind === "graduated",
        requires: "requires" in operation ? operation.requires : undefined,
      });
    }
  }
  return rows;
}

// The pinned table — `(bundle, operation, code)` triples the enumeration
// must reproduce EXACTLY, in both directions.
const PINNED_REFUSAL_TABLE: readonly (readonly [string, string, string])[] = [
  [
    "uniqueSidecarBatch",
    "unique reap by node ids",
    "UNIQUE_REAP_BY_NODE_IDS_UNSUPPORTED",
  ],
  [
    "uniqueSidecarBatch",
    "set-based node update",
    "SET_UPDATE_UNIQUENESS_UNSUPPORTED",
  ],
  [
    "uniqueSidecarBatch",
    "resolved node write",
    "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED",
  ],
  [
    "statementExecution",
    "identity statement execution",
    "IDENTITY_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "recorded capture statement",
    "RECORDED_CAPTURE_STATEMENT_UNSUPPORTED",
  ],
  [
    "statementExecution",
    "history construction gate",
    "HISTORY_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "revision tracking construction gate",
    "REVISION_TRACKING_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "identity construction gate",
    "IDENTITY_REQUIRES_ATOMIC_BACKEND",
  ],
  [
    "statementExecution",
    "validity window repair",
    "VALIDITY_WINDOW_REPAIR_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "recorded-time migration",
    "RECORDED_TIME_MIGRATION_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "statementExecution",
    "legacy anchor map delete",
    "LEGACY_ANCHOR_MAP_DELETE_REQUIRES_STATEMENT_EXECUTION",
  ],
  [
    "contributionHealth",
    "contribution verify",
    "CONTRIBUTION_VERIFY_UNSUPPORTED",
  ],
  [
    "contributionHealth",
    "contribution repair",
    "CONTRIBUTION_REPAIR_UNSUPPORTED",
  ],
  [
    "contributionHealth",
    "contribution rebuild",
    "CONTRIBUTION_REBUILD_UNSUPPORTED",
  ],
  [
    "recordedRevisionOrigins",
    "revision tracking construction gate",
    "REVISION_TRACKING_REQUIRES_REVISION_ORIGINS",
  ],
  [
    "recordedRevisionOrigins",
    "revision origin bootstrap",
    "REVISION_ORIGIN_BOOTSTRAP_UNSUPPORTED",
  ],
];

describe("capability refusal matrix (T10, skeleton)", () => {
  it("every refuse row names a non-empty code", () => {
    for (const row of enumerateRefusalRows()) {
      expect(row.code.length, `${row.bundle}/${row.operation}`).toBeGreaterThan(
        0,
      );
    }
  });

  it("every graduated bundle's refuse row carries a non-empty `requires`", () => {
    for (const row of enumerateRefusalRows()) {
      if (!row.graduated) continue;
      expect(
        row.requires,
        `${row.bundle}/${row.operation} is a graduated refuse row with no requires`,
      ).toBeDefined();
      expect((row.requires ?? []).length).toBeGreaterThan(0);
    }
  });

  it("the enumerated (bundle, operation, code) set equals the pinned table, in both directions", () => {
    const enumerated = enumerateRefusalRows().map(
      (row) => [row.bundle, row.operation, row.code] as const,
    );
    const enumeratedKeys = new Set(enumerated.map((row) => row.join(" ")));
    const pinnedKeys = new Set(
      PINNED_REFUSAL_TABLE.map((row) => row.join(" ")),
    );

    const missingFromPinned = [...enumeratedKeys].filter(
      (key) => !pinnedKeys.has(key),
    );
    const missingFromEnumerated = [...pinnedKeys].filter(
      (key) => !enumeratedKeys.has(key),
    );

    expect(missingFromPinned, "rows in the registry but not pinned").toEqual(
      [],
    );
    expect(
      missingFromEnumerated,
      "rows pinned but missing from the registry",
    ).toEqual([]);
  });
});
