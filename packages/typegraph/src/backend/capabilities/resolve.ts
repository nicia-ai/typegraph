/**
 * The bundle verdict resolver — generalizing `claimSupport`
 * (`store/claims/backing.ts`).
 *
 * Resolution splits in two (ruling B1): the VERDICT — the support decision,
 * resolved once against `GraphBackend` and threaded — and the BINDING
 * (`bind.ts`) — the actual member functions, bound at the call site off
 * whichever port the site holds. A verdict carries names, never functions
 * (I19), so it crosses transaction boundaries safely.
 */
import { ConfigurationError } from "../../errors";
import { createDataKeyedBag } from "../../utils/object";
import { type BackendCapabilities, type GraphBackend } from "../types";
import {
  BATCH_POINT_READ,
  type CapabilityBundleDefinition,
  type CapabilityBundleDisposition,
  type CapabilityBundleExtra,
  CLAIMS,
  CONTRIBUTION_HEALTH,
  type OptionalGraphBackendMember,
  RECORDED_REVISION_ORIGINS,
  STATEMENT_EXECUTION,
  UNIQUE_SIDECAR_BATCH,
} from "./bundle-registry";

/**
 * A bundle's extras, as a type-level map from extra id to the UNION of
 * member names that extra covers — derived from the definition's `extras`
 * array by `const` inference, never hand-written.
 */
export type CapabilityExtraSpec = Readonly<
  Record<string, OptionalGraphBackendMember>
>;

/**
 * One extra's verdict. `present: true` carries the member NAMES, not the
 * member functions (ruling B1) — the names are what the accessor binds
 * from, at the site, off the port.
 */
export type ExtraVerdict<M extends OptionalGraphBackendMember> =
  | Readonly<{ present: true; members: readonly M[] }>
  | Readonly<{
      present: false;
      missing: readonly M[];
      disposition: CapabilityBundleDisposition;
    }>;

/** The verdict map: one entry per extra id, never a boolean. */
export type ExtraVerdicts<X extends CapabilityExtraSpec> = Readonly<{
  [K in keyof X]: ExtraVerdict<X[K]>;
}>;

export type GatedBundleVerdict<
  MCore extends OptionalGraphBackendMember,
  X extends CapabilityExtraSpec,
> =
  | Readonly<{
      supported: true;
      bundle: string;
      /** The core, guaranteed present. Names, not functions. */
      members: readonly MCore[];
      extras: ExtraVerdicts<X>;
      /** The `present: false` keys of `extras`. */
      missingExtras: readonly (keyof X)[];
    }>
  | Readonly<{
      supported: false;
      bundle: string;
      missing: readonly MCore[];
      /** Why it is unsupported: the bundle's own `disposition`, verbatim. */
      disposition: CapabilityBundleDisposition;
    }>;

/** No `supported` field: a graduated bundle has no bundle-level verdict. */
export type GraduatedBundleVerdict<X extends CapabilityExtraSpec> = Readonly<{
  bundle: string;
  extras: ExtraVerdicts<X>;
  missingExtras: readonly (keyof X)[];
}>;

/**
 * Recovers the id→members map from a definition's `extras` TUPLE (not
 * `readonly CapabilityBundleExtra<XId, MExtra>[]` — over the array type the
 * id→members association is erased and `ExtraVerdicts<X>` degenerates to an
 * index signature).
 */
export type SpecOf<
  XS extends readonly CapabilityBundleExtra<
    string,
    OptionalGraphBackendMember
  >[],
> = { [K in XS[number] as K["id"]]: K["members"][number] };

export type ExtrasOf<D extends CapabilityBundleDefinition> = SpecOf<
  NonNullable<D["extras"]>
>;
export type ExtraMember<
  D extends CapabilityBundleDefinition,
  X extends keyof ExtrasOf<D>,
> = Extract<ExtrasOf<D>[X], OptionalGraphBackendMember>;

/**
 * The definition union and the return-type mapping. Structural, matching
 * `bundle-registry.ts`'s `BundleMembers` helper's own lesson: reading `core`
 * off `D` directly (rather than re-matching `GatedBundleDefinition`) avoids
 * an unmatched `infer` silently widening to the member constraint.
 */
