/**
 * TraversalBuilder - Intermediate builder for edge traversals.
 */
import { type GraphDef } from "../../core/define-graph";
import { type AnyEdgeType, type NodeType } from "../../core/types";
import {
  type NodePredicate,
  type Traversal,
  type TraversalDirection,
} from "../ast";
import { jsonPointer } from "../json-pointer";
import {
  arrayField,
  baseField,
  dateField,
  fieldRef,
  numberField,
  objectField,
  type Predicate,
  stringField,
} from "../predicates";
// Type-only import to get the QueryBuilder type without runtime circular dependency
import { type QueryBuilder } from "./query-builder";
import {
  type AliasMap,
  type BaseFieldAccessor,
  type EdgeAccessor,
  type EdgeAlias,
  type EdgeAliasMap,
  type NodeAlias,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type UniqueAlias,
  type ValidEdgeTargets,
} from "./types";
import { validateSqlIdentifier } from "./validation";

// Forward declaration - actual import would cause circular dependency
type QueryBuilderConstructor = new (
  config: QueryBuilderConfig,
  state: QueryBuilderState,
) => unknown;

// This will be set by the main builder module to avoid circular imports
let QueryBuilderClass: QueryBuilderConstructor;

/**
 * Sets the QueryBuilder class reference for use by TraversalBuilder.
 * Called during module initialization to break circular dependency.
 */
export function setQueryBuilderClass(cls: QueryBuilderConstructor): void {
  QueryBuilderClass = cls;
}

/**
 * State for variable-length traversal configuration.
 */
interface VariableLengthState {
  enabled: boolean;
  minDepth: number;
  maxDepth: number;
  collectPath: boolean;
  pathAlias?: string;
  depthAlias?: string;
}

/**
 * Default variable-length state (disabled).
 */
const DEFAULT_VARIABLE_LENGTH_STATE: VariableLengthState = {
  enabled: false,
  minDepth: 1,
  maxDepth: -1,
  collectPath: false,
};

/**
 * Intermediate builder for traversal operations.
 *
 * Type parameters track the edge kind and direction to constrain
 * which node kinds are valid targets in the `to()` method.
 */
