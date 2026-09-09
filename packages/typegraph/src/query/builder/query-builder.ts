/**
 * QueryBuilder - The fluent query builder.
 */
import {
  type GraphDef,
  type GraphIdentityConfig,
} from "../../core/define-graph";
import {
  resolveRuntimeKindInput,
  type RuntimeEdgeKind,
  type RuntimeEdgeTypeFor,
  type RuntimeNodeKind,
  type RuntimeNodeTypeFor,
} from "../../core/runtime-kind";
import {
  coordinateContext,
  describeCoordinate,
  resolveReadCoordinate,
} from "../../core/temporal";
import {
  type EdgeType,
  type NodeType,
  type TemporalMode,
} from "../../core/types";
import {
  ConfigurationError,
  KindNotFoundError,
  UnsupportedPredicateError,
} from "../../errors";
import { type PolymorphicNodeType } from "../../ontology/types";
import { partitionCompositionEdgeKindsByDirection } from "../../registry/composition-relation";
import { isInteropProbeKey } from "../../utils/object";
import {
  type AggregateExpr,
  type FieldRef,
  type GroupBySpec,
  type HybridFusionOptions,
  mergeEdgeKinds,
  type PredicateExpression,
  type ProjectedField,
  type SortDirection,
  type TraversalDirection,
  type TraversalExpansion,
} from "../ast";
import { jsonPointer, parseJsonPointer } from "../json-pointer";
import {
  buildFieldBuilderForTypeInfo,
  createFulltextAccessor,
  fieldRef,
  type Predicate,
  stringField,
} from "../predicates";
import { type FieldTypeInfo } from "../schema-introspector";
import {
  type AliasExpansionOptions,
  expandKindsForAxis,
  resolveAliasExpansion,
} from "./alias-expansion";
import {
  createDynamicFieldBuilder,
  type DynamicEdgeType,
  type DynamicNodeType,
} from "./dynamic";
import { ExecutableAggregateQuery } from "./executable-aggregate-query";
import { ExecutableQuery } from "./executable-query";
import { getQueryBuilderInternalContext } from "./internal-context";
import { buildOrderSpec, resolveSystemOrderField } from "./order-by-field";
import { TraversalBuilder } from "./traversal-builder";
import {
  type AliasMap,
  type AliasNodeType,
  type BaseFieldAccessor,
  type BuildRecursiveAliases,
  type EdgeAccessor,
  type EdgeAlias,
  type EdgeAliasMap,
  type EmptyAliasMap,
  type EmptyEdgeAliasMap,
  type EmptyRecursiveAliasMap,
  type NodeAccessor,
  type NodeAlias,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type QueryCoordinateState,
  type RecursiveAliasMap,
  type SelectContext,
  type UniqueAlias,
} from "./types";
import {
  validateHybridFusionOptions,
  validateSqlIdentifier,
} from "./validation";

/**
 * Identity-aware traversal option, available only on a graph that declares an
 * identity configuration. On any other graph the property is typed `never`, so
 * setting it is a compile error (and a runtime guard rejects it as well).
 *
 * When `includeIdentityMembers` is true, the traversal's source hop matches an
 * edge attached to *any* coordinate-visible member of the source node's
 * identity class, not just the source node itself. Semantics:
 *
 * - Results are physical rows: the nodes and edges returned are the ones
 *   actually stored, never a synthesized merge of the class.
 * - Identity-class membership is resolved at the query's own coordinate, so a
 *   traversal under `asOf`/`asOfRecorded` follows only the assertions that were
 *   in force at that instant; a retracted assertion stops conducting.
 * - Within a step, physical edge ids are deduplicated. The one exception is a
 *   self-inverse edge between two folded peers (same id, different kind), which
 *   legitimately matches in both directions and is kept.
 * - Under recursion, cycle detection keys on (kind, id) rather than id alone,
 *   so passing through two folded peers is not mistaken for a revisit. Path
 *   output is unaffected: it remains an array of bare node ids.
 */
export type IdentityTraversalOption<G extends GraphDef> =
  G["identity"] extends GraphIdentityConfig ?
    Readonly<{ includeIdentityMembers?: boolean }>
  : Readonly<{ includeIdentityMembers?: never }>;

type DynamicNodeTypeFor<T> =
  T extends RuntimeNodeKind ? RuntimeNodeTypeFor<T> : DynamicNodeType;

/**
 * Options shared by `parts()` and `wholes()`. There is deliberately no
 * `expand`: `expand` means "same relation, more members" (ontology
 * implying/inverse expansion, Q1), and the composition edge-kind set these
 * two steps traverse is derived from the registry's composition relation,
 * not from an expansion mode.
 */
export type CompositionNavigationOptions<Aliases extends AliasMap> = Readonly<{
  /** Alias to navigate from (defaults to current/last traversal target). */
  from?: keyof Aliases & string;
  /** Maximum recursion depth. `1` reaches only the direct level. */
  maxHops?: number;
  /** Include recursion depth in output. Pass a string to customize the alias. */
  depth?: string;
  /** Include the traversal path in output. Pass a string to customize the alias. */
  path?: string;
}>;

type DynamicEdgeTypeFor<T> =
  T extends RuntimeEdgeKind ? RuntimeEdgeTypeFor<T> : DynamicEdgeType;

/**
 * The `QueryBuilder` shape `parts()`/`wholes()` return: one alias definition
 * consumed by both methods' public signatures and their internal casts, so
 * the same generic expansion is never re-spelled four times over.
 */
type CompositionNavigationResult<
  G extends GraphDef,
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  RecursiveAliases extends RecursiveAliasMap,
  CoordinateState extends QueryCoordinateState,
  NA extends string,
  O,
> = QueryBuilder<
  G,
  Aliases & Record<NA, NodeAlias<DynamicNodeType>>,
  EdgeAliases & Record<`${NA}_edge`, EdgeAlias<DynamicEdgeType>>,
  RecursiveAliases &
    BuildRecursiveAliases<
      O extends { depth: infer D extends string } ? D : false,
      O extends { path: infer P extends string } ? P : false,
      NA
    >,
  CoordinateState
>;

/**
 * Builds projected fields for a node alias (including all metadata columns).
 */
function buildNodeFields(alias: string): ProjectedField[] {
  return [
    {
      outputName: `${alias}_id`,
      source: fieldRef(alias, ["id"]),
    },
    {
      outputName: `${alias}_kind`,
      source: fieldRef(alias, ["kind"]),
    },
    {
      outputName: `${alias}_props`,
      source: fieldRef(alias, ["props"]),
    },
    {
      outputName: `${alias}_version`,
      source: fieldRef(alias, ["version"]),
    },
    {
      outputName: `${alias}_valid_from`,
      source: fieldRef(alias, ["valid_from"]),
    },
    {
      outputName: `${alias}_valid_to`,
      source: fieldRef(alias, ["valid_to"]),
    },
    {
      outputName: `${alias}_created_at`,
      source: fieldRef(alias, ["created_at"]),
    },
    {
      outputName: `${alias}_updated_at`,
      source: fieldRef(alias, ["updated_at"]),
    },
    {
      outputName: `${alias}_deleted_at`,
      source: fieldRef(alias, ["deleted_at"]),
    },
  ];
}

