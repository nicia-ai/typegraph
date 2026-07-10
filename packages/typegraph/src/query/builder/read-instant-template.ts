/**
 * Compiled-SQL template cache keyed on the reserved read-instant placeholder.
 *
 * A "current" (live) query bakes its valid-time read instant into the compiled
 * SQL as a bound parameter. Recompiling the whole AST on every execution just
 * to refresh that one value — the behavior PR #246 introduced to fix a frozen
 * "now" — is pure waste: the SQL text is byte-identical across calls, only the
 * instant differs. This module compiles the statement ONCE in `"placeholder"`
 * mode (the read instant becomes {@link CURRENT_READ_INSTANT_PLACEHOLDER}
 * instead of a frozen value), caches the resulting `{ sql, params }`, and fills
 * a fresh instant into the placeholder on every execution via
 * {@link fillTemplateParams}.
 *
 * The fast path requires a backend that can both compile a Drizzle SQL object
 * to text (`compileSql`) and execute pre-compiled text (`executeRaw`). Custom
 * or async backends without those members fall back to per-call recompilation,
 * exactly as before.
 */
import { Placeholder, type SQL } from "drizzle-orm";

import { ConfigurationError } from "../../errors";
import { nowIso } from "../../utils/date";
import { type ComposableQuery, type QueryAst } from "../ast";
import { compileQuery, type CompileQueryOptions } from "../compiler/index";
import { CURRENT_READ_INSTANT_PLACEHOLDER } from "../compiler/temporal";
import { getDialect } from "../dialect";
import { type SqlDialect } from "../dialect/types";
import { type CompiledSelectSql, isRawExecutable } from "../sql-intent";

/**
 * A compiled statement ready for `executeRaw`: SQL text plus a positional
 * parameter list that may still contain unfilled {@link Placeholder} objects
 * (the read instant, and any user `param()` refs on a prepared query).
 */
export type CompiledTemplate = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

/** Compiles a Drizzle SQL object to `{ sql, params }` without executing. */
type CompileSqlFunction = (query: SQL) => CompiledTemplate;

/**
 * The slice of a backend used to build a template. Passed whole (not as a bare
 * `compileSql` reference) so `compileSql` is invoked as a method — a custom
 * backend may implement it with `this`, which a detached call would lose.
 */
export type SqlCompilerBackend = Readonly<{ compileSql?: CompileSqlFunction }>;

/** Whether a compiled template carries the reserved read-instant placeholder. */
function templateHasReadInstant(template: CompiledTemplate): boolean {
  return template.params.some(
    (parameter) =>
      parameter instanceof Placeholder &&
      parameter.name === CURRENT_READ_INSTANT_PLACEHOLDER,
  );
}

/**
 * True when a query's compiled SQL must bind a fresh "current" instant per
 * execution — i.e. it reads valid-time "current" and is not pinned to a
 * recorded instant (a recorded pin replaces the wall clock with a fixed
 * instant). `asOf`, `includeEnded`, and `includeTombstones` reads bind no
 * read instant at all, so their compiled statement is stable and cacheable
 * verbatim.
 */
function queryAstNeedsCurrentReadInstant(ast: QueryAst): boolean {
  return ast.temporalMode.mode === "current" && ast.recordedAsOf === undefined;
}

/** {@link queryAstNeedsCurrentReadInstant} lifted over a set operation's operands. */
export function composableNeedsCurrentReadInstant(
  query: ComposableQuery,
): boolean {
  if ("__type" in query) {
    return (
      composableNeedsCurrentReadInstant(query.left) ||
      composableNeedsCurrentReadInstant(query.right)
    );
  }
  return queryAstNeedsCurrentReadInstant(query);
}

type BuildReadInstantTemplateArguments = Readonly<{
  /** Compiles the statement in `"placeholder"` read-instant mode. */
  compile: () => CompiledSelectSql;
  /**
   * The backend, whose `compileSql` produces the cacheable text. When it (or
   * its `compileSql`) is absent the backend has no raw-execution fast path, so
   * there is no template to build.
   */
  backend: SqlCompilerBackend | undefined;
  /**
   * Whether the source query requires a fresh instant per execution (see
   * {@link queryAstNeedsCurrentReadInstant}). Used as a correctness guard: a
   * query that needs a read instant but whose compiled template carries no
   * read-instant placeholder has frozen "now" into a literal, so it is NOT
   * safe to cache — the caller must recompile per call instead.
   */
  needsReadInstant: boolean;
}>;

