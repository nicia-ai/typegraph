/**
 * L3's missing-peer refusal fixture (design §4.4b, ruling OQ1/F-1/r3-OQ2).
 * Every test here uses SYNTHETIC error objects — no build required — because
 * `isMissingDrizzlePeerError`/`loadDrizzleBackedModule` are pure functions of
 * an error shape, not of a real module resolution failure.
 *
 * The two "wiring" tests at the bottom prove `createLocalSqliteStore` /
 * `createLocalPgliteStore` actually reach the ledger's refusal through their
 * dynamic import, rather than merely proving the predicate and wrapper work
 * in isolation. `vi.doMock` cannot simulate this end-to-end (Vitest wraps
 * any module-factory failure into its own generic mocking error before the
 * dynamic `import()` ever rejects with OUR synthetic shape — confirmed by
 * experiment, see `impl-notes-port-isolation.md`), so those two tests
 * substitute a STRUCTURAL assertion: each store module's `local-store.ts` /
 * `pglite-store.ts` file contains exactly one `ImportExpression`, and it is
 * nested inside a call to `loadDrizzleBackedModule(...)` — the only path by
 * which a store module may reach its impl module at all.
 */
import fs from "node:fs";
import path from "node:path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { repositoryRoot } from "../scripts/drizzle-claim-inventory";
import { classifyEntrypoints } from "../scripts/drizzle-reachability-scan";
import { ConfigurationError } from "../src";
import {
  isMissingDrizzlePeerError,
  loadDrizzleBackedModule,
  MISSING_PEER_INSTALL_COMMAND,
  MISSING_PEER_LEDGER,
  MISSING_PEER_PACKAGE,
} from "../src/backend/missing-peer-ledger";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

/** A `load` callback that rejects with `error`, for `loadDrizzleBackedModule`. */
function rejectWith(error: Error): () => Promise<never> {
  return () => Promise.reject(error);
}

/** A synthetic Node module-resolution failure with a `code` and `message`. */
function moduleError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * The structural substitute for the wiring tests below (see module doc):
 * `vi.doMock` cannot make the dynamic import inside `createLocalSqliteStore`
 * / `createLocalPgliteStore` reject with a synthetic error shape — Vitest
 * intercepts a throwing module factory and replaces it with its own generic
 * "there was an error when mocking a module" error before the `import()`
 * expression ever settles, so `isMissingDrizzlePeerError` never sees the
 * synthetic error at all. This asserts the STRUCTURE that makes the refusal
 * reachable instead: `filePath`'s only reference to its impl module is a
 * single dynamic `import(...)`, and that import is an argument reachable
 * only through a `loadDrizzleBackedModule(...)` call — never a factory that
 * awaits `import(...)` directly.
 */
function soleImportExpressionIsWrappedByLoadDrizzleBackedModule(
  filePath: string,
): boolean {
  const text = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const importExpressions: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      importExpressions.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  if (importExpressions.length !== 1) return false;
  const [importExpression] = importExpressions;
  if (importExpression === undefined) return false;

  // `ts.Node["parent"]` is declared non-optional (it is only unset on the
  // root `SourceFile`), so the loop terminates by checking for the
  // `SourceFile` itself rather than comparing `.parent` to `undefined`.
  let current: ts.Node = importExpression;
  while (!ts.isSourceFile(current)) {
    current = current.parent;
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "loadDrizzleBackedModule"
    ) {
      return true;
    }
  }
  return false;
}

