import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PGLITE_TEST_FILES } from "../vitest.pglite-project";

const PGLITE_BOOT_MARKERS = [
  /\bPGlite\.create\(/u,
  /\bcreateLocalPgliteBackend\(/u,
  /\bcreateLoggedPostgresBackend\(/u,
  /\bcreateRecordedPostgresStore\(/u,
] as const;

function discoverRootPgliteSuites(): readonly string[] {
  return readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .filter((entry) => {
      const source = readFileSync(new URL(entry.name, import.meta.url), "utf8");
      return PGLITE_BOOT_MARKERS.some((marker) => marker.test(source));
    })
    .map((entry) => `tests/${entry.name}`)
    .toSorted((left, right) => left.localeCompare(right));
}

describe("PGlite project inventory", () => {
  it("keeps every root suite that boots PGlite off the pure-unit budget", () => {
    expect(discoverRootPgliteSuites()).toEqual([...PGLITE_TEST_FILES]);
  });
});
