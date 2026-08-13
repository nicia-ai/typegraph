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

function buildAllInventories(): Map<string, SurfaceInventory> {
  const inventories = new Map<string, SurfaceInventory>();
  for (const reportFile of listApiReportFiles()) {
    inventories.set(reportFile, buildInventory(reportFile));
  }
  return inventories;
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

describe("api-surface-exceptions-ledger", () => {
  it("every etc/*.api.md snapshot yields a non-empty declaration inventory", () => {
    const reportFiles = listApiReportFiles();
    expect(reportFiles.length).toBeGreaterThan(0);
    for (const reportFile of reportFiles) {
      const inventory = buildInventory(reportFile);
      expect(inventory.size).toBeGreaterThan(0);
    }
  }, 30_000);

  it("the shipped ledger parses and resolves against the current snapshots", () => {
    const ledgerSource = readFileSync(
      path.join(PACKAGE_ROOT, EXCEPTIONS_LEDGER_RELATIVE_PATH),
      "utf8",
    );
    const entries = parseExceptionsLedger(ledgerSource);
    const inventories = buildAllInventories();
    expect(validateExceptionsLedger(entries, inventories)).toEqual([]);

    // Seeding with a stale synthetic entry (a member that does not exist)
    // must surface as an issue rather than being silently accepted.
    const staleEntries = [
      ...entries,
      makeEntry({ member: "thisMemberDoesNotExist" }),
    ];
    const staleIssues = validateExceptionsLedger(staleEntries, inventories);
    expect(staleIssues).toHaveLength(1);
    expect(staleIssues[0]?.entry.member).toBe("thisMemberDoesNotExist");
  }, 30_000);

  it("rejects an entry whose member is not required in head", () => {
    const inventories = buildAllInventories();

    const optionalMemberEntry = makeEntry({ member: "clearValidTo" });
    const optionalMemberIssues = validateExceptionsLedger(
      [optionalMemberEntry],
      inventories,
    );
    expect(optionalMemberIssues).toHaveLength(1);
    expect(optionalMemberIssues[0]?.entry).toBe(optionalMemberEntry);

    const unknownDeclarationEntry = makeEntry({
      declaration: "NotADeclaration",
    });
    const unknownDeclarationIssues = validateExceptionsLedger(
      [unknownDeclarationEntry],
      inventories,
    );
    expect(unknownDeclarationIssues).toHaveLength(1);
    expect(unknownDeclarationIssues[0]?.entry).toBe(unknownDeclarationEntry);
  }, 30_000);

  it("accepts a member-removed entry only when the member is absent from head", () => {
    const inventories = buildAllInventories();

    const absentMemberEntry = makeEntry({
      member: "thisMemberDoesNotExist",
      kind: "member-removed",
    });
    expect(validateExceptionsLedger([absentMemberEntry], inventories)).toEqual(
      [],
    );

    const presentMemberEntry = makeEntry({
      member: "transactions",
      kind: "member-removed",
    });
    const presentMemberIssues = validateExceptionsLedger(
      [presentMemberEntry],
      inventories,
    );
    expect(presentMemberIssues).toHaveLength(1);
    expect(presentMemberIssues[0]?.entry).toBe(presentMemberEntry);
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
});
