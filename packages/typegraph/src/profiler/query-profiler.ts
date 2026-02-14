/**
 * QueryProfiler - Main profiler class.
 *
 * Captures query patterns from the AST and generates index recommendations.
 * Uses Proxy to wrap Store and QueryBuilder for transparent interception.
 */

import { type z } from "zod";

import { type GraphDef } from "../core/define-graph";
import { type QueryAst } from "../query/ast";
import { resolveFieldTypeInfoAtJsonPointer } from "../query/field-type-info";
import {
  type JsonPointer,
  jsonPointer,
  parseJsonPointer,
} from "../query/json-pointer";
import {
  createSchemaIntrospector,
  type SchemaIntrospector,
} from "../query/schema-introspector";
import { type Store } from "../store/store";
import { extractPropertyAccesses } from "./ast-extractor";
import { ProfileCollector } from "./collector";
import {
  DEFAULT_HIGH_FREQUENCY_THRESHOLD,
  DEFAULT_MEDIUM_FREQUENCY_THRESHOLD,
  DEFAULT_MIN_FREQUENCY_FOR_RECOMMENDATION,
} from "./constants";
import {
  generateRecommendations,
  getUnindexedFilters,
} from "./recommendations";
import {
  type DeclaredIndex,
  type ProfileReport,
  type ProfilerOptions,
  type PropertyPath,
} from "./types";

// ============================================================
// ProfiledStore Type
// ============================================================

/**
 * A Store with profiling capabilities.
 *
 * Behaves exactly like a regular Store but tracks all query executions.
 * Access the profiler via the `profiler` property.
 */
export type ProfiledStore<G extends GraphDef> = Store<G> & {
  /** The profiler instance attached to this store */
  readonly profiler: QueryProfiler;
};

// ============================================================
// QueryProfiler Class
// ============================================================

/**
 * QueryProfiler captures and analyzes query patterns.
 *
 * Attach to a store to automatically track all query executions,
 * then generate reports with index recommendations.
 *
 * @example
 * ```typescript
 * import { QueryProfiler } from "@nicia-ai/typegraph/profiler";
 *
 * const profiler = new QueryProfiler({
 *   declaredIndexes: [
 *     { nodeKind: "Person", fields: ["email"], unique: true, name: "idx_email" },
 *   ],
 * });
 *
 * const profiledStore = profiler.attachToStore(store);
 *
 * // Run queries...
 * await profiledStore.query()
 *   .from("Person", "p")
 *   .whereNode("p", (p) => p.email.eq("alice@example.com"))
 *   .select((ctx) => ctx.p)
 *   .execute();
 *
 * // Get report
 * const report = profiler.getReport();
 * console.log(report.recommendations);
 * ```
 */
export class QueryProfiler {
  readonly #collector = new ProfileCollector();
  readonly #declaredIndexes: readonly DeclaredIndex[];
  readonly #minFrequencyForRecommendation: number;
  readonly #mediumFrequencyThreshold: number;
  readonly #highFrequencyThreshold: number;
  #schemaIntrospector: SchemaIntrospector | undefined;
  #attached = false;

  constructor(options?: ProfilerOptions) {
    this.#declaredIndexes = options?.declaredIndexes ?? [];
    this.#minFrequencyForRecommendation =
      options?.minFrequencyForRecommendation ??
      DEFAULT_MIN_FREQUENCY_FOR_RECOMMENDATION;
    this.#mediumFrequencyThreshold =
      options?.mediumFrequencyThreshold ?? DEFAULT_MEDIUM_FREQUENCY_THRESHOLD;
    this.#highFrequencyThreshold =
      options?.highFrequencyThreshold ?? DEFAULT_HIGH_FREQUENCY_THRESHOLD;
  }