export type BundleVerdictOf<D extends CapabilityBundleDefinition> =
  D extends (
    {
      kind: "graduated";
      extras: infer XS extends readonly CapabilityBundleExtra<
        string,
        OptionalGraphBackendMember
      >[];
    }
  ) ?
    GraduatedBundleVerdict<SpecOf<XS>>
  : D extends (
    {
      kind: "gated";
      core: readonly (infer MCore extends OptionalGraphBackendMember)[];
      extras?: infer XS extends
        | readonly CapabilityBundleExtra<string, OptionalGraphBackendMember>[]
        | undefined;
    }
  ) ?
    GatedBundleVerdict<
      MCore,
      SpecOf<
        XS extends (
          readonly CapabilityBundleExtra<string, OptionalGraphBackendMember>[]
        ) ?
          XS
        : []
      >
    >
  : never;

function resolveExtras<
  const XS extends readonly CapabilityBundleExtra<
    string,
    OptionalGraphBackendMember
  >[],
>(
  backend: GraphBackend,
  extras: XS,
): Readonly<{
  extras: ExtraVerdicts<SpecOf<XS>>;
  missingExtras: readonly (keyof SpecOf<XS>)[];
}> {
  const verdicts =
    createDataKeyedBag<ExtraVerdict<OptionalGraphBackendMember>>();
  const missingExtras: string[] = [];
  for (const extra of extras) {
    const missing = extra.members.filter(
      (member) => backend[member] === undefined,
    );
    if (missing.length === 0) {
      verdicts[extra.id] = { present: true, members: extra.members };
    } else {
      verdicts[extra.id] = {
        present: false,
        missing,
        disposition: extra.disposition,
      };
      missingExtras.push(extra.id);
    }
  }
  return {
    extras: verdicts as ExtraVerdicts<SpecOf<XS>>,
    missingExtras: missingExtras,
  };
}

/**
 * The `claims` bidirectional cross-check (ruling F2), reproducing
 * `store/claims/backing.ts`'s pre-B7 message text, code and suggestion
 * BYTE-FOR-BYTE. B7 made `claimSupport` (`backing.ts`) delegate to
 * {@link resolveBundle}, so this is now the ONLY place the check runs — there
 * is no second copy left to keep in sync. `bidirectional` is `claims`-only by
 * design (§5.2.1): the two trailing sentences below name "claim"/"fence"
 * vocabulary that is specific to that one bundle, and a future bundle raising
 * `crossCheck` to `"bidirectional"` must carry its own justification row and,
 * with it, its own message pair here.
 *
 * @throws {ConfigurationError} when the declaration and the member surface
 *   disagree in either direction.
 */
function assertClaimsBidirectionalAgreement(
  backend: GraphBackend,
  definition: Readonly<{
    declaration?: keyof BackendCapabilities;
    core: readonly OptionalGraphBackendMember[];
    portSurfaceCode: string;
  }>,
): void {
  if (definition.declaration === undefined) return;
  const declared = backend.capabilities[definition.declaration] === true;
  const present = definition.core.filter(
    (member) => backend[member] !== undefined,
  );
  if (declared && present.length === definition.core.length) return;
  if (!declared && present.length === 0) return;

  const missing = definition.core.filter(
    (member) => backend[member] === undefined,
  );
  const declarationName = definition.declaration;
  throw new ConfigurationError(
    declared ?
      `This backend declares \`${declarationName}: true\` but does not implement ${missing.join(", ")}. ` +
        "A declared constraint would then be written without the fence the declaration promises."
    : `This backend implements ${present.join(", ")} but does not declare \`${declarationName}: true\`. ` +
        "Claim support is read from the declaration, so these members would never be called.",
    { code: definition.portSurfaceCode, missing, present },
    {
      suggestion:
        declared ?
          `Implement the missing members, or drop \`${declarationName}\` from the backend's capabilities.`
        : `Declare \`${declarationName}: true\` in the backend's capabilities, or drop the claim members.`,
    },
  );
}

/**
 * Resolved ONCE, at construction or entry, against the top-level backend —
 * never against a `TransactionBackend` (I15's `@ts-expect-error` row).
 *
 * Rules: the member surface is read always; the declaration is read only
 * when the definition names one AND `crossCheck !== "none"` (only `claims`
 * qualifies in the pilot registry); a gated bundle's core must be complete
 * or the bundle is unsupported with `missing`; a graduated bundle has no
 * bundle-level verdict, only per-extra verdicts. `missingExtras` is built by
 * the SAME fold that builds `extras` (one pass, one owner).
 */
