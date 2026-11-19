/**
 * Query Fragment Composition
 *
 * A fragment is a reusable query transformation applied with `pipe()`. It
 * declares the node aliases it requires and is typed against only those, so
 * it can be written away from the query it is applied to, and it stays
 * generic over everything else that query carries.
 *
 * @example
 * ```typescript
 * const fragment = createFragment<typeof graph>();
 *
 * const activeUsers = fragment({ u: "User" }, (q) =>
 *   q.whereNode("u", ({ status }) => status.eq("active")),
 * );
 *
 * const results = await store
 *   .query()
 *   .from("User", "u")
 *   .pipe(activeUsers)
 *   .select((ctx) => ctx.u)
 *   .execute();
 * ```
 */
import { type GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
import { type TraversalDirection } from "../ast";
import { type QueryBuilder } from "./query-builder";
import { type TraversalBuilder } from "./traversal-builder";
import {
  type AliasMap,
  type AliasNodeType,
  type EdgeAliasMap,
  type EdgeOrderField,
  type EmptyAliasMap,
  type EmptyEdgeAliasMap,
  type EmptyRecursiveAliasMap,
  type IsUnion,
  type NodeAlias,
  type NodeOrderField,
  type QueryCoordinateState,
  type RecursiveAliasMap,
} from "./types";

// ============================================================
// Requirements
// ============================================================

/**
 * The node aliases a fragment requires, each mapped to the node kind it must
 * be bound to: `{ u: "User" }`.
 *
 * A host alias satisfies a requirement when every kind it can bind is the
 * declared kind, so `from("User", "u")` satisfies `{ u: "User" }` under any
 * expansion that keeps it typed as a `User` (the default, `"exact"` and
 * `"subclasses"`). An untyped alias (`expansion: "narrower"`, a runtime kind)
 * or a list source over several kinds does not.
 */
export type FragmentRequirements<G extends GraphDef> = Readonly<
  Record<string, keyof G["nodes"] & string>
>;

type EmptyFragmentRequirements = Readonly<Record<never, never>>;

/**
 * The alias map a fragment body is typed against: each required alias as
 * `from(kind, alias)` types it with no explicit expansion.
 */
export type FragmentRequiredAliases<
  G extends GraphDef,
  Requires extends FragmentRequirements<G>,
> = Readonly<{
  [A in keyof Requires & string]: NodeAlias<AliasNodeType<G, Requires[A]>>;
}>;

/** The node kind identity an alias binds, kept even where `kind` widens. */
type AliasKindIdentity<Alias> =
  Alias extends NodeAlias<infer N, boolean> ? NonNullable<N["__nodeKind"]>
  : never;

/**
 * One message per requirement that does not name exactly one node kind. A
 * requirement typed as a union of kinds (`{ u: kind }` with `kind` typed
 * `"User" | "Post"`) states neither kind: the value captured at runtime is one
 * of them, and a host bound to the other would pass a check against the
 * union and then be refused. The factory and every fit check consult this
 * one predicate.
 */
type RequirementKindErrors<Requires> = {
  [A in keyof Requires & string]: true extends IsUnion<Requires[A]> ?
    `Error: fragment requirement '${A}' must name one node kind, not a union of kinds`
  : never;
}[keyof Requires & string];

/**
 * One message per requirement `Aliases` does not satisfy. With
 * `ReportMissing` false, an alias `Aliases` lacks is not an error: an earlier
 * fragment in a composition leaves it to the query. An alias that
 * `OtherKeys` (the edge and recursive aliases) holds is always an error: no
 * query can bind it as a node.
 */
type RequirementErrors<
  Requires,
  Aliases,
  OtherKeys,
  ReportMissing extends boolean,
> = {
  [A in keyof Requires & string]: A extends keyof Aliases ?
    [AliasKindIdentity<Aliases[A]>] extends [Requires[A]] ?
      never
    : `Error: fragment requires alias '${A}' to be a '${Requires[A] & string}' node`
  : A extends OtherKeys ?
    `Error: fragment requires alias '${A}' to be a '${Requires[A] & string}' node, but it is an edge or recursive alias here`
  : ReportMissing extends true ?
    `Error: fragment requires alias '${A}' (a '${Requires[A] & string}' node), which this query does not have`
  : never;
}[keyof Requires & string];

/**
 * A message when `HostGraph` is not the graph a fragment was written for. A
 * fragment written for one graph types its body against that graph's
 * schemas, so it applies only to a query (or a composition) over that graph
 * or one that extends it; a broad `GraphDef` fragment applies to every graph.
 */
type GraphErrors<FragmentGraph, HostGraph> =
  [HostGraph] extends [FragmentGraph] ? never
  : "Error: fragment is written for another graph";

type CollisionErrors<AddedKeys, ExistingKeys> =
  Extract<AddedKeys, ExistingKeys> extends infer Collision extends string ?
    Collision extends unknown ?
      `Error: fragment adds alias '${Collision}', which this query already uses`
    : never
  : never;

/**
 * `unknown` when a fragment fits a builder; otherwise an object type whose
 * keys are the reasons it does not, which the builder lacks, so the misfit is
 * reported at the `pipe()` (or `composeFragments()`) call that caused it.
 */
type FitReport<Errors extends string> =
  [Errors] extends [never] ? unknown : Readonly<Record<Errors, never>>;

type FragmentFitErrors<
  Shape extends AnyFragmentShape,
  HostGraph,
  Aliases,
  EdgeAliases,
  RecursiveAliases,
  ReportMissing extends boolean,
> =
  | GraphErrors<Shape["graph"], HostGraph>
  | RequirementKindErrors<Shape["requires"]>
  | RequirementErrors<
      Shape["requires"],
      Aliases,
      keyof EdgeAliases | keyof RecursiveAliases,
      ReportMissing
    >
  | CollisionErrors<
      | keyof Shape["added"]
      | keyof Shape["addedEdges"]
      | keyof Shape["addedRecursive"],
      keyof Aliases | keyof EdgeAliases | keyof RecursiveAliases
    >;

type FragmentFit<
  Shape extends AnyFragmentShape,
  HostGraph,
  Aliases,
  EdgeAliases,
  RecursiveAliases,
  ReportMissing extends boolean,
> = FitReport<
  FragmentFitErrors<
    Shape,
    HostGraph,
    Aliases,
    EdgeAliases,
    RecursiveAliases,
    ReportMissing
  >
>;

// ============================================================
// Fragment Types
// ============================================================

type MergeMaps<Existing, Added> =
  keyof Added extends never ? Existing : Existing & Added;

/** The entries of `Out` that are not keys of `Base`. */
type AddedEntries<Out, Base> = Readonly<{
  [K in Exclude<keyof Out, keyof Base>]: Out[K];
}>;

declare const FRAGMENT_SHAPE: unique symbol;

type FragmentShape<
  G extends GraphDef,
  Requires extends FragmentRequirements<G>,
  Added extends AliasMap,
  AddedEdges extends EdgeAliasMap,
  AddedRecursive extends RecursiveAliasMap,
> = Readonly<{
  graph: G;
  requires: Requires;
  added: Added;
  addedEdges: AddedEdges;
  addedRecursive: AddedRecursive;
}>;

type AnyFragmentShape = FragmentShape<
  GraphDef,
  FragmentRequirements<GraphDef>,
  AliasMap,
  EdgeAliasMap,
  RecursiveAliasMap
>;

/**
 * A reusable query transformation, built with {@link createFragment}.
 *
 * It applies to any query over `G` (or a graph that extends it) whose
 * aliases include `Requires` at compatible kinds, and returns that query
 * with its own aliases, edge aliases and recursive aliases unchanged plus the
 * ones the fragment adds. Applying it to a query over another graph, or one
 * that lacks a required alias, binds it at another kind, or already uses an
 * alias the fragment adds, is a compile error at `pipe()`.
 *
 * @typeParam G - The graph definition
 * @typeParam Requires - The node aliases the fragment requires, by kind
 * @typeParam Added - The node aliases the fragment adds
 * @typeParam AddedEdges - The edge aliases the fragment adds
 * @typeParam AddedRecursive - The recursive depth/path aliases the fragment adds
 */
export interface QueryFragment<
  G extends GraphDef,
  Requires extends FragmentRequirements<G> = EmptyFragmentRequirements,
  Added extends AliasMap = EmptyAliasMap,
  AddedEdges extends EdgeAliasMap = EmptyEdgeAliasMap,
  AddedRecursive extends RecursiveAliasMap = EmptyRecursiveAliasMap,
> {
  // The call signature and the brand share one object type, not a function
  // type intersected with the brand: `pipe()` instantiates a generic
  // argument's signature against the host builder only when the argument is a
  // single object type.
  <
    HostGraph extends GraphDef,
    Aliases extends AliasMap,
    EdgeAliases extends EdgeAliasMap,
    RecursiveAliases extends RecursiveAliasMap,
    CoordinateState extends QueryCoordinateState,
  >(
    builder: QueryBuilder<
      HostGraph,
      Aliases,
      EdgeAliases,
      RecursiveAliases,
      CoordinateState
    > &
      FragmentFit<
        FragmentShape<G, Requires, Added, AddedEdges, AddedRecursive>,
        HostGraph,
        Aliases,
        EdgeAliases,
        RecursiveAliases,
        true
      >,
  ): QueryBuilder<
    HostGraph,
    MergeMaps<Aliases, Added>,
    MergeMaps<EdgeAliases, AddedEdges>,
    MergeMaps<RecursiveAliases, AddedRecursive>,
    CoordinateState
  >;
  /**
   * Type-level only: what the fragment requires and adds. Invariant, so an
   * annotation cannot state a shape the fragment does not have: widening its
   * graph, a requirement's kind or its requirements away would let `pipe()`
   * accept a query the fragment refuses at runtime.
   */
  readonly [FRAGMENT_SHAPE]: InvariantShape<
    FragmentShape<G, Requires, Added, AddedEdges, AddedRecursive>
  >;
}

type InvariantShape<Shape> = (shape: Shape) => Shape;

/** Every fragment: the shape's parameter is `never`, which any shape accepts. */
type AnyQueryFragment = Readonly<{
  [FRAGMENT_SHAPE]: (shape: never) => AnyFragmentShape;
}>;

/**
 * The function a fragment is written as: typed against a builder that holds
 * only the required aliases, and generic over the coordinate state so it
 * applies to a live query and to a StoreView query alike.
 */
export type QueryFragmentBody<
  G extends GraphDef,
  Requires extends FragmentRequirements<G>,
  OutAliases extends AliasMap,
  OutEdgeAliases extends EdgeAliasMap,
  OutRecursiveAliases extends RecursiveAliasMap,
> = <CoordinateState extends QueryCoordinateState>(
  builder: QueryBuilder<
    G,
    FragmentRequiredAliases<G, Requires>,
    EmptyEdgeAliasMap,
    EmptyRecursiveAliasMap,
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

/** The fragment factory {@link createFragment} returns for a graph. */
export interface QueryFragmentFactory<G extends GraphDef> {
  /** A fragment that requires no alias. */
  <
    OutAliases extends AliasMap,
    OutEdgeAliases extends EdgeAliasMap,
    OutRecursiveAliases extends RecursiveAliasMap,
  >(
    body: QueryFragmentBody<
      G,
      EmptyFragmentRequirements,
      OutAliases,
      OutEdgeAliases,
      OutRecursiveAliases
    >,
  ): QueryFragment<
    G,
    EmptyFragmentRequirements,
    OutAliases,
    OutEdgeAliases,
    OutRecursiveAliases
  >;
  /** A fragment that requires the node aliases `requires` declares. */
  <
    const Requires extends FragmentRequirements<G>,
    OutAliases extends AliasMap,
    OutEdgeAliases extends EdgeAliasMap,
    OutRecursiveAliases extends RecursiveAliasMap,
  >(
    requires: Requires & FitReport<RequirementKindErrors<Requires>>,
    body: QueryFragmentBody<
      G,
      Requires,
      OutAliases,
      OutEdgeAliases,
      OutRecursiveAliases
    >,
  ): QueryFragment<
    G,
    Requires,
    AddedEntries<OutAliases, Requires>,
    OutEdgeAliases,
    OutRecursiveAliases
  >;
}

type ErasedFragment = (builder: unknown) => unknown;

type ErasedBuilder<G extends GraphDef> = QueryBuilder<
  G,
  AliasMap,
  EdgeAliasMap,
  RecursiveAliasMap,
  QueryCoordinateState
>;

/**
 * Types a runtime transformation as a {@link QueryFragment}. The shape is a
 * type-level brand: the fragment is the transformation itself at runtime.
 */
function asQueryFragment<Fragment extends AnyQueryFragment>(
  transform: ErasedFragment,
): Fragment {
  return transform as unknown as Fragment;
}

function defineFragment(
  requiresOrBody: ErasedFragment | FragmentRequirements<GraphDef>,
  body?: ErasedFragment,
): AnyQueryFragment {
  if (typeof requiresOrBody === "function") {
    return asQueryFragment(requiresOrBody);
  }
  if (body === undefined) {
    throw new ConfigurationError(
      "A fragment that declares required aliases needs a body: fragment(requires, body).",
    );
  }
  const requires = Object.freeze({ ...requiresOrBody });
  // A caller the compile-time check cannot reach (untyped code, a cast) still
  // meets the declaration: an unmet requirement is refused, never ignored.
  return asQueryFragment((builder) => {
    (builder as ErasedBuilder<GraphDef>).assertFragmentRequirements(requires);
    return body(builder);
  });
}

/**
 * Creates the fragment factory for a graph.
 *
 * `fragment(requires, body)` declares the node aliases the fragment needs,
 * by kind, and types `body` against a builder holding only those; the
 * aliases, traversals and filters `body` adds are carried onto whatever
 * query the fragment is piped into. `fragment(body)` is a fragment that
 * requires no alias.
 *
 * A traversal in `body` without a `from` option starts at the host query's
 * current node, which the fragment cannot know; pass `from` to start it at a
 * required alias.
 *
 * @example
 * ```typescript
 * const fragment = createFragment<typeof graph>();
 *
 * const activeOnly = fragment({ u: "User" }, (q) =>
 *   q.whereNode("u", ({ status }) => status.eq("active")),
 * );
 *
 * const withPosts = fragment({ u: "User" }, (q) =>
 *   q.traverse("authored", "a", { from: "u" }).to("Post", "p"),
 * );
 *
 * store
 *   .query()
 *   .from("User", "u")
 *   .pipe(activeOnly)
 *   .pipe(withPosts)
 *   .select((ctx) => ({ user: ctx.u, post: ctx.p }));
 * ```
 */
export function createFragment<G extends GraphDef>(): QueryFragmentFactory<G> {
  return defineFragment as QueryFragmentFactory<G>;
}

// ============================================================
// Composition
// ============================================================

type ShapeOf<Fragment> =
  Fragment extends (
    Readonly<{
      [FRAGMENT_SHAPE]: (shape: never) => infer Shape extends AnyFragmentShape;
    }>
  ) ?
    Shape
  : never;

/**
 * The aliases a composition holds after `First` ran: its required aliases,
 * at their declared kinds, and the ones it added.
 */
type ComposedNodeAliases<Shape extends AnyFragmentShape> = Readonly<
  FragmentRequiredAliases<Shape["graph"], Shape["requires"]>
> &
  Shape["added"];

/**
 * The graph a composition of `First` and `Second` is written for: the
 * narrower of the two, so a broad `GraphDef` helper composed with a fragment
 * for one graph yields a fragment for that graph, in either order.
 * {@link ComposeFit} refuses two graphs neither of which extends the other.
 */
type ComposedGraph<
  First extends AnyFragmentShape,
  Second extends AnyFragmentShape,
> =
  [Second["graph"]] extends [First["graph"]] ? Second["graph"] : First["graph"];

type ComposedShape<
  First extends AnyFragmentShape,
  Second extends AnyFragmentShape,
> = FragmentShape<
  ComposedGraph<First, Second>,
  Readonly<
    First["requires"] &
      AddedEntries<Second["requires"], ComposedNodeAliases<First>>
  >,
  MergeMaps<First["added"], Second["added"]>,
  MergeMaps<First["addedEdges"], Second["addedEdges"]>,
  MergeMaps<First["addedRecursive"], Second["addedRecursive"]>
>;

/**
 * Why `Second` cannot run after `First`, if it cannot: the two are written
 * for graphs neither of which extends the other, a requirement of `Second`
 * that `First` holds is not a node alias at a compatible kind, or `Second`
 * adds an alias `First` holds. Requirements `First` does not hold pass to
 * the query.
 */
type ComposeErrors<
  First extends AnyFragmentShape,
  Second extends AnyFragmentShape,
> = FragmentFitErrors<
  Second,
  ComposedGraph<First, Second>,
  ComposedNodeAliases<First>,
  First["addedEdges"],
  First["addedRecursive"],
  false
>;

/**
 * A message when `Fragment` is a union of fragments (`flag ? a : b`). A
 * union's shape keeps only what every branch shares, so a composition built
 * from one would drop the requirements of whichever branch runs; it is
 * refused, and each branch is composed (or piped) on its own.
 */
type UnionFragmentErrors<Fragment> =
  true extends IsUnion<Fragment> ?
    "Error: composeFragments() takes a fragment, not a union of fragments; compose each branch separately"
  : never;

/** The shape of `Composed` followed by `Next`. */
type ComposeStep<
  Composed extends AnyFragmentShape | undefined,
  Next extends AnyFragmentShape,
> = Composed extends AnyFragmentShape ? ComposedShape<Composed, Next> : Next;

/** The shape of a composition: its fragments' shapes folded left to right. */
type CompositionShape<
  Fragments extends readonly unknown[],
  Composed extends AnyFragmentShape | undefined = undefined,
> =
  Fragments extends readonly [infer Next, ...infer Rest] ?
    CompositionShape<Rest, ComposeStep<Composed, ShapeOf<Next>>>
  : Composed;

/** Every reason a fragment of `Fragments` cannot follow the ones before it. */
type CompositionErrors<
  Fragments extends readonly unknown[],
  Composed extends AnyFragmentShape | undefined = undefined,
> =
  Fragments extends readonly [infer Next, ...infer Rest] ?
    | UnionFragmentErrors<Next>
    | (Composed extends AnyFragmentShape ?
        ComposeErrors<Composed, ShapeOf<Next>>
      : never)
    | CompositionErrors<Rest, ComposeStep<Composed, ShapeOf<Next>>>
  : never;

type ShapeFragment<Shape> =
  Shape extends AnyFragmentShape ?
    QueryFragment<
      Shape["graph"],
      Shape["requires"],
      Shape["added"],
      Shape["addedEdges"],
      Shape["addedRecursive"]
    >
  : never;

/**
 * Combines fragments into one, applied left to right.
 *
 * The result is written for the narrowest graph among the fragments'
 * graphs, requires every alias the first fragment requires, plus each alias
 * a later fragment requires that no earlier fragment holds, and adds every
 * alias the fragments add. It is a compile error at this call when a
 * fragment is a union of fragments, is written for a graph unrelated to an
 * earlier fragment's, requires an alias an earlier one holds as an edge,
 * recursive alias or node of another kind, or adds an alias an earlier one
 * holds.
 *
 * @example
 * ```typescript
 * const activeWithPosts = composeFragments(activeOnly, withPosts);
 *
 * store
 *   .query()
 *   .from("User", "u")
 *   .pipe(activeWithPosts)
 *   .select((ctx) => ({ user: ctx.u, post: ctx.p }));
 * ```
 */
// The fragments are inferred as one tuple, not as one type parameter each:
// a later parameter typed by an earlier one's shape would fix the earlier
// one to its constraint whenever its argument is an inline generic call
// (`limitFragment(20)`), which TypeScript infers only on a second pass.
export function composeFragments<
  Fragments extends readonly [AnyQueryFragment, ...AnyQueryFragment[]],
>(
  ...fragments: Fragments & FitReport<CompositionErrors<Fragments>>
): ShapeFragment<CompositionShape<Fragments>>;

export function composeFragments(
  ...fragments: readonly AnyQueryFragment[]
): unknown {
  return asQueryFragment<AnyQueryFragment>((builder: unknown) => {
    let result = builder;
    for (const fragment of fragments) {
      result = (fragment as unknown as ErasedFragment)(result);
    }
    return result;
  });
}

// ============================================================
// Common Fragment Patterns
// ============================================================

/**
 * Every name `orderBy(alias, field)` accepts for some node or edge kind of
 * `G`. A fragment does not know which kind its alias will be bound to, so it
 * is typed against the whole graph; the builder refuses a name the bound
 * alias does not declare when the fragment is applied.
 */
export type GraphOrderField<G extends GraphDef> =
  | {
      [K in keyof G["nodes"]]: NodeOrderField<G["nodes"][K]["type"]>;
    }[keyof G["nodes"]]
  | {
      [K in keyof G["edges"]]: EdgeOrderField<G["edges"][K]["type"]>;
    }[keyof G["edges"]];

/**
 * Creates a fragment that adds ordering.
 *
 * It requires no alias at the type level: `alias` may name a node or an edge
 * of any kind, and `orderBy` refuses an alias the query does not have, or a
 * field that alias does not accept, when the fragment is applied.
 *
 * @example
 * ```typescript
 * const newestFirst = orderByFragment<MyGraph, "u">("u", "meta.createdAt", "desc");
 * ```
 */
export function orderByFragment<G extends GraphDef, A extends string>(
  alias: A,
  field: GraphOrderField<G>,
  direction: "asc" | "desc" = "asc",
): QueryFragment<G> {
  return asQueryFragment((builder) =>
    (builder as ErasedBuilder<G>).orderBy(alias, field as never, direction),
  );
}

/**
 * Creates a fragment that adds a limit.
 *
 * @example
 * ```typescript
 * const first10 = limitFragment<MyGraph>(10);
 * ```
 */
export function limitFragment<G extends GraphDef>(n: number): QueryFragment<G> {
  return createFragment<G>()((builder) => builder.limit(n));
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
): QueryFragment<G> {
  return createFragment<G>()((builder) => builder.offset(n));
}