  /**
   * Records a query execution from its AST.
   *
   * This is called automatically when attached to a store.
   * Can also be called manually for custom integrations.
   *
   * @param ast - The query AST to analyze
   */
  recordQuery(ast: QueryAst): void {
    this.#collector.recordQuery();

    const accesses = extractPropertyAccesses(ast);
    for (const access of accesses) {
      const paths = resolveAccessPaths(access, this.#schemaIntrospector);
      for (const path of paths) {
        this.#collector.record(path, access.context, access.predicateType);
      }
    }
  }

  /**
   * Attaches the profiler to a store.
   *
   * Returns a wrapped store that tracks all query executions.
   * The wrapped store behaves identically to the original.
   *
   * @param store - The store to attach to
   * @returns A profiled store with the `profiler` property
   * @throws Error if the profiler is already attached to another store
   */
  attachToStore<G extends GraphDef>(store: Store<G>): ProfiledStore<G> {
    if (this.#attached) {
      throw new Error(
        "Profiler is already attached. Call detach() first or create a new profiler.",
      );
    }
    this.#attached = true;
    this.#schemaIntrospector = createSchemaIntrospector(
      buildNodeSchemaMap(store.graph),
      buildEdgeSchemaMap(store.graph),
    );
    return createProfiledStore(store, this);
  }

  /**
   * Generates a complete profile report.
   *
   * The report includes:
   * - All property access patterns with frequency and context
   * - Index recommendations sorted by priority
   * - List of unindexed filter properties
   * - Summary statistics
   *
   * @returns The profile report
   */
  getReport(): ProfileReport {
    const patterns = this.#collector.getPatterns();
    const summary = this.#collector.getSummary();

    return {
      patterns,
      recommendations: generateRecommendations(
        patterns,
        this.#declaredIndexes,
        {
          minFrequencyForRecommendation: this.#minFrequencyForRecommendation,
          mediumFrequencyThreshold: this.#mediumFrequencyThreshold,
          highFrequencyThreshold: this.#highFrequencyThreshold,
        },
      ),
      summary,
      unindexedFilters: getUnindexedFilters(patterns, this.#declaredIndexes),
    };
  }

  /**
   * Checks if all filtered properties are covered by indexes.
   *
   * Throws an error if any filtered properties lack indexes.
   * Useful for test assertions to ensure query performance.
   *
   * @throws Error if unindexed filter properties are found
   *
   * @example
   * ```typescript
   * // In your test file
   * it("all filtered properties should be indexed", () => {
   *   profiler.assertIndexCoverage();
   * });
   * ```
   */
  assertIndexCoverage(): void {
    const report = this.getReport();
    if (report.unindexedFilters.length > 0) {
      const missing = report.unindexedFilters
        .map((p) => formatPropertyPath(p))
        .join(", ");
      throw new Error(`Unindexed filter properties: ${missing}`);
    }
  }

  /**
   * Resets all collected data.
   *
   * Clears patterns and query count. Useful for starting a fresh
   * profiling session without creating a new profiler instance.
   */
  reset(): void {
    this.#collector.reset();
  }

  /**
   * Marks the profiler as detached.
   *
   * Call this when you're done profiling to allow reattachment
   * to the same or a different store.
   */
  detach(): void {
    this.#attached = false;
    this.#schemaIntrospector = undefined;
  }

  /**
   * Whether the profiler is currently attached to a store.
   */
  get isAttached(): boolean {
    return this.#attached;
  }
}

function buildNodeSchemaMap(
  graph: GraphDef,
): ReadonlyMap<string, Readonly<{ schema: z.ZodType }>> {
  const entries = Object.values(graph.nodes).map(
    (n) => [n.type.kind, { schema: n.type.schema }] as const,
  );
  return new Map(entries);
}

function buildEdgeSchemaMap(
  graph: GraphDef,
): ReadonlyMap<string, Readonly<{ schema: z.ZodType }>> {
  const entries = Object.values(graph.edges).map(
    (edgeRegistration) =>
      [
        edgeRegistration.type.kind,
        { schema: edgeRegistration.type.schema },
      ] as const,
  );
  return new Map(entries);
}

function resolveAccessPaths(
  access: ReturnType<typeof extractPropertyAccesses>[number],
  schemaIntrospector: SchemaIntrospector | undefined,
): readonly PropertyPath[] {
  const kinds = access.kindNames;
  if (kinds.length === 0) {
    // This indicates a bug in the AST extractor - aliases should always resolve to kinds.
    // Log warning and skip rather than silently dropping data.
    warnInDevelopment(
      `[QueryProfiler] Access pattern has empty kindNames for context "${access.context}". ` +
        `This may indicate a bug in alias resolution.`,
    );
    return [];
  }

  if (!schemaIntrospector) {
    return [
      {
        entityType: access.entityType,
        kind: kinds[0]!,
        target: access.target,
      },
    ];
  }

  if (access.target.__type !== "prop") {
    return [
      {
        entityType: access.entityType,
        kind: kinds[0]!,
        target: access.target,
      },
    ];
  }

  const pointer = access.target.pointer;
  const matchingKinds = kinds.filter((kindName) =>
    hasPointerInSchema(
      schemaIntrospector,
      access.entityType,
      kindName,
      pointer,
    ),
  );

  const kindsToUse = matchingKinds.length > 0 ? matchingKinds : [kinds[0]!];

  return kindsToUse.map((kindName) => ({
    entityType: access.entityType,
    kind: kindName,
    target: access.target,
  }));
}

function warnInDevelopment(message: string, details?: unknown): void {
  if (!isDevelopmentEnvironment()) {
    return;
  }
  if (details !== undefined) {
    console.warn(message, details);
    return;
  }
  console.warn(message);
}

function isDevelopmentEnvironment(): boolean {
  return getNodeEnv() !== "production";
}

function getNodeEnv(): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env.NODE_ENV;
}