export class TraversalBuilder<
  G extends GraphDef,
  Aliases extends AliasMap,
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Empty object for initial empty edge alias map
  EdgeAliases extends EdgeAliasMap = {},
  EK extends keyof G["edges"] & string = keyof G["edges"] & string,
  EA extends string = string,
  Dir extends TraversalDirection = "out",
  Optional extends boolean = false,
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;
  readonly #edgeKinds: readonly string[];
  readonly #edgeAlias: EA;
  readonly #direction: Dir;
  readonly #fromAlias: string;
  readonly #optional: Optional;
  readonly #variableLength: VariableLengthState;
  readonly #pendingEdgePredicates: readonly NodePredicate[];

  constructor(
    config: QueryBuilderConfig,
    state: QueryBuilderState,
    edgeKinds: readonly string[],
    edgeAlias: EA,
    direction: Dir,
    fromAlias: string,
    optional: Optional = false as Optional,
    variableLength: VariableLengthState = DEFAULT_VARIABLE_LENGTH_STATE,
    pendingEdgePredicates: readonly NodePredicate[] = [],
  ) {
    this.#config = config;
    this.#state = state;
    this.#edgeKinds = edgeKinds;
    this.#edgeAlias = edgeAlias;
    this.#direction = direction;
    this.#fromAlias = fromAlias;
    this.#optional = optional;
    this.#variableLength = variableLength;
    this.#pendingEdgePredicates = pendingEdgePredicates;
  }

  /**
   * Enables variable-length (recursive) traversal.
   * By default, traverses unlimited depth with cycle detection.
   */
  recursive(): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    Dir,
    Optional
  > {
    return new TraversalBuilder(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#optional,
      { ...this.#variableLength, enabled: true },
      this.#pendingEdgePredicates,
    );
  }

  /**
   * Sets the maximum traversal depth.
   * @param max Maximum number of hops (must be >= 1)
   */
  maxHops(
    max: number,
  ): TraversalBuilder<G, Aliases, EdgeAliases, EK, EA, Dir, Optional> {
    if (max < 1) {
      throw new Error("maxHops must be >= 1");
    }
    return new TraversalBuilder(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#optional,
      { ...this.#variableLength, enabled: true, maxDepth: max },
      this.#pendingEdgePredicates,
    );
  }

  /**
   * Sets the minimum traversal depth (skip nodes closer than this).
   * @param min Minimum hops before including results (default: 1)
   */
  minHops(
    min: number,
  ): TraversalBuilder<G, Aliases, EdgeAliases, EK, EA, Dir, Optional> {
    if (min < 0) {
      throw new Error("minHops must be >= 0");
    }
    return new TraversalBuilder(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#optional,
      { ...this.#variableLength, enabled: true, minDepth: min },
      this.#pendingEdgePredicates,
    );
  }

  /**
   * Includes the traversal path as an array in results.
   * @param alias Column alias for the path array (default: "{nodeAlias}_path")
   */
  collectPath(
    alias?: string,
  ): TraversalBuilder<G, Aliases, EdgeAliases, EK, EA, Dir, Optional> {
    const newState: VariableLengthState = {
      ...this.#variableLength,
      enabled: true,
      collectPath: true,
    };
    if (alias !== undefined) {
      newState.pathAlias = alias;
    }
    return new TraversalBuilder(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#optional,
      newState,
      this.#pendingEdgePredicates,
    );
  }

  /**
   * Includes the traversal depth in results.
   * @param alias Column alias for the depth (default: "{nodeAlias}_depth")
   */
  withDepth(
    alias?: string,
  ): TraversalBuilder<G, Aliases, EdgeAliases, EK, EA, Dir, Optional> {
    const newState: VariableLengthState = {
      ...this.#variableLength,
      enabled: true,
    };
    if (alias !== undefined) {
      newState.depthAlias = alias;
    }
    return new TraversalBuilder(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#optional,
      newState,
      this.#pendingEdgePredicates,
    );
  }

  /**
   * Adds a WHERE clause for the edge being traversed.
   *
   * @param alias - The edge alias to filter on (must be the current edge alias)
   * @param predicateFunction - A function that builds predicates using the edge accessor
   */
  whereEdge(
    alias: EA,
    predicateFunction: (
      edge: EdgeAccessor<G["edges"][EK]["type"]>,
    ) => Predicate,
  ): TraversalBuilder<G, Aliases, EdgeAliases, EK, EA, Dir, Optional> {
    const accessor = this.#createEdgeAccessor(alias);
    const predicate = predicateFunction(
      accessor as EdgeAccessor<G["edges"][EK]["type"]>,
    );

    const newPredicate: NodePredicate = {
      targetAlias: alias,
      targetType: "edge",
      expression: predicate.__expr,
    };

    return new TraversalBuilder(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#optional,
      this.#variableLength,
      [...this.#pendingEdgePredicates, newPredicate],
    );
  }

  /**
   * Creates a type-safe accessor for edge properties.
   */
  #createEdgeAccessor(alias: string): EdgeAccessor<AnyEdgeType> {
    // Pre-compute system field accessors
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

    // Build field accessor for a schema property
    const buildFieldAccessor = (propertyName: string): BaseFieldAccessor => {
      const typeInfo =
        this.#config.schemaIntrospector.getSharedEdgeFieldTypeInfo(
          this.#edgeKinds,
          propertyName,
        );

      const valueType = typeInfo?.valueType;
      const elementType = typeInfo?.elementType;

      const ref = fieldRef(alias, ["props"], {
        jsonPointer: jsonPointer([propertyName]),
        valueType,
        elementType,
      });

      switch (valueType) {
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
          return objectField(ref);
        }
        case "embedding":
        case "unknown":
        case undefined: {
          // Embedding, unknown, or unresolved type - return base field
          return baseField(ref);
        }
      }
    };

    // Use a Proxy to provide flattened property access
    return new Proxy({} as EdgeAccessor<AnyEdgeType>, {
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
        return buildFieldAccessor(property);
      },
    });
  }

  /**
   * Specifies the target node kind.
   *
   * The kind must be a valid target for this edge based on the traversal direction:
   * - "out" direction: kind must be in the edge's "to" array
   * - "in" direction: kind must be in the edge's "from" array
   *
   * @param kind - The target node kind
   * @param alias - A unique alias for this node (compile-time error if duplicate)
   */
  to<K extends ValidEdgeTargets<G, EK, Dir>, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options?: { includeSubClasses?: false },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<G["nodes"][K]["type"], Optional>>,
    EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>
  >;

  to<K extends ValidEdgeTargets<G, EK, Dir>, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options: { includeSubClasses: true },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<NodeType, Optional>>,
    EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>
  >;

  to<K extends ValidEdgeTargets<G, EK, Dir>, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options?: { includeSubClasses?: boolean },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<NodeType, Optional>>,
    EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>
  > {
    // Validate node alias to prevent SQL injection
    validateSqlIdentifier(alias);

    const includeSubClasses = options?.includeSubClasses ?? false;
    const kinds =
      includeSubClasses ? this.#config.registry.expandSubClasses(kind) : [kind];

    // Build base traversal
    const baseTraversal = {
      edgeAlias: this.#edgeAlias,
      edgeKinds: this.#edgeKinds,
      direction: this.#direction,
      nodeAlias: alias,
      nodeKinds: kinds,
      joinFromAlias: this.#fromAlias,
      joinEdgeField: this.#direction === "out" ? "from_id" : "to_id",
      optional: this.#optional,
    } as const;

    // Add variable-length spec if enabled
    const traversal: Traversal =
      this.#variableLength.enabled ?
        {
          ...baseTraversal,
          variableLength: {
            minDepth: this.#variableLength.minDepth,
            maxDepth: this.#variableLength.maxDepth,
            collectPath: this.#variableLength.collectPath,
            pathAlias: this.#variableLength.pathAlias ?? `${alias}_path`,
            depthAlias: this.#variableLength.depthAlias ?? `${alias}_depth`,
          },
        }
      : baseTraversal;

    const newState: QueryBuilderState = {
      ...this.#state,
      traversals: [...this.#state.traversals, traversal],
      predicates: [...this.#state.predicates, ...this.#pendingEdgePredicates],
      currentAlias: alias, // Update current alias to this traversal's target
    };

    // Cast is safe because the overloads provide compile-time type safety
    // The runtime QueryBuilderClass is the correct implementation
    return new QueryBuilderClass(this.#config, newState) as QueryBuilder<
      G,
      Aliases & Record<A, NodeAlias<NodeType, Optional>>,
      EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>
    >;
  }
}
