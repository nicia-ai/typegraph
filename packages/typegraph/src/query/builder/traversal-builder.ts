/**
 * TraversalBuilder - Intermediate builder for edge traversals.
 */
import { type GraphDef } from "../../core/define-graph";
import { type AnyEdgeType, type NodeType } from "../../core/types";
import { EndpointError, KindNotFoundError } from "../../errors";
import {
  type NodePredicate,
  type RecursiveCyclePolicy,
  type Traversal,
  type TraversalDirection,
} from "../ast";
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "../compiler";
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
import {
  createDynamicFieldBuilder,
  type DynamicEdgeType,
  type DynamicNodeType,
} from "./dynamic";
import { type QueryBuilder } from "./query-builder";
import {
  type AliasMap,
  type BaseFieldAccessor,
  type BuildRecursiveAliases,
  type EdgeAccessor,
  type EdgeAlias,
  type EdgeAliasMap,
  type EmptyEdgeAliasMap,
  type EmptyRecursiveAliasMap,
  type NodeAlias,
  type QueryBuilderConfig,
  type QueryBuilderState,
  type QueryCoordinateState,
  type RecursiveAliasMap,
  type RecursiveTraversalOptions,
  type UniqueAlias,
  type ValidEdgeTargets,
} from "./types";
import { validateSqlIdentifier } from "./validation";

/**
 * Resolves the edge type for an edge alias based on its kind type parameter.
 *
 * For `traverse(...)`, `EK` is a literal like `"authoredBy"` and the
 * type comes from the typed graph. For `traverseDynamic(...)`, `EK` is
 * widened to `string` — `string extends EK` distinguishes that case and
 * resolves to `DynamicEdgeType`, so the conditional accessor types fire.
 */
type EdgeTypeForKey<G extends GraphDef, EK> =
  string extends EK ? DynamicEdgeType
  : EK extends keyof G["edges"] & string ? G["edges"][EK]["type"]
  : DynamicEdgeType;

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
  cyclePolicy: RecursiveCyclePolicy;
  pathEnabled: boolean;
  pathAlias?: string;
  depthEnabled: boolean;
  depthAlias?: string;
}

/**
 * Default variable-length state (disabled).
 */
const DEFAULT_VARIABLE_LENGTH_STATE: VariableLengthState = {
  enabled: false,
  minDepth: 1,
  maxDepth: -1,
  cyclePolicy: "prevent",
  pathEnabled: false,
  depthEnabled: false,
};

function validateMaxHops(max: number): void {
  if (!Number.isFinite(max) || !Number.isInteger(max)) {
    throw new TypeError("maxHops must be a finite integer");
  }
  if (max < 1) {
    throw new Error("maxHops must be >= 1");
  }
  if (max > MAX_EXPLICIT_RECURSIVE_DEPTH) {
    throw new Error(
      `maxHops must be <= ${MAX_EXPLICIT_RECURSIVE_DEPTH}. ` +
        `Use a smaller bound to prevent runaway recursive queries.`,
    );
  }
}

function validateMinHops(min: number): void {
  if (!Number.isFinite(min) || !Number.isInteger(min)) {
    throw new TypeError("minHops must be a finite integer");
  }
  if (min < 0) {
    throw new Error("minHops must be >= 0");
  }
}

function resolveAliasOption(
  option: boolean | string | undefined,
): string | undefined {
  if (option === undefined || option === false) {
    return;
  }

  if (option === true) {
    return;
  }

  return option;
}

/**
 * Intermediate builder for traversal operations.
 *
 * Type parameters track the edge kind and direction to constrain
 * which node kinds are valid targets in the `to()` method.
 */
export class TraversalBuilder<
  G extends GraphDef,
  Aliases extends AliasMap,
  EdgeAliases extends EdgeAliasMap = EmptyEdgeAliasMap,
  EK extends keyof G["edges"] & string = keyof G["edges"] & string,
  EA extends string = string,
  Dir extends TraversalDirection = "out",
  Optional extends boolean = false,
  DC extends boolean | string = false,
  PC extends boolean | string = false,
  RecAliases extends RecursiveAliasMap = EmptyRecursiveAliasMap,
  CoordinateState extends QueryCoordinateState = "open",