/**
 * Checks whether a JSON pointer exists in the schema for the given kind.
 *
 * This is used to attribute multi-kind aliases (includeSubClasses) to the most
 * relevant concrete kinds by verifying that the accessed pointer exists.
 *
 * Returns false on missing fields or invalid pointers.
 */
function hasPointerInSchema(
  schemaIntrospector: SchemaIntrospector,
  entityType: PropertyPath["entityType"],
  kindName: string,
  pointer: JsonPointer,
): boolean {
  const segments = parseJsonPointer(pointer);
  const [first, ...rest] = segments;
  if (!first) {
    return false;
  }

  const rootInfo =
    entityType === "node" ?
      schemaIntrospector.getFieldTypeInfo(kindName, first)
    : schemaIntrospector.getEdgeFieldTypeInfo(kindName, first);

  if (!rootInfo) {
    return false;
  }

  if (rest.length === 0) {
    return true;
  }

  try {
    const resolved = resolveFieldTypeInfoAtJsonPointer(
      rootInfo,
      jsonPointer(rest),
    );
    return resolved !== undefined;
  } catch (error) {
    warnInDevelopment(
      `[QueryProfiler] Failed to resolve pointer "${pointer}" for ${entityType} kind "${kindName}".`,
      error,
    );
    return false;
  }
}

function formatPropertyPath(path: PropertyPath): string {
  const target =
    path.target.__type === "prop" ?
      (path.target.pointer as string)
    : `$${path.target.field}`;
  return `${path.entityType}:${path.kind}:${target}`;
}

// ============================================================
// Proxy Implementation
// ============================================================

/**
 * Creates a profiled store wrapper using Proxy.
 */
function createProfiledStore<G extends GraphDef>(
  store: Store<G>,
  profiler: QueryProfiler,
): ProfiledStore<G> {
  const handler: ProxyHandler<Store<G>> = {
    get(target, property, _receiver) {
      // Add profiler property
      if (property === "profiler") {
        return profiler;
      }

      // Wrap query() method
      if (property === "query") {
        return () => {
          const builder = target.query();
          return wrapQueryBuilder(builder, profiler);
        };
      }

      // IMPORTANT: Store is a class with private fields; accessors and methods
      // must be invoked with `this === target`, not the proxy receiver.
      const value: unknown = Reflect.get(target, property, target);

      // Bind functions to the target to preserve private field access.
      if (typeof value === "function") {
        return (value as (...args: unknown[]) => unknown).bind(target);
      }

      return value;
    },
  };

  return new Proxy(store, handler) as ProfiledStore<G>;
}

