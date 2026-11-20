/**
 * The `recursiveTraversal` capability: whether this engine can compute a
 * BOUNDED TRANSITIVE CLOSURE of a relation in one round trip — the traversal
 * primitive, not the SQL syntax.
 */
import { ConfigurationError } from "../../errors";
import { type BackendCapabilities } from "../types";

/**
 * Whether this engine can compute a BOUNDED TRANSITIVE CLOSURE of a relation
 * in one round trip — the traversal primitive, not the SQL syntax. A SQL
 * engine satisfies it with `WITH RECURSIVE`; a graph-native engine satisfies
 * it with a native expansion operator. What the capability promises is the
 * SEMANTICS: given a seed set, a step relation, and a hop bound, the engine
 * returns the reachable set (optionally with depth and path) without the
 * client issuing one statement per hop.
 *
 * Absent means SUPPORTED. Every engine TypeGraph ships supports it, and every
 * custom backend already has the six emission sites run against it
 * unconditionally: making absence mean `false` would refuse traversals that
 * work today. This mirrors `returning`, not `constraintClaims` — absence is
 * only allowed to mean "false" where absence is SAFE, and here it is not. A
 * backend that genuinely lacks the primitive must say so.
 */
export type RecursiveTraversalCapability = Readonly<{
  supported: boolean;
  /**
   * Why the engine lacks it — surfaced in every refusal's details so the
   * state is named rather than implied. Required when `supported: false` and
   * forbidden when `true`, so the union cannot carry a dangling reason.
   */
  reason?: string;
}>;

/**
 * The brand. Declared but never exported, and never assigned at runtime — it
 * exists only so that an object literal outside this module is not assignable
 * to {@link RecursiveTraversalVerdict}. Compare `VectorSlot`'s construction
 * discipline: the type is public, the constructor is the seam.
 */
declare const RECURSIVE_TRAVERSAL_VERDICT: unique symbol;

/**
 * The decision, branded so it can only originate from this module's
 * constructors. Round 1 made the verdict a required *field*, which forces a
 * token, not a verdict: any caller could satisfy it by writing
 * `{ supported: true }` inline, and nothing tied the value to the resolver.
 * The brand closes that at the type level.
 */
export type RecursiveTraversalVerdict = Readonly<
  { [RECURSIVE_TRAVERSAL_VERDICT]: true } & (
    { supported: true } | { supported: false; reason: string }
  )
>;

/** THE one reader of `capabilities.recursiveTraversal`, and THE one constructor. */
export function resolveRecursiveTraversal(
  capabilities: BackendCapabilities,
): RecursiveTraversalVerdict {
  const declared = capabilities.recursiveTraversal;
  if (declared === undefined) {
    return { supported: true } as RecursiveTraversalVerdict;
  }
  if (declared.supported) {
    return { supported: true } as RecursiveTraversalVerdict;
  }
  // A raw custom-backend object may never have passed the §4 assert
  // (`assertBundledCapabilityDeclarations`), so `reason` is not guaranteed to
  // be present even though the type says it is. Naming the state explicitly
  // beats a default that would hide a contradictory declaration.
  return {
    supported: false,
    reason:
      declared.reason ??
      "backend declares recursiveTraversal: { supported: false }",
  } as RecursiveTraversalVerdict;
}

/**
 * The ONE sanctioned way to obtain a verdict without a backend: the query
 * compiler's public entry point `compileQuery(ast, graphId, "postgres")`
 * takes no backend at all, so it has no capabilities to resolve from. The
 * reason string is required and is echoed in nothing — it exists so the call
 * site states why it is allowed to assume.
 */
export function assumeRecursiveTraversalSupported(
  reason: string,
): RecursiveTraversalVerdict {
  // `reason` is intentionally unused in the returned verdict: it documents
  // the assumption at the call site rather than becoming part of the value.
  void reason;
  return { supported: true } as RecursiveTraversalVerdict;
}

/** THE one refusal builder. */
export function recursiveTraversalUnsupportedError(
  verdict: Extract<RecursiveTraversalVerdict, { supported: false }>,
  operation: string,
): ConfigurationError {
  return new ConfigurationError(
    `${operation} requires recursive traversal, but this backend declares recursiveTraversal: { supported: false }.`,
    {
      code: "RECURSIVE_TRAVERSAL_UNSUPPORTED",
      capability: "recursiveTraversal",
      operation,
      reason: verdict.reason,
    },
    {
      suggestion:
        "Use a backend that supports recursive traversal, or avoid this query shape.",
    },
  );
}

/** THE one assertion: refuses when the verdict says the engine cannot. */
export function assertRecursiveTraversal(
  verdict: RecursiveTraversalVerdict,
  operation: string,
): asserts verdict is Extract<RecursiveTraversalVerdict, { supported: true }> {
  if (verdict.supported) return;
  throw recursiveTraversalUnsupportedError(verdict, operation);
}
