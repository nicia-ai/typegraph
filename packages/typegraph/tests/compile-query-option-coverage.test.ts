/**
 * T6/I12: a `CompileQueryOptions` key can never be silently dropped from
 * `propagateOptions`'s recursive-sub-compile forwarding.
 *
 * Two nets, matching the two ways this could drift:
 * 1. A type-level check that `COMPILE_QUERY_OPTION_KEYS` names exactly the
 *    keys `CompileQueryOptions` declares — a new option added to the type
 *    without adding its key here fails to compile.
 * 2. A runtime round-trip: a fully-populated options object survives
 *    `propagateOptions` key-for-key, so a key present in both places but
 *    never actually forwarded still fails.
 */
import { describe, expect, it } from "vitest";

import { assumeRecursiveTraversalSupported } from "../src/backend/capabilities/recursive-traversal";
import {
  COMPILE_QUERY_OPTION_KEYS,
  type CompileQueryOptions,
  propagateOptions,
} from "../src/query/compiler/index";
import {
  DEFAULT_SQL_SCHEMA,
  recordedRelation,
  type VectorSlotMap,
} from "../src/query/compiler/schema";
import { fts5Strategy } from "../src/query/dialect/fulltext-strategy";
import { sqliteVecStrategy } from "../src/query/dialect/vector/sqlite-vec-strategy";
import { type Assert, type Equal } from "../src/utils/type-assert";

// A key present on `CompileQueryOptions` but missing from
// `COMPILE_QUERY_OPTION_KEYS` (or vice versa) fails to compile.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time assertion
type _compileQueryOptionKeysCoverTheType = Assert<
  Equal<(typeof COMPILE_QUERY_OPTION_KEYS)[number], keyof CompileQueryOptions>
>;

function fullyPopulatedOptions(): Required<CompileQueryOptions> {
  const vectorSlots: VectorSlotMap = new Map();
  return {
    dialect: "postgres",
    schema: DEFAULT_SQL_SCHEMA,
    fulltextStrategy: fts5Strategy,
    vectorStrategy: sqliteVecStrategy,
    windowFunctions: false,
    vectorSlots,
    fulltextLanguages: new Map([["Document", "english"]]),
    recordedReadBinding: recordedRelation({ schema: DEFAULT_SQL_SCHEMA }),
    readInstant: "placeholder",
    identitySameIdAcrossKinds: "ignore",
    recursiveTraversal: assumeRecursiveTraversalSupported(
      "compile-query-option-coverage test",
    ),
  };
}

describe("propagateOptions key coverage", () => {
  const input = fullyPopulatedOptions();
  const result = propagateOptions(input);

  it.each(COMPILE_QUERY_OPTION_KEYS)(
    "propagates %s unchanged into recursive sub-compiles",
    (key) => {
      expect(result[key]).toBe(input[key]);
    },
  );

  it("propagates every declared option with nothing extra", () => {
    expect(Object.keys(result).toSorted()).toEqual(
      [...COMPILE_QUERY_OPTION_KEYS].toSorted(),
    );
  });
});