/**
 * Compiles the reusable placeholder template, or returns `undefined` when the
 * statement cannot be safely cached (or the backend has no raw-execution fast
 * path).
 *
 * The `needsReadInstant` guard enforces the lesson of the #246 freshness
 * regression: if the query needs a "current" instant yet the placeholder-mode
 * compilation did not templatize one, some read-instant emission escaped the
 * placeholder seam and would freeze into the cache. Every "current" query in
 * the builder's compile pipeline binds its instant through the one placeholder
 * seam, so this branch is unreachable by construction today; it exists to fail
 * safe — degrading to correct-but-uncached — if a future emission path forgets
 * the mode, rather than resting the invariant on a whole-compiler proof.
 */
export function buildReadInstantTemplate(
  args: BuildReadInstantTemplateArguments,
): CompiledTemplate | undefined {
  const { backend } = args;
  if (backend?.compileSql === undefined) return undefined;

  const compiled = args.compile();
  // A statement whose execution semantics ride on the compiled SQL OBJECT
  // (pgvector ANN GUCs, force-custom-plan) loses them when flattened to raw
  // text, so it can't take the executeRaw fast path — the caller falls back to
  // backend.execute, which honors the brand. See isRawExecutable.
  if (!isRawExecutable(compiled)) return undefined;

  // Method call (not a detached reference) so a this-using compileSql works.
  const template = backend.compileSql(compiled);
  if (args.needsReadInstant && !templateHasReadInstant(template)) {
    return undefined;
  }
  return template;
}

/**
 * Convenience over {@link buildReadInstantTemplate} for a standard (non
 * set-operation) query: compiles `ast` in placeholder mode via
 * {@link compileQuery} and derives {@link queryAstNeedsCurrentReadInstant}.
 * Set operations call {@link buildReadInstantTemplate} directly with their own
 * compile function and composable need-check.
 */
export function buildQueryTemplate(
  ast: QueryAst,
  graphId: string,
  compileOptions: CompileQueryOptions,
  backend: SqlCompilerBackend | undefined,
): CompiledTemplate | undefined {
  return buildReadInstantTemplate({
    compile: () =>
      compileQuery(ast, graphId, {
        ...compileOptions,
        readInstant: "placeholder",
      }),
    backend,
    needsReadInstant: queryAstNeedsCurrentReadInstant(ast),
  });
}

/**
 * Resolves a template's positional parameters for `executeRaw`, replacing
 * every {@link Placeholder} with a concrete value:
 *
 * - the reserved read-instant placeholder → a single fresh {@link nowIso}
 *   sampled once and shared by every occurrence, preserving the "one instant
 *   per statement" invariant the literal path guaranteed;
 * - a user `param()` placeholder → its binding, mapped the same way the
 *   compile path binds a literal (Date → ISO string; everything else through
 *   the dialect's `bindValue`).
 */
export function fillTemplateParams(
  params: readonly unknown[],
  bindings: Readonly<Record<string, unknown>>,
  dialect: SqlDialect,
): unknown[] {
  const adapter = getDialect(dialect);
  let readInstant: string | undefined;
  return params.map((parameter) => {
    if (!(parameter instanceof Placeholder)) return parameter;

    // drizzle types Placeholder#name as `any`; it is always a string.
    const name = parameter.name as string;
    if (name === CURRENT_READ_INSTANT_PLACEHOLDER) {
      readInstant ??= nowIso();
      return readInstant;
    }

    const value = bindings[name];
    if (value === undefined) {
      throw new ConfigurationError(`Missing binding for parameter "${name}"`, {
        parameterName: name,
      });
    }
    if (value instanceof Date) return value.toISOString();
    return adapter.bindValue(value);
  });
}