/**
 * Builds projected fields for an edge alias (including all metadata columns).
 *
 * Edge columns are stored in the traversal's node CTE (e.g., cte_c contains e_id, e_kind, etc.).
 * The nodeCteAlias parameter specifies which CTE contains these columns.
 */
function buildEdgeFields(
  edgeAlias: string,
  nodeCteAlias: string,
): ProjectedField[] {
  const cteAlias = `cte_${nodeCteAlias}`;
  return [
    {
      outputName: `${edgeAlias}_id`,
      source: fieldRef(edgeAlias, ["id"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_kind`,
      source: fieldRef(edgeAlias, ["kind"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_from_id`,
      source: fieldRef(edgeAlias, ["from_id"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_to_id`,
      source: fieldRef(edgeAlias, ["to_id"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_props`,
      source: fieldRef(edgeAlias, ["props"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_valid_from`,
      source: fieldRef(edgeAlias, ["valid_from"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_valid_to`,
      source: fieldRef(edgeAlias, ["valid_to"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_created_at`,
      source: fieldRef(edgeAlias, ["created_at"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_updated_at`,
      source: fieldRef(edgeAlias, ["updated_at"]),
      cteAlias,
    },
    {
      outputName: `${edgeAlias}_deleted_at`,
      source: fieldRef(edgeAlias, ["deleted_at"]),
      cteAlias,
    },
  ];
}

type TemporalMethod<
  G extends GraphDef,
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap,
  RecursiveAliases extends RecursiveAliasMap,
  CoordinateState extends QueryCoordinateState,
> =
  CoordinateState extends "open" ?
    (
      mode: TemporalMode,
      asOf?: string,
    ) => QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, "open">
  : never;

/**
 * The fluent query builder.
 *
 * Type parameters accumulate as methods are chained:
 * - G: The graph definition
 * - Aliases: Map of alias names to their node kinds
 * - EdgeAliases: Map of alias names to their edge kinds (accumulated during traversals)
 */
export class QueryBuilder<
  G extends GraphDef,
  Aliases extends AliasMap = EmptyAliasMap,
  EdgeAliases extends EdgeAliasMap = EmptyEdgeAliasMap,
  RecursiveAliases extends RecursiveAliasMap = EmptyRecursiveAliasMap,
  CoordinateState extends QueryCoordinateState = "open",
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;
  readonly temporal: TemporalMethod<
    G,
    Aliases,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  constructor(config: QueryBuilderConfig, state: QueryBuilderState) {
    this.#config = config;
    this.#state = state;
    this.temporal = ((mode, asOf) =>
      this.#setTemporal(mode, asOf)) as TemporalMethod<
      G,
      Aliases,
      EdgeAliases,
      RecursiveAliases,
      CoordinateState
    >;
  }

  /**
   * Sets temporal mode.
   *
   * @param mode - The temporal mode to use
   * @param asOf - Required timestamp for "asOf" mode (ISO 8601 string).
   *   Rejected for every other mode — pinning an instant is only meaningful
   *   in "asOf" mode, so `temporal("current", t)` is a caller error, not a
   *   silently-dropped argument.
   * @throws ValidationError if mode is "asOf" but no timestamp is provided, or
   *   if an asOf is supplied with a non-"asOf" mode.
   */
  #setTemporal(
    mode: TemporalMode,
    asOf?: string,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, "open"> {
    const { sealedCoordinate } = getQueryBuilderInternalContext(this.#config);
    if (sealedCoordinate !== undefined) {
      const coordinate = sealedCoordinate;
      throw new ConfigurationError(
        `.temporal() is not available on a StoreView query — the view's ` +
          `temporal coordinate (${describeCoordinate(coordinate)}) is sealed. ` +
          `Re-coordinate on the live Store via store.query() or store.view(...).`,
        {
          code: "STORE_VIEW_SEALED_QUERY",
          ...coordinateContext(coordinate),
          requestedMode: mode,
        },
      );
    }
    const coordinate = resolveReadCoordinate(
      mode,
      asOf,
      `Use .temporal("asOf", "2024-01-15T10:00:00.000Z") or .temporal("current") for current time.`,
    );
    return new QueryBuilder(this.#config, {
      ...this.#state,
      temporalMode: coordinate.valid.mode,
      asOf: coordinate.valid.asOf,
    });
  }

  /**
   * Starts a query from a node kind.
   *
   * The alias's expansion axis is one option, `expansion` (default
   * `"subclasses"`, roadmap Q3 — a supertype query is polymorphic unless
   * narrowed). `"exact"` restores the exact-kind reading; `"narrower"`
   * expands through `broader`/`narrower` instead (C.3, untyped alias — no
   * schema relationship is claimed). Omitting the option, passing `{}`, or
   * passing an explicit `undefined` all take the store default.
   *
   * @param kind - The node kind to start from
   * @param alias - A unique alias for this node (compile-time error if duplicate)
   */
  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options?: { expansion?: undefined },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<AliasNodeType<G, K>>>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options: { expansion: "exact" },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<G["nodes"][K]["type"]>>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options: { expansion: "subclasses" },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<PolymorphicNodeType<G["nodes"][K]["type"]>>>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options: { expansion: "narrower" },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options?: AliasExpansionOptions,
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  > {
    // Validate alias to prevent SQL injection
    validateSqlIdentifier(alias);

    const expansion = resolveAliasExpansion(
      options,
      this.#config.defaultExpansion,
    );
    const kinds = expandKindsForAxis(expansion, kind, this.#config.registry);

    const newState: QueryBuilderState = {
      ...this.#state,
      startAlias: alias,
      currentAlias: alias,
      startKinds: kinds,
      startExpansion: expansion,
    };

    return new QueryBuilder(this.#config, newState);
  }

  /**
   * Runtime-kind sibling of `from`; accepts a kind name or Store-issued token.
   * Throws `KindNotFoundError` if the kind is not registered. String-keyed
   * predicates use the `n.field("name").number().gte(...)` discriminator.
   *
   * The runtime kind may not appear in `G["ontology"]` at all, so — unlike
   * `from()` — this always widens to {@link PolymorphicNodeType} whenever the
   * axis is not `"exact"`, rather than computing `SubsumptionAffected`.
   * `expansion: "narrower"` types the alias as an untyped {@link NodeAlias},
   * the same way `from()` does.
   */
  fromDynamic<T extends string | RuntimeNodeKind, A extends string>(
    kind: T,
    alias: UniqueAlias<A, Aliases>,
    options: { expansion: "exact" },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<DynamicNodeTypeFor<T>>>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  fromDynamic<T extends string | RuntimeNodeKind, A extends string>(
    kind: T,
    alias: UniqueAlias<A, Aliases>,
    options?: { expansion?: "subclasses" },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<PolymorphicNodeType<DynamicNodeTypeFor<T>>>>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  fromDynamic<T extends string | RuntimeNodeKind, A extends string>(
    kind: T,
    alias: UniqueAlias<A, Aliases>,
    options: { expansion: "narrower" },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  >;

  fromDynamic<T extends string | RuntimeNodeKind, A extends string>(
    kind: T,
    alias: UniqueAlias<A, Aliases>,
    options?: AliasExpansionOptions,
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias>,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState
  > {
    validateSqlIdentifier(alias);
    const kindName = resolveRuntimeKindInput(
      kind,
      "node",
      getQueryBuilderInternalContext(this.#config).runtimeKindTokenResolver,
    );
    if (!this.#config.registry.hasNodeType(kindName)) {
      throw new KindNotFoundError(kindName, "node", {
        graphId: this.#config.graphId,
      });
    }

    const expansion = resolveAliasExpansion(
      options,
      this.#config.defaultExpansion,
    );
    const kinds = expandKindsForAxis(
      expansion,
      kindName,
      this.#config.registry,
    );

    const newState: QueryBuilderState = {
      ...this.#state,
      startAlias: alias,
      currentAlias: alias,
      startKinds: kinds,
      startExpansion: expansion,
      dynamicNodeAliases: new Set([...this.#state.dynamicNodeAliases, alias]),
    };

    return new QueryBuilder(this.#config, newState);
  }

  /**
   * Adds a WHERE clause for a node.
   */
  whereNode<A extends keyof Aliases & string>(
    alias: A,
    predicateFunction: (n: NodeAccessor<Aliases[A]["type"]>) => Predicate,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    const accessor = this.#createNodeAccessor(alias);
    const predicate = predicateFunction(
      accessor as NodeAccessor<Aliases[A]["type"]>,
    );

    const newState: QueryBuilderState = {
      ...this.#state,
      predicates: [
        ...this.#state.predicates,
        {
          targetAlias: alias,
          expression: predicate.__expr,
        },
      ],
    };

    return new QueryBuilder(this.#config, newState);
  }

  /**
   * Adds a WHERE clause for an edge.
   *
   * @param alias - The edge alias to filter on
   * @param predicateFunction - A function that builds predicates using the edge accessor
   */
  whereEdge<EA extends keyof EdgeAliases & string>(
    alias: EA,
    predicateFunction: (
      edge: EdgeAccessor<EdgeAliases[EA]["type"]>,
    ) => Predicate,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    const accessor = this.#createEdgeAccessor(alias);
    const predicate = predicateFunction(
      accessor as EdgeAccessor<EdgeAliases[EA]["type"]>,
    );

    const newState: QueryBuilderState = {
      ...this.#state,
      predicates: [
        ...this.#state.predicates,
        {
          targetAlias: alias,
          targetType: "edge",
          expression: predicate.__expr,
        },
      ],
    };

    return new QueryBuilder(this.#config, newState);
  }

  /**
   * Traverses an edge to another node (outgoing direction).
   *
   * By default, traverses from the current node (last traversal target, or start node).
   * Use the `from` option to traverse from a different alias (fan-out pattern).
   *
   * @param options.expand - Ontology expansion mode for implying/inverse edges
   * @param options.from - Alias to traverse from (defaults to current/last traversal target)
   */
  traverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options?: {
      direction?: "out";
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    "out",
    false,
    false,
    false,
    RecursiveAliases,
    CoordinateState
  >;

  /**
   * Traverses an edge to another node (incoming direction).
   *
   * By default, traverses from the current node (last traversal target, or start node).
   * Use the `from` option to traverse from a different alias (fan-out pattern).
   *
   * @param options.direction - Set to "in" for incoming edge traversal
   * @param options.expand - Ontology expansion mode for implying/inverse edges
   * @param options.from - Alias to traverse from (defaults to current/last traversal target)
   */
  traverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options: {
      direction: "in";
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    "in",
    false,
    false,
    false,
    RecursiveAliases,
    CoordinateState
  >;

  traverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options?: {
      direction?: TraversalDirection;
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    TraversalDirection,
    false,
    false,
    false,
    RecursiveAliases,
    CoordinateState
  > {
    // Validate edge alias to prevent SQL injection
    validateSqlIdentifier(edgeAlias);

    const direction = options?.direction ?? "out";
    this.#assertIdentityTraversalAllowed(options);
    const expansion = options?.expand ?? this.#config.defaultTraversalExpansion;
    const includeImplyingEdges =
      expansion === "implying" || expansion === "all";
    const includeInverseEdges = expansion === "inverse" || expansion === "all";
    // Use explicit `from` if provided, otherwise chain from currentAlias
    const fromAlias = options?.from ?? this.#state.currentAlias;

    // Expand edge kinds if including implying edges
    const edgeKinds = this.#expandTraversalEdgeKinds(
      edgeKind,
      includeImplyingEdges,
    );
    const inverseEdgeKinds =
      includeInverseEdges ?
        this.#expandInverseTraversalEdgeKinds(edgeKinds, includeImplyingEdges)
      : [];

    return new TraversalBuilder<
      G,
      Aliases,
      EdgeAliases,
      EK,
      EA,
      TraversalDirection,
      false,
      false,
      false,
      RecursiveAliases,
      CoordinateState
    >(
      this.#config,
      this.#state,
      edgeKinds,
      edgeAlias,
      direction,
      fromAlias,
      inverseEdgeKinds,
      false,
      undefined, // variableLength — default
      undefined, // pendingEdgePredicates — default
      options?.includeIdentityMembers ?? false,
    );
  }

  /**
   * Navigates to every composition PART transitively under the source
   * alias's kind — the declared-structure alternative to spelling
   * `.traverse(edgeKind, ...).recursive(...)` by hand over the realizing
   * edge kinds, and the one way to cross a composition relation realized by
   * more than one edge kind in a single step (a Podcast whose Episodes are
   * `episodeOf` and whose Segments are `segmentOf` still reads as one
   * `.parts(...)` call).
   *
   * Direction is derived per realizing edge kind from
   * `registry.compositionPartSide`, not fixed: a `part -> whole` edge
   * (`partSide: "from"`) is followed reversed (`"in"`) to reach parts, and a
   * `whole -> part` edge (`partSide: "to"`, the `has_*` convention) is
   * followed in its own direction (`"out"`). A relation realized by both
   * orientations compiles to one traversal step that unions them — the same
   * `inverseEdgeKinds` mechanism `{ expand: "inverse" }` already compiles to
   * a `UNION ALL` of both directions at every recursion round — so a mixed
   * relation costs nothing extra to declare and the uniform case (the common
   * one) pays nothing extra to compile.
   *
   * Recurses by default — the difference from `traverse`, which reaches only
   * the direct level — to the full transitive parts closure; pass `maxHops:
   * 1` for direct parts only. The result alias is untyped (`DynamicNodeType`,
   * reached through `.field(name)`) because the parts closure is registry
   * data that may span more than one node kind with different schemas, not a
   * single kind the graph's static type can name.
   *
   * Deviation from the design ruling (composition-contract-design.md Q1,
   * plan-E-d §5.1): the ruling calls for the alias to be typed when the
   * closure resolves to a single kind. This implementation always returns
   * `DynamicNodeType` — the conservative side, matching `wholes()` and never
   * misrepresenting a multi-kind closure — because typing the single-kind
   * case requires a conditional return type keyed on a set computed inside
   * this method's body (`targetKinds.size === 1`), which the generic
   * signature above cannot see before the call resolves. Recorded here
   * rather than implemented silently; a future pass can add the
   * single-kind-typed overload without changing this one's behavior.
   *
   * Refuses rather than silently returning zero rows: an alias whose kind
   * declares no composition parts throws `ConfigurationError` with code
   * `COMPOSITION_NO_PARTS_DECLARED`; an `{ from }` naming an alias this
   * query does not have throws `COMPOSITION_UNKNOWN_ALIAS` instead — not the
   * former, which would misdiagnose a typo'd alias as a composition
   * problem.
   */
  parts<
    NA extends string,
    const O extends CompositionNavigationOptions<Aliases> = Record<
      string,
      never
    >,
  >(
    nodeAlias: UniqueAlias<NA, Aliases>,
    options?: O,
  ): CompositionNavigationResult<
    G,
    Aliases,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState,
    NA,
    O
  > {
    return this.#navigateComposition(
      "parts",
      nodeAlias,
      options,
    ) as unknown as CompositionNavigationResult<
      G,
      Aliases,
      EdgeAliases,
      RecursiveAliases,
      CoordinateState,
      NA,
      O
    >;
  }

  /**
   * Navigates to every composition WHOLE transitively over the source
   * alias's kind — the mirror of {@link QueryBuilder.parts}. Direction is
   * derived the same way, flipped: a `part -> whole` edge is followed in its
   * own direction (`"out"`) and a `whole -> part` (`has_*`) edge is followed
   * reversed (`"in"`). See {@link QueryBuilder.parts} for the recursion,
   * typing, and refusal rules, which are otherwise identical.
   *
   * Refuses with `ConfigurationError` (`COMPOSITION_NO_WHOLES_DECLARED`) on
   * an alias whose kind declares no composition wholes.
   */
  wholes<
    NA extends string,
    const O extends CompositionNavigationOptions<Aliases> = Record<
      string,
      never
    >,
  >(
    nodeAlias: UniqueAlias<NA, Aliases>,
    options?: O,
  ): CompositionNavigationResult<
    G,
    Aliases,
    EdgeAliases,
    RecursiveAliases,
    CoordinateState,
    NA,
    O
  > {
    return this.#navigateComposition(
      "wholes",
      nodeAlias,
      options,
    ) as unknown as CompositionNavigationResult<
      G,
      Aliases,
      EdgeAliases,
      RecursiveAliases,
      CoordinateState,
      NA,
      O
    >;
  }

  /**
   * Shared body for `parts()`/`wholes()`. `relation` selects which registry
   * readers and which orientation-to-direction mapping apply; everything
   * else — refusal, edge-kind partition, the union construction, recursion —
   * is one code path so the two steps cannot drift.
   */
  #navigateComposition(
    relation: "parts" | "wholes",
    nodeAlias: string,
    options: CompositionNavigationOptions<Aliases> | undefined,
  ): QueryBuilder<G, AliasMap, EdgeAliasMap, RecursiveAliasMap, "open"> {
    validateSqlIdentifier(nodeAlias);
    const registry = this.#config.registry;
    const fromAlias = options?.from ?? this.#state.currentAlias;
    const sourceKinds = this.#getKindNamesForAlias(fromAlias);
    if (sourceKinds === undefined) {
      const knownAliases = [
        this.#state.startAlias,
        ...this.#state.traversals.map((traversal) => traversal.nodeAlias),
      ];
      throw new ConfigurationError(
        `.${relation}("${nodeAlias}", { from: "${fromAlias}" }) was called, but this query has no alias "${fromAlias}". ` +
          `Known aliases: ${knownAliases.map((known) => `"${known}"`).join(", ")}.`,
        {
          code: "COMPOSITION_UNKNOWN_ALIAS",
          relation,
          alias: fromAlias,
          knownAliases,
        },
        {
          suggestion: `Pass the alias of a node already in this query as { from: ... }, e.g. one of ${knownAliases.map((known) => `"${known}"`).join(", ")}.`,
        },
      );
    }

    const edgeKindsUnder = (kind: string): readonly string[] =>
      relation === "parts" ?
        registry.compositionEdgeKindsUnder(kind)
      : registry.compositionEdgeKindsOver(kind);
    const targetKindsUnder = (kind: string): readonly string[] =>
      relation === "parts" ?
        registry.compositionPartKindsUnder(kind)
      : registry.compositionWholeKindsOver(kind);

    const edgeKinds = new Set<string>();
    for (const kind of sourceKinds) {
      for (const edgeKind of edgeKindsUnder(kind)) edgeKinds.add(edgeKind);
    }
    if (edgeKinds.size === 0) {
      const kindsLabel =
        sourceKinds.length > 0 ?
          sourceKinds.map((kind) => `"${kind}"`).join(", ")
        : "(unknown)";
      throw new ConfigurationError(
        `.${relation}("${nodeAlias}") was called on alias "${fromAlias}" (kind${sourceKinds.length === 1 ? "" : "s"} ${kindsLabel}), which declares no composition ${relation}.`,
        {
          code:
            relation === "parts" ?
              "COMPOSITION_NO_PARTS_DECLARED"
            : "COMPOSITION_NO_WHOLES_DECLARED",
          alias: fromAlias,
          kinds: sourceKinds,
        },
        {
          suggestion:
            relation === "parts" ?
              `Declare a partOf/hasPart relation naming ${kindsLabel} as the whole, or call .traverse(...) directly for a non-composition relationship.`
            : `Declare a partOf/hasPart relation naming ${kindsLabel} as the part, or call .traverse(...) directly for a non-composition relationship.`,
        },
      );
    }

    // The registry's `*KindsUnder`/`*KindsOver` readers return only the
    // literal kinds a `partOf`/`hasPart` declaration named (Ed-a-r2-1's
    // subclass-assignable rule applies to which PAIR matches, not to which
    // concrete kinds the pair's declared endpoint admits at read time).
    // Edge-endpoint validation accepts any subclass of a declared endpoint
    // (`isAssignableToAny`), so a live row's actual kind can be an
    // undeclared subclass of a declared target kind — expand through the
    // same subclass closure `to(kind, alias, { expansion: "subclasses" })`
    // applies, or a real row is silently dropped from the result instead of
    // refused or returned (Ed-02).
    const targetKinds = new Set<string>();
    for (const kind of sourceKinds) {
      for (const targetKind of targetKindsUnder(kind)) {
        for (const concreteKind of registry.expandSubClasses(targetKind)) {
          targetKinds.add(concreteKind);
        }
      }
    }

    // §1.7 orientation table, derived through the one shared partition
    // (`partitionCompositionEdgeKindsByDirection`) `subgraph({ composition:
    // true })` also uses, so the two navigators cannot drift on which way
    // an edge is walked (Ed-01) or on what happens when an edge kind has no
    // recorded part side (Ed-r2-3): a `part -> whole` edge ("from") reaches
    // its parts reversed ("in") and its wholes forward ("out"); a
    // `whole -> part` edge ("to") is the mirror.
    const { outEdgeKinds, inEdgeKinds } =
      partitionCompositionEdgeKindsByDirection(registry, edgeKinds, relation);

    // Uniform orientation (either set empty) needs no `inverseEdgeKinds` —
    // the direct-only compiled branch — and pays nothing beyond a plain
    // traversal; mixed orientation folds the other set in as the existing
    // union machinery's inverse branch.
    const [direction, directEdgeKinds, inverseEdgeKinds]: readonly [
      TraversalDirection,
      readonly string[],
      readonly string[],
    ] =
      outEdgeKinds.length > 0 ?
        ["out", outEdgeKinds, inEdgeKinds]
      : ["in", inEdgeKinds, []];

    const edgeAlias = `${nodeAlias}_edge`;
    validateSqlIdentifier(edgeAlias);

    // The derived edge alias is not caller-chosen the way `.traverse()`'s
    // is, so a collision is invisible to the caller until it silently
    // merges two different edge types under one alias (Ed-11) — refuse
    // rather than let `whereEdge(edgeAlias, ...)` later target an
    // ambiguous traversal.
    if (this.#getEdgeKindNamesForAlias(edgeAlias) !== undefined) {
      throw new ConfigurationError(
        `.${relation}("${nodeAlias}") would derive the edge alias "${edgeAlias}", which this query already uses for another traversal. Choose a different alias for .${relation}("${nodeAlias}") or for the conflicting traversal.`,
        { alias: edgeAlias, relation, nodeAlias },
      );
    }

    const newState: QueryBuilderState = {
      ...this.#state,
      dynamicEdgeAliases: new Set([
        ...this.#state.dynamicEdgeAliases,
        edgeAlias,
      ]),
    };

    const traversalBuilder = new TraversalBuilder<
      G,
      AliasMap,
      EdgeAliasMap,
      string,
      string,
      TraversalDirection,
      false,
      false,
      false,
      RecursiveAliasMap,
      "open",
      DynamicEdgeType
    >(
      this.#config,
      newState,
      directEdgeKinds,
      edgeAlias,
      direction,
      fromAlias,
      inverseEdgeKinds,
      false,
      undefined, // variableLength — default
      undefined, // pendingEdgePredicates — default
      false,
    );

    const targetKindList = [...targetKinds].toSorted((left, right) =>
      left < right ? -1
      : left > right ? 1
      : 0,
    );

    // Recurse by default (the value proposition versus `traverse`): skip only
    // when the caller both asked for exactly one hop and requested neither a
    // depth nor a path column, so no accepted option is ever silently
    // dropped by the optimization.
    const wantsRecursiveOutput =
      options?.depth !== undefined || options?.path !== undefined;
    const willRecurse = !(options?.maxHops === 1 && !wantsRecursiveOutput);

    // A recursing `parts()`/`wholes()` compiles to a variable-length
    // traversal, and the compiler supports only one of those per query
    // (`runRecursiveTraversalSelectionPass`). Refuse here, naming the step
    // and the `maxHops: 1` escape hatch, rather than letting the query build
    // successfully and fail deep in the compiler with a message that names
    // neither (Ed-05).
    if (willRecurse && this.#state.traversals.length > 0) {
      throw new UnsupportedPredicateError(
        `.${relation}("${nodeAlias}") recurses by default and compiles to a variable-length traversal, but this query already has ${this.#state.traversals.length} traversal(s) before it. A query may contain only one recursive traversal.`,
        {
          relation,
          alias: nodeAlias,
          existingTraversalCount: this.#state.traversals.length,
        },
        {
          suggestion: `Pass { maxHops: 1 } to .${relation}("${nodeAlias}", ...) to compile it as a direct (non-recursive) traversal, or split this into separate queries.`,
        },
      );
    }

    return (options?.maxHops === 1 && !wantsRecursiveOutput ?
      traversalBuilder.toKindSet(targetKindList, nodeAlias)
    : traversalBuilder
        .recursive({
          ...(options?.maxHops === undefined ?
            {}
          : { maxHops: options.maxHops }),
          ...(options?.depth === undefined ? {} : { depth: options.depth }),
          ...(options?.path === undefined ? {} : { path: options.path }),
        })
        .toKindSet(targetKindList, nodeAlias)) as unknown as QueryBuilder<
      G,
      AliasMap,
      EdgeAliasMap,
      RecursiveAliasMap,
      "open"
    >;
  }

  /**
   * Runtime-kind sibling of `traverse`; accepts a kind name or Store-issued
   * token. Throws `KindNotFoundError` if the edge kind is not registered.
   */
  traverseDynamic<T extends string | RuntimeEdgeKind, EA extends string>(
    edgeKind: T,
    edgeAlias: EA,
    options?: {
      direction?: TraversalDirection;
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases & Record<EA, EdgeAlias<DynamicEdgeTypeFor<T>>>,
    string,
    EA,
    TraversalDirection,
    false,
    false,
    false,
    RecursiveAliases,
    CoordinateState,
    DynamicEdgeTypeFor<T>
  > {
    return this.#beginDynamicTraversal(edgeKind, edgeAlias, false, options);
  }

  /**
   * Optionally traverses an edge to another node (LEFT JOIN semantics).
   * If no matching edge/node exists, the result will include null values.
   *
   * By default, traverses from the current node (last traversal target, or start node).
   * Use the `from` option to traverse from a different alias (fan-out pattern).
   *
   * @param options.direction - Direction of traversal: "out" (default) or "in"
   * @param options.expand - Ontology expansion mode for implying/inverse edges
   * @param options.from - Alias to traverse from (defaults to current/last traversal target)
   */
  optionalTraverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options?: {
      direction?: "out";
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    "out",
    true,
    false,
    false,
    RecursiveAliases,
    CoordinateState
  >;

  optionalTraverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options: {
      direction: "in";
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    "in",
    true,
    false,
    false,
    RecursiveAliases,
    CoordinateState
  >;

  optionalTraverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options?: {
      direction?: TraversalDirection;
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    TraversalDirection,
    true,
    false,
    false,
    RecursiveAliases,
    CoordinateState
  > {
    // Validate edge alias to prevent SQL injection
    validateSqlIdentifier(edgeAlias);

    const direction = options?.direction ?? "out";
    this.#assertIdentityTraversalAllowed(options);
    const expansion = options?.expand ?? this.#config.defaultTraversalExpansion;
    const includeImplyingEdges =
      expansion === "implying" || expansion === "all";
    const includeInverseEdges = expansion === "inverse" || expansion === "all";
    // Use explicit `from` if provided, otherwise chain from currentAlias
    const fromAlias = options?.from ?? this.#state.currentAlias;

    // Expand edge kinds if including implying edges
    const edgeKinds = this.#expandTraversalEdgeKinds(
      edgeKind,
      includeImplyingEdges,
    );
    const inverseEdgeKinds =
      includeInverseEdges ?
        this.#expandInverseTraversalEdgeKinds(edgeKinds, includeImplyingEdges)
      : [];

    return new TraversalBuilder<
      G,
      Aliases,
      EdgeAliases,
      EK,
      EA,
      TraversalDirection,
      true,
      false,
      false,
      RecursiveAliases,
      CoordinateState
    >(
      this.#config,
      this.#state,
      edgeKinds,
      edgeAlias,
      direction,
      fromAlias,
      inverseEdgeKinds,
      true,
      undefined, // variableLength — default
      undefined, // pendingEdgePredicates — default
      options?.includeIdentityMembers ?? false,
    );
  }

  /**
   * Runtime-kind sibling of `optionalTraverse`; accepts a kind name or
   * Store-issued token. LEFT JOIN semantics — non-matching rows produce a null
   * edge alias instead of dropping. Throws `KindNotFoundError` if the edge kind
   * is not registered.
   */
  optionalTraverseDynamic<
    T extends string | RuntimeEdgeKind,
    EA extends string,
  >(
    edgeKind: T,
    edgeAlias: EA,
    options?: {
      direction?: TraversalDirection;
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    } & IdentityTraversalOption<G>,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases & Record<EA, EdgeAlias<DynamicEdgeTypeFor<T>, true>>,
    string,
    EA,
    TraversalDirection,
    true,
    false,
    false,
    RecursiveAliases,
    CoordinateState,
    DynamicEdgeTypeFor<T>
  > {
    return this.#beginDynamicTraversal(edgeKind, edgeAlias, true, options);
  }

  /**
   * Shared body for `traverseDynamic` and `optionalTraverseDynamic`.
   * The only difference is the `optional` flag passed to the
   * `TraversalBuilder` constructor.
   */
  #beginDynamicTraversal<
    T extends string | RuntimeEdgeKind,
    EA extends string,
    Optional extends boolean,
  >(
    edgeKind: T,
    edgeAlias: EA,
    optional: Optional,
    options:
      | ({
          direction?: TraversalDirection;
          expand?: TraversalExpansion;
          from?: keyof Aliases & string;
          includeIdentityMembers?: boolean;
        } & IdentityTraversalOption<G>)
      | undefined,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases & Record<EA, EdgeAlias<DynamicEdgeTypeFor<T>, Optional>>,
    string,
    EA,
    TraversalDirection,
    Optional,
    false,
    false,
    RecursiveAliases,
    CoordinateState,
    DynamicEdgeTypeFor<T>
  > {
    validateSqlIdentifier(edgeAlias);
    const edgeKindName = resolveRuntimeKindInput(
      edgeKind,
      "edge",
      getQueryBuilderInternalContext(this.#config).runtimeKindTokenResolver,
    );
    if (!this.#config.registry.hasEdgeType(edgeKindName)) {
      throw new KindNotFoundError(edgeKindName, "edge", {
        graphId: this.#config.graphId,
      });
    }

    const direction = options?.direction ?? "out";
    this.#assertIdentityTraversalAllowed(options);
    const expansion = options?.expand ?? this.#config.defaultTraversalExpansion;
    const includeImplyingEdges =
      expansion === "implying" || expansion === "all";
    const includeInverseEdges = expansion === "inverse" || expansion === "all";
    const fromAlias = options?.from ?? this.#state.currentAlias;

    const edgeKinds = this.#expandTraversalEdgeKinds(
      edgeKindName,
      includeImplyingEdges,
    );
    const inverseEdgeKinds =
      includeInverseEdges ?
        this.#expandInverseTraversalEdgeKinds(edgeKinds, includeImplyingEdges)
      : [];

    const newState: QueryBuilderState = {
      ...this.#state,
      dynamicEdgeAliases: new Set([
        ...this.#state.dynamicEdgeAliases,
        edgeAlias,
      ]),
    };

    return new TraversalBuilder<
      G,
      Aliases,
      EdgeAliases & Record<EA, EdgeAlias<DynamicEdgeTypeFor<T>, Optional>>,
      string,
      EA,
      TraversalDirection,
      Optional,
      false,
      false,
      RecursiveAliases,
      CoordinateState,
      DynamicEdgeTypeFor<T>
    >(
      this.#config,
      newState,
      edgeKinds,
      edgeAlias,
      direction,
      fromAlias,
      inverseEdgeKinds,
      optional,
      undefined, // variableLength — default
      undefined, // pendingEdgePredicates — default
      options?.includeIdentityMembers ?? false,
    );
  }

  /**
   * Selects fields to return.
   */
  select<R>(
    selectFunction: (
      context: SelectContext<Aliases, EdgeAliases, RecursiveAliases>,
    ) => R,
  ): ExecutableQuery<G, Aliases, EdgeAliases, RecursiveAliases, R> {
    // For now, project all fields from all aliases
    // A more sophisticated implementation would parse the selectFn

    // Start node fields (including metadata)
    const startFields = buildNodeFields(this.#state.startAlias);

    // Traversal node and edge fields (including metadata)
    // Edge fields are in the node's CTE, so we pass the node alias for CTE reference
    const traversalFields = this.#state.traversals.flatMap((traversal) => [
      ...buildEdgeFields(traversal.edgeAlias, traversal.nodeAlias),
      ...buildNodeFields(traversal.nodeAlias),
    ]);

    const projection = [...startFields, ...traversalFields];

    const newState: QueryBuilderState = {
      ...this.#state,
      projection,
    };

    return new ExecutableQuery(this.#config, newState, selectFunction);
  }

  /**
   * Selects fields including aggregates.
   * Use with groupBy() for aggregate queries.
   *
   * @param fields - Object mapping output names to field refs or aggregate expressions
   */
  aggregate<R extends Record<string, FieldRef | AggregateExpr>>(
    fields: R,
  ): ExecutableAggregateQuery<G, Aliases, R> {
    const resolvedFields = Object.fromEntries(
      Object.entries(fields).map(([outputName, source]) => {
        if (source.__type !== "field_ref") {
          return [outputName, source];
        }

        if (
          source.valueType !== undefined ||
          source.path.length !== 1 ||
          source.path[0] !== "props" ||
          source.jsonPointer === undefined
        ) {
          return [outputName, source];
        }

        const segments = parseJsonPointer(source.jsonPointer);
        if (segments.length !== 1) {
          return [outputName, source];
        }

        const propertyName = segments[0];
        if (propertyName === undefined) {
          return [outputName, source];
        }

        const kindNames = this.#getKindNamesForAlias(source.alias);
        const typeInfo =
          kindNames ?
            this.#config.schemaIntrospector.getSharedFieldTypeInfo(
              kindNames,
              propertyName,
            )
          : undefined;

        if (!typeInfo) {
          return [outputName, source];
        }

        return [
          outputName,
          {
            ...source,
            valueType: typeInfo.valueType,
            elementType: typeInfo.elementType,
          } satisfies FieldRef,
        ];
      }),
    ) as R;

    const projection: ProjectedField[] = Object.entries(resolvedFields).map(
      ([outputName, source]) => ({
        outputName,
        source,
      }),
    );

    const newState: QueryBuilderState = {
      ...this.#state,
      projection,
    };

    return new ExecutableAggregateQuery(this.#config, newState, resolvedFields);
  }

  /**
   * Orders results.
   */
  orderBy<A extends (keyof Aliases | keyof EdgeAliases) & string>(
    alias: A,
    field: string,
    direction: SortDirection = "asc",
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    const edgeKindNames = this.#getEdgeKindNamesForAlias(alias);
    const isEdge = edgeKindNames !== undefined;
    const nodeKindNames =
      isEdge ? undefined : this.#getKindNamesForAlias(alias);
    const hasDeclaredProperty =
      isEdge ?
        this.#config.schemaIntrospector.hasDeclaredEdgeField(
          edgeKindNames,
          field,
        )
      : nodeKindNames !== undefined &&
        this.#config.schemaIntrospector.hasDeclaredField(nodeKindNames, field);
    const systemField = resolveSystemOrderField(
      alias,
      field,
      isEdge,
      hasDeclaredProperty,
    );
    let typeInfo: FieldTypeInfo | undefined;
    if (systemField === undefined) {
      typeInfo =
        isEdge ?
          this.#config.schemaIntrospector.getSharedEdgeFieldTypeInfo(
            edgeKindNames,
            field,
          )
        : nodeKindNames === undefined ? undefined
        : this.#config.schemaIntrospector.getSharedFieldTypeInfo(
            nodeKindNames,
            field,
          );
    }
    const orderSpec = buildOrderSpec(
      alias,
      field,
      direction,
      systemField,
      typeInfo,
    );

    const newState: QueryBuilderState = {
      ...this.#state,
      orderBy: [...this.#state.orderBy, orderSpec],
    };

    return new QueryBuilder(this.#config, newState);
  }

  /**
   * Limits the number of results.
   */
  limit(
    n: number,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    return new QueryBuilder(this.#config, {
      ...this.#state,
      limit: n,
    });
  }

  /**
   * Offsets the results.
   */
  offset(
    n: number,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    return new QueryBuilder(this.#config, {
      ...this.#state,
      offset: n,
    });
  }

  /**
   * Groups results by the specified field.
   * Use with aggregate functions like COUNT, SUM, AVG in select().
   *
   * @param alias - The node alias to group by
   * @param field - The field name to group by
   */
  groupBy<A extends keyof Aliases & string>(
    alias: A,
    field: string,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    const kindNames = this.#getKindNamesForAlias(alias);
    const typeInfo =
      kindNames ?
        this.#config.schemaIntrospector.getSharedFieldTypeInfo(kindNames, field)
      : undefined;

    const fieldRefValue: FieldRef = {
      __type: "field_ref",
      alias,
      path: ["props"],
      jsonPointer: jsonPointer([field]),
      valueType: typeInfo?.valueType,
      elementType: typeInfo?.elementType,
    };

    const existingFields = this.#state.groupBy?.fields ?? [];
    const newGroupBy: GroupBySpec = {
      fields: [...existingFields, fieldRefValue],
    };

    return new QueryBuilder(this.#config, {
      ...this.#state,
      groupBy: newGroupBy,
    });
  }

  /**
   * Groups results by the node ID.
   * Use when you want to group by a complete node rather than a specific field.
   *
   * @param alias - The node alias to group by (uses the node's ID)
   */
  groupByNode<A extends keyof Aliases & string>(
    alias: A,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    const fieldRefValue: FieldRef = {
      __type: "field_ref",
      alias,
      path: ["id"],
      valueType: "string",
    };

    const existingFields = this.#state.groupBy?.fields ?? [];
    const newGroupBy: GroupBySpec = {
      fields: [...existingFields, fieldRefValue],
    };

    return new QueryBuilder(this.#config, {
      ...this.#state,
      groupBy: newGroupBy,
    });
  }

  /**
   * Filters grouped results using aggregate conditions (HAVING clause).
   * Use after groupBy() to filter based on aggregate values.
   *
   * @param predicate - A predicate expression to filter groups
   */
  having(
    predicate: PredicateExpression,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    return new QueryBuilder(this.#config, {
      ...this.#state,
      having: predicate,
    });
  }

  /**
   * Sets fusion parameters for hybrid (vector + fulltext) queries.
   *
   * Applies only when the query contains both a `.similarTo()` and a
   * `.$fulltext.matches()` predicate. Without this call, the default is
   * RRF with k=60 and equal weights. A mismatch between `.fuseWith()`
   * configuration and the predicates on the query is caught during
   * compilation, not here.
   *
   * @example
   * ```typescript
   * store.query()
   *   .from("Document", "d")
   *   .whereNode("d", d =>
   *     d.$fulltext.matches("renewable energy", 50)
   *       .and(d.embedding.similarTo(vec, 50))
   *       .and(d.tenantId.eq(tenant))
   *   )
   *   .fuseWith({ k: 60, weights: { fulltext: 1.5 } })
   *   .limit(10)
   *   .execute();
   * ```
   */
  fuseWith(
    options: HybridFusionOptions,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases, CoordinateState> {
    validateHybridFusionOptions(options);
    return new QueryBuilder(this.#config, {
      ...this.#state,
      fusion: options,
    });
  }

  /**
   * Applies a query fragment to transform this builder.
   *
   * Fragments are reusable query transformations that can add predicates,
   * traversals, ordering, and other query operations. Use this for
   * composing complex queries from simpler, reusable parts.
   *
   * @example
   * ```typescript
   * // Define a reusable fragment
   * const activeUsers = createFragment<MyGraph>()((q) =>
   *   q.whereNode("u", ({ status }) => status.eq("active"))
   * );
   *
   * // Apply the fragment
   * const results = await query()
   *   .from("User", "u")
   *   .pipe(activeUsers)
   *   .select((ctx) => ctx.u)
   *   .execute();
   * ```
   *
   * @param fragment - A function that transforms the builder
   * @returns The transformed builder
   */
  pipe<
    OutAliases extends AliasMap,
    OutEdgeAliases extends EdgeAliasMap = EdgeAliases,
    OutRecAliases extends RecursiveAliasMap = RecursiveAliases,
  >(
    fragment: (
      builder: QueryBuilder<
        G,
        Aliases,
        EdgeAliases,
        RecursiveAliases,
        CoordinateState
      >,
    ) => QueryBuilder<
      G,
      OutAliases,
      OutEdgeAliases,
      OutRecAliases,
      CoordinateState
    >,
  ): QueryBuilder<
    G,
    OutAliases,
    OutEdgeAliases,
    OutRecAliases,
    CoordinateState
  > {
    return fragment(this);
  }

  /**
   * Gets all kind names for an alias.
   */
  #getKindNamesForAlias(alias: string): readonly string[] | undefined {
    if (alias === this.#state.startAlias) {
      return this.#state.startKinds;
    }
    for (const traversal of this.#state.traversals) {
      if (traversal.nodeAlias === alias) {
        return traversal.nodeKinds;
      }
    }
    return undefined;
  }

  /**
   * Determines the appropriate field builder based on Zod schema type.
   */
  #getFieldBuilderForProperty(
    kindNames: readonly string[] | undefined,
    property: string,
    alias: string,
  ): BaseFieldAccessor {
    const typeInfo =
      kindNames ?
        this.#config.schemaIntrospector.getSharedFieldTypeInfo(
          kindNames,
          property,
        )
      : undefined;

    const ref = fieldRef(alias, ["props"], {
      jsonPointer: jsonPointer([property]),
      valueType: typeInfo?.valueType,
      elementType: typeInfo?.elementType,
    });

    return this.#buildFieldBuilderForTypeInfo(ref, typeInfo);
  }

  #buildFieldBuilderForTypeInfo(
    ref: ReturnType<typeof fieldRef>,
    typeInfo: FieldTypeInfo | undefined,
  ): BaseFieldAccessor {
    return buildFieldBuilderForTypeInfo(ref, typeInfo);
  }

  #createNodeAccessor(alias: string): NodeAccessor<NodeType> {
    const kindNames = this.#getKindNamesForAlias(alias);
    const idAccessor = stringField(
      fieldRef(alias, ["id"], { valueType: "string" }),
    );
    const kindAccessor = stringField(
      fieldRef(alias, ["kind"], { valueType: "string" }),
    );
    const fulltextAccessor = createFulltextAccessor(alias, () =>
      this.#hasSearchableField(kindNames),
    );

    if (this.#state.dynamicNodeAliases.has(alias)) {
      return {
        id: idAccessor,
        kind: kindAccessor,
        $fulltext: fulltextAccessor,
        field: (name: string) =>
          createDynamicFieldBuilder(
            this.#config.schemaIntrospector,
            alias,
            name,
            kindNames,
            "node",
          ),
      } as unknown as NodeAccessor<NodeType>;
    }

    // Use a Proxy to provide flattened property access
    return new Proxy({} as NodeAccessor<NodeType>, {
      get: (_, property: string | symbol) => {
        // Handle symbols and special properties to avoid infinite loops
        if (typeof property === "symbol") return;

        // System fields
        if (property === "id") return idAccessor;
        if (property === "kind") return kindAccessor;
        if (property === "$fulltext") return fulltextAccessor;

        // A DECLARED field wins over the interop exemption: `toJSON` and `then`
        // are legal schema field names, and the accessor type offers them, so
        // resolving them to `undefined` here made a declared field
        // unaddressable in a predicate. Only an UNDECLARED probe resolves to
        // `undefined`, keeping the accessor safe to await or stringify.
        if (
          isInteropProbeKey(property) &&
          !(
            kindNames !== undefined &&
            this.#config.schemaIntrospector.hasDeclaredField(
              kindNames,
              property,
            )
          )
        ) {
          return;
        }

        // Schema properties
        return this.#getFieldBuilderForProperty(kindNames, property, alias);
      },
    });
  }

  #hasSearchableField(kindNames: readonly string[] | undefined): boolean {
    if (!kindNames) return false;
    return this.#config.schemaIntrospector.hasSearchableField(kindNames);
  }

  /**
   * Guards `includeIdentityMembers` against a non-identity-enabled builder.
   */
  #assertIdentityTraversalAllowed(
    options: Readonly<{ includeIdentityMembers?: boolean }> | undefined,
  ): void {
    if (!options?.includeIdentityMembers || this.#config.identityEnabled) {
      return;
    }
    throw new ConfigurationError(
      "includeIdentityMembers requires an identity-enabled graph registry.",
      { code: "IDENTITY_NOT_ENABLED", graphId: this.#config.graphId },
      {
        suggestion:
          "Enable defineGraph(...).identity and build the registry from that graph.",
      },
    );
  }

  #expandTraversalEdgeKinds(
    edgeKind: string,
    includeImplyingEdges: boolean,
  ): readonly string[] {
    return includeImplyingEdges ?
        this.#config.registry.expandImplyingEdges(edgeKind)
      : [edgeKind];
  }

  #expandInverseTraversalEdgeKinds(
    edgeKinds: readonly string[],
    includeImplyingEdges: boolean,
  ): readonly string[] {
    const inverseKinds = new Set<string>();

    for (const kind of edgeKinds) {
      const inverseKind = this.#config.registry.getInverseEdge(kind);
      if (inverseKind === undefined) {
        continue;
      }

      inverseKinds.add(inverseKind);

      if (!includeImplyingEdges) {
        continue;
      }

      for (const implyingKind of this.#config.registry.expandImplyingEdges(
        inverseKind,
      )) {
        inverseKinds.add(implyingKind);
      }
    }

    return [...inverseKinds];
  }

  /**
   * Gets edge kind names for an edge alias.
   */
  #getEdgeKindNamesForAlias(alias: string): readonly string[] | undefined {
    for (const traversal of this.#state.traversals) {
      if (traversal.edgeAlias === alias) {
        return mergeEdgeKinds(traversal);
      }
    }
    return undefined;
  }

  /**
   * Determines the appropriate field builder for an edge property based on Zod schema type.
   */
  #getFieldBuilderForEdgeProperty(
    edgeKindNames: readonly string[] | undefined,
    property: string,
    alias: string,
  ): BaseFieldAccessor {
    const typeInfo =
      edgeKindNames ?
        this.#config.schemaIntrospector.getSharedEdgeFieldTypeInfo(
          edgeKindNames,
          property,
        )
      : undefined;

    const ref = fieldRef(alias, ["props"], {
      jsonPointer: jsonPointer([property]),
      valueType: typeInfo?.valueType,
      elementType: typeInfo?.elementType,
    });

    return this.#buildFieldBuilderForTypeInfo(ref, typeInfo);
  }

  #createEdgeAccessor(alias: string): EdgeAccessor<EdgeType> {
    const edgeKindNames = this.#getEdgeKindNamesForAlias(alias);
    const idAccessor = stringField(
      fieldRef(alias, ["id"], { valueType: "string" }),
    );
    const kindAccessor = stringField(
      fieldRef(alias, ["kind"], { valueType: "string" }),
    );
    const fromIdAccessor = stringField(
      fieldRef(alias, ["from_id"], { valueType: "string" }),
    );
    const toIdAccessor = stringField(
      fieldRef(alias, ["to_id"], { valueType: "string" }),
    );

    if (this.#state.dynamicEdgeAliases.has(alias)) {
      return {
        id: idAccessor,
        kind: kindAccessor,
        fromId: fromIdAccessor,
        toId: toIdAccessor,
        field: (name: string) =>
          createDynamicFieldBuilder(
            this.#config.schemaIntrospector,
            alias,
            name,
            edgeKindNames,
            "edge",
          ),
      } as unknown as EdgeAccessor<EdgeType>;
    }

    // Use a Proxy to provide flattened property access
    return new Proxy({} as EdgeAccessor<EdgeType>, {
      get: (_, property: string | symbol) => {
        // Handle symbols and special properties to avoid infinite loops
        if (typeof property === "symbol") return;

        // System fields
        if (property === "id") return idAccessor;
        if (property === "kind") return kindAccessor;
        if (property === "fromId") return fromIdAccessor;
        if (property === "toId") return toIdAccessor;

        // A DECLARED field wins over the interop exemption — see
        // #createNodeAccessor.
        if (
          isInteropProbeKey(property) &&
          !(
            edgeKindNames !== undefined &&
            this.#config.schemaIntrospector.hasDeclaredEdgeField(
              edgeKindNames,
              property,
            )
          )
        ) {
          return;
        }

        // Schema properties
        return this.#getFieldBuilderForEdgeProperty(
          edgeKindNames,
          property,
          alias,
        );
      },
    });
  }
}
