/**
 * Query Fragment Composition
 *
 * Provides types and utilities for creating reusable query fragments
 * that can be composed together using the pipe() method.
 *
 * @example
 * ```typescript
 * // Define a reusable fragment
 * const activeUsers = createFragment<MyGraph>()((q) =>
 *   q.whereNode("u", ({ status }) => status.eq("active"))
 * );
 *
 * // Use in queries
 * const results = await query()
 *   .from("User", "u")
 *   .pipe(activeUsers)
 *   .select((ctx) => ctx.u)
 *   .execute();
 * ```
 */
import { type GraphDef } from "../../core/define-graph";
import { type TraversalDirection } from "../ast";
import { type QueryBuilder } from "./query-builder";
import { type TraversalBuilder } from "./traversal-builder";
import {
  type AliasMap,
  type EdgeAliasMap,
  type EmptyRecursiveAliasMap,
  type QueryCoordinateState,
  type RecursiveAliasMap,
} from "./types";

// ============================================================
// Fragment Types
// ============================================================

/**
 * A query fragment that transforms a QueryBuilder.
 *
 * Fragments are functions that take a builder and return a modified builder.
 * They can add predicates, traversals, ordering, and other query operations.
 *
 * @typeParam G - The graph definition
 * @typeParam InAliases - Input alias map (what the fragment requires)
 * @typeParam OutAliases - Output alias map (what the fragment produces)
 * @typeParam InEdgeAliases - Input edge alias map
 * @typeParam OutEdgeAliases - Output edge alias map
 * @typeParam InRecursiveAliases - Input recursive alias map
 * @typeParam OutRecursiveAliases - Output recursive alias map
 */
export type QueryFragment<
  G extends GraphDef,
  InAliases extends AliasMap = AliasMap,
  OutAliases extends AliasMap = InAliases,
  InEdgeAliases extends EdgeAliasMap = EdgeAliasMap,
  OutEdgeAliases extends EdgeAliasMap = InEdgeAliases,
  InRecursiveAliases extends RecursiveAliasMap = EmptyRecursiveAliasMap,
  OutRecursiveAliases extends RecursiveAliasMap = InRecursiveAliases,
> = <CoordinateState extends QueryCoordinateState>(
  builder: QueryBuilder<
    G,
    InAliases,
    InEdgeAliases,
    InRecursiveAliases,
    CoordinateState
  >,
) => QueryBuilder<
  G,
  OutAliases,
  OutEdgeAliases,
  OutRecursiveAliases,
  CoordinateState
>;

/**
 * A flexible query fragment that works with any compatible builder.
 *
 * Use this when you want a fragment that only requires certain aliases
 * to exist, but doesn't care about other aliases that may be present.
 */
export type FlexibleQueryFragment<
  G extends GraphDef,
  RequiredAliases extends AliasMap = AliasMap,
  AddedAliases extends AliasMap = AliasMap,
  RequiredEdgeAliases extends EdgeAliasMap = EdgeAliasMap,
  AddedEdgeAliases extends EdgeAliasMap = EdgeAliasMap,
> = <
  Aliases extends RequiredAliases,
  EdgeAliases extends RequiredEdgeAliases,
  RecursiveAliases extends RecursiveAliasMap,
  CoordinateState extends QueryCoordinateState,
>(
  builder: QueryBuilder<
    G,
    Aliases,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >,
) => QueryBuilder<
  G,
  Aliases & AddedAliases,
  EdgeAliases & AddedEdgeAliases,
  RecursiveAliases,
  CoordinateState
>;

/**
 * A traversal fragment that transforms a TraversalBuilder.
 *
 * Use this for reusable traversal patterns including edge filtering,
 * recursive traversals, and path collection.
 */
export type TraversalFragment<
  G extends GraphDef,
  EK extends keyof G["edges"] & string,
  EA extends string,
  InAliases extends AliasMap = AliasMap,
  InEdgeAliases extends EdgeAliasMap = EdgeAliasMap,