/**
 * Wraps a query builder to intercept method calls.
 *
 * The builder returns new builders for most methods, and returns
 * ExecutableQuery for select/aggregate. We need to recursively
 * wrap to ensure all paths lead to wrapped ExecutableQueries.
 */
function wrapQueryBuilder<T extends object>(
  builder: T,
  profiler: QueryProfiler,
): T {
  const handler: ProxyHandler<T> = {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);

      // Not a function - return as-is
      if (typeof value !== "function") {
        return value;
      }

      // Wrap the method to intercept results
      return (...args: unknown[]): unknown => {
        const result: unknown = (
          value as (...args: unknown[]) => unknown
        ).apply(target, args);

        // If result is null/undefined or primitive, return as-is
        if (result === null || typeof result !== "object") {
          return result;
        }

        // Check if result is an ExecutableQuery (has toAst and execute)
        if (hasExecutableQueryShape(result)) {
          return wrapExecutableQuery(result, profiler);
        }

        // Check if result is a builder (has from, select, whereNode, etc.)
        if (hasQueryBuilderShape(result)) {
          return wrapQueryBuilder(result, profiler);
        }

        // Otherwise return as-is (e.g., compile() returns SQL)
        return result;
      };
    },
  };

  return new Proxy(builder, handler);
}

/**
 * Wraps an ExecutableQuery to intercept execute(), paginate(), stream().
 */
function wrapExecutableQuery<T extends object>(
  query: T,
  profiler: QueryProfiler,
): T {
  const handler: ProxyHandler<T> = {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);

      // Not a function - return as-is
      if (typeof value !== "function") {
        return value;
      }

      const fn = value as (...args: unknown[]) => unknown;

      // Always bind `this` to the original instance to preserve private fields.
      return (...args: unknown[]): unknown => {
        // Intercept execute, paginate, stream
        if (
          property === "execute" ||
          property === "paginate" ||
          property === "stream"
        ) {
          const toAst = Reflect.get(
            target,
            "toAst",
            receiver,
          ) as () => QueryAst;
          const ast = toAst.call(target);
          profiler.recordQuery(ast);
        }

        const result: unknown = fn.apply(target, args);

        // Any method that returns an ExecutableQuery-shaped object should remain wrapped.
        // Using duck-typing rather than a method whitelist ensures new chainable methods
        // (e.g., orderBy, limit, offset, pipe, union, intersect, etc.) are automatically handled.
        if (
          result &&
          typeof result === "object" &&
          hasExecutableQueryShape(result)
        ) {
          return wrapExecutableQuery(result, profiler);
        }

        return result;
      };
    },
  };

  return new Proxy(query, handler);
}

// ============================================================
// Type Guards
// ============================================================

/**
 * Checks if an object looks like an ExecutableQuery.
 */
function hasExecutableQueryShape(object: object): boolean {
  return (
    "toAst" in object &&
    typeof object.toAst === "function" &&
    "execute" in object &&
    typeof object.execute === "function"
  );
}

/**
 * Checks if an object looks like a QueryBuilder or TraversalBuilder.
 * Covers both the main query builder and traversal/edge builder chains.
 */
function hasQueryBuilderShape(object: object): boolean {
  return (
    ("from" in object && typeof object.from === "function") ||
    ("select" in object && typeof object.select === "function") ||
    ("whereNode" in object && typeof object.whereNode === "function") ||
    ("traverse" in object && typeof object.traverse === "function") ||
    // Traversal builder methods
    ("whereEdge" in object && typeof object.whereEdge === "function") ||
    ("to" in object && typeof object.to === "function")
  );
}