describe("missing-peer-ledger", () => {
  describe("isMissingDrizzlePeerError / loadDrizzleBackedModule", () => {
    it("refuses a missing drizzle-orm peer raised as ERR_MODULE_NOT_FOUND (ESM)", async () => {
      const cause = moduleError(
        "ERR_MODULE_NOT_FOUND",
        "Cannot find package 'drizzle-orm' imported from /x/dist/backend/sqlite/impl-AB12.js",
      );

      expect(isMissingDrizzlePeerError(cause)).toBe(true);

      let caught: unknown;
      try {
        await loadDrizzleBackedModule("./sqlite/local", rejectWith(cause));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConfigurationError);
      const configurationError = caught as ConfigurationError;
      expect(configurationError.details["code"]).toBe(
        "MISSING_PEER_DEPENDENCY",
      );
      expect(configurationError.details["package"]).toBe("drizzle-orm");
      expect(configurationError.details["entrypoint"]).toBe("./sqlite/local");
      expect(configurationError.message).toContain("drizzle-orm");
      expect(configurationError.message).toContain("npm install drizzle-orm");
      expect(configurationError.cause).toBe(cause);
    });

    it("refuses a missing drizzle-orm subpath raised as MODULE_NOT_FOUND (CJS)", async () => {
      const cause = moduleError(
        "MODULE_NOT_FOUND",
        "Cannot find module 'drizzle-orm/better-sqlite3'\nRequire stack:\n- /x/dist/backend/sqlite/local-store.cjs",
      );

      expect(isMissingDrizzlePeerError(cause)).toBe(true);

      let caught: unknown;
      try {
        await loadDrizzleBackedModule("./sqlite/local", rejectWith(cause));
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ConfigurationError);
      const configurationError = caught as ConfigurationError;
      expect(configurationError.details["code"]).toBe(
        "MISSING_PEER_DEPENDENCY",
      );
      expect(configurationError.details["package"]).toBe("drizzle-orm");
      expect(configurationError.details["entrypoint"]).toBe("./sqlite/local");
      expect(configurationError.message).toContain("drizzle-orm");
      expect(configurationError.message).toContain("npm install drizzle-orm");
      expect(configurationError.cause).toBe(cause);
    });

    it("rethrows ERR_PACKAGE_PATH_NOT_EXPORTED untouched", async () => {
      const cause = moduleError(
        "ERR_PACKAGE_PATH_NOT_EXPORTED",
        `Package subpath './better-sqlite3' is not defined by "exports" in /x/node_modules/drizzle-orm/package.json`,
      );

      expect(isMissingDrizzlePeerError(cause)).toBe(false);
      await expect(
        loadDrizzleBackedModule("./sqlite/local", rejectWith(cause)),
      ).rejects.toBe(cause);
    });

    it("does not launder a dependency of drizzle-orm that is itself missing", async () => {
      const esmCause = moduleError(
        "ERR_MODULE_NOT_FOUND",
        "Cannot find package 'some-internal-dep' imported from /x/node_modules/drizzle-orm/bs3.js",
      );
      const cjsCause = moduleError(
        "MODULE_NOT_FOUND",
        "Cannot find module 'some-internal-dep'",
      );

      expect(isMissingDrizzlePeerError(esmCause)).toBe(false);
      expect(isMissingDrizzlePeerError(cjsCause)).toBe(false);

      await expect(
        loadDrizzleBackedModule("./sqlite/local", rejectWith(esmCause)),
      ).rejects.toBe(esmCause);
      await expect(
        loadDrizzleBackedModule("./sqlite/local", rejectWith(cjsCause)),
      ).rejects.toBe(cjsCause);
    });

    it("rethrows a missing non-Drizzle peer untouched", async () => {
      const cause = moduleError(
        "MODULE_NOT_FOUND",
        "Cannot find module 'better-sqlite3'",
      );

      expect(isMissingDrizzlePeerError(cause)).toBe(false);
      await expect(
        loadDrizzleBackedModule("./sqlite/local", rejectWith(cause)),
      ).rejects.toBe(cause);
    });
  });

  describe("MISSING_PEER_LEDGER", () => {
    it("the ledger's typed-refusal arm equals the adapter-dynamic-only classification", () => {
      const classification = classifyEntrypoints();

      const typedRefusalEntrypoints = new Set(
        MISSING_PEER_LEDGER.filter(
          (entry) => entry.arm === "typed-refusal",
        ).map((entry) => entry.entrypoint),
      );
      const dynamicOnlyEntrypoints = new Set(
        Object.entries(classification)
          .filter(([, value]) => value === "adapter-dynamic-only")
          .map(([entrypoint]) => entrypoint),
      );
      expect(typedRefusalEntrypoints).toEqual(dynamicOnlyEntrypoints);

      const documentedResolutionErrorEntrypoints = new Set(
        MISSING_PEER_LEDGER.filter(
          (entry) => entry.arm === "documented-resolution-error",
        ).map((entry) => entry.entrypoint),
      );
      const adapterStaticEntrypoints = new Set(
        Object.entries(classification)
          .filter(([, value]) => value === "adapter-static")
          .map(([entrypoint]) => entrypoint),
      );
      expect(documentedResolutionErrorEntrypoints).toEqual(
        adapterStaticEntrypoints,
      );
    });

    it("every non-portable published entrypoint has exactly one ledger row", () => {
      const classification = classifyEntrypoints();
      const nonPortableEntrypoints = Object.entries(classification)
        .filter(([, value]) => value !== "portable")
        .map(([entrypoint]) => entrypoint)
        .toSorted();

      const ledgerEntrypoints = MISSING_PEER_LEDGER.map(
        (entry) => entry.entrypoint,
      );
      expect(new Set(ledgerEntrypoints).size).toBe(ledgerEntrypoints.length);
      expect(ledgerEntrypoints.toSorted()).toEqual(nonPortableEntrypoints);
    });

    it("every documented-resolution-error row names files that state the package and the install command", () => {
      const root = repositoryRoot();
      const documentedResolutionErrorRows = MISSING_PEER_LEDGER.filter(
        (entry) => entry.arm === "documented-resolution-error",
      );
      expect(documentedResolutionErrorRows.length).toBeGreaterThan(0);

      for (const row of documentedResolutionErrorRows) {
        expect(row.documentedIn.length).toBeGreaterThan(0);
        for (const documentedFile of row.documentedIn) {
          const absolutePath = path.join(root, documentedFile);
          expect(
            fs.existsSync(absolutePath),
            `${row.entrypoint}: documentedIn file does not exist: ${documentedFile}`,
          ).toBe(true);
          const text = fs.readFileSync(absolutePath, "utf8");
          expect(
            text.includes(MISSING_PEER_PACKAGE),
            `${documentedFile} does not mention ${MISSING_PEER_PACKAGE}`,
          ).toBe(true);
          expect(
            text.includes(MISSING_PEER_INSTALL_COMMAND),
            `${documentedFile} does not mention "${MISSING_PEER_INSTALL_COMMAND}"`,
          ).toBe(true);
        }
      }
    });
  });

  describe("wiring: the dynamic import is reachable only through loadDrizzleBackedModule", () => {
    it("createLocalSqliteStore refuses when its impl module cannot resolve drizzle-orm", () => {
      const filePath = path.join(
        PACKAGE_ROOT,
        "src/backend/sqlite/local-store.ts",
      );
      expect(
        soleImportExpressionIsWrappedByLoadDrizzleBackedModule(filePath),
      ).toBe(true);
    });

    it("createLocalPgliteStore refuses when its impl module cannot resolve drizzle-orm", () => {
      const filePath = path.join(
        PACKAGE_ROOT,
        "src/backend/postgres/pglite-store.ts",
      );
      expect(
        soleImportExpressionIsWrappedByLoadDrizzleBackedModule(filePath),
      ).toBe(true);
    });
  });
});