> = <
  Dir extends TraversalDirection,
  Optional extends boolean,
  DC extends boolean | string,
  PC extends boolean | string,
  RecursiveAliases extends RecursiveAliasMap,
  CoordinateState extends QueryCoordinateState,
>(
  builder: TraversalBuilder<
    G,
    InAliases,
    InEdgeAliases,
    EK,
    EA,
    Dir,
    Optional,
    DC,
    PC,
    RecursiveAliases,
    CoordinateState
  >,
) => unknown;

// ============================================================
// Fragment Factory
// ============================================================

/**
 * Creates a typed query fragment factory for a specific graph.
 *
 * This is the recommended way to create reusable fragments with full type safety.
 * The factory returns a function that creates fragments bound to your graph type.
 *
 * @example
 * ```typescript
 * // Create a factory for your graph
 * const fragment = createFragment<MyGraph>();
 *
 * // Define a simple filter fragment
 * const activeOnly = fragment((q) =>
 *   q.whereNode("u", ({ isActive }) => isActive.eq(true))
 * );
 *
 * // Define a traversal fragment
 * const withManager = fragment((q) =>
 *   q.traverse("reportsTo", "r").to("User", "manager")
 * );
 *
 * // Compose fragments
 * query()
 *   .from("User", "u")
 *   .pipe(activeOnly)
 *   .pipe(withManager)
 *   .select((ctx) => ({ user: ctx.u, manager: ctx.manager }))
 * ```
 */
/**
 * Identity function used by createFragment to return the fragment unchanged.
 * Defined at module scope to satisfy consistent-function-scoping lint rule.
 */
function fragmentIdentity<
  G extends GraphDef,
  InAliases extends AliasMap,
  OutAliases extends AliasMap,
  InEdgeAliases extends EdgeAliasMap,
  OutEdgeAliases extends EdgeAliasMap,
  InRecursiveAliases extends RecursiveAliasMap,
  OutRecursiveAliases extends RecursiveAliasMap,
>(
  fn: QueryFragment<
    G,
    InAliases,
    OutAliases,
    InEdgeAliases,
    OutEdgeAliases,
    InRecursiveAliases,
    OutRecursiveAliases
  >,
): QueryFragment<
  G,
  InAliases,
  OutAliases,
  InEdgeAliases,
  OutEdgeAliases,
  InRecursiveAliases,
  OutRecursiveAliases
> {
  return fn;
}

export function createFragment<G extends GraphDef>(): <
  InAliases extends AliasMap,
  OutAliases extends AliasMap,
  InEdgeAliases extends EdgeAliasMap,
  OutEdgeAliases extends EdgeAliasMap,
  InRecursiveAliases extends RecursiveAliasMap = EmptyRecursiveAliasMap,
  OutRecursiveAliases extends RecursiveAliasMap = InRecursiveAliases,
>(
  fn: QueryFragment<
    G,
    InAliases,
    OutAliases,
    InEdgeAliases,
    OutEdgeAliases,
    InRecursiveAliases,
    OutRecursiveAliases
  >,
) => QueryFragment<
  G,
  InAliases,
  OutAliases,
  InEdgeAliases,
  OutEdgeAliases,
  InRecursiveAliases,
  OutRecursiveAliases
> {
  return fragmentIdentity;
}

type ErasedFragment = (builder: unknown) => unknown;

/**
 * Combines multiple fragments into a single fragment.
 *
 * Fragments are applied in order from left to right.
 *
 * @example
 * ```typescript
 * const combinedFragment = composeFragments(
 *   activeOnly,
 *   withManager,
 *   recentlyUpdated
 * );
 *
 * query()
 *   .from("User", "u")
 *   .pipe(combinedFragment)
 *   .select(...)
 * ```
 */
export function composeFragments<
  G extends GraphDef,
  A1 extends AliasMap,
  A2 extends AliasMap,
  E1 extends EdgeAliasMap,
  E2 extends EdgeAliasMap,
  R1 extends RecursiveAliasMap,
  R2 extends RecursiveAliasMap,
>(
  f1: QueryFragment<G, A1, A2, E1, E2, R1, R2>,
): QueryFragment<G, A1, A2, E1, E2, R1, R2>;

