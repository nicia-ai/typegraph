/**
 * The review's edits, applied to the real modules they were made in, in a
 * program over the whole of `src`. Each one is a way Store code got past the
 * statement gate with `tsc` and every scan passing; each must now draw the
 * type error named here. A virtual file replaces the module at its own path,
 * so the edited module type-checks exactly as the real one would.
 *
 * The shim inventory's bracket-access edit lives with the shim ratchet's own
 * fixture (`tests/legacy-transaction-operation-ratchet.test.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createScanProgram,
  errorDiagnostics,
  PACKAGE_ROOT,
  rawTransactionSites,
  type ScanProgram,
} from "./helpers/operation-scope-scan";

type Edit = Readonly<{
  /** The module the edit is made in, relative to the package root. */
  file: string;
  /** Each `[find, replace]` must match the module exactly once. */
  replacements: readonly (readonly [string, string])[];
}>;

function applied(edit: Edit): string {
  let text = readFileSync(path.join(PACKAGE_ROOT, edit.file), "utf8");
  for (const [find, replace] of edit.replacements) {
    const first = text.indexOf(find);
    if (first === -1 || text.includes(find, first + 1)) {
      throw new Error(`${edit.file}: the edit no longer matches exactly once`);
    }
    text = text.replace(find, replace);
  }
  return text;
}

const ALLOCATION_OWNER = "src/store/allocation-owner.ts";
const ALLOCATION_OWNER_CALLBACK = `backend.transaction(async (transaction: StoreTransactionBackend) => {
          const target = legacyTransactionOperation(transaction);`;

/**
 * P2: an ordinary transaction callback annotated as the schema-write
 * transaction, then DDL through the shim it already calls.
 */
const SCHEMA_WRITE_ANNOTATION: Edit = {
  file: ALLOCATION_OWNER,
  replacements: [
    [
      ALLOCATION_OWNER_CALLBACK,
      `backend.transaction(async (transaction: StoreTransactionBackend<import("../backend/types").SchemaWriteTransactionBackend>) => {
          const target = legacyTransactionOperation(transaction);
          await target.executeSchemaDdl("SELECT 1");`,
    ],
  ],
};

/** The same question for the other specialisation: the preflight target. */
const PREFLIGHT_ANNOTATION: Edit = {
  file: ALLOCATION_OWNER,
  replacements: [
    [
      ALLOCATION_OWNER_CALLBACK,
      `backend.transaction(async (transaction: StoreTransactionBackend<import("../backend/types").SchemaCommitPreflightBackend>) => {
          const target = legacyTransactionOperation(transaction);
          await target.executeSchemaDdl?.("SELECT 1");`,
    ],
  ],
};

/** And for the preflight specialisation one level down, on the handle. */
const PREFLIGHT_HANDLE_ANNOTATION: Edit = {
  file: ALLOCATION_OWNER,
  replacements: [
    [
      ALLOCATION_OWNER_CALLBACK,
      `backend.transaction(async (transaction: StoreTransactionBackend) => {
          const preflight: import("./operation-scope").OperationScoped<import("../backend/types").SchemaCommitPreflightBackend> = legacyTransactionOperation(transaction);
          await preflight.executeSchemaDdl?.("SELECT 1");
          const target = legacyTransactionOperation(transaction);`,
    ],
  ],
};

/**
 * P2: a statement on an allowlisted public parameter, before the shim the
 * body already calls.
 */
const STATEMENT_ON_PUBLIC_PARAMETER: Edit = {
  file: "src/query/builder/executable-projection-query.ts",
  replacements: [
    [
      `    const rows = await this.#fetchRows(
      legacyTransactionOperation(backend),
      this.toAst(),
    );`,
      `    await backend.getNode("graph", "Kind", "id");
    const rows = await this.#fetchRows(
      legacyTransactionOperation(backend),
      this.toAst(),
    );`,
    ],
  ],
};

/** Argument of type … is not assignable to parameter of type …. */
const NOT_ASSIGNABLE_ARGUMENT = 2345;
/** Type … is not assignable to type … (under `exactOptionalPropertyTypes`). */
const NOT_ASSIGNABLE = 2375;
/** Property … does not exist on type …. */
const NO_SUCH_PROPERTY = 2339;

function codes(scan: ScanProgram, file: string): readonly number[] {
  return [...new Set(errorDiagnostics(scan, file).map(([, code]) => code))];
}

describe("the review's edits", () => {
  // One program per edit of the same module; the two modules' edits share one.
  let schemaWrite: ScanProgram;
  let preflight: ScanProgram;
  let preflightHandle: ScanProgram;

  beforeAll(() => {
    schemaWrite = createScanProgram({
      [SCHEMA_WRITE_ANNOTATION.file]: applied(SCHEMA_WRITE_ANNOTATION),
      [STATEMENT_ON_PUBLIC_PARAMETER.file]: applied(
        STATEMENT_ON_PUBLIC_PARAMETER,
      ),
    });
    preflight = createScanProgram({
      [PREFLIGHT_ANNOTATION.file]: applied(PREFLIGHT_ANNOTATION),
    });
    preflightHandle = createScanProgram({
      [PREFLIGHT_HANDLE_ANNOTATION.file]: applied(PREFLIGHT_HANDLE_ANNOTATION),
    });
  }, 360_000);

  it("a schema-write annotation on an ordinary transaction callback fails tsc", () => {
    expect(codes(schemaWrite, ALLOCATION_OWNER)).toEqual([
      NOT_ASSIGNABLE_ARGUMENT,
    ]);
  });

  it("a preflight annotation on an ordinary transaction callback fails tsc", () => {
    expect(codes(preflight, ALLOCATION_OWNER)).toEqual([
      NOT_ASSIGNABLE_ARGUMENT,
    ]);
  });

  it("a preflight annotation on an ordinary handle fails tsc", () => {
    expect(codes(preflightHandle, ALLOCATION_OWNER)).toEqual([NOT_ASSIGNABLE]);
  });

  it(
    "a statement on the public executeOn parameter fails tsc, and the scan has nothing to excuse",
    { timeout: 180_000 },
    () => {
      expect(codes(schemaWrite, STATEMENT_ON_PUBLIC_PARAMETER.file)).toEqual([
        NO_SUCH_PROPERTY,
      ]);
      // The public overload is the only place the engine type remains.
      expect(
        rawTransactionSites(schemaWrite, [
          path.join(PACKAGE_ROOT, STATEMENT_ON_PUBLIC_PARAMETER.file),
        ]).map((site) => site.route),
      ).toEqual(["signature"]);
    },
  );
});
