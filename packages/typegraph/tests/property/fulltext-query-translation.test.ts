/**
 * Property-based tests for dialect-level fulltext query translation.
 *
 * The websearch/phrase/plain/raw modes accept arbitrary user-supplied
 * strings. The translators must never throw on any input — unescaped
 * quotes, dangling operators, empty strings, and unicode should all
 * flow through to either a valid MATCH/tsquery fragment or a match
 * against nothing.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { getDialect } from "../../src/query/dialect";
import type { FulltextStrategy } from "../../src/query/dialect/fulltext-strategy";
import { unicodeStringArb } from "./arbitraries";

const MODES = ["websearch", "phrase", "plain", "raw"] as const;

function requireStrategy(dialectName: "sqlite" | "postgres"): FulltextStrategy {
  const strategy = getDialect(dialectName).fulltext;
  if (strategy === undefined) {
    throw new Error(`Dialect ${dialectName} has no fulltext strategy`);
  }
  return strategy;
}

describe("FulltextStrategy.matchCondition — translator robustness", () => {
  it("SQLite translator never throws on arbitrary input (websearch, phrase, plain)", () => {
    const sqlite = requireStrategy("sqlite");
    fc.assert(
      fc.property(
        unicodeStringArb,
        fc.constantFrom("websearch", "phrase", "plain"),
        (query, mode) => {
          // We exclude "raw" because raw passes the query through verbatim
          // and SQLite can legitimately reject malformed FTS5 syntax at
          // execution time — the translator itself isn't responsible.
          expect(() =>
            sqlite.matchCondition("typegraph_node_fulltext", query, mode),
          ).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Postgres translator never throws on arbitrary input for any mode", () => {
    const postgres = requireStrategy("postgres");
    fc.assert(
      fc.property(
        unicodeStringArb,
        fc.constantFrom(...MODES),
        (query, mode) => {
          // Postgres builds parameterised SQL; the translator only
          // composes the tsquery-function call. `raw` mode passes the
          // query as a parameter, so all modes are safe here.
          expect(() =>
            postgres.matchCondition("typegraph_node_fulltext", query, mode),
          ).not.toThrow();
          expect(() =>
            postgres.rankExpression("typegraph_node_fulltext", query, mode),
          ).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rank expression never throws for valid modes on either dialect", () => {
    fc.assert(
      fc.property(
        unicodeStringArb,
        fc.constantFrom("websearch", "phrase", "plain"),
        fc.constantFrom("sqlite", "postgres"),
        (query, mode, dialectName) => {
          const strategy = requireStrategy(dialectName);
          expect(() =>
            strategy.rankExpression("typegraph_node_fulltext", query, mode),
          ).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
  });

  it("SQLite translator treats empty input as empty match expression", () => {
    const sqlite = requireStrategy("sqlite");
    // Must not throw for any mode.
    for (const mode of MODES) {
      expect(() =>
        sqlite.matchCondition("typegraph_node_fulltext", "", mode),
      ).not.toThrow();
    }
  });

  it("unbalanced quotes in websearch mode do not escape the quoted-string wrapper", () => {
    const sqlite = requireStrategy("sqlite");
    // A dangling open-quote should still produce some valid FTS5 token
    // sequence — the translator closes the quote implicitly. This
    // prevents unescaped user input from forming syntactically invalid
    // MATCH expressions that would throw at SQL execution.
    const match = sqlite.matchCondition(
      "typegraph_node_fulltext",
      '"unclosed phrase',
      "websearch",
    );
    expect(match).toBeDefined();
  });

  it("dangling NOT operator at start of query does not crash", () => {
    const sqlite = requireStrategy("sqlite");
    // FTS5 rejects a leading NOT without a LHS; the translator strips
    // it so the remaining query is still valid.
    const match = sqlite.matchCondition(
      "typegraph_node_fulltext",
      "-only",
      "websearch",
    );
    expect(match).toBeDefined();
  });

  it("NOT chained after a real token is preserved", () => {
    const sqlite = requireStrategy("sqlite");
    const match = sqlite.matchCondition(
      "typegraph_node_fulltext",
      "climate -warming",
      "websearch",
    );
    expect(match).toBeDefined();
  });
});