export function composeFragments<
  G extends GraphDef,
  A1 extends AliasMap,
  A2 extends AliasMap,
  A3 extends AliasMap,
  E1 extends EdgeAliasMap,
  E2 extends EdgeAliasMap,
  E3 extends EdgeAliasMap,
  R1 extends RecursiveAliasMap,
  R2 extends RecursiveAliasMap,
  R3 extends RecursiveAliasMap,
>(
  f1: QueryFragment<G, A1, A2, E1, E2, R1, R2>,
  f2: QueryFragment<G, A2, A3, E2, E3, R2, R3>,
): QueryFragment<G, A1, A3, E1, E3, R1, R3>;

export function composeFragments<
  G extends GraphDef,
  A1 extends AliasMap,
  A2 extends AliasMap,
  A3 extends AliasMap,
  A4 extends AliasMap,
  E1 extends EdgeAliasMap,
  E2 extends EdgeAliasMap,
  E3 extends EdgeAliasMap,
  E4 extends EdgeAliasMap,
  R1 extends RecursiveAliasMap,
  R2 extends RecursiveAliasMap,
  R3 extends RecursiveAliasMap,
  R4 extends RecursiveAliasMap,
>(
  f1: QueryFragment<G, A1, A2, E1, E2, R1, R2>,
  f2: QueryFragment<G, A2, A3, E2, E3, R2, R3>,
  f3: QueryFragment<G, A3, A4, E3, E4, R3, R4>,
): QueryFragment<G, A1, A4, E1, E4, R1, R4>;

export function composeFragments<
  G extends GraphDef,
  A1 extends AliasMap,
  A2 extends AliasMap,
  A3 extends AliasMap,
  A4 extends AliasMap,
  A5 extends AliasMap,
  E1 extends EdgeAliasMap,
  E2 extends EdgeAliasMap,
  E3 extends EdgeAliasMap,
  E4 extends EdgeAliasMap,
  E5 extends EdgeAliasMap,
  R1 extends RecursiveAliasMap,
  R2 extends RecursiveAliasMap,
  R3 extends RecursiveAliasMap,
  R4 extends RecursiveAliasMap,
  R5 extends RecursiveAliasMap,
>(
  f1: QueryFragment<G, A1, A2, E1, E2, R1, R2>,
  f2: QueryFragment<G, A2, A3, E2, E3, R2, R3>,
  f3: QueryFragment<G, A3, A4, E3, E4, R3, R4>,
  f4: QueryFragment<G, A4, A5, E4, E5, R4, R5>,
): QueryFragment<G, A1, A5, E1, E5, R1, R5>;

export function composeFragments(...fragments: readonly unknown[]): unknown {
  return (builder: unknown) => {
    let result = builder;
    for (const fragment of fragments) {
      result = (fragment as ErasedFragment)(result);
    }
    return result;
  };
}

// ============================================================
// Common Fragment Patterns
// ============================================================

/**
 * Creates a fragment that adds ordering.
 *
 * @example
 * ```typescript
 * const byCreatedAt = orderByFragment<MyGraph, "u">("u", "createdAt", "desc");
 * ```
 */
export function orderByFragment<G extends GraphDef, A extends string>(
  alias: A,
  field: string,
  direction: "asc" | "desc" = "asc",
): FlexibleQueryFragment<G> {
  return (builder) => builder.orderBy(alias, field, direction);
}

/**
 * Creates a fragment that adds a limit.
 *
 * @example
 * ```typescript
 * const first10 = limitFragment<MyGraph>(10);
 * ```
 */
export function limitFragment<G extends GraphDef>(
  n: number,
): FlexibleQueryFragment<G> {
  return (builder) => builder.limit(n);
}

/**
 * Creates a fragment that adds an offset.
 *
 * @example
 * ```typescript
 * const skip10 = offsetFragment<MyGraph>(10);
 * ```
 */
export function offsetFragment<G extends GraphDef>(
  n: number,
): FlexibleQueryFragment<G> {
  return (builder) => builder.offset(n);
}
