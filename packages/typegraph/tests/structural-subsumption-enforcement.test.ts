/**
 * Construction ratchet: every `buildValidatedKindRegistry(` call in `src/`
 * supplies `structuralSubsumption` explicitly, and exactly the ONE call site
 * documented as unenforced (`StructuralSubsumptionMode`,
 * `src/registry/build-validated.ts`) is allowed to pass
 * `"unenforced-baseline"`.
 *
 * A new registry construction that forgets the field is a TypeScript error
 * already (the field is required, not optional) — this test instead guards
 * against a construction that supplies the field but with the WRONG
 * literal, silently widening which registry the C.2 check skips.
 *
 * *Mutation*: change the BEFORE-side call in
 * `src/schema/ontology-change.ts` from `"unenforced-baseline"` to the
 * default (drop the second argument) — the "unenforced sites" assertion
 * fails, since the source no longer contains the literal this test expects.
 * *Mutation*: add a second `"unenforced-baseline"` call anywhere in `src/`
 * not named in `EXPECTED_UNENFORCED_CALL_SITES` — the "exactly one" count
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

/** The one call site permitted to build an unenforced registry, and why. */
const EXPECTED_UNENFORCED_CALL_SITES: ReadonlySet<string> = new Set([
  "schema/ontology-change.ts",
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

describe("structural subsumption enforcement construction ratchet", () => {
  it("every buildRegistryFromSerializedSchema call site's structuralSubsumption argument is accounted for", () => {
    const unenforcedSites: string[] = [];
    for (const filePath of walkTsFiles(SOURCE_ROOT)) {
      const content = fs.readFileSync(filePath, "utf8");
      // A CALL site, not the `StructuralSubsumptionMode` type declaration
      // (`registry/build-validated.ts`) that merely names the literal.
      if (
        !content.includes('"unenforced-baseline"') ||
        !content.includes("buildRegistryFromSerializedSchema(")
      ) {
        continue;
      }
      unenforcedSites.push(relativeToSourceRoot(filePath));
    }

    expect(new Set(unenforcedSites)).toEqual(EXPECTED_UNENFORCED_CALL_SITES);
  });

  it("the two live buildValidatedKindRegistry call sites both supply structuralSubsumption", () => {
    const callSites = ["registry/builders.ts", "schema/deserializer.ts"];
    for (const relativePath of callSites) {
      const content = fs.readFileSync(
        path.join(SOURCE_ROOT, relativePath),
        "utf8",
      );
      expect(content).toContain("structuralSubsumption");
    }
  });
});
