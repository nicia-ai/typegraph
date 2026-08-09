/**
 * The temporal oracle model's independence, ratcheted.
 *
 * The model is only evidence if it is a SECOND implementation. Nothing stops a
 * future edit from importing the very predicate under test and turning the
 * oracle into a tautology, and ESLint cannot close that: `no-restricted-imports`
 * matches the specifier string, so a ban is defeated by reaching through the
 * `src` barrel, and the rule is not configured in this package at all.
 *
 * So the guard is exact-set equality over the model's own import specifiers,
 * plus two clauses the set alone does not carry:
 *
 * - the `src/utils/date` import is checked at the NAMED-import level, so the
 *   window guards (`isInvertedValidityWindow`, `isEmptyValidityWindow` and the
 *   stamping owner `resolveStampedValidityLowerBound`) stay out while the
 *   timestamp normalizer stays in;
 * - the barrel import is asserted to be an `import type` declaration. Specifier
 *   equality alone leaves the barrel a live hole: it is closed today only by
 *   what `src/index.ts` happens to re-export, which is not a property anyone
 *   maintains on the model's behalf. `import type` cannot carry a value however
 *   the barrel grows.
 *
 * Adding an import to the model without adding it here is a test failure,
 * deliberately: it is the moment to ask whether the model is still independent.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { generatedOpArb } from "./backends/integration/temporal-oracle";
import {
  TEMPORAL_OP_SHAPES,
  type TemporalOpShape,
} from "./backends/integration/temporal-oracle-model";

const MODEL_PATH = fileURLToPath(
  new URL("backends/integration/temporal-oracle-model.ts", import.meta.url),
);
const ORACLE_PATH = fileURLToPath(
  new URL("backends/integration/temporal-oracle.ts", import.meta.url),
);

/**
 * Every specifier the model may import, with the role that earns it. Equality,
 * not a denylist: a new specifier fails whether or not anyone thought to ban it.
 */
const ALLOWED_MODEL_IMPORTS = {
  // Row and backend TYPES only — asserted `import type` below.
  "../../../src": {},
  // SQL plumbing for the raw ledger read: table-name resolution and the
  // fragment/intent pair. None of it decides visibility.
  "../../../src/query/compiler/schema": {},
  "../../../src/query/sql-fragment": {},
  "../../../src/query/sql-intent": {},
  // Driver normalization ONLY. The window guards live in this module too, which
  // is why this entry is checked at the named-import level.
  "../../../src/utils/date": { named: ["canonicalizeDatabaseTimestamp"] },
} as const satisfies Readonly<
  Record<string, Readonly<{ named?: readonly string[] }>>
>;

type ParsedImport = Readonly<{
  specifier: string;
  clause: string;
  typeOnly: boolean;
}>;

function parseImports(source: string): readonly ParsedImport[] {
  const pattern = /^import\s+([\s\S]*?)\s+from\s+"([^"]+)";$/gm;
  const parsed: ParsedImport[] = [];
  for (const match of source.matchAll(pattern)) {
    const clause = match[1] ?? "";
    parsed.push({
      specifier: match[2] ?? "",
      clause,
      typeOnly: clause.startsWith("type "),
    });
  }
  return parsed;
}

/** The names a clause binds, `type` markers stripped, aliases resolved to source names. */
function namedBindings(clause: string): readonly string[] {
  const braces = /\{([\s\S]*)\}/.exec(clause);
  if (braces === null) return [];
  return (braces[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "")
    .toSorted();
}

describe("temporal oracle model independence", () => {
  const source = readFileSync(MODEL_PATH, "utf8");
  const imports = parseImports(source);

  it("imports exactly the declared specifiers, no more and no fewer", () => {
    expect(imports.map((entry) => entry.specifier).toSorted()).toEqual(
      Object.keys(ALLOWED_MODEL_IMPORTS).toSorted(),
    );
  });

  it("reaches the barrel by type only, so it cannot carry a value", () => {
    const barrel = imports.find((entry) => entry.specifier === "../../../src");
    expect(barrel?.typeOnly).toBe(true);
  });

  it("takes only the timestamp normalizer from the module that owns the window guards", () => {
    const dateImport = imports.find(
      (entry) => entry.specifier === "../../../src/utils/date",
    );
    expect(namedBindings(dateImport?.clause ?? "")).toEqual([
      ...ALLOWED_MODEL_IMPORTS["../../../src/utils/date"].named,
    ]);
  });

  it("loads nothing dynamically, which the specifier scan would not see", () => {
    expect(/\bimport\s*\(/.test(source)).toBe(false);
    expect(/\brequire\s*\(/.test(source)).toBe(false);
  });
});

describe("temporal oracle op vocabulary", () => {
  it("draws every declared op shape, so the script covers what the vocabulary claims", () => {
    // The assertion that matters is over the GENERATOR, not over a re-spelling
    // of the declared list: comparing one spelling against another can only
    // fail if someone edits that one expression, whereas narrowing what
    // `generatedOpArb` draws from — which is exactly how the deleted
    // `KNOWN_CONTRACT_GAPS` table withheld the shapes it excused — would leave
    // such a comparison green while the script silently stopped exercising a
    // cell. With no gap standing, the drawn set must be the WHOLE vocabulary:
    // this is the ratchet that keeps the reopened born-ended and resurrection
    // shapes genuinely emitted.
    //
    // Sampled with a fixed seed, so it is deterministic; 2000 draws over a
    // vocabulary this size hits every constant of a uniform `constantFrom`.
    const drawn = new Set<TemporalOpShape>(
      fc
        .sample(generatedOpArb(), { numRuns: 2000, seed: 20_260_809 })
        .map((op) => op.shape),
    );
    expect([...drawn].toSorted()).toEqual([...TEMPORAL_OP_SHAPES].toSorted());
  });

  it("implements every declared op shape", () => {
    // A shape declared but never executed is a silent no-op in the generator:
    // the vocabulary would claim coverage the script does not have. This is what
    // kept each restricted shape wired while its gap stood, so lifting the
    // restriction found an implementation waiting rather than a stub.
    const oracle = readFileSync(ORACLE_PATH, "utf8");
    const unimplemented = TEMPORAL_OP_SHAPES.filter(
      (shape) => !oracle.includes(`"${shape}"`),
    );
    expect(unimplemented).toEqual([]);
  });
});
