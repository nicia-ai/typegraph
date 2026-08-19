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
import {
  historicalIdentityPeerClassQuery,
  historicalIdentityReconstructionCtes,
  type HistoricalIdentitySqlCoordinate,
} from "../src/identity/historical-sql";
import {
  type IdentityWindowLedgerInput,
  type IdentityWindowValidationRequest,
} from "../src/identity/service-mutation";
import { type IdentityTarget } from "../src/identity/sql-target";
import { type QueryAst } from "../src/query/ast";
import {
  compileQuery,
  type CompileQueryOptions,
} from "../src/query/compiler/index";
import { type PredicateCompilerContext } from "../src/query/compiler/predicates";
import {
  DEFAULT_SQL_SCHEMA,
  type SqlSchema,
} from "../src/query/compiler/schema";
import { sqliteDialect } from "../src/query/dialect";
import { type DialectAdapter } from "../src/query/dialect/types";
import { sql, type SqlFragment } from "../src/query/sql-fragment";
import { buildReachableCte } from "../src/store/recursive-cte";

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

/** Site B: `buildReachableCte`'s (module-private) options object. */
function buildReachableCteRequiresVerdict(
  dialect: DialectAdapter,
  schema: SqlSchema,
): void {
  // @ts-expect-error a call to buildReachableCte omitting `recursiveTraversal`
  // is not assignable to its options parameter.
  buildReachableCte({
    graphId: "g",
    sourceId: "n1",
    edgeKinds: ["knows"],
    maxHops: 3,
    direction: "out",
    cyclePolicy: "prevent",
    includePath: false,
    temporalMode: "current",
    dialect,
    schema,
    operation: "test",
  });

  buildReachableCte({
    graphId: "g",
    sourceId: "n1",
    edgeKinds: ["knows"],
    maxHops: 3,
    direction: "out",
    cyclePolicy: "prevent",
    includePath: false,
    temporalMode: "current",
    dialect,
    schema,
    operation: "test",
    // @ts-expect-error a raw `{ supported: true }` literal is not a branded
    // RecursiveTraversalVerdict.
    recursiveTraversal: { supported: true },
  });

  // The sanctioned form compiles.
  buildReachableCte({
    graphId: "g",
    sourceId: "n1",
    edgeKinds: ["knows"],
    maxHops: 3,
    direction: "out",
    cyclePolicy: "prevent",
    includePath: false,
    temporalMode: "current",
    dialect,
    schema,
    operation: "test",
    recursiveTraversal: resolveRecursiveTraversal(SQLITE_CAPABILITIES),
  });
}
void buildReachableCteRequiresVerdict;

/** Site C: `historicalIdentityReconstructionCtes`'s input. */
function historicalIdentityReconstructionCtesRequiresVerdict(
  schema: SqlSchema,
  coordinate: HistoricalIdentitySqlCoordinate,
  seedSource: SqlFragment,
): void {
  // @ts-expect-error a call omitting `recursiveTraversal` is not assignable
  // to the builder's input.
  historicalIdentityReconstructionCtes({
    schema,
    graphId: "g",
    coordinate,
    seedSource,
    sameIdAcrossKinds: "fold",
  });

  historicalIdentityReconstructionCtes({
    schema,
    graphId: "g",
    coordinate,
    seedSource,
    sameIdAcrossKinds: "fold",
    // @ts-expect-error a raw `{ supported: true }` literal is not a branded
    // RecursiveTraversalVerdict.
    recursiveTraversal: { supported: true },
  });

  // The sanctioned form compiles.
  historicalIdentityReconstructionCtes({
    schema,
    graphId: "g",
    coordinate,
    seedSource,
    sameIdAcrossKinds: "fold",
    recursiveTraversal: resolveRecursiveTraversal(SQLITE_CAPABILITIES),
  });
}
void historicalIdentityReconstructionCtesRequiresVerdict;

/** Site D: `historicalIdentityPeerClassQuery`'s input. */
function historicalIdentityPeerClassQueryRequiresVerdict(
  schema: SqlSchema,
  coordinate: HistoricalIdentitySqlCoordinate,
): void {
  // @ts-expect-error a call omitting `recursiveTraversal` is not assignable
  // to the builder's input.
  historicalIdentityPeerClassQuery({
    schema,
    graphId: "g",
    coordinate,
    sameIdAcrossKinds: "fold",
  });

  historicalIdentityPeerClassQuery({
    schema,
    graphId: "g",
    coordinate,
    sameIdAcrossKinds: "fold",
    // @ts-expect-error a raw `{ supported: true }` literal is not a branded
    // RecursiveTraversalVerdict.
    recursiveTraversal: { supported: true },
  });

  // The sanctioned form compiles.
  historicalIdentityPeerClassQuery({
    schema,
    graphId: "g",
    coordinate,
    sameIdAcrossKinds: "fold",
    recursiveTraversal: resolveRecursiveTraversal(SQLITE_CAPABILITIES),
  });
}
void historicalIdentityPeerClassQueryRequiresVerdict;

/**
 * Site F: `loadIdentityWindowLedger` itself stays module-private, so this
 * witnesses the brand requirement through its exported input type,
 * `IdentityWindowLedgerInput`, instead of through a call.
 */
function identityWindowLedgerInputRequiresVerdict(
  target: IdentityTarget,
  schema: SqlSchema,
  requests: readonly IdentityWindowValidationRequest[],
): void {
  // @ts-expect-error an IdentityWindowLedgerInput omitting `recursiveTraversal`
  // is not assignable to the type.
  const omitted: IdentityWindowLedgerInput = {
    target,
    schema,
    graphId: "g",
    requests,
    operationInstant: "2024-01-01T00:00:00.000Z",
    sameIdAcrossKinds: "fold",
  };
  void omitted;

  const forged: IdentityWindowLedgerInput = {
    target,
    schema,
    graphId: "g",
    requests,
    operationInstant: "2024-01-01T00:00:00.000Z",
    sameIdAcrossKinds: "fold",
    // @ts-expect-error a raw `{ supported: true }` literal is not a branded
    // RecursiveTraversalVerdict.
    recursiveTraversal: { supported: true },
  };
  void forged;

  // The sanctioned form compiles.
  const sanctioned: IdentityWindowLedgerInput = {
    target,
    schema,
    graphId: "g",
    requests,
    operationInstant: "2024-01-01T00:00:00.000Z",
    sameIdAcrossKinds: "fold",
    recursiveTraversal: resolveRecursiveTraversal(SQLITE_CAPABILITIES),
  };
  void sanctioned;
}
void identityWindowLedgerInputRequiresVerdict;

describe("RecursiveTraversalVerdict brand (sites B, C, D, F)", () => {
  it("requires a verdict on buildReachableCte's options (site B)", () => {
    // Assertion is the compile-time check above; nothing to run.
  });

  it("requires a verdict on historicalIdentityReconstructionCtes's input (site C)", () => {
    // Assertion is the compile-time check above; nothing to run.
  });

  it("requires a verdict on historicalIdentityPeerClassQuery's input (site D)", () => {
    // Assertion is the compile-time check above; nothing to run.
  });

  it("requires a verdict on IdentityWindowLedgerInput (site F)", () => {
    // Assertion is the compile-time check above; nothing to run.
  });
});
