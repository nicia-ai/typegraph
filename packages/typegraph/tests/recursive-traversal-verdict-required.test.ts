/**
 * Compile-time coverage for the `RecursiveTraversalVerdict` brand (T3, site
 * A): a raw object literal can never stand in for a resolved verdict, in
 * either of the two places site A threads one. Enforced by `pnpm typecheck`,
 * which includes this file.
 *
 * Both assertion functions below are never invoked — `pnpm typecheck` checks
 * their bodies regardless, and invoking them would exercise a deliberately
 * ill-typed call. `it()` blocks exist only to give each row a name; the
 * `@ts-expect-error` directives are the actual assertion (see the mutation
 * check recorded in the batch's commit body).
 */
import { describe, it } from "vitest";

import {
  assumeRecursiveTraversalSupported,
  type RecursiveTraversalCapability,
  resolveRecursiveTraversal,
} from "../src/backend/capabilities/recursive-traversal";
import { SQLITE_CAPABILITIES } from "../src/backend/types";
import { type QueryAst } from "../src/query/ast";
import {
  compileQuery,
  type CompileQueryOptions,
} from "../src/query/compiler/index";
import { type PredicateCompilerContext } from "../src/query/compiler/predicates";
import { DEFAULT_SQL_SCHEMA } from "../src/query/compiler/schema";
import { sqliteDialect } from "../src/query/dialect";
import { sql } from "../src/query/sql-fragment";

function inlineVerdictLiteralOnCompileQueryOptionsIsRejected(
  ast: QueryAst,
): void {
  // @ts-expect-error a raw `{ supported: true }` literal is not a branded
  // RecursiveTraversalVerdict.
  compileQuery(ast, "g", { recursiveTraversal: { supported: true } });

  // The sanctioned forms compile.
  const resolved: CompileQueryOptions = {
    recursiveTraversal: resolveRecursiveTraversal(SQLITE_CAPABILITIES),
  };
  compileQuery(ast, "g", resolved);

  const assumed: CompileQueryOptions = {
    recursiveTraversal: assumeRecursiveTraversalSupported("test"),
  };
  compileQuery(ast, "g", assumed);
}
void inlineVerdictLiteralOnCompileQueryOptionsIsRejected;

function rawCapabilityDeclarationOnPredicateContextIsRejected(): void {
  // `satisfies` (not an explicit `: RecursiveTraversalCapability` annotation)
  // keeps the inferred type the fresh literal `{ supported: true }` while
  // still checking it against the capability shape — so the assignment
  // below fails for exactly one reason: the missing brand. An explicit
  // annotation would widen `supported` to `boolean`, which is *also*
  // structurally incompatible with the verdict union independent of the
  // brand, and would survive the brand-drop mutation check undetected.
  const rawDeclaration = {
    supported: true,
  } satisfies RecursiveTraversalCapability;

  const ctx: PredicateCompilerContext = {
    dialect: sqliteDialect,
    schema: DEFAULT_SQL_SCHEMA,
    compileQuery: () => sql`SELECT 1`,
    windowFunctions: true,
    // @ts-expect-error a `RecursiveTraversalCapability` (an unbranded
    // declaration) is not a `RecursiveTraversalVerdict`.
    recursiveTraversal: rawDeclaration,
  };
  void ctx;

  // The sanctioned forms compile.
  const sanctioned: PredicateCompilerContext = {
    dialect: sqliteDialect,
    schema: DEFAULT_SQL_SCHEMA,
    compileQuery: () => sql`SELECT 1`,
    windowFunctions: true,
    recursiveTraversal: resolveRecursiveTraversal(SQLITE_CAPABILITIES),
  };
  void sanctioned;

  const sanctionedAssumed: PredicateCompilerContext = {
    dialect: sqliteDialect,
    schema: DEFAULT_SQL_SCHEMA,
    compileQuery: () => sql`SELECT 1`,
    windowFunctions: true,
    recursiveTraversal: assumeRecursiveTraversalSupported("test"),
  };
  void sanctionedAssumed;
}
void rawCapabilityDeclarationOnPredicateContextIsRejected;

describe("RecursiveTraversalVerdict brand (site A)", () => {
  it("rejects an inline verdict literal on CompileQueryOptions", () => {
    // Assertion is the compile-time check above; nothing to run.
  });

  it("rejects a raw capability declaration where a verdict is required", () => {
    // Assertion is the compile-time check above; nothing to run.
  });
});