export function resolveBundle<const D extends CapabilityBundleDefinition>(
  backend: GraphBackend,
  definition: D,
): BundleVerdictOf<D> {
  const extras = (definition.extras ?? []) as readonly CapabilityBundleExtra<
    string,
    OptionalGraphBackendMember
  >[];
  const { extras: extraVerdicts, missingExtras } = resolveExtras(
    backend,
    extras,
  );

  // Rule 1: the declaration is read whenever `crossCheck !== "none"`,
  // regardless of kind — a graduated bundle's "core" for this purpose is the
  // union of every extra's members, since it has no core of its own. Only
  // `claims` (gated) exercises this in the pilot registry, but the check
  // itself must not silently no-op for a hypothetical graduated bidirectional
  // bundle (T11's mutation pins exactly this).
  if (definition.crossCheck === "bidirectional") {
    const memberSet =
      definition.kind === "gated" ?
        definition.core
      : extras.flatMap((extra) => extra.members);
    assertClaimsBidirectionalAgreement(backend, {
      ...(definition.declaration === undefined ?
        {}
      : { declaration: definition.declaration }),
      core: memberSet,
      portSurfaceCode: definition.portSurfaceCode,
    });
  }

  if (definition.kind === "graduated") {
    return {
      bundle: definition.id,
      extras: extraVerdicts,
      missingExtras,
    } as unknown as BundleVerdictOf<D>;
  }

  const missing = definition.core.filter(
    (member) => backend[member] === undefined,
  );
  if (missing.length > 0) {
    return {
      supported: false,
      bundle: definition.id,
      missing,
      disposition: definition.disposition,
    } as unknown as BundleVerdictOf<D>;
  }
  return {
    supported: true,
    bundle: definition.id,
    members: definition.core,
    extras: extraVerdicts,
    missingExtras,
  } as unknown as BundleVerdictOf<D>;
}

/** The literal operation names a bundle's `operations` table declares. */
export type OperationNames<D extends CapabilityBundleDefinition> =
  D["operations"][number]["operation"];

/** The extras a named operation `requires`, read from the ROW — never re-spelled at the call site. */
export type RequiredExtrasOf<
  D extends CapabilityBundleDefinition,
  Op extends OperationNames<D>,
> =
  Extract<D["operations"][number], { operation: Op }> extends (
    { requires: infer R extends readonly string[] }
  ) ?
    R[number]
  : never;

/**
 * The refusal for an operation whose `requires` extras are absent — how a
 * GRADUATED bundle refuses where the tree refuses today: the row names the
 * operation and the extras, this asserts they are present, and
 * {@link bindExtra} (`bind.ts`) binds them off the port.
 *
 * `operation` is the literal key of the bundle's `operations` tuple, so the
 * required extras are looked up TYPE-LEVEL from the registry — no second
 * spelling of `requires` at the call site.
 *
 * @throws {ConfigurationError} naming the row's own `code` when one or more
 *   required extras is absent from the verdict.
 */
export function requireExtras<
  const D extends CapabilityBundleDefinition,
  Op extends OperationNames<D>,
>(
  definition: D,
  verdict: BundleVerdictOf<D>,
  operation: Op,
): asserts verdict is BundleVerdictOf<D> & {
  extras: {
    [K in RequiredExtrasOf<D, Op> & keyof ExtrasOf<D>]: Extract<
      ExtraVerdict<ExtraMember<D, K>>,
      { present: true }
    >;
  };
} {
  const row = definition.operations.find(
    (candidate) => candidate.operation === operation,
  );
  if (row === undefined) {
    throw new ConfigurationError(
      `Unknown operation "${operation}" for capability bundle "${definition.id}".`,
      { bundle: definition.id, operation },
    );
  }
  const required = row.requires ?? [];
  const extras:
    | Readonly<Record<string, ExtraVerdict<OptionalGraphBackendMember>>>
    | undefined = "extras" in verdict ? verdict.extras : undefined;
  const missing = required.filter(
    (id) => extras === undefined || extras[id]?.present !== true,
  );
  if (missing.length === 0) return;

  const { disposition } = row;
  if (disposition.kind === "refuse") {
    throw new ConfigurationError(
      `Operation "${operation}" on capability bundle "${definition.id}" requires ${missing.join(", ")}.`,
      { code: disposition.code, bundle: definition.id, operation, missing },
    );
  }
  // No pilot row reaches this: every row with a non-empty `requires` in the
  // registry disposes `refuse` (a graduated bundle's fallback rows never
  // name `requires` — the fallback IS the degrade path). Kept as a named,
  // typed refusal rather than a silent pass so a future `fallback` +
  // `requires` row cannot pass `requireExtras` unnoticed.
  throw new ConfigurationError(
    `Operation "${operation}" on capability bundle "${definition.id}" requires ${missing.join(", ")}, and the registry names no refusal code for this fallback-dispositioned row.`,
    { bundle: definition.id, operation, missing },
  );
}

