/**
 * Cross-backend code-point ordering for the equivalence-is-subsumption fold
 * (D1).
 *
 * Every kind-name ordering item B owns — the subclass-component sort behind
 * the `kindWithSubClasses` claim axis chief among them — moved from
 * `compareStrings` (UTF-16 code-unit order) to `compareCodePoints`
 * (code-point order, matching SQLite's `BINARY` and Postgres's `C`
 * collation). The two orders disagree for an astral character: its lead
 * surrogate sorts BELOW U+FFFD under code-unit order, but its real code point
 * is far ABOVE it. A JS-side ordering that used the wrong comparator would
 * disagree with SQL row order without any test on a single backend ever
 * noticing, which is why this lives in the shared cross-backend suite rather
 * than a per-dialect test.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  equivalentTo,
  UniquenessError,
} from "../../../src";
import { type IntegrationTestContext } from "./test-context";

/**
 * `"K\u{10000}"` (an astral character) vs `"K�"` (a BMP character):
 * `compareStrings` puts `ASTRAL_KIND` first because its lead surrogate
 * (`0xD800`) is less than `0xFFFD`; `compareCodePoints` puts `BMP_KIND` first
 * because its real code point (`0xFFFD`) is less than `0x10000`.
 */
const ASTRAL_KIND = "K\u{10000}";
const BMP_KIND = "K�";

/**
 * `"Zebra"` vs `"apple"`: code-point (and SQL `BINARY`/`C`) order sorts
 * uppercase before lowercase (`Z` is `0x5A`, `a` is `0x61`), which
 * ICU/locale-aware collation would reverse (case-insensitive "apple" <
 * "Zebra").
 */
const UPPERCASE_KIND = "Zebra";
const LOWERCASE_KIND = "apple";

const EMAIL_SCHEMA = z.object({ email: z.string() });

const ASTRAL_NODE = defineNode(ASTRAL_KIND, { schema: EMAIL_SCHEMA });
const BMP_NODE = defineNode(BMP_KIND, { schema: EMAIL_SCHEMA });
const UPPERCASE_NODE = defineNode(UPPERCASE_KIND, { schema: EMAIL_SCHEMA });
const LOWERCASE_NODE = defineNode(LOWERCASE_KIND, { schema: EMAIL_SCHEMA });

const EQUIV_EMAIL_CONSTRAINT = "equiv_email";

const EQUIV_EMAIL_UNIQUE = {
  name: EQUIV_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const codePointOrderingGraph = defineGraph({
  id: "ontology_equivalence_code_point_ordering",
  nodes: {
    [ASTRAL_KIND]: { type: ASTRAL_NODE, unique: [EQUIV_EMAIL_UNIQUE] },
    [BMP_KIND]: { type: BMP_NODE, unique: [EQUIV_EMAIL_UNIQUE] },
    [UPPERCASE_KIND]: { type: UPPERCASE_NODE, unique: [EQUIV_EMAIL_UNIQUE] },
    [LOWERCASE_KIND]: { type: LOWERCASE_NODE, unique: [EQUIV_EMAIL_UNIQUE] },
  },
  edges: {},
  ontology: [
    equivalentTo(ASTRAL_NODE, BMP_NODE),
    equivalentTo(UPPERCASE_NODE, LOWERCASE_NODE),
  ],
});

export function registerOntologyEquivalenceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Ontology equivalence — code-point ordering (D1)", () => {
    it("orders the astral/BMP subclass component by code point, not code unit", async () => {
      const store = await context.createStore(codePointOrderingGraph);
      expect(store.registry.getSubClassComponent(ASTRAL_KIND)).toEqual([
        BMP_KIND,
        ASTRAL_KIND,
      ]);
      expect(store.registry.getSubClassComponent(BMP_KIND)).toBe(
        store.registry.getSubClassComponent(ASTRAL_KIND),
      );
    });

    it("orders the uppercase/lowercase pair uppercase-first, unlike ICU collation", async () => {
      const store = await context.createStore(codePointOrderingGraph);
      // Code-point order: 'Z' (0x5A) < 'a' (0x61), so the uppercase kind
      // sorts FIRST — the opposite of case-insensitive ICU/locale collation.
      expect(store.registry.getSubClassComponent(UPPERCASE_KIND)).toEqual([
        UPPERCASE_KIND,
        LOWERCASE_KIND,
      ]);
    });

    it("fences a kindWithSubClasses collision across the astral/BMP equivalence class", async () => {
      const store = await context.createStore(codePointOrderingGraph);
      const astralCollection = store.getNodeCollection(ASTRAL_KIND);
      const bmpCollection = store.getNodeCollection(BMP_KIND);
      if (astralCollection === undefined || bmpCollection === undefined) {
        throw new Error("Expected astral/BMP node collections to exist.");
      }

      await astralCollection.create({ email: "astral-then-bmp@example.com" });
      await expect(
        bmpCollection.create({ email: "astral-then-bmp@example.com" }),
      ).rejects.toThrow(UniquenessError);
    });

    it("fences the reverse creation order (BMP then astral) identically", async () => {
      const store = await context.createStore(codePointOrderingGraph);
      const astralCollection = store.getNodeCollection(ASTRAL_KIND);
      const bmpCollection = store.getNodeCollection(BMP_KIND);
      if (astralCollection === undefined || bmpCollection === undefined) {
        throw new Error("Expected astral/BMP node collections to exist.");
      }

      await bmpCollection.create({ email: "bmp-then-astral@example.com" });
      await expect(
        astralCollection.create({ email: "bmp-then-astral@example.com" }),
      ).rejects.toThrow(UniquenessError);
    });
  });
}
