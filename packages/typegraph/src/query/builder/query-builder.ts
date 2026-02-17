/**
 * QueryBuilder - The fluent query builder.
 */
import { type GraphDef } from "../../core/define-graph";
import {
  type EdgeType,
  type NodeType,
  type TemporalMode,
} from "../../core/types";
import { ValidationError } from "../../errors";
import {
  type AggregateExpr,
  type FieldRef,
  type GroupBySpec,
  mergeEdgeKinds,
  type OrderSpec,
  type PredicateExpression,
  type ProjectedField,
  type SortDirection,
  type TraversalDirection,
  type TraversalExpansion,
} from "../ast";
import { jsonPointer, parseJsonPointer } from "../json-pointer";
import {
  arrayField,
  baseField,
  dateField,
  embeddingField,
  fieldRef,
  numberField,
  objectField,
  type Predicate,
  stringField,
} from "../predicates";
import { type FieldTypeInfo } from "../schema-introspector";
import { ExecutableAggregateQuery } from "./executable-aggregate-query";
import { ExecutableQuery } from "./executable-query";
import { TraversalBuilder } from "./traversal-builder";
import {
  type AliasMap,
  type BaseFieldAccessor,
  type EdgeAccessor,
  type EdgeAliasMap,
  type NodeAccessor,
  type NodeAlias,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type RecursiveAliasMap,
  type SelectContext,
  type UniqueAlias,
} from "./types";
import { validateSqlIdentifier } from "./validation";

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
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty object for initial empty alias map
  Aliases extends AliasMap = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty object for initial empty edge alias map
  EdgeAliases extends EdgeAliasMap = {},
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty when no recursive aliases
  RecursiveAliases extends RecursiveAliasMap = {},
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;

  constructor(config: QueryBuilderConfig, state: QueryBuilderState) {
    this.#config = config;
    this.#state = state;
  }

  /**
   * Starts a query from a node kind.
   *
   * @param kind - The node kind to start from
   * @param alias - A unique alias for this node (compile-time error if duplicate)
   */
  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options?: { includeSubClasses?: false },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<G["nodes"][K]["type"]>>,
    EdgeAliases,
    RecursiveAliases
  >;

  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options: { includeSubClasses: true },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias>,
    EdgeAliases,
    RecursiveAliases
  >;

  from<K extends keyof G["nodes"] & string, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options?: { includeSubClasses?: boolean },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias>,
    EdgeAliases,
    RecursiveAliases
  > {
    // Validate alias to prevent SQL injection
    validateSqlIdentifier(alias);

    const includeSubClasses = options?.includeSubClasses ?? false;

    // Expand kinds if including subclasses
    const kinds =
      includeSubClasses ? this.#config.registry.expandSubClasses(kind) : [kind];

    const newState: QueryBuilderState = {
      ...this.#state,
      startAlias: alias,
      currentAlias: alias,
      startKinds: kinds,
      includeSubClasses,
    };

    return new QueryBuilder(this.#config, newState);
  }

  /**
   * Adds a WHERE clause for a node.
   */
  whereNode<A extends keyof Aliases & string>(
    alias: A,
    predicateFunction: (n: NodeAccessor<Aliases[A]["type"]>) => Predicate,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
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
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
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
    },
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
    RecursiveAliases
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
    },
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
    RecursiveAliases
  >;

  traverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options?: {
      direction?: TraversalDirection;
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    },
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
    RecursiveAliases
  > {
    // Validate edge alias to prevent SQL injection
    validateSqlIdentifier(edgeAlias);

    const direction = options?.direction ?? "out";
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

    return new TraversalBuilder(
      this.#config,
      this.#state,
      edgeKinds,
      edgeAlias,
      direction,
      fromAlias,
      inverseEdgeKinds,
      false,
    );
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
    },
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
    RecursiveAliases
  >;

  optionalTraverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options: {
      direction: "in";
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    },
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
    RecursiveAliases
  >;

  optionalTraverse<EK extends keyof G["edges"] & string, EA extends string>(
    edgeKind: EK,
    edgeAlias: EA,
    options?: {
      direction?: TraversalDirection;
      expand?: TraversalExpansion;
      from?: keyof Aliases & string;
    },
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
    RecursiveAliases
  > {
    // Validate edge alias to prevent SQL injection
    validateSqlIdentifier(edgeAlias);

    const direction = options?.direction ?? "out";
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

    return new TraversalBuilder(
      this.#config,
      this.#state,
      edgeKinds,
      edgeAlias,
      direction,
      fromAlias,
      inverseEdgeKinds,
      true,
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
  orderBy<A extends keyof Aliases & string>(
    alias: A,
    field: string,
    direction: SortDirection = "asc",
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
    const kindNames = this.#getKindNamesForAlias(alias);
    const typeInfo =
      kindNames ?
        this.#config.schemaIntrospector.getSharedFieldTypeInfo(kindNames, field)
      : undefined;

    const orderSpec: OrderSpec = {
      field: fieldRef(alias, ["props"], {
        jsonPointer: jsonPointer([field]),
        valueType: typeInfo?.valueType,
        elementType: typeInfo?.elementType,
      }),
      direction,
    };

    const newState: QueryBuilderState = {
      ...this.#state,
      orderBy: [...this.#state.orderBy, orderSpec],
    };

    return new QueryBuilder(this.#config, newState);
  }

  /**
   * Limits the number of results.
   */
  limit(n: number): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
    return new QueryBuilder(this.#config, {
      ...this.#state,
      limit: n,
    });
  }

  /**
   * Offsets the results.
   */
  offset(n: number): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
    return new QueryBuilder(this.#config, {
      ...this.#state,
      offset: n,
    });
  }

  /**
   * Sets temporal mode.
   *
   * @param mode - The temporal mode to use
   * @param asOf - Required timestamp for "asOf" mode (ISO 8601 string)
   * @throws ValidationError if mode is "asOf" but no timestamp is provided
   */
  temporal(
    mode: TemporalMode,
    asOf?: string,
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
    if (mode === "asOf" && asOf === undefined) {
      throw new ValidationError(
        'Temporal mode "asOf" requires a timestamp',
        {
          issues: [
            { path: "asOf", message: "Timestamp is required for asOf mode" },
          ],
        },
        {
          suggestion: `Use .temporal("asOf", "2024-01-15T10:00:00.000Z") or .temporal("current") for current time.`,
        },
      );
    }
    return new QueryBuilder(this.#config, {
      ...this.#state,
      temporalMode: mode,
      asOf,
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
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
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
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
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
  ): QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases> {
    return new QueryBuilder(this.#config, {
      ...this.#state,
      having: predicate,
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
      builder: QueryBuilder<G, Aliases, EdgeAliases, RecursiveAliases>,
    ) => QueryBuilder<G, OutAliases, OutEdgeAliases, OutRecAliases>,
  ): QueryBuilder<G, OutAliases, OutEdgeAliases, OutRecAliases> {
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
    if (!typeInfo) {
      return baseField(ref);
    }

    switch (typeInfo.valueType) {
      case "string": {
        return stringField(ref);
      }
      case "number": {
        return numberField(ref);
      }
      case "boolean": {
        return baseField(ref);
      }
      case "date": {
        return dateField(ref);
      }
      case "array": {
        return arrayField(ref);
      }
      case "object": {
        return objectField(ref, { typeInfo });
      }
      case "embedding": {
        return embeddingField(ref);
      }
      case "unknown": {
        return baseField(ref);
      }
    }
  }

  #createNodeAccessor(alias: string): NodeAccessor<NodeType> {
    const kindNames = this.#getKindNamesForAlias(alias);
    const idAccessor = stringField(
      fieldRef(alias, ["id"], { valueType: "string" }),
    );
    const kindAccessor = stringField(
      fieldRef(alias, ["kind"], { valueType: "string" }),
    );

    // Use a Proxy to provide flattened property access
    return new Proxy({} as NodeAccessor<NodeType>, {
      get: (_, property: string | symbol) => {
        // Handle symbols and special properties to avoid infinite loops
        if (typeof property === "symbol") return;
        if (property === "then") return;
        if (property === "toJSON") return;

        // System fields
        if (property === "id") return idAccessor;
        if (property === "kind") return kindAccessor;

        // Schema properties
        return this.#getFieldBuilderForProperty(kindNames, property, alias);
      },
    });
  }

  #expandTraversalEdgeKinds(
    edgeKind: keyof G["edges"] & string,
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

    // Use a Proxy to provide flattened property access
    return new Proxy({} as EdgeAccessor<EdgeType>, {
      get: (_, property: string | symbol) => {
        // Handle symbols and special properties to avoid infinite loops
        if (typeof property === "symbol") return;
        if (property === "then") return;
        if (property === "toJSON") return;

        // System fields
        if (property === "id") return idAccessor;
        if (property === "kind") return kindAccessor;
        if (property === "fromId") return fromIdAccessor;
        if (property === "toId") return toIdAccessor;

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
