/**
 * Canonical-key injectivity for `src/graph-extension/ontology-keys.ts`
 * (item E, lane E-a §2.3).
 *
 * Both keys used to be a delimiter join (`${metaEdge}|${from}|${to}`), which
 * collides for any kind name containing the delimiter and is blind to a
 * `via`/`partSide` change. Both are now `encodeTupleKey([...])`.
 *
 * MUTATION CHECK (recorded in the lane's load-bearing note): reverted both
 * functions to the delimiter-join form — "does not collide two distinct
 * relations..." and "folds via/partSide into the key..." both flipped to
 * failing; "agree for the same relation" kept passing (a false negative on
 * agreement is not what the join breaks). Restored after the check.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { subClassOf } from "../src";
import { defineNode } from "../src/core/node";
import { type ExtensionOntologyRelation } from "../src/graph-extension/extension-types";
import {
  compileTimeOntologyKey,
  graphExtensionOntologyKey,
} from "../src/graph-extension/ontology-keys";

const emptySchema = z.object({});

describe("ontology relation canonical keys", () => {
  it("compileTimeOntologyKey and graphExtensionOntologyKey agree for the same relation", () => {
    const A = defineNode("A|B", { schema: emptySchema });
    const B = defineNode("C:D", { schema: emptySchema });
    const relation = subClassOf(A, B);
    const extensionEntry: ExtensionOntologyRelation = {
      metaEdge: "subClassOf",
      from: "A|B",
      to: "C:D",
    };
    expect(compileTimeOntologyKey(relation)).toBe(
      graphExtensionOntologyKey(extensionEntry),
    );
  });

  it("does not collide two distinct relations a naive delimiter join would conflate", () => {
    // `${metaEdge}|${from}|${to}` (the old key) produces
    // "subClassOf|A|B|C" for BOTH of these.
    const left: ExtensionOntologyRelation = {
      metaEdge: "subClassOf",
      from: "A|B",
      to: "C",
    };
    const right: ExtensionOntologyRelation = {
      metaEdge: "subClassOf",
      from: "A",
      to: "B|C",
    };
    expect(graphExtensionOntologyKey(left)).not.toBe(
      graphExtensionOntologyKey(right),
    );
  });

  it("folds `via`/`partSide` into the key", () => {
    const plain: ExtensionOntologyRelation = {
      metaEdge: "partOf",
      from: "Part",
      to: "Whole",
    };
    const composition: ExtensionOntologyRelation = {
      ...plain,
      via: "realizes",
    };
    expect(graphExtensionOntologyKey(plain)).not.toBe(
      graphExtensionOntologyKey(composition),
    );

    const forward: ExtensionOntologyRelation = {
      ...composition,
      partSide: "from",
    };
    const reverse: ExtensionOntologyRelation = {
      ...composition,
      partSide: "to",
    };
    expect(graphExtensionOntologyKey(forward)).not.toBe(
      graphExtensionOntologyKey(reverse),
    );
  });
});
