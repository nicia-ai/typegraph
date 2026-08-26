import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ApiSurfaceLedgerError,
  buildSurfaceInventory,
  type ExceptionEntry,
  EXCEPTIONS_LEDGER_RELATIVE_PATH,
  extractApiReportBody,
  parseExceptionsLedger,
  type SurfaceFinding,
  type SurfaceInventory,
  validateExceptionsLedger,
} from "../scripts/api-surface-compat";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ETC_DIR = path.join(PACKAGE_ROOT, "etc");
const BACKEND_ENTRYPOINT = "typegraph-backend.api.md";

function listApiReportFiles(): readonly string[] {
  return readdirSync(ETC_DIR)
    .filter((file) => file.endsWith(".api.md"))
    .toSorted();
}

function buildInventory(reportFile: string): SurfaceInventory {
  const source = readFileSync(path.join(ETC_DIR, reportFile), "utf8");
  return buildSurfaceInventory(extractApiReportBody(source), reportFile);
}

function makeEntry(overrides: Partial<ExceptionEntry> = {}): ExceptionEntry {
  return {
    entrypoint: BACKEND_ENTRYPOINT,
    declaration: "BackendCapabilities",
    member: "transactions",
    kind: "required-member-added",
    reason: "test fixture reason",
    issue: "#1",
    ...overrides,
  };
}

function makeFinding(overrides: Partial<SurfaceFinding> = {}): SurfaceFinding {
  return {
    entrypoint: BACKEND_ENTRYPOINT,
    declaration: "BackendCapabilities",
    member: "transactions",
    kind: "required-member-added",
    severity: "fail",
    message: "test fixture finding",
    ...overrides,
  };
}

describe("api-surface-exceptions-ledger", () => {
  it("every etc/*.api.md snapshot yields a non-empty declaration inventory", () => {
    const reportFiles = listApiReportFiles();
    expect(reportFiles.length).toBeGreaterThan(0);
    for (const reportFile of reportFiles) {
      const inventory = buildInventory(reportFile);
      expect(inventory.size).toBeGreaterThan(0);
    }
  }, 30_000);

  it("the shipped ledger resolves and rejects stale entries", () => {
    const ledgerSource = readFileSync(
      path.join(PACKAGE_ROOT, EXCEPTIONS_LEDGER_RELATIVE_PATH),
      "utf8",
    );
    const entries = parseExceptionsLedger(ledgerSource);

    // Feed the validator a matching breaking finding for every shipped entry;
    // this exercises the same exact-tuple resolution used by the API-surface
    // script without requiring this unit test to resolve a git base tag.
    const matchingFindings: SurfaceFinding[] = entries.map((entry) => ({
      ...entry,
      severity: "fail",
      message: "test fixture finding",
    }));
    expect(validateExceptionsLedger(entries, matchingFindings)).toEqual([]);

    const staleEntries = [
      ...entries,
      makeEntry({ member: "thisMemberDoesNotExist" }),
    ];
    const staleIssues = validateExceptionsLedger(
      staleEntries,
      matchingFindings,
    );
    expect(staleIssues).toHaveLength(1);
    expect(staleIssues[0]?.entry.member).toBe("thisMemberDoesNotExist");
  }, 30_000);

  it("accepts an entry only when its exact breaking finding exists", () => {
    const removedMemberEntry = makeEntry({
      member: "thisMemberDoesNotExist",
      kind: "member-removed",
    });
    const matchingFinding = makeFinding({
      member: "thisMemberDoesNotExist",
      kind: "member-removed",
    });
    expect(
      validateExceptionsLedger([removedMemberEntry], [matchingFinding]),
    ).toEqual([]);

    const wrongKindIssues = validateExceptionsLedger(
      [removedMemberEntry],
      [makeFinding({ member: "thisMemberDoesNotExist" })],
    );
    expect(wrongKindIssues).toHaveLength(1);
    expect(wrongKindIssues[0]?.entry).toBe(removedMemberEntry);
  }, 30_000);

  it("rejects an entry with an empty reason or a malformed issue", () => {
    expect(() =>
      parseExceptionsLedger(JSON.stringify([makeEntry({ reason: "   " })])),
    ).toThrow(ApiSurfaceLedgerError);
    expect(() =>
      parseExceptionsLedger(JSON.stringify([makeEntry({ reason: "   " })])),
    ).toThrow(/reason/);

    expect(() =>
      parseExceptionsLedger(
        JSON.stringify([makeEntry({ issue: "not-an-issue-link" })]),
      ),
    ).toThrow(ApiSurfaceLedgerError);
    expect(() =>
      parseExceptionsLedger(
        JSON.stringify([makeEntry({ issue: "not-an-issue-link" })]),
      ),
    ).toThrow(/issue/);
  }, 30_000);

  it("rejects a blanket exemption", () => {
    expect(() =>
      parseExceptionsLedger(JSON.stringify([makeEntry({ member: "*" })])),
    ).toThrow(ApiSurfaceLedgerError);
    expect(() =>
      parseExceptionsLedger(
        JSON.stringify([makeEntry({ member: "some*wildcard" })]),
      ),
    ).toThrow(ApiSurfaceLedgerError);
  }, 30_000);

  it("rejects a malformed refusal code and duplicate entries", () => {
    expect(() =>
      parseExceptionsLedger(
        JSON.stringify([makeEntry({ refusal: "not-screaming-snake" })]),
      ),
    ).toThrow(ApiSurfaceLedgerError);

    const duplicateEntry = makeEntry();
    expect(() =>
      parseExceptionsLedger(JSON.stringify([duplicateEntry, duplicateEntry])),
    ).toThrow(ApiSurfaceLedgerError);
  }, 30_000);

  it("a nested value-type member is not expressible as a ledger entry", () => {
    const issues = validateExceptionsLedger(
      [
        {
          entrypoint: BACKEND_ENTRYPOINT,
          declaration: "SyntheticOptions",
          member: "executeStatement",
          kind: "optionality-tightened",
          reason:
            "synthetic value-type-body tightening inside a Pick/Required intersection, which the checker does not walk",
          issue: "#1",
        },
      ],
      [],
    );

    // Exactly one issue: the member does not exist in the inventory at all,
    // because `backend`'s value type is a Pick/Required-intersection body
    // this checker never expands, so `executeStatement` never became a
    // tracked member of `SyntheticOptions` in the first place. A fabricated
    // ledger entry for this shape exempts nothing.
    expect(issues).toHaveLength(1);
    expect(issues[0]?.entry.member).toBe("executeStatement");
  }, 30_000);
});