// ---------------------------------------------------------------------------
// The six named verdict accessors — GraphBackend-only, no exceptions (I15).
// ---------------------------------------------------------------------------

export function claimsVerdict(
  backend: GraphBackend,
): BundleVerdictOf<typeof CLAIMS> {
  return resolveBundle(backend, CLAIMS);
}

export function uniqueSidecarBatchVerdict(
  backend: GraphBackend,
): BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH> {
  return resolveBundle(backend, UNIQUE_SIDECAR_BATCH);
}

export function batchPointReadVerdict(
  backend: GraphBackend,
): BundleVerdictOf<typeof BATCH_POINT_READ> {
  return resolveBundle(backend, BATCH_POINT_READ);
}

export function statementExecutionVerdict(
  backend: GraphBackend,
): BundleVerdictOf<typeof STATEMENT_EXECUTION> {
  return resolveBundle(backend, STATEMENT_EXECUTION);
}

export function contributionHealthVerdict(
  backend: GraphBackend,
): BundleVerdictOf<typeof CONTRIBUTION_HEALTH> {
  return resolveBundle(backend, CONTRIBUTION_HEALTH);
}

export function recordedRevisionOriginsVerdict(
  backend: GraphBackend,
): BundleVerdictOf<typeof RECORDED_REVISION_ORIGINS> {
  return resolveBundle(backend, RECORDED_REVISION_ORIGINS);
}

// ---------------------------------------------------------------------------
// The claims verdict THUNK — the reference implementation of §5.2.3's INTENT
// (one owner, at-most-once resolution, no re-derivation) moved to WHEN it
// resolves rather than IF (ruling B7 refinement 2).
// ---------------------------------------------------------------------------

/**
 * A memoized, at-most-once resolution of the `claims` bundle's verdict
 * against ONE backend.
 *
 * Eager resolution at store construction is forbidden: T14's
 * contradictory-declaration backends must still be able to construct a store
 * and create nodes — only a constrained edge write may legally reach the
 * bidirectional cross-check's throw, and it must do so lazily, at the first
 * write that needs the verdict.
 *
 * A cached verdict cannot go stale because `GraphBackend` is deep-frozen (B1):
 * nothing can flip `capabilities.constraintClaims` or add/remove a claim
 * member on a backend object after this thunk has already resolved it, so
 * "resolve once and reuse forever" is exactly as safe as "resolve every
 * time" — for one backend object, they observe the same immutable answer.
 */
export type ClaimsVerdictThunk = () => BundleVerdictOf<typeof CLAIMS>;

/**
 * Interning: the same backend object always gets back the SAME thunk object.
 * This is what makes "one shared thunk per backend" structural rather than a
 * convention every population site has to honor — a second call to
 * {@link createClaimsVerdictThunk} for a backend already minted cannot produce
 * a second, independently-memoized verdict.
 */
const CLAIMS_VERDICT_THUNKS = new WeakMap<GraphBackend, ClaimsVerdictThunk>();

/**
 * Mints — or returns the already-minted — {@link ClaimsVerdictThunk} for
 * `backend`.
 *
 * The thunk resolves {@link resolveBundle}`(backend, CLAIMS)` on its first
 * call and caches the outcome, INCLUDING a thrown `ConfigurationError`: a
 * refusal is cached and re-thrown on every subsequent call, never
 * re-resolved. Both layers — interning here, memoization inside the thunk —
 * are required: interning alone would still let two independently-memoized
 * thunks exist for one backend if a caller ignored the shared one; memoizing
 * alone would still let two different call sites mint two different thunks
 * that could disagree about whether they had already resolved.
 */
export function createClaimsVerdictThunk(
  backend: GraphBackend,
): ClaimsVerdictThunk {
  const existing = CLAIMS_VERDICT_THUNKS.get(backend);
  if (existing !== undefined) return existing;

  type Memo =
    | Readonly<{ state: "resolved"; verdict: BundleVerdictOf<typeof CLAIMS> }>
    | Readonly<{ state: "thrown"; error: unknown }>;
  let memo: Memo | undefined;

  const thunk: ClaimsVerdictThunk = () => {
    if (memo === undefined) {
      try {
        memo = { state: "resolved", verdict: resolveBundle(backend, CLAIMS) };
      } catch (error) {
        memo = { state: "thrown", error };
        throw error;
      }
    }
    if (memo.state === "thrown") throw memo.error;
    return memo.verdict;
  };

  CLAIMS_VERDICT_THUNKS.set(backend, thunk);
  return thunk;
}
