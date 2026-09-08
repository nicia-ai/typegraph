/**
 * Construction ratchet: every `buildValidatedKindRegistry(` call in `src/`
 * (direct, or through the `buildRegistryFromSerializedSchema(` wrapper)
 * supplies `structuralSubsumption`, and exactly the ONE call site documented
 * as unenforced (`StructuralSubsumptionMode`, `src/registry/build-validated.ts`)
 * is allowed to pass `"unenforced-baseline"`.
 *
 * A new registry construction that forgets the field is a TypeScript error
 * already (the field is required, not optional) — this test instead guards
 * against a construction that supplies the field but with the WRONG
 * literal, silently widening which registry the C.2 check skips.
 *
 * The scan for BOTH entry points is independent of whether the
 * `"unenforced-baseline"` literal and the call itself appear in the same
 * text pattern (C13-R1-04): a direct `buildValidatedKindRegistry({ ...,
 * structuralSubsumption: "unenforced-baseline" })` call site is caught even
 * though it never mentions `buildRegistryFromSerializedSchema(`.
 *
 * *Mutation*: change the BEFORE-side call in
 * `src/schema/ontology-change.ts` from `"unenforced-baseline"` to the
 * default (drop the second argument) — the "unenforced sites" assertion
 * fails, since the source no longer contains the literal this test expects.
 * *Mutation*: add a second `"unenforced-baseline"` call anywhere in `src/`
 * not named in `EXPECTED_UNENFORCED_CALL_SITES`, through EITHER entry
 * point (including a direct `buildValidatedKindRegistry(` call with no
 * `buildRegistryFromSerializedSchema(` in sight) — the "exactly one" count
 * assertion fails, naming the unexpected file.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

/**
 * The file that DECLARES `StructuralSubsumptionMode` and its
 * `"unenforced-baseline"` member — a type declaration, not a call site, so
 * it is excluded from both scans below.
 */
const TYPE_DECLARATION_FILE = "registry/build-validated.ts";

/** The two call-site patterns that can reach `buildValidatedKindRegistry`. */
const CALL_SITE_PATTERNS: readonly string[] = [
  "buildValidatedKindRegistry(",
  "buildRegistryFromSerializedSchema(",
];

const UNENFORCED_LITERAL = '"unenforced-baseline"';

/** The one call site permitted to build an unenforced registry, and why. */
const EXPECTED_UNENFORCED_CALL_SITES: ReadonlySet<string> = new Set([
  "schema/ontology-change.ts",
]);

/** The direct `buildValidatedKindRegistry(` call sites — both required to supply `structuralSubsumption` explicitly (it is a required field on the input object, not defaulted). */
const EXPECTED_DIRECT_CALL_SITES: ReadonlySet<string> = new Set([
  "registry/builders.ts",
  "schema/deserializer.ts",
]);

function walkTsFiles(dir: string): readonly string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function relativeToSourceRoot(filePath: string): string {
  return path.relative(SOURCE_ROOT, filePath).split(path.sep).join("/");
}

function isCallSiteFile(content: string): boolean {
  return CALL_SITE_PATTERNS.some((pattern) => content.includes(pattern));
}

describe("structural subsumption enforcement construction ratchet", () => {
  it("every unenforced-baseline literal in src/ sits in a real registry-builder call site, and the set is exactly the documented one", () => {
    const unenforcedSites: string[] = [];
    for (const filePath of walkTsFiles(SOURCE_ROOT)) {
      const relativePath = relativeToSourceRoot(filePath);
      if (relativePath === TYPE_DECLARATION_FILE) continue;
      const content = fs.readFileSync(filePath, "utf8");
      if (!content.includes(UNENFORCED_LITERAL)) continue;

      // A file carrying the literal for some other reason (a comment, a
      // fixture) with no registry-builder call in sight would otherwise
      // silently pass the "exactly one" check below. Failure names the
      // offending file via `unenforcedSites`/`callSiteFiles` divergence one
      // assertion down, so this only needs to guard, not narrate.
      if (!isCallSiteFile(content)) {
        throw new Error(
          `${relativePath} contains the "unenforced-baseline" literal but neither ` +
            `buildValidatedKindRegistry( nor buildRegistryFromSerializedSchema( — ` +
            `the construction ratchet cannot verify what consumes this literal`,
        );
      }
      unenforcedSites.push(relativePath);
    }

    expect(new Set(unenforcedSites)).toEqual(EXPECTED_UNENFORCED_CALL_SITES);
  });

  it("every direct buildValidatedKindRegistry( call site supplies structuralSubsumption explicitly", () => {
    const directCallSites: string[] = [];
    for (const filePath of walkTsFiles(SOURCE_ROOT)) {
      const relativePath = relativeToSourceRoot(filePath);
      if (relativePath === TYPE_DECLARATION_FILE) continue;
      const content = fs.readFileSync(filePath, "utf8");
      if (!content.includes("buildValidatedKindRegistry(")) continue;
      directCallSites.push(relativePath);
      if (!content.includes("structuralSubsumption")) {
        throw new Error(
          `${relativePath} calls buildValidatedKindRegistry( without mentioning structuralSubsumption`,
        );
      }
    }

    expect(new Set(directCallSites)).toEqual(EXPECTED_DIRECT_CALL_SITES);
  });
});