> {
  readonly #config: QueryBuilderConfig;
  readonly #state: QueryBuilderState;
  readonly #edgeKinds: readonly string[];
  readonly #inverseEdgeKinds: readonly string[];
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
    inverseEdgeKinds: readonly string[] = [],
    optional: Optional = false as Optional,
    variableLength: VariableLengthState = DEFAULT_VARIABLE_LENGTH_STATE,
    pendingEdgePredicates: readonly NodePredicate[] = [],
  ) {
    this.#config = config;
    this.#state = state;
    this.#edgeKinds = edgeKinds;
    this.#inverseEdgeKinds = inverseEdgeKinds;
    this.#edgeAlias = edgeAlias;
    this.#direction = direction;
    this.#fromAlias = fromAlias;
    this.#optional = optional;
    this.#variableLength = variableLength;
    this.#pendingEdgePredicates = pendingEdgePredicates;
  }

  /**
   * Enables variable-length (recursive) traversal.
   * Defaults to MAX_RECURSIVE_DEPTH (10) hops with cycle prevention.
   * Use `maxHops` to override (up to MAX_EXPLICIT_RECURSIVE_DEPTH).
   */
  recursive<const O extends RecursiveTraversalOptions = Record<string, never>>(
    options?: O,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    Dir,
    Optional,
    O extends { depth: infer D extends boolean | string } ? D : DC,
    O extends { path: infer P extends boolean | string } ? P : PC,
    RecAliases,
    CoordinateState
  > {
    const minDepth = options?.minHops ?? this.#variableLength.minDepth;
    const maxDepth = options?.maxHops ?? this.#variableLength.maxDepth;
    validateMinHops(minDepth);
    if (options?.maxHops !== undefined) {
      validateMaxHops(maxDepth);
    }
    if (maxDepth > 0 && minDepth > maxDepth) {
      throw new Error("minHops must be <= maxHops");
    }

    const pathAlias = resolveAliasOption(options?.path);
    const depthAlias = resolveAliasOption(options?.depth);
    if (pathAlias !== undefined) validateSqlIdentifier(pathAlias);
    if (depthAlias !== undefined) validateSqlIdentifier(depthAlias);
    const cyclePolicy =
      options?.cyclePolicy ?? this.#variableLength.cyclePolicy;

    return new TraversalBuilder<
      G,
      Aliases,
      EdgeAliases,
      EK,
      EA,
      Dir,
      Optional,
      O extends { depth: infer D extends boolean | string } ? D : DC,
      O extends { path: infer P extends boolean | string } ? P : PC,
      RecAliases,
      CoordinateState
    >(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#inverseEdgeKinds,
      this.#optional,
      {
        ...this.#variableLength,
        enabled: true,
        minDepth,
        maxDepth,
        cyclePolicy,
        ...(options?.path !== undefined && {
          pathEnabled: options.path !== false,
          ...(pathAlias !== undefined && { pathAlias }),
        }),
        ...(options?.depth !== undefined && {
          depthEnabled: options.depth !== false,
          ...(depthAlias !== undefined && { depthAlias }),
        }),
      },
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
    predicateFunction: (edge: EdgeAccessor<EdgeTypeForKey<G, EK>>) => Predicate,
  ): TraversalBuilder<
    G,
    Aliases,
    EdgeAliases,
    EK,
    EA,
    Dir,
    Optional,
    DC,
    PC,
    RecAliases,
    CoordinateState
  > {
    const accessor = this.#createEdgeAccessor(alias);
    const predicate = predicateFunction(
      accessor as EdgeAccessor<EdgeTypeForKey<G, EK>>,
    );

    const newPredicate: NodePredicate = {
      targetAlias: alias,
      targetType: "edge",
      expression: predicate.__expr,
    };

    return new TraversalBuilder<
      G,
      Aliases,
      EdgeAliases,
      EK,
      EA,
      Dir,
      Optional,
      DC,
      PC,
      RecAliases,
      CoordinateState
    >(
      this.#config,
      this.#state,
      this.#edgeKinds,
      this.#edgeAlias,
      this.#direction,
      this.#fromAlias,
      this.#inverseEdgeKinds,
      this.#optional,
      this.#variableLength,
      [...this.#pendingEdgePredicates, newPredicate],
    );
  }

  /**
   * Creates a type-safe accessor for edge properties.
   */
  #createEdgeAccessor(alias: string): EdgeAccessor<AnyEdgeType> {
    const allEdgeKinds = [
      ...this.#edgeKinds,
      ...this.#inverseEdgeKinds.filter(
        (kind) => !this.#edgeKinds.includes(kind),
      ),
    ];

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
          allEdgeKinds,
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
            allEdgeKinds,
            "edge",
          ),
      } as unknown as EdgeAccessor<AnyEdgeType>;
    }

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
    EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>,
    RecAliases & BuildRecursiveAliases<DC, PC, A>,
    CoordinateState
  >;

  to<K extends ValidEdgeTargets<G, EK, Dir>, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options: { includeSubClasses: true },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<NodeType, Optional>>,
    EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>,
    RecAliases & BuildRecursiveAliases<DC, PC, A>,
    CoordinateState
  >;

  to<K extends ValidEdgeTargets<G, EK, Dir>, A extends string>(
    kind: K,
    alias: UniqueAlias<A, Aliases>,
    options?: { includeSubClasses?: boolean },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<NodeType, Optional>>,
    EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>,
    RecAliases & BuildRecursiveAliases<DC, PC, A>,
    CoordinateState
  > {
    validateSqlIdentifier(alias);

    const includeSubClasses = options?.includeSubClasses ?? false;
    const kinds =
      includeSubClasses ? this.#config.registry.expandSubClasses(kind) : [kind];

    const newState = this.#stateWithTraversal(alias, kinds);

    // Cast is safe because the overloads provide compile-time type safety
    // The runtime QueryBuilderClass is the correct implementation
    return new QueryBuilderClass(this.#config, newState) as QueryBuilder<
      G,
      Aliases & Record<A, NodeAlias<NodeType, Optional>>,
      EdgeAliases & Record<EA, EdgeAlias<G["edges"][EK]["type"], Optional>>,
      RecAliases & BuildRecursiveAliases<DC, PC, A>,
      CoordinateState
    >;
  }

  /**
   * String-keyed sibling of `to` for runtime-declared target kinds.
   * Throws `KindNotFoundError` if the kind is not registered.
   */
  toDynamic<A extends string>(
    kind: string,
    alias: UniqueAlias<A, Aliases>,
    options?: { includeSubClasses?: boolean },
  ): QueryBuilder<
    G,
    Aliases & Record<A, NodeAlias<DynamicNodeType, Optional>>,
    EdgeAliases & Record<EA, EdgeAlias<EdgeTypeForKey<G, EK>, Optional>>,
    RecAliases & BuildRecursiveAliases<DC, PC, A>,
    CoordinateState
  > {
    validateSqlIdentifier(alias);
    if (!this.#config.registry.hasNodeType(kind)) {
      throw new KindNotFoundError(kind, "node", {
        graphId: this.#config.graphId,
      });
    }
    this.#assertValidEndpoint(kind);

    const includeSubClasses = options?.includeSubClasses ?? false;
    const kinds =
      includeSubClasses ? this.#config.registry.expandSubClasses(kind) : [kind];

    const baseState = this.#stateWithTraversal(alias, kinds);
    const newState: QueryBuilderState = {
      ...baseState,
      dynamicNodeAliases: new Set([...baseState.dynamicNodeAliases, alias]),
    };

    return new QueryBuilderClass(this.#config, newState) as QueryBuilder<
      G,
      Aliases & Record<A, NodeAlias<DynamicNodeType, Optional>>,
      EdgeAliases & Record<EA, EdgeAlias<EdgeTypeForKey<G, EK>, Optional>>,
      RecAliases & BuildRecursiveAliases<DC, PC, A>,
      CoordinateState
    >;
  }

  /**
   * Builds the next `QueryBuilderState` after appending a traversal
   * targeting `alias` with `kinds`. Shared by `to` and `toDynamic`.
   */
  #stateWithTraversal(
    alias: string,
    kinds: readonly string[],
  ): QueryBuilderState {
    const traversalBase: Traversal = {
      edgeAlias: this.#edgeAlias,
      edgeKinds: this.#edgeKinds,
      direction: this.#direction,
      nodeAlias: alias,
      nodeKinds: kinds,
      joinFromAlias: this.#fromAlias,
      joinEdgeField: this.#direction === "out" ? "from_id" : "to_id",
      optional: this.#optional,
    };

    const baseTraversal: Traversal =
      this.#inverseEdgeKinds.length > 0 ?
        { ...traversalBase, inverseEdgeKinds: this.#inverseEdgeKinds }
      : traversalBase;

    const traversal: Traversal =
      this.#variableLength.enabled ?
        {
          ...baseTraversal,
          variableLength: {
            minDepth: this.#variableLength.minDepth,
            maxDepth: this.#variableLength.maxDepth,
            cyclePolicy: this.#variableLength.cyclePolicy,
            ...(this.#variableLength.pathEnabled && {
              pathAlias: this.#variableLength.pathAlias ?? `${alias}_path`,
            }),
            ...(this.#variableLength.depthEnabled && {
              depthAlias: this.#variableLength.depthAlias ?? `${alias}_depth`,
            }),
          },
        }
      : baseTraversal;

    return {
      ...this.#state,
      traversals: [...this.#state.traversals, traversal],
      predicates: [...this.#state.predicates, ...this.#pendingEdgePredicates],
      currentAlias: alias,
    };
  }

  /**
   * Asserts a runtime-declared target kind is a valid endpoint for the
   * current traversal. Mirrors the compile-time `ValidEdgeTargets`
   * constraint enforced by `to(...)` — without this check `toDynamic`
   * would silently accept e.g. `traverseDynamic("authoredBy") +
   * toDynamic("Document")` where authoredBy.to=[Author] and produce an
   * empty result set.
   *
   * Permissive on unions: if the target is assignable to any valid
   * endpoint across the edges being traversed, accept. Subclass
   * relationships are honored via `registry.isAssignableTo`.
   */
  #assertValidEndpoint(targetKind: string): void {
    const expectedKinds = new Set<string>();
    const collectFromEdge = (edgeName: string, side: "to" | "from"): void => {
      const edgeType = this.#config.registry.getEdgeType(edgeName);
      const endpoints = edgeType?.[side];
      if (!endpoints) return;
      for (const endpoint of endpoints) {
        expectedKinds.add(endpoint.kind);
      }
    };
    const forwardSide = this.#direction === "out" ? "to" : "from";
    const inverseSide = this.#direction === "out" ? "from" : "to";
    for (const edgeName of this.#edgeKinds) {
      collectFromEdge(edgeName, forwardSide);
    }
    for (const edgeName of this.#inverseEdgeKinds) {
      collectFromEdge(edgeName, inverseSide);
    }

    // No declared endpoints anywhere — edge kinds in the registry can
    // legally have undefined `to` / `from`; nothing to validate against.
    if (expectedKinds.size === 0) return;

    for (const expected of expectedKinds) {
      if (this.#config.registry.isAssignableTo(targetKind, expected)) return;
    }

    throw new EndpointError({
      edgeKind: this.#edgeKinds[0] ?? "(unknown)",
      endpoint: forwardSide,
      actualKind: targetKind,
      expectedKinds: [...expectedKinds],
    });
  }
}
